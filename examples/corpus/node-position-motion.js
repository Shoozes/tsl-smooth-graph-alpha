export function createNodePositionMotion(options) {
  const active = new Map();
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const clock = options.now ?? (() => performance.now());
  let frame;
  let generation = 0;
  let disposed = false;

  const cancelAll = (settle = true) => {
    const pending = [...active];
    active.clear();
    generation += 1;
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    if (settle) for (const [id, motion] of pending) options.setPosition(id, motion.to);
  };
  const schedule = () => {
    if (frame !== undefined || active.size === 0 || disposed) return;
    const current = generation;
    frame = requestFrame(time => {
      // A cancelled callback may already have left the browser's frame queue.
      if (disposed || current !== generation) return;
      tick(time);
    });
  };
  const tick = (time) => {
    frame = undefined;
    if (disposed) return;
    if (options.reducedMotion?.()) { cancelAll(true); return; }
    for (const [id, motion] of active) {
      if (time < motion.startAt) continue;
      const progress = Math.min(1, (time - motion.startAt) / motion.durationMs);
      options.setPosition(id, progress >= 1 ? motion.to : sampleNodeBloomPosition(motion.from, motion.to, id, progress));
      if (progress >= 1) active.delete(id);
    }
    schedule();
  };

  return Object.freeze({
    animate(id, from, to, motion = {}) {
      if (disposed) throw new Error('Node position motion is disposed.');
      const durationMs = Number.isFinite(motion.durationMs) && motion.durationMs > 0 ? motion.durationMs : 760;
      const delayMs = Number.isFinite(motion.delayMs) && motion.delayMs >= 0 ? motion.delayMs : 0;
      if (options.reducedMotion?.()) {
        cancelAll(true);
        options.setPosition(id, copyPosition(to));
        return false;
      }
      active.set(id, { from: copyPosition(from), to: copyPosition(to), durationMs, startAt: clock() + delayMs });
      options.setPosition(id, from);
      schedule();
      return true;
    },
    cancelAll,
    get activeCount() { return active.size; },
    dispose() {
      if (disposed) return;
      this.cancelAll(false);
      disposed = true;
    }
  });
}

export function sampleNodeBloomPosition(from, to, id, progress) {
  const amount = easeOutCubic(Math.min(1, Math.max(0, progress)));
  const arcAmount = Math.sin(Math.PI * amount);
  const arc = bloomArc(id, from, to);
  return {
    x: mix(from.x, to.x, amount) + arc.x * arcAmount,
    y: mix(from.y, to.y, amount) + arc.y * arcAmount,
    z: mix(from.z, to.z, amount) + arc.z * arcAmount
  };
}

function bloomArc(id, from, to) {
  const hash = stableHash(String(id));
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const lift = Math.min(14, Math.max(1.5, distance * 0.08));
  const angle = (hash / 0xffffffff) * Math.PI * 2;
  return { x: Math.cos(angle) * lift, y: lift * (0.45 + ((hash >>> 8) & 0xff) / 510), z: Math.sin(angle) * lift };
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function copyPosition(value) {
  return { x: finite(value?.x), y: finite(value?.y), z: finite(value?.z) };
}

function finite(value) { return Number.isFinite(value) ? value : 0; }
function mix(from, to, amount) { return from + (to - from) * amount; }
function easeOutCubic(progress) { return 1 - (1 - progress) ** 3; }
