const MAX_CELL_COORDINATE = Number.MAX_SAFE_INTEGER - 2;

export interface MinimumDistanceCursor {
  readonly node: number;
  readonly pairOffset: number;
}

export interface MinimumDistanceVisitResult {
  readonly pairChecks: number;
  readonly deferredPairCount: number;
  readonly budgetExhausted: boolean;
  readonly cursor: MinimumDistanceCursor;
}

/** Reusable spatial hash that emits each potentially overlapping pair once. */
export class MinimumDistanceIndex {
  private readonly buckets = new Map<string, number[]>();
  private readonly bucketPool: number[][] = [];
  private activeSweep: {
    readonly nodeCount: number;
    readonly dimensions: 2 | 3;
    readonly cellSize: number;
    readonly totalPairs: number;
    readonly cellX: Float64Array;
    readonly cellY: Float64Array;
    readonly cellZ: Float64Array;
    cursor: MinimumDistanceCursor;
    visitedPairs: number;
  } | undefined;

  forEachNearbyPair(
    positions: Float32Array,
    nodeCount: number,
    dimensions: 2 | 3,
    cellSize: number,
    visit: (first: number, second: number) => void
  ): number {
    return this.forEachNearbyPairBounded(
      positions,
      nodeCount,
      dimensions,
      cellSize,
      Number.MAX_SAFE_INTEGER,
      { node: 0, pairOffset: 0 },
      visit
    ).pairChecks;
  }

  forEachNearbyPairBounded(
    positions: Float32Array,
    nodeCount: number,
    dimensions: 2 | 3,
    cellSize: number,
    maximumPairChecks: number,
    cursor: MinimumDistanceCursor,
    visit: (first: number, second: number) => void
  ): MinimumDistanceVisitResult {
    const requestedCursor = normalizeCursor(cursor, nodeCount);
    if (!this.activeSweep || !this.matchesActiveSweep(nodeCount, dimensions, cellSize, requestedCursor)) {
      this.beginSweep(positions, nodeCount, dimensions, cellSize, requestedCursor);
    }
    const sweep = this.activeSweep!;
    const totalPairs = sweep.totalPairs;
    if (totalPairs === 0 || maximumPairChecks <= 0) {
      if (totalPairs === 0) this.resetSweep();
      return {
        pairChecks: 0,
        deferredPairCount: Math.max(0, totalPairs - sweep.visitedPairs),
        budgetExhausted: totalPairs > sweep.visitedPairs,
        cursor: totalPairs === 0 ? { node: 0, pairOffset: 0 } : sweep.cursor
      };
    }
    const start = sweep.cursor;
    let pairChecks = 0;
    for (let node = start.node; node < nodeCount; node += 1) {
      const x = sweep.cellX[node] ?? 0;
      const y = sweep.cellY[node] ?? 0;
      const z = sweep.cellZ[node] ?? 0;
      const skip = node === start.node ? start.pairOffset : 0;
      let nodePairOffset = 0;
      for (let dz = dimensions === 3 ? -1 : 0; dz <= (dimensions === 3 ? 1 : 0); dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const bucket = this.buckets.get(cellKey(x + dx, y + dy, z + dz)) ?? [];
            const eligible = lowerBound(bucket, node);
            for (let index = 0; index < eligible; index += 1) {
              if (nodePairOffset < skip) {
                nodePairOffset += 1;
                continue;
              }
              if (pairChecks >= maximumPairChecks) {
                sweep.cursor = { node, pairOffset: nodePairOffset };
                return {
                  pairChecks,
                  deferredPairCount: Math.max(0, totalPairs - sweep.visitedPairs),
                  budgetExhausted: true,
                  cursor: sweep.cursor
                };
              }
              visit(bucket[index] ?? 0, node);
              pairChecks += 1;
              sweep.visitedPairs += 1;
              nodePairOffset += 1;
            }
          }
        }
      }
      sweep.cursor = { node: node + 1, pairOffset: 0 };
    }
    this.resetSweep();
    return {
      pairChecks,
      deferredPairCount: 0,
      budgetExhausted: false,
      cursor: { node: 0, pairOffset: 0 }
    };
  }

  resetSweep(): void {
    this.activeSweep = undefined;
    this.resetBuckets();
  }

  private beginSweep(
    positions: Float32Array,
    nodeCount: number,
    dimensions: 2 | 3,
    cellSize: number,
    cursor: MinimumDistanceCursor
  ): void {
    this.resetBuckets();
    const cellX = new Float64Array(nodeCount);
    const cellY = new Float64Array(nodeCount);
    const cellZ = new Float64Array(nodeCount);
    for (let node = 0; node < nodeCount; node += 1) {
      const offset = node * 3;
      const x = cellCoordinate(positions[offset] ?? 0, cellSize);
      const y = cellCoordinate(positions[offset + 1] ?? 0, cellSize);
      const z = dimensions === 3 ? cellCoordinate(positions[offset + 2] ?? 0, cellSize) : 0;
      cellX[node] = x;
      cellY[node] = y;
      cellZ[node] = z;
      const key = cellKey(x, y, z);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = this.bucketPool.pop() ?? [];
        this.buckets.set(key, bucket);
      }
      bucket.push(node);
    }
    this.activeSweep = {
      nodeCount,
      dimensions,
      cellSize,
      totalPairs: this.countPairs(positions, nodeCount, dimensions, cellSize),
      cellX,
      cellY,
      cellZ,
      cursor,
      visitedPairs: this.countPairsBeforeCursor(positions, dimensions, cellSize, cursor)
    };
  }

  private matchesActiveSweep(
    nodeCount: number,
    dimensions: 2 | 3,
    cellSize: number,
    cursor: MinimumDistanceCursor
  ): boolean {
    const sweep = this.activeSweep;
    return sweep !== undefined
      && sweep.nodeCount === nodeCount
      && sweep.dimensions === dimensions
      && sweep.cellSize === cellSize
      && sweep.cursor.node === cursor.node
      && sweep.cursor.pairOffset === cursor.pairOffset;
  }

  private countPairsBeforeCursor(
    positions: Float32Array,
    dimensions: 2 | 3,
    cellSize: number,
    cursor: MinimumDistanceCursor
  ): number {
    let count = 0;
    for (let node = 0; node < cursor.node; node += 1) {
      count += this.countNodePairs(positions, node, dimensions, cellSize);
    }
    return count + cursor.pairOffset;
  }

  private countPairs(positions: Float32Array, nodeCount: number, dimensions: 2 | 3, cellSize: number): number {
    let count = 0;
    for (let node = 0; node < nodeCount; node += 1) {
      const offset = node * 3;
      const x = cellCoordinate(positions[offset] ?? 0, cellSize);
      const y = cellCoordinate(positions[offset + 1] ?? 0, cellSize);
      const z = dimensions === 3 ? cellCoordinate(positions[offset + 2] ?? 0, cellSize) : 0;
      for (let dz = dimensions === 3 ? -1 : 0; dz <= (dimensions === 3 ? 1 : 0); dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            count += lowerBound(this.buckets.get(cellKey(x + dx, y + dy, z + dz)) ?? [], node);
          }
        }
      }
    }
    return count;
  }

  private countNodePairs(positions: Float32Array, node: number, dimensions: 2 | 3, cellSize: number): number {
    const offset = node * 3;
    const x = cellCoordinate(positions[offset] ?? 0, cellSize);
    const y = cellCoordinate(positions[offset + 1] ?? 0, cellSize);
    const z = dimensions === 3 ? cellCoordinate(positions[offset + 2] ?? 0, cellSize) : 0;
    let count = 0;
    for (let dz = dimensions === 3 ? -1 : 0; dz <= (dimensions === 3 ? 1 : 0); dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          count += lowerBound(this.buckets.get(cellKey(x + dx, y + dy, z + dz)) ?? [], node);
        }
      }
    }
    return count;
  }

  private resetBuckets(): void {
    for (const bucket of this.buckets.values()) {
      bucket.length = 0;
      this.bucketPool.push(bucket);
    }
    this.buckets.clear();
  }
}

function normalizeCursor(cursor: MinimumDistanceCursor, nodeCount: number): MinimumDistanceCursor {
  if (nodeCount <= 0) return { node: 0, pairOffset: 0 };
  return {
    node: Number.isSafeInteger(cursor.node) ? Math.max(0, cursor.node % nodeCount) : 0,
    pairOffset: Number.isSafeInteger(cursor.pairOffset) ? Math.max(0, cursor.pairOffset) : 0
  };
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? 0) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function cellCoordinate(value: number, cellSize: number): number {
  const coordinate = Math.floor(value / cellSize);
  if (!Number.isFinite(coordinate)) {
    return value < 0 ? -MAX_CELL_COORDINATE : MAX_CELL_COORDINATE;
  }
  return Math.max(-MAX_CELL_COORDINATE, Math.min(MAX_CELL_COORDINATE, coordinate));
}

function cellKey(x: number, y: number, z: number): string {
  return `${x}:${y}:${z}`;
}
