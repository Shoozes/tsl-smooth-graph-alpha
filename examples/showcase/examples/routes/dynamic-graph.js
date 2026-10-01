import { parentRelativePosition } from '../runtime/node-spawn-motion.js';

export function createDynamicGraphController(options) {
  const rootId = options.rootId ?? 'core';
  const intervalMs = finiteInterval(options.intervalMs ?? 900);
  const maximumNodes = finiteMaximum(options.maximumNodes ?? 40);
  const ids = new Set([rootId]);
  let nextOrdinal = 1;
  let running = false;
  let lifecycle = 'active';
  let callbacksEnabled = true;
  let disposePromise;
  let timer;
  let generation = 0;
  let lastMutation;
  let pending = Promise.resolve();

  const enqueue = (operation) => {
    if (lifecycle !== 'active') return Promise.reject(new Error(`Dynamic graph controller is ${lifecycle}.`));
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      (error) => {
        if (callbacksEnabled) options.onError?.(error);
      }
    );
    return result;
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!running || lifecycle !== 'active' || ids.size >= maximumNodes) return;
    const token = generation;
    timer = setTimeout(() => {
      timer = undefined;
      if (token !== generation || !running || lifecycle !== 'active') return;
      const result = enqueue(() => token === generation && running && lifecycle === 'active'
        ? addOne()
        : emptyResult('add'));
      void result.then(schedule, schedule);
    }, intervalMs);
  };

  const addOne = async () => {
    if (lifecycle === 'disposed' || ids.size >= maximumNodes) return emptyResult('add');
    const ordinal = nextOrdinal++;
    const id = `dynamic-${String(ordinal).padStart(4, '0')}`;
    const candidates = [...ids];
    const parentId = candidates[(ordinal * 7 + 3) % candidates.length];
    const color = [0x39c990, 0x7868f7, 0xd99245, 0x39bde0][ordinal % 4];
    const node = {
      id,
      data: { color, label: `Dynamic ${String(ordinal).padStart(4, '0')}` },
      initialPosition: parentRelativePosition(options.graph.getNodePosition(parentId), parentId, id, {
        distance: options.spawnDistance ?? 2.4,
        dimensions: options.dimensions,
        seed: options.seed
      })
    };
    const receipt = await options.graph.applyPatchAsync({
      nodes: { upsert: [node] },
      links: { upsert: [{ id: `dynamic:${parentId}>${id}`, source: parentId, target: id, data: { color } }] }
    });
    lastMutation = receipt;
    ids.add(id);
    if (callbacksEnabled) {
      options.motion.animate(id);
      options.onNodeAdded?.(node);
      options.onChange?.(snapshot());
    }
    return mutationResult('add', receipt);
  };

  const removeOne = async (id) => {
    if (lifecycle === 'disposed' || id === rootId || !ids.has(id)) return emptyResult('remove');
    const receipt = await options.graph.applyPatchAsync({ nodes: { remove: [id] } });
    lastMutation = receipt;
    ids.delete(id);
    if (callbacksEnabled) {
      options.motion.remove(id);
      options.onNodeRemoved?.(id);
      options.onChange?.(snapshot());
      schedule();
    }
    return mutationResult('remove', receipt);
  };

  const pause = (notify = true) => {
    running = false;
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
    if (notify && callbacksEnabled) options.onChange?.(snapshot());
  };

  const resume = () => {
    if (lifecycle !== 'active') return;
    running = true;
    schedule();
    options.onChange?.(snapshot());
  };

  const resetOne = async () => {
    const removed = [...ids].filter((id) => id !== rootId);
    if (removed.length > 0) {
      const receipt = await options.graph.applyPatchAsync({ nodes: { remove: removed } });
      lastMutation = receipt;
      for (const id of removed) {
        ids.delete(id);
        if (callbacksEnabled) {
          options.motion.remove(id);
          options.onNodeRemoved?.(id);
        }
      }
    }
    nextOrdinal = 1;
    if (callbacksEnabled) options.onChange?.(snapshot());
    return removed.length;
  };

  const snapshot = () => {
    const diagnostics = options.graph.getDiagnostics();
    return Object.freeze({
      running,
      nodeIds: Object.freeze([...ids]),
      nodeCount: ids.size,
      maximumNodes,
      pendingTimer: timer !== undefined,
      activeMotionCount: options.motion.activeCount,
      revision: options.graph.getGraphView().revision,
      layoutAlpha: diagnostics.layoutAlpha,
      lastMutation: lastMutation === undefined ? undefined : receiptSummary(lastMutation),
      lifecycle
    });
  };

  return Object.freeze({
    addOne() {
      return enqueue(addOne);
    },
    remove(id) {
      return enqueue(() => removeOne(id));
    },
    pause,
    resume,
    reset() {
      pause();
      return enqueue(resetOne);
    },
    snapshot,
    get running() {
      return running;
    },
    async dispose() {
      if (disposePromise !== undefined) return disposePromise;
      if (lifecycle === 'disposed') return;
      lifecycle = 'closing';
      callbacksEnabled = false;
      pause(false);
      disposePromise = pending.finally(() => {
        lifecycle = 'disposed';
      });
      return disposePromise;
    },
    terminate() {
      if (lifecycle === 'disposed') return;
      lifecycle = 'disposed';
      callbacksEnabled = false;
      pause(false);
    }
  });
}

function mutationResult(action, receipt) {
  return Object.freeze({ action, changed: true, ...receiptSummary(receipt) });
}

function emptyResult(action) {
  return Object.freeze({ action, changed: false, addedNodes: 0, removedNodes: 0, cascadedLinks: 0 });
}

function receiptSummary(receipt) {
  return Object.freeze({
    revision: receipt.revision,
    addedNodes: receipt.addedNodeIds.length,
    removedNodes: receipt.removedNodeIds.length,
    addedLinks: receipt.addedLinkIds.length,
    removedLinks: receipt.removedLinkIds.length,
    cascadedLinks: receipt.cascadedLinkIds.length
  });
}

function finiteInterval(value) {
  if (!Number.isFinite(value) || value < 100 || value > 10_000) throw new Error('Dynamic intervalMs must be between 100 and 10000.');
  return value;
}

function finiteMaximum(value) {
  if (!Number.isSafeInteger(value) || value < 2 || value > 500) throw new Error('Dynamic maximumNodes must be an integer from 2 through 500.');
  return value;
}
