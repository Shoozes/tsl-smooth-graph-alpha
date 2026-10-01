import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GraphController } from '../../source/core/GraphController.js';
import { GraphError } from '../../source/core/errors.js';
import { NodeFlags, type ForceGraphOptions, type WorkerLike } from '../../source/core/types.js';
import { GraphStore } from '../../source/data/GraphStore.js';
import type { ThreePlatform } from '../../source/platform/three/createThreePlatform.js';
import { createForceGraph3D } from '../../source/index.js';
import { createHeadlessForceGraph } from '../../source/headless/index.js';

type GraphControllerExposesMutableStore = 'store' extends keyof GraphController ? true : false;
const graphControllerExposesMutableStore: GraphControllerExposesMutableStore = false;
void graphControllerExposesMutableStore;

class RecordingWorker implements WorkerLike {
  readonly commands: unknown[] = [];
  terminated = false;
  throwOnNextPost = false;
  detachTransfers = false;
  onPostMessage: ((message: unknown) => void) | undefined;
  private readonly listeners = new Map<string, Set<EventListener>>();

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.throwOnNextPost) {
      this.throwOnNextPost = false;
      throw new Error('post failed');
    }
    const recorded = this.detachTransfers && transfer.length > 0
      ? structuredClone(message, { transfer })
      : message;
    this.commands.push(recorded);
    this.onPostMessage?.(recorded);
  }

  addEventListener(type: 'message' | 'error', listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: 'message' | 'error', listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitError(message: string): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener({ message } as ErrorEvent);
    }
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data } as MessageEvent<unknown>);
    }
  }
}

function initializeRevisions(worker: RecordingWorker): number[] {
  return worker.commands.flatMap((command) => {
    const revisions = typeof command === 'object'
      && command !== null
      && (command as { type?: unknown }).type === 'initialize'
      && typeof (command as { revision?: unknown }).revision === 'number'
      ? [(command as { revision: number }).revision]
      : [];
    return revisions;
  });
}

test('headless graph coordinates data, layout, selection, and semantic interaction events', async () => {
  const graph = await createForceGraph3D<{ weight: number }>({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false, seed: 7 },
    interaction: { selection: 'multiple', dragNodes: { releaseBehavior: 'unpin' } },
    nodes: { radius: (node) => node.data?.weight ?? 1 }
  });
  const hoverEvents: Array<string | undefined> = [];
  const clickEvents: string[] = [];
  const dragPhases: string[] = [];
  graph.on('node-hover', (event) => hoverEvents.push(event.nodeId as string | undefined));
  graph.on('node-click', (event) => clickEvents.push(event.nodeId as string));
  graph.on('node-drag', (event) => dragPhases.push(event.phase));

  const data = {
    nodes: [{ id: 'root', data: { weight: 2 } }, { id: 'leaf', data: { weight: 1 } }],
    links: [{ id: 'root-leaf', source: 'root', target: 'leaf' }]
  } as const;
  graph.setData(data);
  await graph.stepLayout(12);
  graph.setSelection(['root', 'leaf']);
  graph.setHoveredNode('root');
  graph.notifyNodeClick('root', { shiftKey: true });
  graph.beginNodeDrag('leaf', { x: 10, y: 11, z: 12 });
  graph.moveNodeDrag('leaf', { x: 13, y: 14, z: 15 });
  graph.endNodeDrag('leaf', { x: 13, y: 14, z: 15 });

  assert.deepEqual(hoverEvents, ['root']);
  assert.deepEqual(clickEvents, ['root']);
  assert.deepEqual(dragPhases, ['start', 'move', 'end']);
  assert.equal(graph.getDiagnostics().hostMode, 'headless');
  assert.equal(graph.getDiagnostics().layoutBackend, 'local');
  assert.equal(graph.getDiagnostics().nodeCount, 2);
  assert.deepEqual(graph.getNodePosition('leaf'), { x: 13, y: 14, z: 15 });
  const bounds = graph.getGraphBounds();
  assert.ok(bounds);
  assert.ok(bounds.min.x <= 13 && bounds.max.x >= 13);
  assert.ok(bounds.min.y <= 14 && bounds.max.y >= 14);
  assert.ok(bounds.min.z <= 15 && bounds.max.z >= 15);

  graph.dispose();
  assert.throws(
    () => graph.getNodePosition('root'),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RESOURCE_ALREADY_DISPOSED'
  );
  assert.throws(
    () => graph.getGraphBounds(),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RESOURCE_ALREADY_DISPOSED'
  );
});

test('controller batches application-managed visual flags and validates state themes', async () => {
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });

  assert.deepEqual(
    graph.setNodeFlagsMany(['a', 'b', 'a', 'missing'], NodeFlags.Dimmed | NodeFlags.Hidden),
    ['a', 'b']
  );
  assert.equal(graph.setNodeFlags('a', 0, NodeFlags.Hidden), true);
  assert.equal(graph.setNodeFlags('missing', NodeFlags.Dimmed), false);
  assert.throws(
    () => graph.setNodeFlags('a', NodeFlags.Selected),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID'
  );
  assert.throws(
    () => graph.setStateTheme({ hovered: { colorMix: 2 } }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID'
  );
  assert.throws(
    () => graph.setStateTheme({ dimmed: { opacity: 0.5 } } as unknown as Parameters<typeof graph.setStateTheme>[0]),
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_RENDER_PLATFORM_INVALID'
      && error.message.includes('unsupported field opacity')
  );
  graph.setStateTheme({ dimmed: { scale: 0.6, color: 0x000000, colorMix: 0.5 } });
  graph.dispose();
});

test('headless graph exposes copied current bounds without owning a camera', async () => {
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({
    nodes: [
      { id: 'low', initialPosition: { x: -2, y: 3, z: -4 } },
      { id: 'high', initialPosition: { x: 5, y: 7, z: 11 } }
    ],
    links: []
  });

  const bounds = graph.getGraphBounds();
  assert.deepEqual(bounds, {
    min: { x: -2, y: 3, z: -4 },
    max: { x: 5, y: 7, z: 11 }
  });
  assert.ok(Object.isFrozen(bounds));
  assert.ok(Object.isFrozen(bounds?.min));
  assert.ok(Object.isFrozen(bounds?.max));

  graph.clear();
  assert.equal(graph.getGraphBounds(), undefined);
  graph.dispose();
});

test('consumer snapshot export/import preserves graph structure and rejects foreign envelopes', async () => {
  const graph = await createForceGraph3D<{ label: string }, { weight: number }>({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({
    nodes: [
      { id: 'a', data: { label: 'first' }, initialPosition: { x: 1, y: 2, z: 3 } },
      { id: 'b', data: { label: 'second' } }
    ],
    links: [{ id: 'a-b', source: 'a', target: 'b', data: { weight: 2 } }]
  });

  const snapshot = graph.exportSnapshot();
  assert.equal(snapshot.schema, 'tsl-smooth-graph/graph-snapshot');
  assert.equal(snapshot.version, 2);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.data));
  assert.ok(Object.isFrozen(snapshot.data.nodes));
  assert.deepEqual(snapshot.data.nodes[0], {
    id: 'a',
    data: { label: 'first' },
    initialPosition: { x: 1, y: 2, z: 3 }
  });

  graph.clear();
  graph.importSnapshot(snapshot);
  assert.equal(graph.getDiagnostics().nodeCount, 2);
  assert.equal(graph.getDiagnostics().linkCount, 1);
  assert.deepEqual(graph.getGraphView().getLink('a-b')?.data, { weight: 2 });
  assert.throws(
    () => graph.importSnapshot({ schema: 'foreign', version: 1, data: snapshot.data } as never),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_INVALID_ID'
  );
  graph.importSnapshot({ schema: '@ours/forcegraph-tsl/graph-snapshot', version: 1, data: snapshot.data });
  assert.throws(() => graph.importSnapshot({ schema: 'tsl-smooth-graph/graph-snapshot', version: 3, data: snapshot.data } as never));
  graph.dispose();
});

test('tolerant snapshot import cannot erase live graph or interaction state', async () => {
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false },
    validation: { mode: 'tolerant' },
    interaction: { selection: 'multiple' }
  });
  graph.setData({ nodes: [{ id: 'kept' }], links: [] });
  graph.setSelection(['kept']);
  graph.setHoveredNode('kept');
  const revision = graph.getGraphView().revision;
  const selectionEvents: Array<readonly (string | number)[]> = [];
  graph.on('selection-change', (event) => selectionEvents.push(event.nodeIds));

  assert.throws(
    () => graph.importSnapshot({
      schema: '@ours/forcegraph-tsl/graph-snapshot',
      version: 1,
      data: { nodes: undefined, links: [] }
    } as never),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_INVALID_ID'
  );
  const rejected = graph.importSnapshot({
    schema: '@ours/forcegraph-tsl/graph-snapshot',
    version: 1,
    data: { nodes: [{ id: Number.NaN }], links: [] }
  } as never);
  assert.equal(rejected.revisionAfter, revision);
  assert.equal(rejected.visualChanged, false);
  assert.equal(graph.getGraphView().hasNode('kept'), true);
  assert.deepEqual(selectionEvents, []);

  const hoverEvents: Array<string | number | undefined> = [];
  graph.on('node-hover', (event) => hoverEvents.push(event.nodeId));
  graph.setHoveredNode(undefined);
  assert.deepEqual(hoverEvents, [undefined]);
  graph.dispose();
});

test('headless graph exposes a frozen read view without exposing mutable store state', async () => {
  const graph = await createForceGraph3D<{ label: string }>({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false }
  });
  const inputPosition = { x: 1, y: 2, z: 3 };
  const inputNode = { id: 'node', data: { label: 'original' }, initialPosition: inputPosition };
  graph.setData({ nodes: [inputNode], links: [] });

  const view = graph.getGraphView();
  assert.equal('store' in (graph as object), false);
  assert.ok(Object.isFrozen(view));
  assert.equal(view.revision, 1);
  assert.equal(view.nodeCount, 1);
  assert.equal(view.linkCount, 0);
  assert.equal(view.hasNode('node'), true);

  inputNode.id = 'changed';
  inputPosition.x = 99;
  const record = view.getNode('node');
  const position = view.getNodePosition('node');
  assert.ok(record);
  assert.ok(position);
  assert.equal(record.id, 'node');
  assert.deepEqual(record.initialPosition, { x: 1, y: 2, z: 3 });
  assert.deepEqual(position, { x: 1, y: 2, z: 3 });
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.initialPosition));
  assert.ok(Object.isFrozen(position));
  assert.equal(Reflect.set(record, 'id', 'tampered'), false);
  assert.equal(Reflect.set(position, 'x', 100), false);

  graph.dispose();
  assert.throws(
    () => view.nodeCount,
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RESOURCE_ALREADY_DISPOSED'
  );
});

test('headless graph reconciles hover and selection when a patch removes a node', async () => {
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false },
    interaction: { selection: 'multiple' }
  });
  const selections: string[][] = [];
  const hovers: Array<string | undefined> = [];
  graph.on('selection-change', (event) => selections.push([...event.nodeIds] as string[]));
  graph.on('node-hover', (event) => hovers.push(event.nodeId as string | undefined));

  graph.setData({ nodes: [{ id: 'remove' }, { id: 'keep' }], links: [] });
  graph.setSelection(['remove']);
  graph.setHoveredNode('remove');
  graph.applyPatch({ nodes: { remove: ['remove'] } });

  assert.deepEqual(selections, [['remove'], []]);
  assert.deepEqual(hovers, ['remove', undefined]);
  graph.dispose();
});

test('payload-only patches preserve the current local layout epoch and solver state', async () => {
  const graph = await createForceGraph3D<{ weight: number }>({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false, seed: 9 },
    nodes: { radius: (node) => node.data?.weight ?? 1 }
  });
  graph.setData({
    nodes: [{ id: 'a', data: { weight: 1 } }, { id: 'b', data: { weight: 2 } }],
    links: [{ id: 'a-b', source: 'a', target: 'b' }]
  });
  await graph.stepLayout(3);
  const before = graph.getDiagnostics();

  graph.applyPatch({ nodes: { upsert: [{ id: 'a', data: { weight: 4 } }] } });

  const after = graph.getDiagnostics();
  assert.equal(after.layoutRevision, before.layoutRevision);
  assert.equal(after.layoutAlpha, before.layoutAlpha);
  assert.equal(after.layoutRunning, before.layoutRunning);
  assert.deepEqual(graph.getGraphView().getNode('a')?.data, { weight: 4 });
  graph.dispose();
});

test('worker layout replacement occurs only for topology changes and reconciles interaction state', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D<{ label: string }>({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false },
    interaction: { selection: 'multiple' }
  });
  const selections: string[][] = [];
  const hovers: Array<string | undefined> = [];
  graph.on('selection-change', ({ nodeIds }) => selections.push([...nodeIds] as string[]));
  graph.on('node-hover', ({ nodeId }) => hovers.push(nodeId as string | undefined));
  graph.setData({
    nodes: [{ id: 'a', data: { label: 'first' } }, { id: 'b', data: { label: 'second' } }],
    links: [{ id: 'a-b', source: 'a', target: 'b' }]
  });
  graph.setSelection(['a']);
  graph.setHoveredNode('a');
  const before = graph.getDiagnostics();
  assert.deepEqual(initializeRevisions(worker), [1]);

  graph.applyPatch({ nodes: { upsert: [{ id: 'a', data: { label: 'payload-only' } }] } });

  assert.equal(graph.getDiagnostics().layoutRevision, before.layoutRevision);
  assert.deepEqual(initializeRevisions(worker), [1]);

  graph.applyPatch({ nodes: { remove: ['a'] } });

  assert.equal(graph.getDiagnostics().layoutRevision, before.layoutRevision + 1);
  assert.deepEqual(initializeRevisions(worker), [1, 2]);
  assert.deepEqual(selections, [['a'], []]);
  assert.deepEqual(hovers, ['a', undefined]);
  assert.equal(graph.getDiagnostics().nodeCount, 1);
  assert.equal(graph.getDiagnostics().linkCount, 0);
  graph.dispose();
  assert.equal(worker.terminated, true);
});

test('async worker mutations commit only after matching replacement acknowledgement', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, workerStepTimeoutMs: 20 }
  });
  const pending = graph.setDataAsync({ nodes: [{ id: 'a' }], links: [] });
  const initialize = worker.commands.at(-1) as { type?: unknown; requestId?: unknown; revision?: unknown } | undefined;
  assert.equal(initialize?.type, 'initialize');
  assert.equal(graph.getDiagnostics().nodeCount, 0);
  worker.emitMessage({
    type: 'ack',
    operation: 'initialize',
    requestId: initialize?.requestId,
    revision: 2,
    state: 'ready',
    alpha: 1,
    running: false
  });
  await Promise.resolve();
  assert.equal(graph.getDiagnostics().nodeCount, 0);
  worker.emitMessage({
    type: 'ack',
    operation: 'initialize',
    requestId: initialize?.requestId,
    revision: 1,
    state: 'ready',
    alpha: 1,
    running: false
  });
  await pending;
  assert.equal(graph.getDiagnostics().nodeCount, 1);

  const patchPending = graph.applyPatchAsync({ nodes: { upsert: [{ id: 'b' }] } });
  const replacement = worker.commands.at(-1) as { type?: unknown; requestId?: unknown; revision?: unknown } | undefined;
  assert.equal(replacement?.type, 'initialize');
  worker.emitMessage({
    type: 'nack',
    operation: 'initialize',
    requestId: replacement?.requestId,
    revision: replacement?.revision,
    code: 'FG_DATA_STALE_MUTATION_PLAN',
    message: 'test delayed rejection'
  });
  await assert.rejects(
    patchPending,
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_LAYOUT_WORKER_FAILED'
      && error.context.operation === 'initialize'
  );
  assert.equal(graph.getDiagnostics().nodeCount, 1);
  assert.equal(graph.getGraphView().hasNode('b'), false);
  graph.dispose();
});

test('async worker mutations can recover a rejected replacement to local atomically', async () => {
  const worker = new RecordingWorker();
  worker.detachTransfers = true;
  const failures: boolean[] = [];
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, failurePolicy: 'fallback-local' }
  });
  graph.on('layout-failed', (event) => failures.push(event.recovered));
  const pending = graph.setDataAsync({ nodes: [{ id: 'a' }], links: [] });
  const initialize = worker.commands.at(-1) as { requestId?: number; revision?: number } | undefined;
  worker.emitMessage({
    type: 'nack',
    operation: 'initialize',
    requestId: initialize?.requestId,
    revision: initialize?.revision,
    code: 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
    message: 'test fallback rejection'
  });
  await pending;
  assert.deepEqual(failures, [true]);
  assert.equal(graph.getDiagnostics().layoutBackend, 'local');
  assert.equal(graph.getDiagnostics().nodeCount, 1);
  graph.dispose();
});

test('async worker replacement folds auto-start into the matching ACK', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: true }
  });
  const pending = graph.setDataAsync({ nodes: [{ id: 'a' }], links: [] });
  const initialize = worker.commands.at(-1) as {
    type?: unknown;
    requestId?: number;
    revision?: number;
    startAfterInitialize?: boolean;
  } | undefined;
  assert.equal(initialize?.type, 'initialize');
  assert.equal(initialize?.startAfterInitialize, true);
  assert.equal(worker.commands.filter((command) => (command as { type?: unknown }).type === 'start').length, 0);
  assert.equal(graph.getDiagnostics().nodeCount, 0);
  worker.emitMessage({
    type: 'ack',
    operation: 'initialize',
    requestId: initialize?.requestId,
    revision: initialize?.revision,
    state: 'running',
    alpha: 1,
    running: true
  });
  await pending;
  assert.equal(graph.getDiagnostics().nodeCount, 1);
  assert.equal(graph.getDiagnostics().layoutRunning, true);
  graph.dispose();
});

test('async worker pin waits for acknowledgement before changing graph state', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false }
  });
  const dataPending = graph.setDataAsync({ nodes: [{ id: 'a' }], links: [] });
  const initialize = worker.commands.at(-1) as { requestId?: number; revision?: number } | undefined;
  worker.emitMessage({
    type: 'ack',
    operation: 'initialize',
    requestId: initialize?.requestId,
    revision: initialize?.revision,
    state: 'ready',
    alpha: 1,
    running: false
  });
  await dataPending;

  const pinPending = graph.setNodeFixedAsync('a', { x: 4, y: 5, z: 6 });
  const pin = worker.commands.at(-1) as { type?: unknown; requestId?: number; revision?: number } | undefined;
  assert.equal(pin?.type, 'pin');
  const before = graph.getNodePosition('a');
  assert.deepEqual(graph.getNodePosition('a'), before);
  worker.emitMessage({
    type: 'snapshot',
    snapshot: {
      nodeIndices: new Uint32Array([0]),
      positions: new Float32Array([4, 5, 6]),
      velocities: new Float32Array(3),
      alpha: 1,
      settled: false
    },
    steps: 0,
    lastStepMs: 0,
    revision: graph.getDiagnostics().layoutRevision
  });
  await Promise.resolve();
  assert.deepEqual(graph.getNodePosition('a'), before);
  worker.emitMessage({
    type: 'ack',
    operation: 'pin',
    requestId: pin?.requestId,
    revision: graph.getDiagnostics().layoutRevision,
    state: 'ready',
    alpha: 1,
    running: false
  });
  assert.equal(await pinPending, true);
  assert.deepEqual(graph.getNodePosition('a'), { x: 4, y: 5, z: 6 });
  graph.dispose();
});

test('async worker command NACK recovers to local before committing pin state', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, failurePolicy: 'fallback-local' }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });

  const pinPending = graph.setNodeFixedAsync('a', { x: 8, y: 9, z: 10 });
  const pin = worker.commands.at(-1) as { type?: unknown; requestId?: number; revision?: number } | undefined;
  assert.equal(pin?.type, 'pin');
  worker.emitMessage({
    type: 'nack',
    operation: 'pin',
    requestId: pin?.requestId,
    revision: pin?.revision,
    code: 'FG_DATA_INVALID_POSITION',
    message: 'test command rejection'
  });

  assert.equal(await pinPending, true);
  assert.equal(graph.getDiagnostics().layoutBackend, 'local');
  assert.deepEqual(graph.getNodePosition('a'), { x: 8, y: 9, z: 10 });
  graph.dispose();
});

test('built-in async drag serializes ACKs and coalesces worker moves', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });
  const phases: string[] = [];
  graph.on('node-drag', ({ phase }) => phases.push(phase));

  const begin = graph.beginNodeDragAsync('a', { x: 1, y: 2, z: 3 });
  await Promise.resolve();
  const beginCommand = worker.commands.at(-1) as { requestId?: number; revision?: number } | undefined;
  worker.emitMessage({
    type: 'ack',
    operation: 'pin',
    requestId: beginCommand?.requestId,
    revision: beginCommand?.revision,
    state: 'ready',
    alpha: 1,
    running: false
  });
  await begin;

  const firstMove = graph.moveNodeDragAsync('a', { x: 2, y: 3, z: 4 });
  const secondMove = graph.moveNodeDragAsync('a', { x: 5, y: 6, z: 7 });
  await Promise.resolve();
  const moveCommand = worker.commands.at(-1) as { type?: unknown; requestId?: number; revision?: number; position?: { x: number; y: number; z: number } } | undefined;
  assert.equal(moveCommand?.type, 'pin');
  assert.deepEqual(moveCommand?.position, { x: 5, y: 6, z: 7 });
  worker.emitMessage({
    type: 'ack',
    operation: 'pin',
    requestId: moveCommand?.requestId,
    revision: moveCommand?.revision,
    state: 'ready',
    alpha: 1,
    running: false
  });
  await Promise.all([firstMove, secondMove]);

  const end = graph.endNodeDragAsync('a', { x: 5, y: 6, z: 7 });
  await Promise.resolve();
  const releaseCommand = worker.commands.at(-1) as { requestId?: number; revision?: number } | undefined;
  worker.emitMessage({
    type: 'ack',
    operation: 'release',
    requestId: releaseCommand?.requestId,
    revision: releaseCommand?.revision,
    state: 'ready',
    alpha: 1,
    running: false
  });
  await end;
  assert.deepEqual(phases, ['start', 'move', 'end']);
  assert.deepEqual(graph.getNodePosition('a'), { x: 5, y: 6, z: 7 });
  graph.dispose();
});

test('built-in async drag yields to a delayed worker replacement before pinning', { timeout: 2_000 }, async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });

  const replacement = graph.applyPatchAsync({ nodes: { upsert: [{ id: 'b' }] } });
  await Promise.resolve();
  const initialize = worker.commands.at(-1) as { type?: unknown; requestId?: number; revision?: number } | undefined;
  assert.equal(initialize?.type, 'initialize');

  const drag = graph.beginNodeDragAsync('a', { x: 11, y: 12, z: 13 });
  await Promise.resolve();
  assert.equal((worker.commands.at(-1) as { type?: unknown } | undefined)?.type, 'initialize');

  let replacementTimerRan = false;
  setTimeout(() => {
    replacementTimerRan = true;
    worker.emitMessage({
      type: 'ack',
      operation: 'initialize',
      requestId: initialize?.requestId,
      revision: initialize?.revision,
      state: 'ready',
      alpha: 1,
      running: false
    });
  }, 0);
  await replacement;
  assert.equal(replacementTimerRan, true);

  await Promise.resolve();
  const pin = worker.commands.at(-1) as { type?: unknown; requestId?: number; revision?: number } | undefined;
  assert.equal(pin?.type, 'pin');
  setTimeout(() => worker.emitMessage({
    type: 'ack',
    operation: 'pin',
    requestId: pin?.requestId,
    revision: pin?.revision,
    state: 'ready',
    alpha: 1,
    running: false
  }), 0);
  await drag;
  assert.deepEqual(graph.getNodePosition('a'), { x: 11, y: 12, z: 13 });
  graph.dispose();
});

test('built-in async drag clears an accepted session when release is rejected', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });

  const begin = graph.beginNodeDragAsync('a', { x: 1, y: 2, z: 3 });
  await Promise.resolve();
  const pin = worker.commands.at(-1) as { requestId?: number; revision?: number } | undefined;
  worker.emitMessage({
    type: 'ack',
    operation: 'pin',
    requestId: pin?.requestId,
    revision: pin?.revision,
    state: 'ready',
    alpha: 1,
    running: false
  });
  await begin;

  const end = graph.endNodeDragAsync('a', { x: 1, y: 2, z: 3 });
  await Promise.resolve();
  const release = worker.commands.at(-1) as { requestId?: number; revision?: number } | undefined;
  worker.emitMessage({
    type: 'nack',
    operation: 'release',
    requestId: release?.requestId,
    revision: release?.revision,
    code: 'FG_LAYOUT_WORKER_FAILED',
    message: 'test release rejection'
  });
  await assert.rejects(end, (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_FAILED');

  const commandCount = worker.commands.length;
  await graph.moveNodeDragAsync('a', { x: 4, y: 5, z: 6 });
  assert.equal(worker.commands.length, commandCount);
  graph.dispose();
});

test('built-in async drag rejects queued work when the graph is disposed', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });

  const begin = graph.beginNodeDragAsync('a', { x: 1, y: 2, z: 3 });
  await Promise.resolve();
  assert.equal((worker.commands.at(-1) as { type?: unknown } | undefined)?.type, 'pin');
  const move = graph.moveNodeDragAsync('a', { x: 4, y: 5, z: 6 });
  graph.dispose();

  await assert.rejects(begin, (error: unknown) => error instanceof GraphError && error.code === 'FG_RESOURCE_ALREADY_DISPOSED');
  await assert.rejects(move, (error: unknown) => error instanceof GraphError && error.code === 'FG_RESOURCE_ALREADY_DISPOSED');
});

test('worker failure freezes simulation mutations without losing payload interaction paths', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, failurePolicy: 'freeze' }
  });
  const failures: boolean[] = [];
  graph.on('layout-failed', (event) => failures.push(event.recovered));
  graph.setData({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
  const before = graph.getNodePosition('a');
  worker.emitError('worker stopped');

  assert.deepEqual(failures, [false]);
  assert.equal(graph.getDiagnostics().layoutState, 'failed');
  assert.throws(
    () => graph.setNodeFixed('a', { x: 99, y: 99, z: 99 }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_MUTATION_FROZEN'
  );
  assert.deepEqual(graph.getNodePosition('a'), before);
  assert.throws(
    () => graph.applyPatch({ nodes: { upsert: [{ id: 'c' }] } }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_MUTATION_FROZEN'
  );
  const payload = graph.applyPatch({ nodes: { upsert: [{ id: 'a', data: { ok: true } }] } });
  assert.equal(payload.frameScheduled, true);
  graph.setHoveredNode('a');
  assert.deepEqual(graph.getNodePosition('a'), before);
  assert.doesNotThrow(() => graph.dispose());
});

test('payload-only controller patches skip retained-capacity preflight clones', async () => {
  const graph = await createForceGraph3D<{ label?: string }>({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'node', data: { label: 'before' } }], links: [] });
  const originalClone = GraphStore.prototype.clone;
  GraphStore.prototype.clone = function cloneShouldNotRun(): never {
    throw new Error('payload-only patch cloned the full store');
  };
  try {
    const receipt = graph.applyPatch({ nodes: { upsert: [{ id: 'node', data: { label: 'after' } }] } });
    assert.equal(receipt.payloadChanged, true);
    assert.equal(receipt.layoutRebuildScheduled, false);
  } finally {
    GraphStore.prototype.clone = originalClone;
    graph.dispose();
  }
});

test('prepared controller mutations avoid clone preflight and keep layout failures atomic', async () => {
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });
  const originalClone = GraphStore.prototype.clone;
  GraphStore.prototype.clone = function cloneShouldNotRun(): never {
    throw new Error('prepared mutation used the legacy clone preflight');
  };
  try {
    const added = graph.applyPatch({ nodes: { upsert: [{ id: 'b' }] } });
    assert.equal(added.layoutRebuildScheduled, true);
    assert.equal(graph.getDiagnostics().nodeCount, 2);
    const cleared = graph.clear();
    assert.equal(cleared.layoutRebuildScheduled, true);
    assert.equal(graph.getDiagnostics().nodeCount, 0);
  } finally {
    GraphStore.prototype.clone = originalClone;
    graph.dispose();
  }
});

test('prepared replacement buffers neutral local snapshots and rejects re-entry', async () => {
  const local = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false }
  });
  let settledEvents = 0;
  local.on('layout-settled', () => { settledEvents += 1; });
  local.setData({ nodes: [{ id: 'a' }], links: [] });
  local.startLayout();
  local.clear();
  assert.equal(local.getDiagnostics().nodeCount, 0);
  assert.equal(settledEvents, 0);
  local.dispose();

  const worker = new RecordingWorker();
  let workerGraph: Awaited<ReturnType<typeof createForceGraph3D>> | undefined;
  const reentryErrors: unknown[] = [];
  workerGraph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, failurePolicy: 'freeze' }
  });
  workerGraph.setData({ nodes: [{ id: 'a' }], links: [] });
  worker.onPostMessage = (message) => {
    if (!workerGraph || (message as { type?: unknown }).type !== 'initialize') {
      return;
    }
    const attempts = [
      () => workerGraph?.setData({ nodes: [{ id: 'reentrant-data' }], links: [] }),
      () => workerGraph?.applyPatch({ nodes: { upsert: [{ id: 'reentrant-patch' }] } }),
      () => workerGraph?.clear(),
      () => workerGraph?.startLayout(),
      () => workerGraph?.stopLayout(),
      () => workerGraph?.restartLayout(),
      () => workerGraph?.setNodeFixed('a', { x: 1, y: 2, z: 3 }),
      () => workerGraph?.releaseNode('a')
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        reentryErrors.push(error);
      }
    }
  };
  workerGraph.applyPatch({ nodes: { upsert: [{ id: 'b' }] } });
  assert.equal(reentryErrors.length, 8);
  assert.ok(reentryErrors.every((error) => error instanceof GraphError && error.code === 'FG_DATA_MUTATION_IN_PROGRESS'));
  assert.equal(workerGraph.getDiagnostics().nodeCount, 2);
  workerGraph.dispose();
});

test('prepared local replacement restores the prior layout epoch when commit fails', async () => {
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });
  const before = graph.getDiagnostics();
  const beforePosition = graph.getNodePosition('a');
  const originalCommit = GraphStore.prototype.commitPrepared;
  GraphStore.prototype.commitPrepared = function commitPreparedShouldFail(): never {
    throw new GraphError('FG_DATA_STALE_MUTATION_PLAN', 'test stale prepared mutation');
  };
  try {
    assert.throws(
      () => graph.applyPatch({ nodes: { upsert: [{ id: 'b' }] } }),
      (error: unknown) => error instanceof GraphError && error.code === 'FG_DATA_STALE_MUTATION_PLAN'
    );
  } finally {
    GraphStore.prototype.commitPrepared = originalCommit;
  }
  const after = graph.getDiagnostics();
  assert.equal(after.nodeCount, 1);
  assert.equal(after.layoutRevision, before.layoutRevision);
  assert.deepEqual(graph.getNodePosition('a'), beforePosition);
  assert.equal(graph.getGraphView().hasNode('b'), false);
  graph.dispose();
});

test('prepared worker replacement failure leaves the live store unchanged', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, failurePolicy: 'freeze' }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });
  worker.throwOnNextPost = true;
  assert.throws(
    () => graph.applyPatch({ nodes: { upsert: [{ id: 'b' }] } }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_FAILED'
  );
  assert.equal(graph.getGraphView().hasNode('a'), true);
  assert.equal(graph.getGraphView().hasNode('b'), false);
  assert.equal(graph.getDiagnostics().nodeCount, 1);
  graph.dispose();
});

test('GraphController disposal releases its owned graph store exactly once', async () => {
  const originalRelease = GraphStore.prototype.release;
  let releaseCount = 0;
  GraphStore.prototype.release = function releaseForTest(): void {
    releaseCount += 1;
    originalRelease.call(this);
  };
  try {
    const graph = await createForceGraph3D({
      host: { mode: 'headless' },
      layout: { backend: 'local', autoStart: false }
    });
    graph.setData({ nodes: [{ id: 'a' }], links: [] });
    graph.dispose();
    graph.dispose();
    assert.equal(releaseCount, 1);
  } finally {
    GraphStore.prototype.release = originalRelease;
  }
});

test('freeze policy leaves visual frames renderable after a layout failure', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, failurePolicy: 'freeze' }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });
  worker.emitError('worker stopped');
  graph.setSelection(['a']);
  assert.doesNotThrow(() => graph.update(1));
  assert.doesNotThrow(() => graph.render());
  assert.equal(graph.getDiagnostics().layoutState, 'failed');
  assert.equal(graph.getDiagnostics().layoutRunning, false);
  graph.dispose();
});

test('dispose layout failure policy terminates the graph without an interrupted teardown', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, failurePolicy: 'dispose' }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });
  worker.emitError('worker stopped');
  assert.equal(graph.isDisposed, true);
  assert.doesNotThrow(() => graph.dispose());
});

test('worker failure can recover to local layout and keeps topology mutations atomic', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, failurePolicy: 'fallback-local' }
  });
  const failures: boolean[] = [];
  graph.on('layout-failed', (event) => failures.push(event.recovered));
  graph.setData({ nodes: [{ id: 'a' }], links: [] });
  worker.emitMessage({ type: 'state', state: 'running', alpha: 1, revision: 1 });
  worker.emitError('worker stopped');
  assert.deepEqual(failures, [true]);
  assert.equal(graph.getDiagnostics().layoutBackend, 'local');
  assert.equal(graph.getDiagnostics().layoutRunning, true);
  await assert.doesNotReject(() => graph.stepLayout(1));

  const result = graph.applyPatch({ nodes: { upsert: [{ id: 'b' }] } });
  assert.equal(result.layoutRebuildScheduled, true);
  assert.equal(graph.getDiagnostics().nodeCount, 2);
  assert.doesNotThrow(() => graph.dispose());
});

test('a failed worker pin command does not partially commit node state', async () => {
  const worker = new RecordingWorker();
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'worker', workerFactory: () => worker, autoStart: false, failurePolicy: 'freeze' }
  });
  graph.setData({ nodes: [{ id: 'a' }], links: [] });
  const before = graph.getNodePosition('a');
  worker.throwOnNextPost = true;
  assert.throws(
    () => graph.setNodeFixed('a', { x: 7, y: 8, z: 9 }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_FAILED'
  );
  assert.deepEqual(graph.getNodePosition('a'), before);
  graph.dispose();
});

test('consumer event failures are isolated and reported through the observer-error hook', async () => {
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false }
  });
  const observed: Array<{ eventName: string; message: string }> = [];
  graph.onObserverError((event) => observed.push({ eventName: event.eventName, message: event.error.message }));
  graph.on('node-hover', () => {
    throw new Error('consumer hover failure');
  });
  graph.setData({ nodes: [{ id: 'node' }], links: [] });

  assert.doesNotThrow(() => graph.setHoveredNode('node'));
  await graph.stepLayout(1);
  assert.deepEqual(observed, [{ eventName: 'node-hover', message: 'consumer hover failure' }]);
  assert.equal(graph.getGraphView().hasNode('node'), true);
  graph.dispose();
});

test('style accessor failures use a fallback and still reconcile data and layout', async () => {
  const graph = await createForceGraph3D<{ weight: number }>({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false },
    nodes: { radius: () => { throw new Error('style boom'); } }
  });
  const errors: GraphError[] = [];
  graph.on('error', ({ error }) => errors.push(error as GraphError));

  graph.setData({ nodes: [{ id: 'node', data: { weight: 1 } }], links: [] });

  assert.equal(graph.getDiagnostics().nodeCount, 1);
  assert.equal(graph.getDiagnostics().layoutRevision, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, 'FG_STYLE_RESOLUTION_FAILED');
  graph.dispose();
});

test('node clicks drive the configured single and multiple-selection semantics', async () => {
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false },
    interaction: { selection: 'multiple' }
  });
  const selections: string[][] = [];
  graph.on('selection-change', ({ nodeIds }) => selections.push([...nodeIds] as string[]));
  graph.setData({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });

  graph.notifyNodeClick('a');
  graph.notifyNodeClick('b', { shiftKey: true });
  graph.notifyNodeClick('a', { ctrlKey: true });

  assert.deepEqual(selections, [['a'], ['a', 'b'], ['b']]);
  graph.dispose();
});

test('creation snapshots nested options and exposes replayable startup facts', async () => {
  const options: ForceGraphOptions = {
    host: { mode: 'headless' },
    layout: { backend: 'local', autoStart: false },
    renderer: { backend: 'webgpu' },
    interaction: { selection: 'multiple', dragNodes: { enabled: true, releaseBehavior: 'unpin' } }
  };
  const graph = await createForceGraph3D(options);
  options.layout!.backend = 'worker';
  options.renderer!.backend = 'webgl2';
  options.interaction!.selection = 'none';
  if (typeof options.interaction!.dragNodes === 'object') {
    options.interaction!.dragNodes.enabled = false;
  }

  const selections: string[][] = [];
  graph.on('selection-change', ({ nodeIds }) => selections.push([...nodeIds] as string[]));
  graph.setData({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
  graph.setSelection(['a', 'b']);
  const report = graph.getStartupReport();
  assert.deepEqual(selections, [['a', 'b']]);
  assert.deepEqual(report, {
    hostMode: 'headless',
    layout: { requested: 'local', selected: 'local' },
    renderer: {
      policy: 'webgpu-preferred',
      selected: 'none',
      materialPath: 'none',
      transformPath: 'none',
      requestedWidthUnit: 'world',
      selectedWidthUnit: 'none',
      cameraProjection: 'unknown',
      positionAtlasWidth: 0,
      positionAtlasMaxHeight: 0,
      positionAtlasMaxNodeCapacity: 0,
      nodeDynamicOpacityRequested: false,
      nodeDynamicOpacitySelected: false,
      linkDynamicOpacityRequested: false,
      linkDynamicOpacitySelected: false
    },
    warnings: []
  });
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.layout));
  assert.ok(Object.isFrozen(report.renderer));
  assert.ok(Object.isFrozen(report.warnings));
  graph.dispose();
  assert.equal(graph.getStartupReport(), report);
});

test('creation records worker fallback and rejects malformed hosts before acquiring a worker', async () => {
  const fallback = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: {
      backend: 'worker',
      workerFactory: () => {
        throw new Error('worker unavailable');
      }
    }
  });
  assert.deepEqual(fallback.getStartupReport().layout, { requested: 'worker', selected: 'local' });
  assert.deepEqual(fallback.getStartupReport().warnings, [{
    code: 'FG_STARTUP_LAYOUT_FALLBACK',
    message: 'The requested layout worker could not be created; local layout was selected.',
    detail: 'worker unavailable'
  }]);
  fallback.dispose();

  let workersCreated = 0;
  await assert.rejects(() => createForceGraph3D({
    host: { mode: 'embedded', renderer: {}, scene: {}, camera: {} },
    layout: {
      backend: 'worker',
      workerFactory: () => {
        workersCreated += 1;
        return new RecordingWorker();
      }
    }
  }), (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID');
  assert.equal(workersCreated, 0);
});

test('renderer capability preflight acquires no workers, renderers, observers, or listeners', async () => {
  let workersCreated = 0;
  let renderersCreated = 0;
  let observersCreated = 0;
  let listenersAdded = 0;
  class RuntimeObject {}
  class CountingRenderer {
    constructor() {
      renderersCreated += 1;
    }
  }
  const platform = {
    THREE: {
      Group: RuntimeObject,
      Object3D: RuntimeObject,
      PlaneGeometry: RuntimeObject,
      InstancedMesh: RuntimeObject,
      Matrix4: RuntimeObject,
      MeshBasicMaterial: RuntimeObject,
      WebGPURenderer: CountingRenderer,
      Scene: RuntimeObject,
      PerspectiveCamera: RuntimeObject,
      DataTexture: RuntimeObject,
      InstancedBufferAttribute: RuntimeObject,
      Mesh: RuntimeObject
    },
    TSL: {},
    capabilities: { webgpuRenderer: true, nodeMaterials: false, raycasting: false }
  } as unknown as ThreePlatform;
  const canvas = {
    width: 640,
    height: 480,
    clientWidth: 640,
    clientHeight: 480,
    getContext: () => null,
    addEventListener: () => { listenersAdded += 1; },
    removeEventListener: () => undefined
  } as unknown as HTMLCanvasElement;
  const originalResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor() {
        observersCreated += 1;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  });
  try {
    await assert.rejects(() => createForceGraph3D({
      platform,
      host: { mode: 'managed', canvas: { ...canvas, getContext: undefined } as unknown as HTMLCanvasElement },
      layout: {
        backend: 'worker',
        workerFactory: () => {
          workersCreated += 1;
          return new RecordingWorker();
        }
      }
    }), (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID');
    await assert.rejects(() => createForceGraph3D({
      platform,
      host: {
        mode: 'embedded',
        renderer: { render: () => undefined },
        scene: { add: () => undefined, remove: () => undefined },
        camera: { position: {} },
        controls: { enabled: 'yes' } as unknown as { enabled: boolean }
      },
      layout: {
        backend: 'worker',
        workerFactory: () => {
          workersCreated += 1;
          return new RecordingWorker();
        }
      }
    }), (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID');
    await assert.rejects(() => createForceGraph3D({
      platform,
      host: { mode: 'managed', canvas },
      renderer: { nodeSurface: { profile: 'metallic' } },
      layout: {
        backend: 'worker',
        workerFactory: () => {
          workersCreated += 1;
          return new RecordingWorker();
        }
      }
    }), (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_CAPABILITY_UNAVAILABLE');
  } finally {
    if (originalResizeObserver === undefined) {
      Reflect.deleteProperty(globalThis, 'ResizeObserver');
    } else {
      Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: originalResizeObserver });
    }
  }
  assert.deepEqual({ workersCreated, renderersCreated, observersCreated, listenersAdded }, {
    workersCreated: 0,
    renderersCreated: 0,
    observersCreated: 0,
    listenersAdded: 0
  });
});

test('creation rejects invalid runtime host and renderer policies', async () => {
  await assert.rejects(
    () => createForceGraph3D({ host: { mode: 'unsupported' } } as unknown as ForceGraphOptions),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID'
  );
  await assert.rejects(
    () => createForceGraph3D({ renderer: { backend: 'unsupported' } } as unknown as ForceGraphOptions),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_BACKEND_UNAVAILABLE'
  );
  await assert.rejects(
    () => createForceGraph3D({ renderer: { maxPositionAtlasHeight: 0 } }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID'
  );
});

test('incremental topology patches preserve alpha with a configurable reheat floor', async () => {
  const graph = await createForceGraph3D({
    host: { mode: 'headless' },
    layout: {
      backend: 'local',
      autoStart: false,
      alphaDecay: 0.1,
      alphaMinimum: 1e-9,
      settleThreshold: 1e-12,
      chargeStrength: -20,
      linkStrength: 0,
      centerStrength: 0,
      topologyReheatAlpha: 0.35
    }
  });
  graph.setData({
    nodes: [
      { id: 'a', initialPosition: { x: -1, y: 0, z: 0 } },
      { id: 'b', initialPosition: { x: 1, y: 0, z: 0 } }
    ],
    links: []
  });
  await graph.stepLayout(20);
  assert.ok(graph.getDiagnostics().layoutAlpha < 0.35);

  graph.applyPatch({
    nodes: { upsert: [{ id: 'c', initialPosition: { x: 0, y: 0, z: 0 } }] },
    links: { upsert: [{ id: 'a-c', source: 'a', target: 'c' }] }
  });
  assert.equal(graph.getDiagnostics().layoutAlpha, 0.35);

  graph.setData({ nodes: [{ id: 'replacement' }], links: [] });
  assert.equal(graph.getDiagnostics().layoutAlpha, 1);
  graph.dispose();
});

test('headless and rendered-local mutation policies agree on alpha and stopped state', async () => {
  const layout = {
    autoStart: false,
    alphaDecay: 0.1,
    alphaMinimum: 1e-9,
    settleThreshold: 1e-12,
    chargeStrength: -20,
    linkStrength: 0,
    centerStrength: 0,
    topologyReheatAlpha: 0.35
  } as const;
  const rendered = await createForceGraph3D({ host: { mode: 'headless' }, layout: { backend: 'local', ...layout } });
  const headless = createHeadlessForceGraph({ layout });
  const data = {
    nodes: [
      { id: 'a', initialPosition: { x: -1, y: 0, z: 0 } },
      { id: 'b', initialPosition: { x: 1, y: 0, z: 0 } }
    ],
    links: []
  };
  const assertParity = (): void => {
    const diagnostics = rendered.getDiagnostics();
    const snapshot = headless.getLayoutSnapshot();
    assert.equal(diagnostics.layoutAlpha, snapshot.alpha);
    assert.equal(diagnostics.layoutRunning, !snapshot.settled);
  };
  rendered.setData(data);
  headless.setData(data);
  assertParity();
  await rendered.stepLayout(20);
  headless.stepLayout(20);
  rendered.stopLayout();
  headless.stopLayout();
  assertParity();
  const patch = { nodes: { upsert: [{ id: 'c', initialPosition: { x: 0, y: 0, z: 0 } }] }, links: { upsert: [{ id: 'a-c', source: 'a', target: 'c' }] } };
  rendered.applyPatch(patch);
  headless.applyPatch(patch);
  assertParity();
  rendered.clear();
  headless.clear();
  assertParity();
  rendered.dispose();
  headless.dispose();
});

test('creation and runtime style setters reject malformed public options instead of clamping them', async () => {
  const invalidOptions: ForceGraphOptions[] = [
    { layout: { dimensions: 4 } } as unknown as ForceGraphOptions,
    { layout: { velocityDecay: 2 } },
    { layout: { minimumNodeDistance: -1 } },
    { layout: { separationStrength: 1.1 } },
    { layout: { separationIterations: 5 } },
    { layout: { topologyReheatAlpha: -0.1 } },
    { layout: { interactionReheatAlpha: 1.1 } },
    { layout: { maxSeparationPairChecksPerStep: 1_000_001 } },
    { layout: { maxStepsPerRequest: 1.5 } },
    { layout: { maxStepsPerUpdate: 257 } },
    { layout: { maxStepsPerRequest: 4_097 } },
    { layout: { maxPendingWorkerSteps: 65 } },
    { layout: { maxPendingWorkerCommands: 65 } },
    { layout: { workerStepTimeoutMs: 600_001 } },
    { layout: { workerCommandTimeoutMs: 600_001 } },
    { layout: { maxStepsPerUpdate: 9, maxStepsPerRequest: 8 } },
    { layout: { workerCommandTimeoutMs: 0 } },
    { host: { mode: 'headless' }, renderer: { linkFlow: { enabled: true } } },
    { layout: { typo: true } } as unknown as ForceGraphOptions,
    { renderer: { frameLoop: 'sometimes' } } as unknown as ForceGraphOptions,
    { renderer: { pixelRatio: { minimum: 2, maximum: 1 } } },
    { renderer: { pixelRatio: { maximum: 8.1 } } },
    { renderer: { picking: { spatialCellSize: 4_097 } } },
    { renderer: { picking: { mode: 'spatial', typo: true } } } as unknown as ForceGraphOptions,
    { interaction: { selection: 'many' } } as unknown as ForceGraphOptions,
    { interaction: { dragNodes: { releaseBehavior: 'release' } } } as unknown as ForceGraphOptions,
    { validation: { mode: 'lenient' } } as unknown as ForceGraphOptions,
    { nodes: { radius: 0 } },
    { links: { opacity: 2 } },
    { typo: true } as unknown as ForceGraphOptions
  ];
  for (const options of invalidOptions) {
    await assert.rejects(
      () => createForceGraph3D(options),
      (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID'
    );
  }

  const graph = await createForceGraph3D({ host: { mode: 'headless' }, layout: { backend: 'local' } });
  assert.throws(
    () => graph.setNodeStyle({ color: 0x1000000 }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID'
  );
  assert.throws(
    () => graph.setLinkStyle({ width: Number.NaN }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_PLATFORM_INVALID'
  );
  graph.dispose();
});
