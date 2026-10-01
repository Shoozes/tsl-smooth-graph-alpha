import type { Vec3 } from '../core/types.js';

export interface PickingViewport {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PickingCameraMatrices {
  readonly view: ArrayLike<number>;
  readonly projection: ArrayLike<number>;
}

export interface SpatialPickResult {
  readonly instance: number | undefined;
  readonly candidateCount: number;
  readonly scannedCellCount: number;
  readonly ordinaryCandidateCount: number;
  readonly oversizedCandidateCount: number;
  readonly rebuilt: boolean;
}

interface ProjectedNode {
  readonly instance: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly depth: number;
}

interface PickingLevel {
  readonly cellSize: number;
  readonly buckets: Map<string, ProjectedNode[]>;
}

/**
 * Rebuilds only on picking/camera/viewport revisions and limits a hover pick
 * to nearby projected billboards. It intentionally owns no Three or graph state.
 */
export class SpatialPickingIndex {
  private readonly levels = new Map<number, PickingLevel>();
  private readonly levelIndexes: number[] = [];
  private revisionKey = '';
  private lastCandidateCountValue = 0;
  private lastScannedCellCountValue = 0;
  private lastOrdinaryCandidateCountValue = 0;
  private lastOversizedCandidateCountValue = 0;
  private readonly cellSize: number;

  constructor(cellSize = 48) {
    this.cellSize = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 48;
  }

  query(
    localX: number,
    localY: number,
    positions: readonly (Vec3 | undefined)[],
    radii: readonly number[],
    pickable: readonly boolean[],
    camera: PickingCameraMatrices,
    viewport: PickingViewport,
    pickingRevision: number,
    cameraRevision: number
  ): SpatialPickResult {
    if (!validViewport(viewport)
      || !Number.isFinite(localX)
      || !Number.isFinite(localY)
      || localX < 0
      || localY < 0
      || localX >= viewport.width
      || localY >= viewport.height) {
      this.recordWork(0, 0, 0);
      return {
        instance: undefined,
        candidateCount: 0,
        scannedCellCount: 0,
        ordinaryCandidateCount: 0,
        oversizedCandidateCount: 0,
        rebuilt: false
      };
    }
    const revisionKey = `${pickingRevision}:${cameraRevision}:${viewport.width}:${viewport.height}:${viewport.left}:${viewport.top}`;
    const rebuilt = revisionKey !== this.revisionKey;
    if (rebuilt) {
      this.rebuild(positions, radii, pickable, camera, viewport, revisionKey);
    }
    let ordinaryCandidateCount = 0;
    let oversizedCandidateCount = 0;
    let selected: ProjectedNode | undefined;
    for (const levelIndex of this.levelIndexes) {
      const level = this.levels.get(levelIndex)!;
      const candidates = level.buckets.get(cellKey(
        Math.floor(localX / level.cellSize),
        Math.floor(localY / level.cellSize)
      )) ?? [];
      if (levelIndex === 0) ordinaryCandidateCount += candidates.length;
      else oversizedCandidateCount += candidates.length;
      for (const candidate of candidates) {
        if (contains(candidate, localX, localY) && (!selected || candidate.depth < selected.depth)) {
          selected = candidate;
        }
      }
    }
    const candidateCount = ordinaryCandidateCount + oversizedCandidateCount;
    this.recordWork(this.levelIndexes.length, ordinaryCandidateCount, oversizedCandidateCount);
    return {
      instance: selected?.instance,
      candidateCount,
      scannedCellCount: this.levelIndexes.length,
      ordinaryCandidateCount,
      oversizedCandidateCount,
      rebuilt
    };
  }

  get lastCandidateCount(): number {
    return this.lastCandidateCountValue;
  }

  get lastScannedCellCount(): number {
    return this.lastScannedCellCountValue;
  }

  get lastOrdinaryCandidateCount(): number {
    return this.lastOrdinaryCandidateCountValue;
  }

  get lastOversizedCandidateCount(): number {
    return this.lastOversizedCandidateCountValue;
  }

  private rebuild(
    positions: readonly (Vec3 | undefined)[],
    radii: readonly number[],
    pickable: readonly boolean[],
    camera: PickingCameraMatrices,
    viewport: PickingViewport,
    revisionKey: string
  ): void {
    this.levels.clear();
    this.levelIndexes.length = 0;
    this.revisionKey = revisionKey;
    const columnCount = Math.max(1, Math.ceil(viewport.width / this.cellSize));
    const rowCount = Math.max(1, Math.ceil(viewport.height / this.cellSize));
    for (let instance = 0; instance < positions.length; instance += 1) {
      const position = positions[instance];
      const radius = radii[instance] ?? 0;
      if (!position || pickable[instance] !== true || !Number.isFinite(radius) || radius <= 0) {
        continue;
      }
      const center = project(position, camera, viewport);
      if (!center) {
        continue;
      }
      const right = project(projectOffset(position, radius, camera.view, 0), camera, viewport);
      const up = project(projectOffset(position, radius, camera.view, 1), camera, viewport);
      const projectedRadii = [right, up]
        .filter((point): point is NonNullable<typeof point> => point !== undefined)
        .map((point) => Math.hypot(point.x - center.x, point.y - center.y))
        .filter(Number.isFinite);
      if (projectedRadii.length === 0) {
        continue;
      }
      const screenRadius = Math.max(1, ...projectedRadii);
      if (!Number.isFinite(screenRadius)
        || !Number.isFinite(center.depth)
        || !circleIntersectsViewport(center.x, center.y, screenRadius, viewport)) {
        continue;
      }
      const candidate: ProjectedNode = { instance, x: center.x, y: center.y, radius: screenRadius, depth: center.depth };
      const levelIndex = pickingLevelIndex(screenRadius, this.cellSize, viewport);
      const level = this.ensureLevel(levelIndex);
      const levelColumnCount = levelIndex === 0 ? columnCount : Math.max(1, Math.ceil(viewport.width / level.cellSize));
      const levelRowCount = levelIndex === 0 ? rowCount : Math.max(1, Math.ceil(viewport.height / level.cellSize));
      const minimumColumn = clampCell(Math.floor((center.x - screenRadius) / level.cellSize), levelColumnCount);
      const maximumColumn = clampCell(Math.floor((center.x + screenRadius) / level.cellSize), levelColumnCount);
      const minimumRow = clampCell(Math.floor((center.y - screenRadius) / level.cellSize), levelRowCount);
      const maximumRow = clampCell(Math.floor((center.y + screenRadius) / level.cellSize), levelRowCount);
      for (let row = minimumRow; row <= maximumRow; row += 1) {
        for (let column = minimumColumn; column <= maximumColumn; column += 1) {
          const key = cellKey(column, row);
          const bucket = level.buckets.get(key);
          if (bucket) bucket.push(candidate);
          else level.buckets.set(key, [candidate]);
        }
      }
    }
  }

  private ensureLevel(index: number): PickingLevel {
    const existing = this.levels.get(index);
    if (existing) return existing;
    const scaledCellSize = this.cellSize * (2 ** index);
    const level = {
      cellSize: Number.isFinite(scaledCellSize) ? scaledCellSize : Number.MAX_VALUE,
      buckets: new Map<string, ProjectedNode[]>()
    };
    this.levels.set(index, level);
    this.levelIndexes.splice(lowerBound(this.levelIndexes, index), 0, index);
    return level;
  }

  private recordWork(scannedCells: number, ordinaryCandidates: number, oversizedCandidates: number): void {
    this.lastScannedCellCountValue = scannedCells;
    this.lastOrdinaryCandidateCountValue = ordinaryCandidates;
    this.lastOversizedCandidateCountValue = oversizedCandidates;
    this.lastCandidateCountValue = ordinaryCandidates + oversizedCandidates;
  }
}

function pickingLevelIndex(radius: number, baseCellSize: number, viewport: PickingViewport): number {
  const radiusLevel = radius <= baseCellSize
    ? 0
    : Math.ceil(Math.log2(radius / baseCellSize));
  const viewportLevel = Math.max(0, Math.ceil(Math.log2(
    Math.max(viewport.width, viewport.height) / baseCellSize
  )));
  return Math.min(radiusLevel, viewportLevel);
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function contains(candidate: ProjectedNode, x: number, y: number): boolean {
  const dx = x - candidate.x;
  const dy = y - candidate.y;
  return dx * dx + dy * dy <= candidate.radius * candidate.radius;
}

function validViewport(viewport: PickingViewport): boolean {
  return Number.isFinite(viewport.left)
    && Number.isFinite(viewport.top)
    && Number.isFinite(viewport.width)
    && Number.isFinite(viewport.height)
    && viewport.width > 0
    && viewport.height > 0;
}

function circleIntersectsViewport(x: number, y: number, radius: number, viewport: PickingViewport): boolean {
  return x + radius >= 0
    && x - radius <= viewport.width
    && y + radius >= 0
    && y - radius <= viewport.height;
}

function clampCell(value: number, count: number): number {
  return Math.min(count - 1, Math.max(0, value));
}

/** Projects an offset along a camera-facing billboard axis expressed in world space. */
function projectOffset(position: Vec3, radius: number, view: ArrayLike<number>, cameraAxisRow: 0 | 1): Vec3 {
  const offset = cameraAxisRow === 0
    ? { x: value(view, 0) * radius, y: value(view, 4) * radius, z: value(view, 8) * radius }
    : { x: value(view, 1) * radius, y: value(view, 5) * radius, z: value(view, 9) * radius };
  return {
    x: position.x + offset.x,
    y: position.y + offset.y,
    z: position.z + offset.z
  };
}

function project(position: Vec3, camera: PickingCameraMatrices, viewport: PickingViewport): { x: number; y: number; depth: number } | undefined {
  const view = camera.view;
  const projection = camera.projection;
  if (view.length < 16 || projection.length < 16 || viewport.width <= 0 || viewport.height <= 0) {
    return undefined;
  }
  const viewX = value(view, 0) * position.x + value(view, 4) * position.y + value(view, 8) * position.z + value(view, 12);
  const viewY = value(view, 1) * position.x + value(view, 5) * position.y + value(view, 9) * position.z + value(view, 13);
  const viewZ = value(view, 2) * position.x + value(view, 6) * position.y + value(view, 10) * position.z + value(view, 14);
  const viewW = value(view, 3) * position.x + value(view, 7) * position.y + value(view, 11) * position.z + value(view, 15);
  const clipX = value(projection, 0) * viewX + value(projection, 4) * viewY + value(projection, 8) * viewZ + value(projection, 12) * viewW;
  const clipY = value(projection, 1) * viewX + value(projection, 5) * viewY + value(projection, 9) * viewZ + value(projection, 13) * viewW;
  const clipZ = value(projection, 2) * viewX + value(projection, 6) * viewY + value(projection, 10) * viewZ + value(projection, 14) * viewW;
  const clipW = value(projection, 3) * viewX + value(projection, 7) * viewY + value(projection, 11) * viewZ + value(projection, 15) * viewW;
  if (!Number.isFinite(clipX) || !Number.isFinite(clipY) || !Number.isFinite(clipZ) || !Number.isFinite(clipW) || clipW <= 0) {
    return undefined;
  }
  const inverseW = 1 / clipW;
  const x = (clipX * inverseW * 0.5 + 0.5) * viewport.width;
  const y = (-clipY * inverseW * 0.5 + 0.5) * viewport.height;
  const depth = clipZ * inverseW;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(depth) ? { x, y, depth } : undefined;
}

function value(matrix: ArrayLike<number>, index: number): number {
  const entry = matrix[index];
  return typeof entry === 'number' && Number.isFinite(entry) ? entry : Number.NaN;
}

function cellKey(column: number, row: number): string {
  return `${column}:${row}`;
}
