import { GraphError } from '../core/errors.js';
import type { Vec3 } from '../core/types.js';
import { supportsThreePositionAtlas } from '../platform/three/ThreeCapabilities.js';

export type PositionAtlasThreeObject = Record<string, unknown>;

export interface PositionAtlasResources {
  readonly texture: PositionAtlasThreeObject;
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly capacity: number;
}

export const DEFAULT_POSITION_ATLAS_MAX_HEIGHT = 4096;
export const DEFAULT_POSITION_ATLAS_WIDTH = 1024;
export const POSITION_ATLAS_ENTRY_BYTES = 4 * Float32Array.BYTES_PER_ELEMENT;

/** Owns the texture-backed TSL position transport and its allocation limits. */
export function createPositionAtlas(
  three: PositionAtlasThreeObject,
  capacity: number,
  maxHeight: number,
  width = DEFAULT_POSITION_ATLAS_WIDTH
): PositionAtlasResources | undefined {
  const DataTexture = asConstructor(three.DataTexture);
  if (!DataTexture || !supportsThreePositionAtlas(three)) {
    return undefined;
  }
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new GraphError('FG_RENDER_CAPACITY_EXCEEDED', 'The position-atlas width must be a positive safe integer.', { width });
  }
  const normalizedCapacity = Math.max(1, capacity);
  const height = Math.max(1, Math.ceil(normalizedCapacity / width));
  if (!Number.isSafeInteger(maxHeight) || maxHeight < 1 || height > maxHeight) {
    throw new GraphError('FG_RENDER_CAPACITY_EXCEEDED', `The graph requires ${height} position-atlas rows, exceeding the configured limit of ${maxHeight}.`, { capacity: normalizedCapacity, width, requiredHeight: height, maxHeight });
  }
  const elementCount = width * height * 4;
  if (!Number.isSafeInteger(elementCount)) {
    throw new GraphError('FG_RENDER_CAPACITY_EXCEEDED', 'The requested position atlas exceeds the supported typed-array size.', { capacity: normalizedCapacity, width, height });
  }
  const data = new Float32Array(elementCount);
  let texture: PositionAtlasThreeObject | undefined;
  try {
    texture = new DataTexture(data, width, height, three.RGBAFormat, three.FloatType) as PositionAtlasThreeObject;
    texture.minFilter = three.NearestFilter;
    texture.magFilter = three.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    if (three.NoColorSpace !== undefined) texture.colorSpace = three.NoColorSpace;
    return { texture, data, width, height, capacity: width * height };
  } catch {
    disposePositionAtlas(texture ? { texture, data, width, height, capacity: width * height } : undefined);
    return undefined;
  }
}

export function writePositionAtlas(atlas: PositionAtlasResources | undefined, instance: number, position: Vec3): void {
  if (!atlas || instance < 0 || instance >= atlas.capacity) return;
  const offset = instance * 4;
  atlas.data[offset] = position.x;
  atlas.data[offset + 1] = position.y;
  atlas.data[offset + 2] = position.z;
  atlas.data[offset + 3] = 1;
}

export function disposePositionAtlas(atlas: PositionAtlasResources | undefined): void {
  if (atlas) call(atlas.texture, 'dispose');
}

function asConstructor(value: unknown): (new (...args: unknown[]) => object) | undefined {
  return typeof value === 'function' ? value as new (...args: unknown[]) => object : undefined;
}

function call(target: PositionAtlasThreeObject, method: string): void {
  const value = target[method];
  if (typeof value === 'function') value.call(target);
}
