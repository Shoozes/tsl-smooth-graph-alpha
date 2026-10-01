import { GraphError } from '../core/errors.js';
import type { GraphErrorCode } from '../core/errors.js';
import type { GraphId } from '../core/types.js';

/** A projected label rectangle in a single caller-owned screen coordinate space. */
export interface LabelScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A label candidate after the caller has projected its graph anchor into screen
 * coordinates. This module deliberately has no camera, Three, glyph, or DOM
 * dependency.
 */
export interface LabelCandidate {
  id: GraphId;
  bounds: Readonly<LabelScreenRect>;
  /** Higher priorities win overlap ties. Omitted values use zero. */
  priority?: number;
}

export interface LabelVisibilityOptions {
  /** Cull labels whose bounds do not intersect this screen-space rectangle. */
  viewport?: Readonly<LabelScreenRect>;
  /** Cull labels shorter than this screen-space pixel height. Defaults to zero. */
  minimumPixelHeight?: number;
  /** Required gap, in screen-space pixels, between two visible label bounds. */
  collisionPadding?: number;
  /** Maximum number of visible labels after culling and collision suppression. */
  maximumVisible?: number;
}

export type LabelVisibilityReason =
  | 'visible'
  | 'below-minimum-size'
  | 'outside-viewport'
  | 'collision'
  | 'maximum-visible';

/** A copied, immutable planner decision corresponding to one input candidate. */
export interface LabelVisibilityDecision {
  readonly id: GraphId;
  readonly bounds: Readonly<LabelScreenRect>;
  readonly priority: number;
  readonly visible: boolean;
  readonly reason: LabelVisibilityReason;
}

interface ValidCandidate {
  index: number;
  id: GraphId;
  idKey: string;
  bounds: LabelScreenRect;
  priority: number;
}

interface ResolvedOptions {
  viewport: LabelScreenRect | undefined;
  minimumPixelHeight: number;
  collisionPadding: number;
  maximumVisible: number;
}

const COLLISION_CELL_SIZE = 64;
const MAX_GRID_CELLS_PER_LABEL = 64;

interface CollisionGridRange {
  readonly minimumColumn: number;
  readonly maximumColumn: number;
  readonly minimumRow: number;
  readonly maximumRow: number;
  readonly cellCount: number;
}

interface CollisionGridRow {
  readonly columns: Map<number, ValidCandidate[]>;
  readonly sortedColumns: number[];
}

interface CollisionLevel {
  readonly cellSize: number;
  readonly grid: SparseCollisionGrid;
}

/**
 * Plans label visibility without mutating caller candidates. Selection is stable
 * across input ordering: higher priority wins, then the typed GraphId order.
 * Returned decisions preserve input order so render layers can map them back to
 * their own candidate storage.
 */
export function planLabelVisibility(
  candidates: readonly LabelCandidate[],
  options: LabelVisibilityOptions = {}
): readonly LabelVisibilityDecision[] {
  if (!Array.isArray(candidates)) {
    throw new GraphError('FG_LABEL_INVALID_CANDIDATE', 'Label candidates must be an array.');
  }
  const resolved = resolveOptions(options);
  const valid = candidates.map((candidate, index) => validateCandidate(candidate, index));
  const ids = new Set<string>();
  for (const candidate of valid) {
    if (ids.has(candidate.idKey)) {
      throw new GraphError('FG_LABEL_DUPLICATE_ID', `Duplicate label id '${String(candidate.id)}'.`, { id: candidate.id });
    }
    ids.add(candidate.idKey);
  }
  const reasons = new Array<LabelVisibilityReason>(valid.length);
  const eligible: ValidCandidate[] = [];

  for (const candidate of valid) {
    if (candidate.bounds.height < resolved.minimumPixelHeight) {
      reasons[candidate.index] = 'below-minimum-size';
    } else if (resolved.viewport && !rectanglesIntersect(candidate.bounds, resolved.viewport, 0)) {
      reasons[candidate.index] = 'outside-viewport';
    } else {
      eligible.push(candidate);
    }
  }

  eligible.sort(compareCandidates);
  const visible: ValidCandidate[] = [];
  const collisionIndex = new LabelCollisionIndex();
  for (const candidate of eligible) {
    if (collisionIndex.intersects(candidate, resolved.collisionPadding)) {
      reasons[candidate.index] = 'collision';
    } else if (visible.length >= resolved.maximumVisible) {
      reasons[candidate.index] = 'maximum-visible';
    } else {
      visible.push(candidate);
      collisionIndex.add(candidate);
      reasons[candidate.index] = 'visible';
    }
  }

  return Object.freeze(valid.map((candidate) => freezeDecision(candidate, reasons[candidate.index] ?? 'maximum-visible')));
}

/** Spatially narrows ordinary label collisions while retaining exact rectangle checks. */
class LabelCollisionIndex {
  private readonly levels = new Map<number, CollisionLevel>();

  add(candidate: ValidCandidate): void {
    const levelIndex = collisionLevelIndex(candidate.bounds);
    const level = this.level(levelIndex);
    const range = gridRange(candidate.bounds, 0, level.cellSize);
    if (!range) return;
    level.grid.add(range, candidate);
  }

  intersects(candidate: ValidCandidate, padding: number): boolean {
    const seen = new Set<number>();
    for (const level of this.levels.values()) {
      const range = gridRange(candidate.bounds, padding, level.cellSize);
      for (const accepted of level.grid.candidates(range)) {
        if (seen.has(accepted.index)) continue;
        seen.add(accepted.index);
        if (rectanglesIntersect(accepted.bounds, candidate.bounds, padding)) return true;
      }
    }
    return false;
  }

  private level(index: number): CollisionLevel {
    const existing = this.levels.get(index);
    if (existing) return existing;
    const level = {
      cellSize: scaledCollisionCellSize(index),
      grid: new SparseCollisionGrid()
    };
    this.levels.set(index, level);
    return level;
  }
}

/** Sparse row/column ordering avoids iterating empty cells for broad queries. */
class SparseCollisionGrid {
  private readonly rows = new Map<number, CollisionGridRow>();
  private readonly sortedRows: number[] = [];

  add(range: CollisionGridRange, candidate: ValidCandidate): void {
    for (let rowKey = range.minimumRow; rowKey <= range.maximumRow; rowKey += 1) {
      let row = this.rows.get(rowKey);
      if (!row) {
        row = { columns: new Map<number, ValidCandidate[]>(), sortedColumns: [] };
        this.rows.set(rowKey, row);
        insertSorted(this.sortedRows, rowKey);
      }
      for (let column = range.minimumColumn; column <= range.maximumColumn; column += 1) {
        const bucket = row.columns.get(column);
        if (bucket) bucket.push(candidate);
        else {
          row.columns.set(column, [candidate]);
          insertSorted(row.sortedColumns, column);
        }
      }
    }
  }

  *candidates(range: CollisionGridRange | undefined): IterableIterator<ValidCandidate> {
    const minimumRowIndex = range ? lowerBound(this.sortedRows, range.minimumRow) : 0;
    for (let rowIndex = minimumRowIndex; rowIndex < this.sortedRows.length; rowIndex += 1) {
      const rowKey = this.sortedRows[rowIndex]!;
      if (range && rowKey > range.maximumRow) break;
      const row = this.rows.get(rowKey)!;
      const minimumColumnIndex = range ? lowerBound(row.sortedColumns, range.minimumColumn) : 0;
      for (let columnIndex = minimumColumnIndex; columnIndex < row.sortedColumns.length; columnIndex += 1) {
        const column = row.sortedColumns[columnIndex]!;
        if (range && column > range.maximumColumn) break;
        yield* row.columns.get(column) ?? [];
      }
    }
  }
}

function collisionLevelIndex(bounds: LabelScreenRect): number {
  const estimated = Math.max(0, Math.floor(Math.log2(
    Math.max(bounds.width, bounds.height) / (COLLISION_CELL_SIZE * 4)
  )));
  let level = Number.isFinite(estimated) ? estimated : 0;
  while (level < 1_024) {
    const range = gridRange(bounds, 0, scaledCollisionCellSize(level));
    if (range && range.cellCount <= MAX_GRID_CELLS_PER_LABEL) return level;
    level += 1;
  }
  return 1_024;
}

function scaledCollisionCellSize(level: number): number {
  const size = COLLISION_CELL_SIZE * (2 ** level);
  return Number.isFinite(size) ? size : Number.MAX_VALUE;
}

function gridRange(bounds: LabelScreenRect, padding: number, cellSize: number): CollisionGridRange | undefined {
  const minimumColumn = Math.floor((bounds.x - padding) / cellSize);
  const maximumColumn = Math.floor((bounds.x + bounds.width + padding) / cellSize);
  const minimumRow = Math.floor((bounds.y - padding) / cellSize);
  const maximumRow = Math.floor((bounds.y + bounds.height + padding) / cellSize);
  const columnCount = maximumColumn - minimumColumn + 1;
  const rowCount = maximumRow - minimumRow + 1;
  const cellCount = columnCount * rowCount;
  if (![minimumColumn, maximumColumn, minimumRow, maximumRow, cellCount].every(Number.isSafeInteger)
    || columnCount < 1
    || rowCount < 1) {
    return undefined;
  }
  return { minimumColumn, maximumColumn, minimumRow, maximumRow, cellCount };
}

function insertSorted(values: number[], value: number): void {
  values.splice(lowerBound(values, value), 0, value);
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

function resolveOptions(options: LabelVisibilityOptions): ResolvedOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new GraphError('FG_LABEL_INVALID_OPTIONS', 'Label visibility options must be an object.');
  }
  const {
    minimumPixelHeight = 0,
    collisionPadding = 0,
    maximumVisible
  } = options;
  if (!isFiniteNonNegative(minimumPixelHeight)) {
    throw new GraphError('FG_LABEL_INVALID_OPTIONS', 'minimumPixelHeight must be a finite non-negative number.', { minimumPixelHeight });
  }
  if (!isFiniteNonNegative(collisionPadding)) {
    throw new GraphError('FG_LABEL_INVALID_OPTIONS', 'collisionPadding must be a finite non-negative number.', { collisionPadding });
  }
  if (maximumVisible !== undefined && (!Number.isInteger(maximumVisible) || maximumVisible < 0)) {
    throw new GraphError('FG_LABEL_INVALID_OPTIONS', 'maximumVisible must be a non-negative integer.', { maximumVisible });
  }
  return {
    viewport: options.viewport === undefined
      ? undefined
      : validateRect(options.viewport, 'viewport', 'FG_LABEL_INVALID_OPTIONS'),
    minimumPixelHeight,
    collisionPadding,
    maximumVisible: maximumVisible ?? Number.POSITIVE_INFINITY
  };
}

function validateCandidate(candidate: unknown, index: number): ValidCandidate {
  if (!isRecord(candidate) || Array.isArray(candidate)) {
    throw new GraphError('FG_LABEL_INVALID_CANDIDATE', `Label candidate at index ${index} must be an object.`, { index });
  }
  const id = candidate.id;
  if (!isGraphId(id)) {
    throw new GraphError('FG_LABEL_INVALID_CANDIDATE', `Label candidate at index ${index} requires a string or finite numeric id.`, { index });
  }
  const priority = candidate.priority === undefined ? 0 : candidate.priority;
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new GraphError('FG_LABEL_INVALID_CANDIDATE', `Label '${String(id)}' has a non-finite priority.`, { id, index });
  }
  const idKey = graphIdKey(id);
  return {
    index,
    id,
    idKey,
    bounds: validateRect(candidate.bounds, `label '${String(id)}' bounds`),
    priority
  };
}

function validateRect(
  value: unknown,
  label: string,
  code: GraphErrorCode = 'FG_LABEL_INVALID_CANDIDATE'
): LabelScreenRect {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new GraphError(code, `${label} must be a rectangle object.`);
  }
  const { x, y, width, height } = value;
  if (
    typeof x !== 'number' || !Number.isFinite(x)
    || typeof y !== 'number' || !Number.isFinite(y)
    || typeof width !== 'number' || !Number.isFinite(width) || width <= 0
    || typeof height !== 'number' || !Number.isFinite(height) || height <= 0
    || !Number.isFinite(x + width)
    || !Number.isFinite(y + height)
  ) {
    throw new GraphError(code, `${label} must have finite x/y and positive finite width/height.`, { label });
  }
  return { x, y, width, height };
}

function compareCandidates(first: ValidCandidate, second: ValidCandidate): number {
  if (first.priority !== second.priority) {
    return first.priority > second.priority ? -1 : 1;
  }
  return first.idKey < second.idKey ? -1 : first.idKey > second.idKey ? 1 : 0;
}

function rectanglesIntersect(first: LabelScreenRect, second: LabelScreenRect, padding: number): boolean {
  return first.x < second.x + second.width + padding
    && first.x + first.width + padding > second.x
    && first.y < second.y + second.height + padding
    && first.y + first.height + padding > second.y;
}

function freezeDecision(candidate: ValidCandidate, reason: LabelVisibilityReason): LabelVisibilityDecision {
  return Object.freeze({
    id: candidate.id,
    bounds: Object.freeze({ ...candidate.bounds }),
    priority: candidate.priority,
    visible: reason === 'visible',
    reason
  });
}

function graphIdKey(id: GraphId): string {
  return `${typeof id}:${String(id)}`;
}

function isGraphId(value: unknown): value is GraphId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
