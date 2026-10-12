const MAX_GROUPS = 128;
const MAX_STEPS = 256;
const MAX_NODE_REFERENCES = 32_768;
const MAX_DURATION_MS = 3_600_000;

/** Absolute-time replay. Camera, rendering, and reduced-motion policy stay in the host. */
export function createSearchScanTimeline(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('options must be an object');
  const { groups = [], steps = [], travelMs = 300, overviewMs = 1_500 } = options;
  if (!Array.isArray(groups) || groups.length > MAX_GROUPS) throw invalid(`groups must be an array of at most ${MAX_GROUPS} entries`);
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) throw invalid(`steps must be an array of at most ${MAX_STEPS} entries`);
  checkDuration(travelMs, 'travelMs');
  checkDuration(overviewMs, 'overviewMs');

  const groupMap = new Map();
  const allNodeIds = new Set();
  for (const group of groups) {
    if (!isRecord(group) || !validId(group.id)) throw invalid('each group needs a nonempty string id');
    if (groupMap.has(group.id)) throw invalid(`duplicate group ${group.id}`);
    if (!Array.isArray(group.nodeIds) || group.nodeIds.length > MAX_NODE_REFERENCES) throw invalid(`group ${group.id} has invalid nodeIds`);
    const nodeIds = new Set();
    for (const id of group.nodeIds) {
      if (!validId(id)) throw invalid(`group ${group.id} has an invalid node id`);
      if (allNodeIds.has(id)) throw invalid(`duplicate node ${id}`);
      allNodeIds.add(id);
      nodeIds.add(id);
      if (allNodeIds.size > MAX_NODE_REFERENCES) throw invalid('node reference limit exceeded');
    }
    groupMap.set(group.id, nodeIds);
  }

  let references = 0;
  const copiedSteps = steps.map((step, index) => {
    if (!isRecord(step) || !groupMap.has(step.groupId)) throw invalid(`step ${index} refers to an unknown group`);
    if (!Array.isArray(step.nodeIds) || step.nodeIds.length > MAX_NODE_REFERENCES) throw invalid(`step ${index} has invalid nodeIds`);
    references += step.nodeIds.length;
    if (references > MAX_NODE_REFERENCES) throw invalid('step node reference limit exceeded');
    for (const id of step.nodeIds) {
      if (!groupMap.get(step.groupId).has(id)) throw invalid(`step ${index} refers to a node outside ${step.groupId}`);
    }
    checkDuration(step.durationMs, `step ${index} durationMs`);
    return { groupId: step.groupId, nodeIds: [...step.nodeIds], durationMs: step.durationMs };
  });

  const segments = [];
  const finalGroupEndMs = new Map();
  let scanEndMs = 0;
  for (const [index, step] of copiedSteps.entries()) {
    if (index > 0) {
      if (travelMs > 0) segments.push({ phase: 'travel', startMs: scanEndMs, endMs: scanEndMs + travelMs, stepIndex: index });
      scanEndMs += travelMs;
    }
    step.startMs = scanEndMs;
    scanEndMs += step.durationMs;
    step.endMs = scanEndMs;
    finalGroupEndMs.set(step.groupId, step.endMs);
    if (step.durationMs > 0) segments.push({ phase: 'scan', startMs: step.startMs, endMs: step.endMs, stepIndex: index });
    if (scanEndMs > MAX_DURATION_MS) throw invalid('total duration exceeds one hour');
  }
  const durationMs = copiedSteps.length ? scanEndMs + overviewMs : 0;
  if (durationMs > MAX_DURATION_MS) throw invalid('total duration exceeds one hour');
  // Reveal results in caller order, then the other groups' overview labels.
  const overviewNodeIds = Object.freeze([...new Set([...copiedSteps.flatMap(step => step.nodeIds), ...allNodeIds])]);

  function sample(elapsedMs = 0) {
    if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) throw invalid('elapsedMs must be finite');
    const timeMs = Math.max(0, Math.min(durationMs, elapsedMs));
    const complete = timeMs === durationMs;
    const segment = complete ? undefined : segments.find(item => timeMs < item.endMs);
    const phase = complete ? 'complete' : segment?.phase ?? 'overview';
    const stepIndex = segment?.stepIndex ?? copiedSteps.length - 1;
    const step = copiedSteps[stepIndex];
    const previousStep = copiedSteps[stepIndex - 1];
    const phaseProgress = segment ? (timeMs - segment.startMs) / (segment.endMs - segment.startMs) : complete ? 1 : (timeMs - scanEndMs) / overviewMs;
    const scanProgress = phase === 'scan' ? phaseProgress : phase === 'travel' ? 0 : 1;
    const visible = new Set();
    const completed = new Set();
    for (const candidate of copiedSteps) {
      if (candidate.endMs > timeMs) continue;
      // Revisited groups complete after their final scheduled scan.
      if (finalGroupEndMs.get(candidate.groupId) <= timeMs) completed.add(candidate.groupId);
      for (const id of candidate.nodeIds) visible.add(id);
    }

    let fromNodeId = null;
    let toNodeId = null;
    let nodeProgress = 1;
    if (phase === 'travel') {
      fromNodeId = previousStep?.nodeIds.at(-1) ?? null;
      toNodeId = step.nodeIds[0] ?? null;
      nodeProgress = smoothstep(phaseProgress);
      if (toNodeId !== null) visible.add(toNodeId);
    } else if (phase === 'scan' && step.nodeIds.length) {
      const scaled = scanProgress * step.nodeIds.length;
      const index = Math.min(step.nodeIds.length - 1, Math.floor(scaled));
      fromNodeId = step.nodeIds[Math.max(0, index - 1)];
      toNodeId = step.nodeIds[index];
      nodeProgress = smoothstep(Math.min(1, scaled - index));
      for (let shown = 0; shown <= index; shown += 1) visible.add(step.nodeIds[shown]);
    } else if (step) {
      fromNodeId = step.nodeIds.at(-1) ?? null;
      toNodeId = fromNodeId;
    }

    return Object.freeze({
      timeMs, progress: durationMs === 0 ? 1 : timeMs / durationMs, phase,
      groupId: step?.groupId ?? null, previousGroupId: previousStep?.groupId ?? null,
      phaseProgress, scanProgress, activeNodeId: toNodeId, previousNodeId: fromNodeId,
      fromNodeId, toNodeId, nodeProgress,
      nodeDurationMs: step?.nodeIds.length ? step.durationMs / step.nodeIds.length : 0,
      completedGroupIds: Object.freeze([...completed]),
      visibleNodeIds: !copiedSteps.length ? Object.freeze([]) : phase === 'overview' || complete ? overviewNodeIds : Object.freeze([...visible]),
      overviewProgress: complete ? 1 : phase === 'overview' ? phaseProgress : 0,
      stepIndex, groupScanStartMs: step?.startMs ?? 0, groupScanEndMs: step?.endMs ?? 0
    });
  }

  return Object.freeze({ durationMs, sample });
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function checkDuration(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_DURATION_MS) {
    throw invalid(`${field} must be a finite duration from 0 to ${MAX_DURATION_MS}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function invalid(reason) {
  return new TypeError(`Search scan timeline is invalid: ${reason}.`);
}
