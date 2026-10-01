import { GraphError } from '../core/errors.js';
import type { GraphBounds, Vec3 } from '../core/types.js';

export interface PerspectiveCameraFrameOptions {
  /** Width divided by height of the target viewport. */
  aspect: number;
  /** Vertical field of view in degrees. */
  verticalFovDegrees: number;
  /** Unit direction from the graph target toward the recommended camera position. */
  direction?: Readonly<Vec3>;
  /** Multiplicative projected-bounds margin. Defaults to 1.1. */
  padding?: number;
  /** Lower bound for zero-size or very small graphs. Defaults to 1. */
  minimumDistance?: number;
}

/** A pure recommendation that an application may apply or animate itself. */
export interface PerspectiveCameraFrame {
  readonly target: Readonly<Vec3>;
  readonly position: Readonly<Vec3>;
  readonly distance: number;
  readonly radius: number;
}

/** Options for framing an individual node or other bounded world. */
export interface PerspectiveCameraFocusOptions extends PerspectiveCameraFrameOptions {}

/**
 * Frames the complete graph bounds with the limiting horizontal or vertical
 * field of view. This utility never reads or mutates a Three camera or control.
 */
export function planPerspectiveCameraFrame(
  bounds: GraphBounds,
  options: PerspectiveCameraFrameOptions
): PerspectiveCameraFrame {
  const validatedBounds = validateBounds(bounds);
  const resolved = resolveOptions(options);
  const target = {
    x: (validatedBounds.min.x + validatedBounds.max.x) / 2,
    y: (validatedBounds.min.y + validatedBounds.max.y) / 2,
    z: (validatedBounds.min.z + validatedBounds.max.z) / 2
  };
  const width = validatedBounds.max.x - validatedBounds.min.x;
  const height = validatedBounds.max.y - validatedBounds.min.y;
  const depth = validatedBounds.max.z - validatedBounds.min.z;
  const radius = Math.hypot(width, height, depth) / 2;
  // Fit the projected bounds instead of always fitting their enclosing sphere.
  // This matters on panoramic/mobile viewports and for thin graph volumes: the
  // sphere is safe, but can leave a large amount of unused camera space.
  const projectedDistance = projectBoundsDistance(validatedBounds, target, resolved, radius);
  return createFrame(target, radius, resolved, projectedDistance);
}

/**
 * Plans a close perspective frame around one finite world-space point. The
 * radius is the visible world's extent, such as a node's resolved visual radius.
 */
export function planPerspectiveCameraFocus(
  target: Readonly<Vec3>,
  radius: number,
  options: PerspectiveCameraFocusOptions
): PerspectiveCameraFrame {
  if (!isFiniteVec3(target)) {
    throw new GraphError('FG_CAMERA_INVALID_BOUNDS', 'Camera focus requires a finite target vector.');
  }
  if (!Number.isFinite(radius) || radius < 0) {
    throw new GraphError('FG_CAMERA_INVALID_BOUNDS', 'Camera focus radius must be a finite non-negative number.', { radius });
  }
  return createFrame({ ...target }, radius, resolveOptions(options));
}

function createFrame(
  target: Vec3,
  radius: number,
  resolved: ResolvedOptions,
  fittedDistanceOverride?: number
): PerspectiveCameraFrame {
  const verticalHalfAngle = degreesToRadians(resolved.verticalFovDegrees) / 2;
  const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * resolved.aspect);
  const limitingHalfAngle = Math.min(verticalHalfAngle, horizontalHalfAngle);
  const fittedDistance = fittedDistanceOverride ?? (radius === 0 ? 0 : radius / Math.sin(limitingHalfAngle));
  const distance = Math.max(resolved.minimumDistance, fittedDistance * resolved.padding);
  const position = {
    x: target.x + resolved.direction.x * distance,
    y: target.y + resolved.direction.y * distance,
    z: target.z + resolved.direction.z * distance
  };
  return Object.freeze({
    target: Object.freeze(target),
    position: Object.freeze(position),
    distance,
    radius
  });
}

function projectBoundsDistance(
  bounds: ValidatedBounds,
  target: Vec3,
  resolved: ResolvedOptions,
  radius: number
): number {
  const verticalTangent = Math.tan(degreesToRadians(resolved.verticalFovDegrees) / 2);
  const horizontalTangent = verticalTangent * resolved.aspect;
  // Project against the host's conventional world-Y camera orientation.
  const worldUp = { x: 0, y: 1, z: 0 };
  const yCross = cross(worldUp, resolved.direction);
  // Three's lookAt applies a small pole perturbation; use the conservative
  // sphere fit for near-pole directions where its roll is implementation-defined.
  if (Math.hypot(yCross.x, yCross.y, yCross.z) <= 0.01) {
    const verticalHalfAngle = degreesToRadians(resolved.verticalFovDegrees) / 2;
    const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * resolved.aspect);
    return radius === 0 ? 0 : radius / Math.sin(Math.min(verticalHalfAngle, horizontalHalfAngle));
  }
  const right = normalize(yCross);
  const up = cross(resolved.direction, right);
  let requiredDistance = 0;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const point = { x: x - target.x, y: y - target.y, z: z - target.z };
        const depth = dot(point, resolved.direction);
        const horizontal = Math.abs(dot(point, right)) / horizontalTangent;
        const vertical = Math.abs(dot(point, up)) / verticalTangent;
        requiredDistance = Math.max(requiredDistance, depth + horizontal, depth + vertical);
      }
    }
  }
  return Math.max(0, requiredDistance);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value.x, value.y, value.z);
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

interface ValidatedBounds {
  min: Vec3;
  max: Vec3;
}

interface ResolvedOptions {
  aspect: number;
  verticalFovDegrees: number;
  direction: Vec3;
  padding: number;
  minimumDistance: number;
}

function validateBounds(bounds: GraphBounds): ValidatedBounds {
  if (!isRecord(bounds) || !isFiniteVec3(bounds.min) || !isFiniteVec3(bounds.max)) {
    throw new GraphError('FG_CAMERA_INVALID_BOUNDS', 'Camera framing requires finite min/max graph bounds.');
  }
  if (
    bounds.min.x > bounds.max.x
    || bounds.min.y > bounds.max.y
    || bounds.min.z > bounds.max.z
  ) {
    throw new GraphError('FG_CAMERA_INVALID_BOUNDS', 'Graph bounds must have min values less than or equal to max values.');
  }
  return {
    min: { ...bounds.min },
    max: { ...bounds.max }
  };
}

function resolveOptions(options: PerspectiveCameraFrameOptions): ResolvedOptions {
  if (!isRecord(options) || Array.isArray(options)) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'Perspective camera frame options must be an object.');
  }
  const { aspect, verticalFovDegrees, padding = 1.1, minimumDistance = 1 } = options;
  if (typeof aspect !== 'number' || !Number.isFinite(aspect) || aspect <= 0) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'aspect must be a finite positive number.', { aspect });
  }
  if (
    typeof verticalFovDegrees !== 'number'
    || !Number.isFinite(verticalFovDegrees)
    || verticalFovDegrees <= 0
    || verticalFovDegrees >= 180
  ) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'verticalFovDegrees must be greater than zero and less than 180.', { verticalFovDegrees });
  }
  if (typeof padding !== 'number' || !Number.isFinite(padding) || padding < 1) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'padding must be a finite number greater than or equal to one.', { padding });
  }
  if (typeof minimumDistance !== 'number' || !Number.isFinite(minimumDistance) || minimumDistance < 0) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'minimumDistance must be a finite non-negative number.', { minimumDistance });
  }
  return {
    aspect,
    verticalFovDegrees,
    direction: normalizeDirection(options.direction ?? { x: 0, y: 0, z: 1 }),
    padding,
    minimumDistance
  };
}

function normalizeDirection(value: Readonly<Vec3>): Vec3 {
  if (!isFiniteVec3(value)) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'direction must contain finite x, y, and z values.');
  }
  const length = Math.hypot(value.x, value.y, value.z);
  if (length === 0) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'direction must not be the zero vector.');
  }
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function isFiniteVec3(value: unknown): value is Vec3 {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && typeof value.z === 'number' && Number.isFinite(value.z);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}
