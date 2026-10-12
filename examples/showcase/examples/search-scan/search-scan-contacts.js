export const SEARCH_SCAN_LEG_COUNT = 24;

/** Absolute-time, presentation-only contacts. Never writes to graph nodes. */
export function createSearchScanContacts({ nodes, sampleAnchor, getNodePosition }) {
  const byGroup = new Map();
  for (const node of nodes) {
    const group = byGroup.get(node.data.groupId) ?? [];
    group.push(node);
    byGroup.set(node.data.groupId, group);
  }
  // One plan per leg is enough; rebuilding after a seek produces the same plan.
  const plans = new Array(SEARCH_SCAN_LEG_COUNT);

  function plan(leg, cycle, startMs, periodMs, sample, angle, restRadius) {
    const key = `${sample.stepIndex}:${cycle}:${sample.groupScanStartMs}:${sample.groupScanEndMs}`;
    if (plans[leg]?.key === key) return plans[leg].value;
    const contactStartMs = startMs + periodMs * 0.4;
    const contactEndMs = startMs + periodMs * 0.64;
    let value = null;
    if (startMs >= sample.groupScanStartMs && startMs + periodMs <= sample.groupScanEndMs) {
      const first = sampleAnchor(contactStartMs);
      const times = [contactStartMs, contactEndMs];
      const nodeDurationMs = first?.nodeDurationMs;
      if (Number.isFinite(nodeDurationMs) && nodeDurationMs > 0) {
        for (let boundary = Math.floor((contactStartMs - sample.groupScanStartMs) / nodeDurationMs) + 1; sample.groupScanStartMs + boundary * nodeDurationMs < contactEndMs; boundary += 1) {
          times.push(sample.groupScanStartMs + boundary * nodeDurationMs);
        }
      } else {
        for (const amount of [0.25, 0.5, 0.75]) times.push(contactStartMs + (contactEndMs - contactStartMs) * amount);
      }
      const anchors = times.sort((a, b) => a - b).map(time => sampleAnchor(time));
      // Between token turns the cursor follows a line plus a bounded .65y/.5z
      // bend. Checking every turn with this margin covers the whole hold.
      const bendMargin = nodeDurationMs > 0 ? Math.hypot(0.65, 0.5) : 0;
      if (anchors.every(anchor => anchor?.phase === 'scan' && anchor.groupId === sample.groupId)) {
        const anchor = anchors[0];
        const direction = { x: Math.cos(angle), y: Math.sin(angle) };
        const nominalTip = {
          x: anchor.center.x + direction.x * restRadius * anchor.scale,
          y: anchor.center.y + direction.y * restRadius * anchor.scale,
          z: anchor.center.z - 2
        };
        let nearest = Infinity;
        for (const node of byGroup.get(sample.groupId) ?? []) {
          const point = node.initialPosition;
          const dx = point.x - anchor.center.x, dy = point.y - anchor.center.y;
          // Keep a leg in its own forward fan, away from the scanner's body.
          if (dx * direction.x + dy * direction.y < Math.hypot(dx, dy) * 0.25) continue;
          if (anchors.some(item => {
            const distance = distanceSquared(point, item.center);
            return distance < (item.scale * 3) ** 2 || distance > Math.max(0, item.scale * 15 - bendMargin) ** 2;
          })) continue;
          const distance = distanceSquared(point, nominalTip);
          if (distance < nearest || (distance === nearest && node.id < value?.targetNodeId)) {
            nearest = distance;
            value = { targetNodeId: node.id, nodeRadius: node.data.radius ?? 0.18, contactStartMs, contactEndMs };
          }
        }
      }
    }
    plans[leg] = { key, value };
    return value;
  }

  return Object.freeze({
    reset() { plans.fill(undefined); },
    sample(sample, { reducedMotion = false, overview = false } = {}) {
      const enabled = sample.phase === 'scan' && !reducedMotion && !overview;
      const current = enabled ? sampleAnchor(sample.timeMs) : null;
      return Array.from({ length: SEARCH_SCAN_LEG_COUNT }, (_, legId) => {
        const periodMs = 520 + legId % 6 * 24;
        const stagger = legId / SEARCH_SCAN_LEG_COUNT * periodMs;
        const localTime = sample.timeMs - sample.groupScanStartMs + stagger;
        const cycle = Math.floor(localTime / periodMs);
        const cycleStartMs = sample.groupScanStartMs + cycle * periodMs - stagger;
        const progress = (localTime - cycle * periodMs) / periodMs;
        const angle = legId / SEARCH_SCAN_LEG_COUNT * Math.PI * 2;
        const restRadius = 6.8 + (Math.sin(legId * 7.19 + 2.3) + 1) * 1.6;
        const target = enabled && current ? plan(legId, cycle, cycleStartMs, periodMs, sample, angle, restRadius) : null;
        const targetPosition = target ? getNodePosition(target.targetNodeId) : null;
        // A live position check also prevents a fast or externally moved graph
        // from reporting a contact beyond the leg's maximum reach.
        const withinReach = targetPosition && distanceSquared(targetPosition, current.center) <= (current.scale * 15) ** 2;
        const plannedPhase = progress < 0.4 ? 'reach' : progress <= 0.64 ? 'touch' : 'retract';
        const phase = !targetPosition || (plannedPhase === 'touch' && !withinReach) ? 'idle' : plannedPhase;
        const reachable = phase !== 'idle';
        const retract = Math.max(0, (progress - 0.64) / 0.36);
        const reach = phase === 'reach' ? smoothstep(progress / 0.4) : phase === 'touch' ? 1 : phase === 'retract' ? 1 - smoothstep(retract) : 0;
        const contactProgress = Math.max(0, Math.min(1, (progress - 0.4) / 0.24));
        const glow = phase === 'touch' ? 1 - contactProgress * 0.15 : phase === 'retract' ? 0.85 * (1 - retract) ** 2 : 0;
        return {
          legId, angle, restRadius, phase, reach,
          targetNodeId: reachable ? target.targetNodeId : null,
          targetPosition: reachable ? { ...targetPosition } : null,
          nodeRadius: reachable ? target.nodeRadius : 0,
          contactStartMs: reachable ? target.contactStartMs : null,
          contactProgress, contactStrength: glow, touching: phase === 'touch'
        };
      });
    }
  });
}

function distanceSquared(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

function smoothstep(value) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}
