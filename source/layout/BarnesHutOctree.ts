import { deterministicPairDirection } from './deterministicPairDirection.js';

const COLLOCATED_LEAF_INTERACTION_LIMIT = 64;

interface OctreeCell {
  centerX: number;
  centerY: number;
  centerZ: number;
  halfExtent: number;
  mass: number;
  centerOfMassX: number;
  centerOfMassY: number;
  centerOfMassZ: number;
  indices?: number[];
  children?: Array<OctreeCell | undefined>;
}

export interface BarnesHutOptions {
  theta: number;
  strength: number;
  softening: number;
  dimensions: 2 | 3;
}

/** A deterministic octree used for the many-body force. */
export class BarnesHutOctree {
  private root: OctreeCell | undefined;
  private positions = new Float32Array(0);
  private nodeCount = 0;
  private dimensions: 2 | 3 = 3;
  private readonly cellPool: OctreeCell[] = [];
  private readonly indexPool: number[][] = [];
  private readonly childrenPool: Array<Array<OctreeCell | undefined>> = [];
  private cellCursor = 0;
  private indexCursor = 0;
  private childrenCursor = 0;

  build(positions: Float32Array, nodeCount: number, dimensions: 2 | 3): void {
    this.positions = positions;
    this.nodeCount = nodeCount;
    this.dimensions = dimensions;
    this.cellCursor = 0;
    this.indexCursor = 0;
    this.childrenCursor = 0;
    if (nodeCount === 0) {
      this.root = undefined;
      return;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < nodeCount; index += 1) {
      const offset = index * 3;
      const x = positions[offset] ?? 0;
      const y = positions[offset + 1] ?? 0;
      const z = dimensions === 3 ? positions[offset + 2] ?? 0 : 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
    const root = this.acquireCell({
      centerX: (minX + maxX) * 0.5,
      centerY: (minY + maxY) * 0.5,
      centerZ: (minZ + maxZ) * 0.5,
      halfExtent: span * 0.5 + 1e-4
    });
    root.indices = this.acquireIndexArray();
    for (let index = 0; index < nodeCount; index += 1) {
      this.insert(root, index, 0);
    }
    this.accumulate(root);
    this.root = root;
  }

  apply(targetIndex: number, output: Float64Array, options: BarnesHutOptions): void {
    if (!this.root || targetIndex < 0 || targetIndex >= this.nodeCount) {
      return;
    }
    this.applyCell(this.root, targetIndex, true, output, options);
  }

  private insert(cell: OctreeCell, index: number, depth: number): void {
    if (!cell.children) {
      const indices = cell.indices ?? (cell.indices = []);
      if (indices.length === 0 || depth >= 20) {
        indices.push(index);
        return;
      }
      const existing = indices;
      delete cell.indices;
      cell.children = this.acquireChildrenArray();
      for (const previousIndex of existing) {
        this.insertIntoChild(cell, previousIndex, depth + 1);
      }
      existing.length = 0;
    }
    this.insertIntoChild(cell, index, depth + 1);
  }

  private insertIntoChild(cell: OctreeCell, index: number, depth: number): void {
    const childIndex = this.childIndexFor(cell, index);
    const children = cell.children ?? (cell.children = new Array<OctreeCell | undefined>(this.childCount()));
    let child = children[childIndex];
    if (!child) {
      const halfExtent = cell.halfExtent * 0.5;
      child = this.acquireCell({
        centerX: cell.centerX + ((childIndex & 1) !== 0 ? halfExtent : -halfExtent),
        centerY: cell.centerY + ((childIndex & 2) !== 0 ? halfExtent : -halfExtent),
        centerZ: cell.centerZ + ((childIndex & 4) !== 0 ? halfExtent : -halfExtent),
        halfExtent
      });
      child.indices = this.acquireIndexArray();
      children[childIndex] = child;
    }
    this.insert(child, index, depth);
  }

  private accumulate(cell: OctreeCell): void {
    let mass = 0;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    if (cell.children) {
      for (const child of cell.children) {
        if (!child) {
          continue;
        }
        this.accumulate(child);
        mass += child.mass;
        sumX += child.centerOfMassX * child.mass;
        sumY += child.centerOfMassY * child.mass;
        sumZ += child.centerOfMassZ * child.mass;
      }
    } else {
      for (const index of cell.indices ?? []) {
        const offset = index * 3;
        mass += 1;
        sumX += this.positions[offset] ?? 0;
        sumY += this.positions[offset + 1] ?? 0;
        sumZ += this.dimensions === 3 ? this.positions[offset + 2] ?? 0 : 0;
      }
    }
    cell.mass = mass;
    cell.centerOfMassX = mass === 0 ? cell.centerX : sumX / mass;
    cell.centerOfMassY = mass === 0 ? cell.centerY : sumY / mass;
    cell.centerOfMassZ = mass === 0 ? cell.centerZ : sumZ / mass;
  }

  private applyCell(
    cell: OctreeCell,
    targetIndex: number,
    containsTarget: boolean,
    output: Float64Array,
    options: BarnesHutOptions
  ): void {
    if (cell.mass === 0) {
      return;
    }
    if (!cell.children) {
      this.applyLeafMasses(cell.indices ?? [], targetIndex, output, options);
      return;
    }

    const targetOffset = targetIndex * 3;
    const dx = cell.centerOfMassX - (this.positions[targetOffset] ?? 0);
    const dy = cell.centerOfMassY - (this.positions[targetOffset + 1] ?? 0);
    const dz = this.dimensions === 3 ? cell.centerOfMassZ - (this.positions[targetOffset + 2] ?? 0) : 0;
    const distance = Math.hypot(dx, dy, dz);
    const cellSize = cell.halfExtent * 2;
    if (!containsTarget && distance > 0 && cellSize / distance < options.theta) {
      this.applyMass(targetIndex, -1, cell.mass, output, options, {
        x: cell.centerOfMassX,
        y: cell.centerOfMassY,
        z: cell.centerOfMassZ
      });
      return;
    }

    const targetChild = this.childIndexFor(cell, targetIndex);
    for (let childIndex = 0; childIndex < this.childCount(); childIndex += 1) {
      const child = cell.children[childIndex];
      if (child) {
        this.applyCell(child, targetIndex, containsTarget && childIndex === targetChild, output, options);
      }
    }
  }

  /**
   * A depth-capped collocated leaf can contain many nodes. Sample it at a
   * fixed deterministic budget so pathological overlap cannot become O(n^2).
   */
  private applyLeafMasses(
    indices: number[],
    targetIndex: number,
    output: Float64Array,
    options: BarnesHutOptions
  ): void {
    if (indices.length <= COLLOCATED_LEAF_INTERACTION_LIMIT) {
      for (const index of indices) {
        if (index !== targetIndex) {
          this.applyMass(targetIndex, index, 1, output, options);
        }
      }
      return;
    }
    const sampleMass = indices.length / COLLOCATED_LEAF_INTERACTION_LIMIT;
    for (let sample = 0; sample < COLLOCATED_LEAF_INTERACTION_LIMIT; sample += 1) {
      const index = indices[Math.floor(sample * indices.length / COLLOCATED_LEAF_INTERACTION_LIMIT)];
      if (index !== undefined && index !== targetIndex) {
        this.applyMass(targetIndex, index, sampleMass, output, options);
      }
    }
  }

  private applyMass(
    targetIndex: number,
    sourceIndex: number,
    sourceMass: number,
    output: Float64Array,
    options: BarnesHutOptions,
    explicitPosition?: { x: number; y: number; z: number }
  ): void {
    const targetOffset = targetIndex * 3;
    const sourceOffset = sourceIndex * 3;
    const sourceX = explicitPosition?.x ?? this.positions[sourceOffset] ?? 0;
    const sourceY = explicitPosition?.y ?? this.positions[sourceOffset + 1] ?? 0;
    const sourceZ = options.dimensions === 3 ? explicitPosition?.z ?? this.positions[sourceOffset + 2] ?? 0 : 0;
    let dx = sourceX - (this.positions[targetOffset] ?? 0);
    let dy = sourceY - (this.positions[targetOffset + 1] ?? 0);
    let dz = options.dimensions === 3 ? sourceZ - (this.positions[targetOffset + 2] ?? 0) : 0;
    if (sourceIndex >= 0 && Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12 && Math.abs(dz) < 1e-12) {
      const direction = deterministicPairDirection(targetIndex, sourceIndex, options.dimensions);
      dx = direction.x * 1e-3;
      dy = direction.y * 1e-3;
      dz = direction.z * 1e-3;
    }
    const distanceSquared = dx * dx + dy * dy + dz * dz + options.softening * options.softening;
    if (!Number.isFinite(distanceSquared) || distanceSquared <= 0) {
      return;
    }
    const magnitude = (options.strength * sourceMass) / distanceSquared;
    output[targetOffset] = (output[targetOffset] ?? 0) + dx * magnitude;
    output[targetOffset + 1] = (output[targetOffset + 1] ?? 0) + dy * magnitude;
    if (options.dimensions === 3) {
      output[targetOffset + 2] = (output[targetOffset + 2] ?? 0) + dz * magnitude;
    }
  }

  private childIndexFor(cell: OctreeCell, index: number): number {
    const offset = index * 3;
    const x = this.positions[offset] ?? 0;
    const y = this.positions[offset + 1] ?? 0;
    const z = this.dimensions === 3 ? this.positions[offset + 2] ?? 0 : 0;
    return (x >= cell.centerX ? 1 : 0)
      | (y >= cell.centerY ? 2 : 0)
      | (this.dimensions === 3 && z >= cell.centerZ ? 4 : 0);
  }

  private childCount(): number {
    return this.dimensions === 2 ? 4 : 8;
  }

  private acquireCell(values: Pick<OctreeCell, 'centerX' | 'centerY' | 'centerZ' | 'halfExtent'>): OctreeCell {
    const cell = this.cellPool[this.cellCursor] ?? {
      centerX: 0,
      centerY: 0,
      centerZ: 0,
      halfExtent: 0,
      mass: 0,
      centerOfMassX: 0,
      centerOfMassY: 0,
      centerOfMassZ: 0
    };
    this.cellPool[this.cellCursor] = cell;
    this.cellCursor += 1;
    cell.centerX = values.centerX;
    cell.centerY = values.centerY;
    cell.centerZ = values.centerZ;
    cell.halfExtent = values.halfExtent;
    cell.mass = 0;
    cell.centerOfMassX = 0;
    cell.centerOfMassY = 0;
    cell.centerOfMassZ = 0;
    delete cell.indices;
    delete cell.children;
    return cell;
  }

  private acquireIndexArray(): number[] {
    const indices = this.indexPool[this.indexCursor] ?? [];
    this.indexPool[this.indexCursor] = indices;
    this.indexCursor += 1;
    indices.length = 0;
    return indices;
  }

  private acquireChildrenArray(): Array<OctreeCell | undefined> {
    const children = this.childrenPool[this.childrenCursor] ?? new Array<OctreeCell | undefined>(8);
    this.childrenPool[this.childrenCursor] = children;
    this.childrenCursor += 1;
    for (let index = 0; index < children.length; index += 1) {
      children[index] = undefined;
    }
    return children;
  }
}
