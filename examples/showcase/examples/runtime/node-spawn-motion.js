const defaultMotion = Object.freeze({
  durationMs: 460,
  initialScale: 0.08,
  overshoot: 1.70158
});

/**
 * Keeps transient node scale outside graph payloads and batches every active
 * animation into one style refresh per frame.
 */
export function createNodeSpawnMotion(options) {
  if (!options || typeof options.refreshNodeStyles !== 'function') {
    throw new Error('Node spawn motion requires refreshNodeStyles(nodeIds).');
  }
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const clock = options.now ?? (() => performance.now());
  const prefersReducedMotion = options.reducedMotion ?? (() => false);
  const scales = new Map();
  const active = new Map();
  let frame;
  let disposed = false;

  const refresh = (ids) => {
    if (ids.length === 0 || disposed) return;
    try {
      options.refreshNodeStyles(ids);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const schedule = () => {
    if (frame === undefined && active.size > 0 && !disposed) frame = requestFrame(tick);
  };

  const tick = (time) => {
    frame = undefined;
    if (disposed) return;
    const changed = [];
    for (const [id, motion] of active) {
      if (time < motion.startAt) continue;
      const progress = clamp01((time - motion.startAt) / motion.durationMs);
      const scale = motion.kind === 'pulse'
        ? pulseScale(motion.from, motion.peak, motion.to, progress)
        : mix(motion.from, motion.to, easeOutBack(progress, motion.overshoot));
      if (scales.get(id) !== scale) {
        scales.set(id, scale);
        changed.push(id);
      }
      if (progress >= 1) {
        scales.set(id, motion.to);
        active.delete(id);
      }
    }
    refresh(changed);
    schedule();
  };

  const animate = (id, motion = {}) => {
    assertActive(disposed);
    const to = finiteScale(motion.to ?? 1, 'target');
    if (prefersReducedMotion()) {
      active.delete(id);
      scales.set(id, to);
      refresh([id]);
      return false;
    }
    const from = finiteScale(motion.from ?? scales.get(id) ?? defaultMotion.initialScale, 'initial');
    const durationMs = finiteDuration(motion.durationMs ?? defaultMotion.durationMs);
    const delayMs = finiteDelay(motion.delayMs ?? 0);
    scales.set(id, from);
    active.set(id, {
      kind: 'spawn',
      from,
      to,
      durationMs,
      startAt: clock() + delayMs,
      overshoot: Number.isFinite(motion.overshoot) ? motion.overshoot : defaultMotion.overshoot
    });
    refresh([id]);
    schedule();
    return true;
  };

  const pulse = (id, motion = {}) => {
    assertActive(disposed);
    const to = finiteScale(motion.to ?? 1, 'target');
    if (prefersReducedMotion()) {
      active.delete(id);
      scales.set(id, to);
      refresh([id]);
      return false;
    }
    const from = finiteScale(motion.from ?? scales.get(id) ?? 1, 'initial');
    const peak = finiteScale(motion.peak ?? 1.24, 'peak');
    const durationMs = finiteDuration(motion.durationMs ?? 360);
    scales.set(id, from);
    active.set(id, { kind: 'pulse', from, peak, to, durationMs, startAt: clock() + finiteDelay(motion.delayMs ?? 0) });
    refresh([id]);
    schedule();
    return true;
  };

  const cancel = (id, settle = true) => {
    const existed = active.delete(id);
    if (settle) {
      scales.set(id, 1);
      refresh([id]);
    }
    if (active.size === 0 && frame !== undefined) {
      cancelFrame(frame);
      frame = undefined;
    }
    return existed;
  };

  const remove = (id) => {
    active.delete(id);
    scales.delete(id);
    if (active.size === 0 && frame !== undefined) {
      cancelFrame(frame);
      frame = undefined;
    }
  };

  const setMany = (entries) => {
    assertActive(disposed);
    const changed = [];
    for (const [id, value] of entries) {
      const scale = finiteScale(value, 'current');
      active.delete(id);
      if (scales.get(id) === scale) continue;
      scales.set(id, scale);
      changed.push(id);
    }
    refresh(changed);
    if (active.size === 0 && frame !== undefined) {
      cancelFrame(frame);
      frame = undefined;
    }
    return Object.freeze(changed);
  };

  const cancelAll = (settle = true) => {
    const changed = settle ? [...new Set([...active.keys(), ...scales.keys()])] : [];
    active.clear();
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    if (settle) {
      for (const id of changed) scales.set(id, 1);
      refresh(changed);
    } else {
      scales.clear();
    }
  };

  return Object.freeze({
    animate,
    pulse,
    cancel,
    cancelMany(ids, settle = true) {
      for (const id of ids) cancel(id, settle);
    },
    cancelAll,
    set(id, scale) {
      return setMany([[id, scale]]).length > 0;
    },
    setMany,
    remove,
    scale(id) {
      return scales.get(id) ?? 1;
    },
    get activeCount() {
      return active.size;
    },
    dispose() {
      if (disposed) return;
      cancelAll(false);
      disposed = true;
    }
  });
}

/** Returns a deterministic child position near its current parent position. */
export function parentRelativePosition(parentPosition, parentId, childId, options = {}) {
  const distance = Number.isFinite(options.distance) && options.distance >= 0 ? options.distance : 2.4;
  const dimensions = options.dimensions === 2 ? 2 : 3;
  const seed = Number.isSafeInteger(options.seed) ? options.seed : 0;
  const origin = {
    x: finiteCoordinate(parentPosition?.x),
    y: finiteCoordinate(parentPosition?.y),
    z: dimensions === 2 ? 0 : finiteCoordinate(parentPosition?.z)
  };
  const hash = stableHash(`${seed}:${String(parentId)}>${String(childId)}`);
  const unitA = ((hash & 0xffff) + 0.5) / 0x10000;
  const unitB = (((hash >>> 16) & 0xffff) + 0.5) / 0x10000;
  const azimuth = unitA * Math.PI * 2;
  if (dimensions === 2) {
    return { x: origin.x + Math.cos(azimuth) * distance, y: origin.y + Math.sin(azimuth) * distance, z: 0 };
  }
  const z = unitB * 2 - 1;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return {
    x: origin.x + Math.cos(azimuth) * radial * distance,
    y: origin.y + Math.sin(azimuth) * radial * distance,
    z: origin.z + z * distance
  };
}

function pulseScale(from, peak, to, progress) {
  const peakAt = 0.56;
  if (progress < peakAt) return mix(from, peak, 1 - (1 - progress / peakAt) ** 3);
  const settle = (progress - peakAt) / (1 - peakAt);
  return mix(peak, to, settle * settle * (3 - 2 * settle));
}

function easeOutBack(progress, overshoot) {
  const shifted = progress - 1;
  return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2;
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function finiteCoordinate(value) {
  return Number.isFinite(value) ? value : 0;
}

function finiteScale(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Node motion ${label} scale must be finite and positive.`);
  return value;
}

function finiteDuration(value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Node motion durationMs must be finite and positive.');
  return value;
}

function finiteDelay(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error('Node motion delayMs must be finite and non-negative.');
  return value;
}

function assertActive(disposed) {
  if (disposed) throw new Error('Node spawn motion is disposed.');
}

function mix(from, to, amount) {
  return from + (to - from) * amount;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
