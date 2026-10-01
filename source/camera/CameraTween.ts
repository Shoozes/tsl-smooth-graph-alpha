import { GraphError } from '../core/errors.js';
import type { CameraPose, Vec3 } from '../core/types.js';

/** Built-in time curves for host-owned camera transitions. */
export type CameraTweenEasing = 'linear' | 'smoothstep' | 'cubic-in-out';

/** Position path for a camera tween. Arc offsets peak at the transition midpoint. */
export type CameraTweenPath =
  | { readonly type: 'direct' }
  | { readonly type: 'arc'; readonly offset: Readonly<Vec3> };

/** Immutable inputs for a pure camera-pose sample. */
export interface CameraPoseTweenOptions {
  readonly from: CameraPose;
  readonly to: CameraPose;
  /** Non-negative transition length. Zero produces the destination immediately. */
  readonly durationMs: number;
  readonly easing?: CameraTweenEasing;
  /** Direct by default; arc offsets let hosts add cinematic lift or orbit motion. */
  readonly path?: CameraTweenPath;
}

/** A sampled pose that a managed or embedded host may apply to its own camera. */
export interface CameraPoseTweenSample extends CameraPose {
  readonly progress: number;
  readonly complete: boolean;
}

/**
 * Samples a deterministic camera transition without scheduling work or
 * mutating a Three camera. Hosts own timing, cancellation, and camera control.
 */
export function sampleCameraPoseTween(
  options: CameraPoseTweenOptions,
  elapsedMs: number
): CameraPoseTweenSample {
  const resolved = resolveOptions(options);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'elapsedMs must be a finite non-negative number.', { elapsedMs });
  }
  const progress = resolved.durationMs === 0 ? 1 : Math.min(1, elapsedMs / resolved.durationMs);
  const amount = ease(progress, resolved.easing);
  const arcAmount = progress === 0 || progress === 1 || resolved.path.type === 'direct'
    ? 0
    : Math.sin(Math.PI * amount);
  const position = interpolateVec3(resolved.from.position, resolved.to.position, amount);
  if (resolved.path.type === 'arc') {
    position.x += resolved.path.offset.x * arcAmount;
    position.y += resolved.path.offset.y * arcAmount;
    position.z += resolved.path.offset.z * arcAmount;
  }
  return Object.freeze({
    position: Object.freeze(position),
    target: Object.freeze(interpolateVec3(resolved.from.target, resolved.to.target, amount)),
    progress,
    complete: progress === 1
  });
}

interface ResolvedCameraPoseTweenOptions {
  readonly from: CameraPose;
  readonly to: CameraPose;
  readonly durationMs: number;
  readonly easing: CameraTweenEasing;
  readonly path: CameraTweenPath;
}

function resolveOptions(options: CameraPoseTweenOptions): ResolvedCameraPoseTweenOptions {
  if (!isRecord(options) || Array.isArray(options)) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'Camera tween options must be an object.');
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs < 0) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'durationMs must be a finite non-negative number.', { durationMs: options.durationMs });
  }
  const easing = options.easing ?? 'cubic-in-out';
  if (easing !== 'linear' && easing !== 'smoothstep' && easing !== 'cubic-in-out') {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'easing must be linear, smoothstep, or cubic-in-out.', { easing });
  }
  const path = copyPath(options.path);
  return Object.freeze({
    from: copyPose(options.from, 'from'),
    to: copyPose(options.to, 'to'),
    durationMs: options.durationMs,
    easing,
    path
  });
}

function copyPath(value: CameraTweenPath | undefined): CameraTweenPath {
  if (value === undefined || (isRecord(value) && value.type === 'direct')) {
    return Object.freeze({ type: 'direct' });
  }
  if (isRecord(value) && value.type === 'arc' && isFiniteVec3(value.offset)) {
    return Object.freeze({ type: 'arc', offset: Object.freeze({ ...value.offset }) });
  }
  throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'path must be direct or an arc with a finite offset vector.', { path: value });
}

function copyPose(value: CameraPose, label: string): CameraPose {
  if (!isRecord(value) || !isFiniteVec3(value.position) || !isFiniteVec3(value.target)) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', `${label} must contain finite position and target vectors.`);
  }
  return Object.freeze({
    position: Object.freeze({ ...value.position }),
    target: Object.freeze({ ...value.target })
  });
}

function ease(progress: number, easing: CameraTweenEasing): number {
  if (easing === 'linear') return progress;
  if (easing === 'smoothstep') return progress * progress * (3 - 2 * progress);
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - ((-2 * progress + 2) ** 3) / 2;
}

function interpolateVec3(from: Readonly<Vec3>, to: Readonly<Vec3>, amount: number): Vec3 {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    z: from.z + (to.z - from.z) * amount
  };
}

function isFiniteVec3(value: unknown): value is Vec3 {
  return isRecord(value)
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && typeof value.z === 'number' && Number.isFinite(value.z);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
