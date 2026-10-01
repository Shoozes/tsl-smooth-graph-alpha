import { sampleCameraPoseTween } from '../../../dist/camera/index.js';

export function createCameraAnimator(options) {
  let frame;
  let token = 0;
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;

  const cancel = () => {
    token += 1;
    cancelFrame(frame);
    frame = undefined;
    if (options.canvas) delete options.canvas.dataset.cameraFlight;
  };

  return Object.freeze({
    animate(to, motion = {}) {
      const from = options.graph.getCameraPose();
      if (!from) return 'unavailable';
      cancel();
      if (options.reducedMotion()) {
        options.graph.setCameraPose(to);
        return 'instant';
      }
      const durationMs = motion.durationMs ?? 780;
      const path = motion.path ?? { type: 'direct' };
      const easing = motion.easing ?? 'cubic-in-out';
      const currentToken = ++token;
      let startTime;
      if (options.canvas) options.canvas.dataset.cameraFlight = motion.mode ?? 'standard';
      const tick = (time) => {
        if (currentToken !== token || options.graph.isDisposed) return;
        startTime ??= time;
        const pose = sampleCameraPoseTween({ from, to, durationMs, easing, path }, time - startTime);
        options.graph.setCameraPose(pose);
        if (!pose.complete) {
          frame = requestFrame(tick);
        } else {
          frame = undefined;
          if (options.canvas) delete options.canvas.dataset.cameraFlight;
          motion.onComplete?.();
        }
      };
      frame = requestFrame(tick);
      return 'animated';
    },
    cancel,
    dispose: cancel
  });
}

export function cameraArcPath(from, to, preset) {
  if (preset === 'direct') return { type: 'direct' };
  const travel = subtract(to.position, from.position);
  const distance = length(travel);
  const forward = normalize(travel);
  let right = normalize(cross(forward, { x: 0, y: 1, z: 0 }));
  if (Math.abs(forward.y) > 0.98) right = { x: 1, y: 0, z: 0 };
  const side = clamp(distance * 0.16, 5, 22);
  const lift = clamp(distance * 0.1, 4, 14);
  const offset = preset === 'arc-over'
    ? { x: 0, y: lift * 1.65, z: 0 }
    : add(scale(right, preset === 'arc-left' ? -side : side), { x: 0, y: lift, z: 0 });
  return { type: 'arc', offset };
}

export function orbitCameraPose(pose, deltaX, deltaY) {
  const offset = subtract(pose.position, pose.target);
  const radius = Math.max(0.001, length(offset));
  const theta = Math.atan2(offset.x, offset.z) - deltaX * 0.006;
  const phi = clamp(Math.acos(clamp(offset.y / radius, -1, 1)) + deltaY * 0.006, 0.08, Math.PI - 0.08);
  return {
    target: pose.target,
    position: {
      x: pose.target.x + radius * Math.sin(phi) * Math.sin(theta),
      y: pose.target.y + radius * Math.cos(phi),
      z: pose.target.z + radius * Math.sin(phi) * Math.cos(theta)
    }
  };
}

export function panCameraPose(pose, deltaX, deltaY) {
  const forward = normalize(subtract(pose.target, pose.position));
  const right = normalize({ x: forward.z, y: 0, z: -forward.x });
  const up = normalize(cross(right, forward));
  const movement = length(subtract(pose.position, pose.target)) * 0.0015;
  const shift = add(scale(right, -deltaX * movement), scale(up, deltaY * movement));
  return { position: add(pose.position, shift), target: add(pose.target, shift) };
}

export function zoomCameraPose(pose, deltaY) {
  const offset = subtract(pose.position, pose.target);
  const distance = clamp(length(offset) * Math.exp(deltaY * 0.0012), 12, 2_500);
  return { position: add(pose.target, scale(normalize(offset), distance)), target: pose.target };
}

export function normalizedDirection(from, target) {
  return normalize({ x: from.x - target.x + 12, y: from.y - target.y + 8, z: from.z - target.z });
}

export function add(left, right) { return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }; }
export function subtract(left, right) { return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z }; }
export function scale(vector, amount) { return { x: vector.x * amount, y: vector.y * amount, z: vector.z * amount }; }
export function length(vector) { return Math.hypot(vector.x, vector.y, vector.z); }
export function normalize(vector) { const magnitude = length(vector); return magnitude > 0.0001 ? scale(vector, 1 / magnitude) : { x: 0, y: 0, z: 1 }; }
export function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }

function cross(left, right) { return { x: left.y * right.z - left.z * right.y, y: left.z * right.x - left.x * right.z, z: left.x * right.y - left.y * right.x }; }
