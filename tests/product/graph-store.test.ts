import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GraphError } from '../../source/core/errors.js';
import { GraphStore } from '../../source/data/GraphStore.js';

test('GraphStore keeps caller data immutable and initializes positions deterministically', () => {
  const nodes = Object.freeze([
    Object.freeze({ id: 'alpha', data: Object.freeze({ label: 'Alpha' }) }),
    Object.freeze({ id: 'beta', data: Object.freeze({ label: 'Beta' }) })
  ]);
  const links = Object.freeze([
    Object.freeze({ id: 'alpha-beta', source: 'alpha', target: 'beta' })
  ]);
  const input = Object.freeze({ nodes, links });
  const before = JSON.stringify(input);

  const first = new GraphStore({ seed: 42 });
  const second = new GraphStore({ seed: 42 });
  first.setData(input);
  second.setData(input);

  assert.equal(JSON.stringify(input), before);
  const firstInputNode = input.nodes[0];
  assert.ok(firstInputNode);
  assert.equal('x' in firstInputNode, false);
  assert.deepEqual(first.getNodePosition('alpha'), second.getNodePosition('alpha'));
  assert.deepEqual(first.getNodePosition('beta'), second.getNodePosition('beta'));
  assert.equal(first.nodeCount, 2);
  assert.equal(first.linkCount, 1);
});

test('GraphStore copies structural records while retaining only opaque payload references', () => {
  const payload = { label: 'caller-owned' };
  const initialPosition = { x: 4, y: -3, z: 2 };
  const fixed = { x: 4 };
  const node = { id: 'node', data: payload, initialPosition, fixed };
  const link = { id: 'link', source: 'node', target: 'node', data: payload };
  const nodes = [node];
  const links = [link];
  const store = new GraphStore();

  store.setData({ nodes, links });
  node.id = 'mutated-node';
  initialPosition.x = 99;
  fixed.x = 99;
  link.source = 'mutated-source';
  nodes.length = 0;
  links.length = 0;

  const storedNode = store.getNode('node');
  const storedLink = store.getLink('link');
  assert.ok(storedNode);
  assert.ok(storedLink);
  assert.equal(storedNode.id, 'node');
  assert.deepEqual(storedNode.initialPosition, { x: 4, y: -3, z: 2 });
  assert.deepEqual(storedNode.fixed, { x: 4 });
  assert.equal(storedNode.data, payload);
  assert.equal(storedLink.source, 'node');
  assert.equal(storedLink.target, 'node');
  assert.equal(storedLink.data, payload);
  assert.ok(Object.isFrozen(storedNode));
  assert.ok(Object.isFrozen(storedNode.initialPosition));
  assert.ok(Object.isFrozen(storedLink));
  assert.equal(Reflect.set(storedNode, 'id', 'tampered'), false);
  assert.equal(Reflect.set(storedNode.initialPosition as object, 'x', 100), false);
  assert.equal(Reflect.set(storedLink, 'source', 'tampered'), false);
  assert.equal(store.hasNode('node'), true);
  assert.equal(store.hasLink('link'), true);
  assert.deepEqual(store.getNodePosition('node'), { x: 4, y: -3, z: 2 });
});

test('GraphStore returns unique incident link IDs without exposing adjacency storage', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    links: [
      { id: 'a-b', source: 'a', target: 'b' },
      { id: 'a-c', source: 'a', target: 'c' },
      { id: 'b-c', source: 'b', target: 'c' }
    ]
  });

  const incident = store.getIncidentLinkIds(['a', 'b', 'missing']);
  assert.deepEqual(incident, ['a-b', 'a-c', 'b-c']);
  assert.equal(Object.isFrozen(incident), true);
});

test('GraphStore rejects invalid endpoint and duplicate-id contracts in strict mode', () => {
  const store = new GraphStore();
  assert.throws(
    () => store.setData({ nodes: [{ id: 'duplicate' }, { id: 'duplicate' }], links: [] }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_DUPLICATE_NODE_ID'
  );
  assert.throws(
    () => store.setData({ nodes: [{ id: 'source' }], links: [{ id: 'bad-link', source: 'source', target: 'missing' }] }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_MISSING_TARGET'
  );
});

test('GraphStore patches incrementally while preserving unaffected handles and reusing free slots', () => {
  const store = new GraphStore({ seed: 9 });
  store.setData({
    nodes: [{ id: 'left' }, { id: 'right' }],
    links: [{ id: 'edge', source: 'left', target: 'right' }]
  });
  const leftHandle = store.getNodeHandle('left');
  const rightHandle = store.getNodeHandle('right');
  assert.ok(leftHandle);
  assert.ok(rightHandle);

  store.applyPatch({
    nodes: { remove: ['right'], upsert: [{ id: 'new', data: { created: true } }] },
    links: { remove: ['edge'], upsert: [{ id: 'replacement', source: 'left', target: 'new' }] }
  });

  const newHandle = store.getNodeHandle('new');
  assert.deepEqual(store.getNodeHandle('left'), leftHandle);
  assert.equal(store.isNodeHandleValid(rightHandle), false);
  assert.equal(newHandle?.index, rightHandle.index);
  assert.equal(newHandle?.generation, rightHandle.generation + 1);
  assert.equal(store.hasLink('replacement'), true);
  assert.equal(store.hasLink('edge'), false);
});

test('GraphStore classifies payload, simulation, and topology patches independently', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [{ id: 'left' }, { id: 'right' }],
    links: [{ id: 'edge', source: 'left', target: 'right' }]
  });

  const payloadChange = store.applyPatch({
    nodes: { upsert: [{ id: 'left', data: { label: 'updated' } }] },
    links: { upsert: [{ id: 'edge', source: 'left', target: 'right', data: { weight: 3 } }] }
  });
  assert.equal(payloadChange.topologyChanged, false);
  assert.equal(payloadChange.simulationChanged, false);
  assert.equal(payloadChange.payloadChanged, true);
  assert.deepEqual(payloadChange.changedNodeIds, ['left']);
  assert.deepEqual(payloadChange.changedLinkIds, ['edge']);
  assert.ok(Object.isFrozen(payloadChange));
  assert.ok(Object.isFrozen(payloadChange.changedNodeIds));
  assert.ok(Object.isFrozen(payloadChange.changedLinkIds));

  const simulationChange = store.applyPatch({
    nodes: { upsert: [{ id: 'left', data: { label: 'positioned' }, initialPosition: { x: 4 } }] }
  });
  assert.equal(simulationChange.topologyChanged, false);
  assert.equal(simulationChange.simulationChanged, false);
  assert.equal(simulationChange.payloadChanged, true);
  assert.deepEqual(simulationChange.changedNodeIds, ['left']);
  assert.deepEqual(simulationChange.changedLinkIds, []);

  const resetChange = store.applyPatch({
    nodes: { upsert: [{ id: 'left', initialPosition: { z: 8 }, resetPosition: true }] }
  });
  assert.equal(resetChange.simulationChanged, true);
  assert.equal(resetChange.visualChanged, true);
  assert.equal(resetChange.layoutRebuildScheduled, false);

  const topologyChange = store.applyPatch({
    links: { upsert: [{ id: 'edge', source: 'right', target: 'left', data: { weight: 4 } }] }
  });
  assert.equal(topologyChange.topologyChanged, true);
  assert.equal(topologyChange.simulationChanged, true);
  assert.equal(topologyChange.payloadChanged, false);
  assert.deepEqual(topologyChange.changedNodeIds, []);
  assert.deepEqual(topologyChange.changedLinkIds, ['edge']);
});

test('GraphStore preserves omitted patch axes and returns mutation receipts', () => {
  const store = new GraphStore({ seed: 5, validationMode: 'tolerant' });
  store.setData({
    nodes: [{ id: 'node', initialPosition: { x: 1, y: 2, z: 3 } }],
    links: []
  });

  const positionBefore = store.getNodePosition('node');
  assert.ok(positionBefore);
  const patch = store.applyPatch({
    nodes: { upsert: [{ id: 'node', initialPosition: { x: 9 } }] }
  });
  assert.equal(patch.revisionAfter, patch.revisionBefore + 1);
  assert.deepEqual(store.getNodePosition('node'), positionBefore);
  assert.deepEqual(store.getNode('node')?.initialPosition, { x: 9, y: 2, z: 3 });

  assert.equal(store.setNodeFixed('node', { x: 10, y: 11, z: 12 }), true);
  store.applyPatch({ nodes: { upsert: [{ id: 'node', fixed: { x: 20 } }] } });
  assert.deepEqual(store.getNodePosition('node'), { x: 20, y: 11, z: 12 });
  store.applyPatch({ nodes: { upsert: [{ id: 'node', fixed: null }] } });
  assert.deepEqual(store.getNodePosition('node'), { x: 20, y: 11, z: 12 });
  const revisionBeforeNoOp = store.currentRevision;
  const noOp = store.applyPatch({ nodes: { upsert: [{ id: 'node' }] } });
  assert.equal(noOp.revisionAfter, revisionBeforeNoOp);
  assert.deepEqual(noOp.unchangedNodeIds, ['node']);
  assert.deepEqual(noOp.updatedNodeIds, []);
  assert.equal(noOp.visualChanged, false);

  const rejected = store.applyPatch({
    nodes: { upsert: [{ id: 'bad', initialPosition: { x: Number.NaN } }] },
    links: { remove: ['missing'] }
  });
  assert.equal(rejected.frameScheduled, false);
  assert.equal(rejected.layoutRebuildScheduled, false);
  assert.equal(rejected.warnings.length, 1);
  assert.equal(rejected.warnings[0]?.code, 'FG_DATA_INVALID_POSITION');
  assert.equal(Object.isFrozen(rejected.warnings[0]?.context), true);
  assert.equal(rejected.skippedLinkIds.length, 1);
});

test('GraphStore skips invalid tolerant patch upserts without deleting valid records', () => {
  const tolerant = new GraphStore({ validationMode: 'tolerant' });
  tolerant.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [{ id: 'edge', source: 'a', target: 'b' }]
  });
  const handle = tolerant.getNodeHandle('a');

  tolerant.applyPatch({
    nodes: { upsert: [{ id: 'a', initialPosition: { x: Number.NaN } }] },
    links: { upsert: [{ id: 'edge', source: 'a', target: 'missing' }] }
  });

  assert.deepEqual(tolerant.getNodeHandle('a'), handle);
  assert.equal(tolerant.hasNode('a'), true);
  assert.equal(tolerant.hasLink('edge'), true);
  assert.deepEqual(tolerant.validationWarnings.map((warning) => warning.code), [
    'FG_DATA_INVALID_POSITION',
    'FG_DATA_MISSING_TARGET'
  ]);

  const strict = new GraphStore();
  strict.setData({ nodes: [{ id: 'kept' }], links: [] });
  assert.throws(
    () => strict.applyPatch(undefined as never),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_INVALID_ID'
  );
  assert.equal(strict.hasNode('kept'), true);
});

test('GraphStore keeps tolerant full-data rejection non-destructive and reserves empty arrays for clear', () => {
  const store = new GraphStore({ validationMode: 'tolerant' });
  store.setData({
    nodes: [{ id: 'kept-a' }, { id: 'kept-b' }],
    links: [{ id: 'kept-link', source: 'kept-a', target: 'kept-b' }]
  });
  const revision = store.currentRevision;
  const position = store.getNodePosition('kept-a');

  assert.throws(
    () => store.setData({ nodes: undefined, links: [] } as never),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_INVALID_ID'
  );
  assert.equal(store.currentRevision, revision);

  const rejected = store.setData({
    nodes: [{ id: Number.NaN }],
    links: [{ id: 'bad-link', source: 'missing', target: 'also-missing' }]
  });
  assert.equal(rejected.revisionAfter, revision);
  assert.equal(rejected.topologyChanged, false);
  assert.equal(rejected.simulationChanged, false);
  assert.equal(rejected.visualChanged, false);
  assert.deepEqual(rejected.unchangedNodeIds, ['kept-a', 'kept-b']);
  assert.deepEqual(rejected.unchangedLinkIds, ['kept-link']);
  assert.deepEqual(rejected.warnings.map((warning) => warning.code), [
    'FG_DATA_INVALID_ID',
    'FG_DATA_MISSING_SOURCE'
  ]);
  assert.deepEqual(store.getNodePosition('kept-a'), position);
  assert.equal(store.hasLink('kept-link'), true);

  const cleared = store.setData({ nodes: [], links: [] });
  assert.equal(cleared.revisionAfter, revision + 1);
  assert.equal(store.nodeCount, 0);
  assert.equal(store.linkCount, 0);
});

test('GraphStore plans payload patches without scanning unchanged records', () => {
  const store = new GraphStore();
  store.setData({
    nodes: Array.from({ length: 100 }, (_, index) => ({ id: `node-${index}`, data: { index } })),
    links: Array.from({ length: 99 }, (_, index) => ({
      id: `link-${index}`,
      source: `node-${index}`,
      target: `node-${index + 1}`
    }))
  });
  const instrumented = store as GraphStore & {
    forEachNode: GraphStore['forEachNode'];
    forEachLink: GraphStore['forEachLink'];
  };
  instrumented.forEachNode = () => {
    throw new Error('payload patch scanned every node');
  };
  instrumented.forEachLink = () => {
    throw new Error('payload patch scanned every link');
  };

  const change = store.applyPatch({
    nodes: { upsert: [{ id: 'node-50', data: { index: 50, updated: true } }] }
  });

  assert.equal(change.topologyChanged, false);
  assert.equal(change.simulationChanged, false);
  assert.deepEqual(change.changedNodeIds, ['node-50']);
  assert.equal(store.nodeCount, 100);
  assert.equal(store.linkCount, 99);
});

test('GraphStore prepares isolated layout mutations and commits only at the base revision', () => {
  const store = new GraphStore({ seed: 17 });
  store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [{ id: 'edge', source: 'a', target: 'b' }]
  });
  const revision = store.currentRevision;
  const plan = store.preparePatch({ nodes: { remove: ['b'], upsert: [{ id: 'c' }] } });

  assert.equal(plan.baseRevision, revision);
  assert.equal(plan.change.topologyChanged, true);
  assert.deepEqual(plan.change.removedNodeIds, ['b']);
  assert.deepEqual(plan.change.addedNodeIds, ['c']);
  assert.equal(plan.createLayoutInput().nodeIndices.length, 2);
  assert.equal(store.hasNode('b'), true);
  assert.equal(store.hasNode('c'), false);
  assert.equal(store.currentRevision, revision);

  const committed = store.commitPrepared(plan);
  assert.equal(committed.revisionBefore, revision);
  assert.equal(store.hasNode('b'), false);
  assert.equal(store.hasNode('c'), true);
  assert.equal(store.hasLink('edge'), false);

  assert.throws(
    () => store.commitPrepared(plan),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_STALE_MUTATION_PLAN'
  );
});

test('GraphStore payload-only prepared plans avoid typed-buffer copies', () => {
  const store = new GraphStore();
  store.setData({
    nodes: Array.from({ length: 200 }, (_, index) => ({ id: `node-${index}`, data: { index } })),
    links: []
  });
  const typedArrayPrototype = Float32Array.prototype;
  const originalSlice = typedArrayPrototype.slice;
  let sliceCalls = 0;
  typedArrayPrototype.slice = function countedSlice(this: Float32Array, start?: number, end?: number): Float32Array {
    sliceCalls += 1;
    return originalSlice.call(this, start, end);
  };
  try {
    const plan = store.preparePatch({
      nodes: { upsert: [{ id: 'node-100', data: { index: 100, changed: true } }] }
    });
    assert.equal(sliceCalls, 0);
    store.commitPrepared(plan);
    assert.deepEqual(store.getNode('node-100')?.data, { index: 100, changed: true });
  } finally {
    typedArrayPrototype.slice = originalSlice;
  }
});

test('GraphStore rejects stale and foreign prepared mutations without changing the target', () => {
  const first = new GraphStore();
  first.setData({ nodes: [{ id: 'a' }], links: [] });
  const stale = first.prepareClear();
  first.applyPatch({ nodes: { upsert: [{ id: 'a', data: { changed: true } }] } });
  assert.throws(
    () => first.commitPrepared(stale),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_STALE_MUTATION_PLAN'
  );
  assert.equal(first.hasNode('a'), true);

  const second = new GraphStore();
  second.setData({ nodes: [{ id: 'b' }], links: [] });
  const foreign = second.prepareClear();
  assert.throws(
    () => first.commitPrepared(foreign),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_STALE_MUTATION_PLAN'
  );
  assert.equal(first.hasNode('a'), true);
  assert.equal(second.hasNode('b'), true);
});

test('GraphStore cascades through adjacency and updates it when a link changes endpoints', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    links: [
      { id: 'moved', source: 'a', target: 'b' },
      { id: 'incident', source: 'b', target: 'c' },
      { id: 'unrelated', source: 'c', target: 'd' }
    ]
  });

  const rescued = store.applyPatch({
    nodes: { remove: ['b'] },
    links: { upsert: [{ id: 'moved', source: 'a', target: 'c' }] }
  });
  assert.deepEqual(rescued.cascadedLinkIds, ['incident']);
  assert.deepEqual(rescued.removedLinkIds, ['incident']);
  assert.equal(store.hasLink('moved'), true);
  assert.equal(store.hasLink('incident'), false);
  assert.equal(store.hasLink('unrelated'), true);
  assert.deepEqual(store.getLink('moved'), { id: 'moved', source: 'a', target: 'c' });

  store.applyPatch({ nodes: { remove: ['c'] } });
  assert.equal(store.hasLink('moved'), false);
  assert.equal(store.hasLink('unrelated'), false);
});

test('GraphStore keeps patch-only controls out of full data and serializes tolerant receipts', () => {
  const strict = new GraphStore();
  assert.throws(
    () => strict.setData({ nodes: [{ id: 'bad', fixed: null } as never], links: [] }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_INVALID_POSITION'
  );

  const tolerant = new GraphStore({ validationMode: 'tolerant' });
  tolerant.setData({ nodes: [{ id: 'kept' }], links: [] });
  const receipt = tolerant.applyPatch({
    nodes: { upsert: [{ id: 'bad', initialPosition: { x: Number.NaN } }] }
  });
  assert.doesNotThrow(() => JSON.stringify(receipt));
  assert.equal(JSON.parse(JSON.stringify(receipt)).warnings[0].code, 'FG_DATA_INVALID_POSITION');
  assert.equal(Object.isFrozen(receipt.warnings[0]?.context), true);
  tolerant.applyPatch({ nodes: { upsert: [{ id: 'kept', fixed: null }] } });
  assert.equal(tolerant.getNode('kept')?.fixed, undefined);
  const invalidReset = tolerant.applyPatch({
    nodes: { upsert: [{ id: 'kept', resetPosition: 'yes' as never }] }
  });
  assert.deepEqual(invalidReset.skippedNodeIds, ['kept']);
  assert.equal(invalidReset.warnings[0]?.code, 'FG_DATA_INVALID_POSITION');
});

test('GraphStore reports full-replacement cascades only when an endpoint disappears', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    links: [
      { id: 'surviving-endpoints', source: 'a', target: 'b' },
      { id: 'missing-target', source: 'a', target: 'c' }
    ]
  });

  const receipt = store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: []
  });
  assert.deepEqual(receipt.removedLinkIds, ['surviving-endpoints', 'missing-target']);
  assert.deepEqual(receipt.cascadedLinkIds, ['missing-target']);
  assert.ok(receipt.cascadedLinkIds.every((id) => receipt.removedLinkIds.includes(id)));
});

test('GraphStore validates a direct patch plan atomically before node removal', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [{ id: 'edge', source: 'a', target: 'b' }]
  });

  assert.throws(
    () => store.applyPatch({
      nodes: { remove: ['b'] },
      links: { upsert: [{ id: 'replacement', source: 'a', target: 'b' }] }
    }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_MISSING_TARGET'
  );
  assert.equal(store.hasNode('b'), true);
  assert.equal(store.hasLink('edge'), true);
  assert.equal(store.hasLink('replacement'), false);
});

test('GraphStore keeps rejected and empty mutations revision-neutral', () => {
  const store = new GraphStore({ validationMode: 'tolerant' });
  store.setData({ nodes: [{ id: 'kept' }], links: [] });
  const revision = store.currentRevision;

  const rejected = store.applyPatch({
    nodes: { upsert: [{ id: 'invalid', initialPosition: { x: Number.NaN } }] },
    links: { remove: ['missing-link'] }
  });
  assert.equal(rejected.revision, revision);
  assert.equal(store.currentRevision, revision);

  const empty = store.applyPatch({});
  assert.equal(empty.revision, revision);
  assert.equal(store.currentRevision, revision);
  assert.equal(store.clear().revision, revision + 1);
  assert.equal(store.clear().revision, revision + 1);
});
