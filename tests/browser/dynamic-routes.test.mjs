import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expandableTree } from '../../examples/showcase/showcase-model.js';
import { createDynamicGraphController } from '../../examples/showcase/examples/routes/dynamic-graph.js';
import { createExpandableTreeController } from '../../examples/showcase/examples/routes/expandable-tree.js';

test('expandable tree batches stable children and leaves no stale motion after collapse', () => {
  const graph = createFakeGraph();
  const motion = createFakeMotion();
  const controller = createExpandableTreeController({ graph, motion, tree: expandableTree, seed: 7 });

  const first = controller.expand('core');
  const firstIds = controller.snapshot().visibleNodeIds;
  assert.equal(first.addedNodes, 3);
  assert.equal(first.addedLinks, 3);
  assert.equal(controller.expand('core').changed, false);
  const collapsed = controller.collapse('core');
  assert.equal(collapsed.removedNodes, 3);
  assert.equal(collapsed.cascadedLinks, 3);
  assert.equal(motion.activeCount, 0);

  const second = controller.expand('core');
  assert.equal(second.addedNodes, 3);
  assert.deepEqual(controller.snapshot().visibleNodeIds, firstIds);
  assert.equal(Object.isFrozen(expandableTree), true);
  assert.equal(expandableTree[1].data.label, 'Retrieval');
});

test('dynamic route preserves monotonic IDs through 100 add/remove cycles and clears timers', async () => {
  const graph = createFakeGraph();
  const motion = createFakeMotion();
  const addedIds = [];
  const controller = createDynamicGraphController({
    graph,
    motion,
    intervalMs: 10_000,
    maximumNodes: 4,
    seed: 11,
    onNodeAdded: (node) => addedIds.push(node.id)
  });

  for (let index = 0; index < 100; index += 1) {
    const added = await controller.addOne();
    const id = controller.snapshot().nodeIds.find((nodeId) => nodeId !== 'core');
    assert.equal(added.addedNodes, 1);
    const removed = await controller.remove(id);
    assert.equal(removed.removedNodes, 1);
    assert.equal(removed.cascadedLinks, 1);
  }
  controller.resume();
  assert.equal(controller.snapshot().pendingTimer, true);
  controller.pause();
  const snapshot = controller.snapshot();
  assert.equal(snapshot.pendingTimer, false);
  assert.equal(snapshot.nodeCount, 1);
  assert.equal(snapshot.activeMotionCount, 0);
  assert.equal(addedIds[0], 'dynamic-0001');
  assert.equal(addedIds.at(-1), 'dynamic-0100');
  assert.equal(new Set(addedIds).size, 100);
  await controller.dispose();
});

test('dynamic route serializes Worker mutations and recovers its queue after rejection', async () => {
  const graph = createFakeGraph();
  const applyPatchAsync = graph.applyPatchAsync;
  const errors = [];
  let active = 0;
  let maximumActive = 0;
  let rejectNext = true;
  graph.applyPatchAsync = async (patch) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    try {
      if (rejectNext) {
        rejectNext = false;
        throw new Error('simulated Worker rejection');
      }
      return await applyPatchAsync(patch);
    } finally {
      active -= 1;
    }
  };
  const controller = createDynamicGraphController({
    graph,
    motion: createFakeMotion(),
    intervalMs: 10_000,
    maximumNodes: 6,
    onError: (error) => errors.push(error)
  });

  await assert.rejects(controller.addOne(), /simulated Worker rejection/);
  const added = await controller.addOne();
  const id = controller.snapshot().nodeIds.find((nodeId) => nodeId !== 'core');
  const [removed, replacement] = await Promise.all([
    controller.remove(id),
    controller.addOne()
  ]);

  assert.equal(added.changed, true);
  assert.equal(removed.changed, true);
  assert.equal(replacement.changed, true);
  assert.equal(maximumActive, 1);
  assert.equal(errors.length, 1);
  await controller.dispose();
});

test('dynamic route keeps topology and motion transactional across rejection and disposal', async () => {
  const graph = createFakeGraph();
  const motion = createFakeMotion();
  const changes = [];
  const controller = createDynamicGraphController({
    graph,
    motion,
    intervalMs: 10_000,
    maximumNodes: 6,
    onChange: (snapshot) => changes.push(snapshot.nodeCount)
  });
  const added = await controller.addOne();
  const id = controller.snapshot().nodeIds.find((nodeId) => nodeId !== 'core');
  assert.equal(added.changed, true);
  assert.equal(motion.has(id), true);

  graph.rejectNext(new Error('remove rejected'));
  await assert.rejects(controller.remove(id), /remove rejected/);
  assert.equal(controller.snapshot().nodeIds.includes(id), true);
  assert.equal(motion.has(id), true);
  assert.equal(controller.snapshot().lastMutation.revision, added.revision);

  graph.rejectNext(new Error('reset rejected'));
  await assert.rejects(controller.reset(), /reset rejected/);
  assert.equal(controller.snapshot().nodeIds.includes(id), true);
  assert.equal(motion.has(id), true);

  const delayed = graph.deferNext();
  const pendingAdd = controller.addOne();
  await Promise.resolve();
  const disposal = controller.dispose();
  const motionCountAtClose = motion.activeCount;
  const changeCountAtClose = changes.length;
  delayed.resolve();
  await pendingAdd;
  await disposal;
  assert.equal(controller.snapshot().nodeCount, 3);
  assert.equal(controller.snapshot().lifecycle, 'disposed');
  assert.equal(motion.activeCount, motionCountAtClose);
  assert.equal(changes.length, changeCountAtClose);
  await assert.rejects(controller.addOne(), /disposed/);
  await controller.dispose();
});

test('dynamic termination cancels timers and prevents late dependency callbacks', async () => {
  const graph = createFakeGraph();
  const motion = createFakeMotion();
  const changes = [];
  const delayed = graph.deferNext();
  const controller = createDynamicGraphController({
    graph,
    motion,
    intervalMs: 10_000,
    maximumNodes: 6,
    onChange: (snapshot) => changes.push(snapshot.nodeCount)
  });
  const pendingAdd = controller.addOne();
  await Promise.resolve();
  controller.resume();
  controller.terminate();
  controller.terminate();
  assert.equal(controller.snapshot().pendingTimer, false);
  const changeCount = changes.length;
  delayed.resolve();
  await pendingAdd;
  assert.equal(controller.snapshot().nodeCount, 2);
  assert.equal(controller.snapshot().lifecycle, 'disposed');
  assert.equal(changes.length, changeCount);
  assert.equal(motion.activeCount, 0);
});

test('expandable collapse and reset preserve state when graph mutation rejects', () => {
  const graph = createFakeGraph();
  const motion = createFakeMotion();
  const controller = createExpandableTreeController({ graph, motion, tree: expandableTree, seed: 7 });
  controller.expand('core');
  const before = controller.snapshot();
  graph.rejectNext(new Error('collapse rejected'));
  assert.throws(() => controller.collapse('core'), /collapse rejected/);
  assert.deepEqual(controller.snapshot().visibleNodeIds, before.visibleNodeIds);
  assert.deepEqual(controller.snapshot().expandedNodeIds, before.expandedNodeIds);
  assert.equal(motion.activeCount, 3);

  const reset = controller.reset();
  assert.equal(reset.removedNodes, 3);
  assert.deepEqual(controller.snapshot().visibleNodeIds, ['core']);
  assert.equal(motion.activeCount, 0);
});

function createFakeGraph() {
  const nodes = new Map([['core', { id: 'core', initialPosition: { x: 0, y: 0, z: 0 } }]]);
  const links = new Map();
  let revision = 1;
  let nextError;
  let deferred;
  const applyPatch = (patch) => {
    if (nextError !== undefined) {
      const error = nextError;
      nextError = undefined;
      throw error;
    }
    const addedNodeIds = [];
    const removedNodeIds = [];
    const addedLinkIds = [];
    const removedLinkIds = [];
    const cascadedLinkIds = [];
    for (const node of patch.nodes?.upsert ?? []) {
      if (!nodes.has(node.id)) addedNodeIds.push(node.id);
      nodes.set(node.id, node);
    }
    for (const link of patch.links?.upsert ?? []) {
      if (!links.has(link.id)) addedLinkIds.push(link.id);
      links.set(link.id, link);
    }
    for (const id of patch.nodes?.remove ?? []) {
      if (!nodes.delete(id)) continue;
      removedNodeIds.push(id);
      for (const [linkId, link] of links) {
        if (link.source !== id && link.target !== id) continue;
        links.delete(linkId);
        cascadedLinkIds.push(linkId);
      }
    }
    for (const id of patch.links?.remove ?? []) {
      if (links.delete(id)) removedLinkIds.push(id);
    }
    revision += 1;
    return {
      revision,
      addedNodeIds,
      removedNodeIds,
      addedLinkIds,
      removedLinkIds,
      cascadedLinkIds
    };
  };
  return {
    applyPatch,
    applyPatchAsync: async (patch) => {
      if (deferred !== undefined) {
        const current = deferred;
        deferred = undefined;
        await current.promise;
      }
      return applyPatch(patch);
    },
    rejectNext(error) {
      nextError = error;
    },
    deferNext() {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      deferred = { promise };
      return { resolve };
    },
    getNodePosition: (id) => nodes.get(id)?.initialPosition ?? { x: 0, y: 0, z: 0 },
    getDiagnostics: () => ({ layoutAlpha: 0.35 }),
    getGraphView: () => ({ revision })
  };
}

function createFakeMotion() {
  const active = new Set();
  return {
    animate(id) {
      active.add(id);
    },
    cancel(id) {
      return active.delete(id);
    },
    cancelMany(ids) {
      for (const id of ids) active.delete(id);
    },
    cancelAll() {
      active.clear();
    },
    remove(id) {
      active.delete(id);
    },
    has(id) {
      return active.has(id);
    },
    get activeCount() {
      return active.size;
    }
  };
}
