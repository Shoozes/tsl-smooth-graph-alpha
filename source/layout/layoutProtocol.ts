import { GraphError } from '../core/errors.js';
import type { LayoutInput, LayoutSnapshot } from '../core/types.js';

/** Validates the typed-array contract shared by local and worker layout paths. */
export function assertValidLayoutInput(input: LayoutInput): void {
  if (!isValidLayoutInput(input)) {
    throw new GraphError(
      'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
      'Layout input must contain complete, unique node buffers and valid link endpoints.'
    );
  }
}

export function isValidLayoutInput(value: unknown): value is LayoutInput {
  if (!isRecord(value)
    || !(value.nodeIndices instanceof Uint32Array)
    || !(value.positions instanceof Float32Array)
    || !(value.velocities instanceof Float32Array)
    || !(value.fixedMask instanceof Uint8Array)
    || !(value.fixedPositions instanceof Float32Array)
    || !(value.links instanceof Uint32Array)) {
    return false;
  }

  const nodeCount = value.nodeIndices.length;
  return value.positions.length === nodeCount * 3
    && value.velocities.length === nodeCount * 3
    && value.fixedMask.length === nodeCount
    && value.fixedPositions.length === nodeCount * 3
    && hasFiniteValues(value.positions)
    && hasFiniteValues(value.velocities)
    && hasFiniteValues(value.fixedPositions)
    && hasValidFixedMasks(value.fixedMask)
    && hasUniqueNodeIndices(value.nodeIndices)
    && hasValidLinkEndpoints(value.links, nodeCount);
}

export function isValidLayoutSnapshot(value: unknown): value is LayoutSnapshot {
  return isRecord(value)
    && value.nodeIndices instanceof Uint32Array
    && value.positions instanceof Float32Array
    && value.velocities instanceof Float32Array
    && isFiniteNumber(value.alpha)
    && typeof value.settled === 'boolean'
    && value.positions.length === value.nodeIndices.length * 3
    && value.velocities.length === value.nodeIndices.length * 3
    && hasFiniteValues(value.positions)
    && hasFiniteValues(value.velocities)
    && hasUniqueNodeIndices(value.nodeIndices);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function hasUniqueNodeIndices(nodeIndices: Uint32Array): boolean {
  const seen = new Set<number>();
  for (const nodeIndex of nodeIndices) {
    if (seen.has(nodeIndex)) {
      return false;
    }
    seen.add(nodeIndex);
  }
  return true;
}

function hasValidLinkEndpoints(links: Uint32Array, nodeCount: number): boolean {
  if (links.length % 2 !== 0) {
    return false;
  }
  for (const endpoint of links) {
    if (endpoint >= nodeCount) {
      return false;
    }
  }
  return true;
}

function hasValidFixedMasks(masks: Uint8Array): boolean {
  return masks.every((mask) => (mask & ~0b111) === 0);
}

function hasFiniteValues(values: Float32Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      return false;
    }
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
