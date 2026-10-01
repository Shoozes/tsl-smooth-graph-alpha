import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphError, createHeadlessForceGraph } from '../../source/headless/index.js';
import { GraphStore } from '../../source/data/GraphStore.js';

test('headless facade owns graph state, patches, layout, and snapshots without browser resources', () => {
  const payload = { label: 'caller-owned' };
  const graph = createHeadlessForceGraph<typeof payload, { weight: number }>({
    layout: { dimensions: 2, seed: 17, autoStart: false, chargeStrength: 0, linkStrength: 0, centerStrength: 0 }
  });
  const admitted = graph.setData({
    nodes: [{ id: 'a', data: payload, initialPosition: { x: 3, y: 4, z: 9 } }, { id: 'b', initialPosition: { x: -1, y: 2 } }],
    links: [{ id: 'a-b', source: 'a', target: 'b', data: { weight: 2 } }]
  });
  assert.equal(admitted.nodeCount, 2);
  assert.equal(graph.graph.getNode('a')?.data, payload);
  assert.deepEqual(graph.graph.getNodePosition('a'), { x: 3, y: 4, z: 9 });

  const before = graph.graph.getNodePosition('a');
  const patched = graph.applyPatch({ nodes: { upsert: [{ id: 'a', data: payload }] } });
  assert.equal(patched.payloadChanged, false);
  assert.deepEqual(graph.graph.getNodePosition('a'), before);
  const layout = graph.stepLayout(2);
  assert.equal(layout.snapshot.nodeIndices.length, 2);
  assert.equal(graph.graph.getNodePosition('a')?.z, 0);
  assert.equal(graph.graph.getBounds() !== undefined, true);

  const snapshot = graph.exportSnapshot();
  assert.equal(snapshot.schema, 'tsl-smooth-graph/graph-snapshot');
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.data.nodes[0]?.data, payload);
  graph.clear();
  graph.importSnapshot({ schema: '@ours/forcegraph-tsl/graph-snapshot', version: 1, data: snapshot.data });
  assert.equal(graph.graph.nodeCount, 2);

  graph.dispose();
  assert.throws(() => graph.stepLayout(), (error: unknown) => error instanceof GraphError && error.code === 'FG_RESOURCE_ALREADY_DISPOSED');
});

test('headless facade rejects invalid topology instead of silently dropping it', () => {
  const graph = createHeadlessForceGraph();
  assert.throws(() => graph.setData({
    nodes: [{ id: 'a' }],
    links: [{ id: 'missing', source: 'a', target: 'missing' }]
  }), (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_MISSING_TARGET');
  graph.dispose();
});

test('headless layout admission rejects Float32 overflow without publishing a replacement or patch', () => {
  const payload = { label: 'stable' };
  const graph = createHeadlessForceGraph<typeof payload>({ layout: { autoStart: false, chargeStrength: 0, linkStrength: 0, centerStrength: 0 } });
  graph.setData({
    nodes: [
      { id: 'a', data: payload, initialPosition: { x: 1, y: 2, z: 3 } },
      { id: 'b', initialPosition: { x: -1, y: -2, z: -3 } }
    ],
    links: [{ id: 'a-b', source: 'a', target: 'b' }]
  });
  const beforeSnapshot = graph.exportSnapshot();
  const beforeLayout = graph.getLayoutSnapshot();
  const beforeRevision = graph.graph.revision;
  const assertUnchanged = (): void => {
    assert.equal(graph.graph.revision, beforeRevision);
    assert.equal(graph.graph.getNode('a')?.data, payload);
    assert.deepEqual(graph.graph.getNodePosition('a'), { x: 1, y: 2, z: 3 });
    assert.deepEqual(graph.exportSnapshot(), beforeSnapshot);
    assert.deepEqual(graph.getLayoutSnapshot(), beforeLayout);
  };

  assert.throws(
    () => graph.setData({ nodes: [{ id: 'replacement', initialPosition: { x: 1e40, y: 0, z: 0 } }], links: [] }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED'
  );
  assertUnchanged();
  assert.throws(
    () => graph.applyPatch({ nodes: { upsert: [{ id: 'a', fixed: { x: 1e40 } }] } }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED'
  );
  assertUnchanged();
  graph.dispose();
});

test('headless options reject unsupported wrappers and worker fields before graph creation', () => {
  const invalidOptions = [
    null,
    [] as unknown as Record<string, unknown>,
    { renderer: {} },
    { host: { mode: 'headless' } },
    { layout: { backend: 'worker' } },
    { layout: { workerFactory: () => undefined } },
    { layout: { maxPendingWorkerSteps: 1 } }
  ];
  for (const options of invalidOptions) {
    assert.throws(
      () => createHeadlessForceGraph(options as never),
      (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID'
    );
  }
});

test('headless replacement alpha and stopped-state policy match explicit auto-start choices', () => {
  const stopped = createHeadlessForceGraph({ layout: { autoStart: false, topologyReheatAlpha: 0.35 } });
  stopped.applyPatch({ nodes: { upsert: [{ id: 'new' }] } });
  assert.equal(stopped.getLayoutSnapshot().alpha, 1);
  assert.equal(stopped.getLayoutSnapshot().settled, true);
  stopped.stepLayout(100);
  stopped.stopLayout();
  stopped.applyPatch({ nodes: { upsert: [{ id: 'second' }] } });
  assert.equal(stopped.getLayoutSnapshot().alpha, 0.35);
  assert.equal(stopped.getLayoutSnapshot().settled, true);
  stopped.clear();
  assert.equal(stopped.getLayoutSnapshot().alpha, 0);
  assert.equal(stopped.getLayoutSnapshot().settled, true);
  stopped.dispose();

  const running = createHeadlessForceGraph({ layout: { autoStart: true } });
  running.setData({ nodes: [{ id: 'a' }], links: [] });
  assert.equal(running.getLayoutSnapshot().settled, false);
  running.dispose();
});

test('GraphStore release deterministically drops owned storage and invalidates prepared plans', () => {
  const store = new GraphStore<{ label: string }>();
  store.setData({ nodes: [{ id: 'a', data: { label: 'owned' } }], links: [] });
  const plan = store.prepareSetData({ nodes: [{ id: 'b' }], links: [] });
  const before = store.getStorageStats();
  assert.ok(before.ownedArrayBytes > 0);
  assert.ok(before.mapEntries > 0);
  store.release();
  assert.deepEqual(store.getStorageStats(), {
    nodeCapacity: 0,
    linkCapacity: 0,
    nodeRecordSlots: 0,
    linkRecordSlots: 0,
    ownedArrayBytes: 0,
    mapEntries: 0,
    adjacencyEntries: 0,
    freeSlotCount: 0,
    released: true
  });
  assert.throws(
    () => store.commitPrepared(plan),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RESOURCE_ALREADY_DISPOSED'
  );
});
