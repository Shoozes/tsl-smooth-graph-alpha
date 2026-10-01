import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GraphError } from '../../source/core/errors.js';
import { RESOURCE_LIMITS } from '../../source/core/resourceLimits.js';
import type { WorkerLike } from '../../source/core/types.js';
import { WorkerLayoutBridge } from '../../source/layout/LayoutBridge.js';

class FakeWorker implements WorkerLike {
  readonly commands: unknown[] = [];
  readonly transfers: Transferable[][] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.commands.push(message);
    this.transfers.push(transfer);
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

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data } as unknown as Event);
    }
  }
}

function snapshot() {
  return {
    nodeIndices: new Uint32Array([0]),
    positions: new Float32Array([1, 2, 3]),
    velocities: new Float32Array(3),
    alpha: 0.5,
    settled: false
  };
}

function layoutInput() {
  return {
    nodeIndices: new Uint32Array([0]),
    positions: new Float32Array([1, 2, 3]),
    velocities: new Float32Array(3),
    fixedMask: new Uint8Array(1),
    fixedPositions: new Float32Array(3),
    links: new Uint32Array()
  };
}

test('WorkerLayoutBridge waits for the matching step snapshot and uses restart semantics', async () => {
  const worker = new FakeWorker();
  const snapshots: number[] = [];
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: (value) => snapshots.push(value.alpha),
    onError: () => undefined
  });

  let completed = false;
  const pending = bridge.step(3).then(() => { completed = true; });
  const command = worker.commands[0] as { type?: unknown; requestId?: unknown; revision?: unknown } | undefined;
  assert.equal(command?.type, 'step');
  assert.equal(typeof command?.requestId, 'number');
  await Promise.resolve();
  assert.equal(completed, false);

  worker.emitMessage({
    type: 'snapshot',
    snapshot: snapshot(),
    steps: 3,
    lastStepMs: 1,
    revision: 0,
    requestId: command?.requestId,
    poolId: 4
  });
  await pending;
  assert.equal(completed, true);
  assert.deepEqual(snapshots, [0.5]);
  const reclaim = worker.commands.at(-1) as {
    type?: unknown;
    revision?: unknown;
    poolId?: unknown;
    buffers?: { nodeIndices?: unknown; positions?: unknown; velocities?: unknown };
  } | undefined;
  assert.equal(reclaim?.type, 'reclaim');
  assert.equal(reclaim?.revision, 0);
  assert.equal(reclaim?.poolId, 4);

  bridge.restart();
  assert.equal((worker.commands.at(-1) as { type?: unknown } | undefined)?.type, 'restart');
  bridge.dispose();
  assert.equal(worker.terminated, true);
});

test('WorkerLayoutBridge resolves acknowledged commands only for the matching operation and epoch', async () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  });
  let completed = false;
  const pending = bridge.startAsync().then(() => { completed = true; });
  const command = worker.commands.at(-1) as { type?: unknown; requestId?: unknown } | undefined;
  assert.equal(command?.type, 'start');
  assert.equal(typeof command?.requestId, 'number');

  worker.emitMessage({ type: 'state', state: 'running', alpha: 1, revision: 0 });
  assert.equal(bridge.isRunning, false);

  worker.emitMessage({
    type: 'ack',
    operation: 'stop',
    requestId: command?.requestId,
    revision: 0,
    state: 'ready',
    alpha: 1,
    running: false
  });
  worker.emitMessage({
    type: 'ack',
    operation: 'start',
    requestId: command?.requestId,
    revision: 1,
    state: 'running',
    alpha: 1,
    running: true
  });
  await Promise.resolve();
  assert.equal(completed, false);

  worker.emitMessage({
    type: 'ack',
    operation: 'start',
    requestId: command?.requestId,
    revision: 0,
    state: 'running',
    alpha: 1,
    running: true
  });
  await pending;
  assert.equal(completed, true);
  bridge.dispose();
});

test('WorkerLayoutBridge keeps the previous replacement epoch after a NACK', async () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  });
  bridge.replace(layoutInput());
  assert.equal(bridge.revision, 1);
  const pending = bridge.replaceAsync(layoutInput());
  const command = worker.commands.at(-1) as { type?: unknown; requestId?: number; revision?: number } | undefined;
  assert.equal(command?.type, 'initialize');
  assert.equal(command?.revision, 2);
  assert.equal(bridge.revision, 1);
  worker.emitMessage({
    type: 'nack',
    operation: 'initialize',
    requestId: command?.requestId,
    revision: command?.revision,
    code: 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
    message: 'replacement rejected'
  });
  await assert.rejects(pending, (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_FAILED');
  assert.equal(bridge.revision, 1);
  bridge.dispose();
});

test('WorkerLayoutBridge does not reopen a stopped layout from a late snapshot', async () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  });
  const pending = bridge.stopAsync();
  const command = worker.commands.at(-1) as { requestId?: number } | undefined;
  worker.emitMessage({
    type: 'ack',
    operation: 'stop',
    requestId: command?.requestId,
    revision: 0,
    state: 'stopped',
    alpha: 0.8,
    running: false
  });
  await pending;
  worker.emitMessage({
    type: 'snapshot',
    snapshot: snapshot(),
    steps: 2,
    lastStepMs: 1,
    revision: 0
  });
  assert.equal(bridge.isRunning, false);
  assert.equal(bridge.state, 'stopped');
  bridge.dispose();
});

test('WorkerLayoutBridge rejects NACK, bounds pending commands, and terminates timed-out work', async () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  }, { stepTimeoutMs: 10, configuration: { maxPendingWorkerSteps: 1 } });
  const pending = bridge.stopAsync();
  await assert.rejects(
    bridge.restartAsync(),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_QUEUE_FULL'
  );
  await assert.rejects(
    bridge.replaceAsync({
      nodeIndices: new Uint32Array([0]),
      positions: new Float32Array([0, 0, 0]),
      velocities: new Float32Array([0, 0, 0]),
      fixedMask: new Uint8Array([0]),
      fixedPositions: new Float32Array([0, 0, 0]),
      links: new Uint32Array(),
    }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_QUEUE_FULL'
  );
  assert.equal(bridge.revision, 0);
  const command = worker.commands.at(-1) as { type?: unknown; requestId?: unknown } | undefined;
  assert.equal(command?.type, 'stop');
  worker.emitMessage({
    type: 'nack',
    operation: 'stop',
    requestId: command?.requestId,
    revision: 0,
    code: 'FG_DATA_INVALID_POSITION',
    message: 'test rejection'
  });
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_LAYOUT_WORKER_FAILED'
      && error.context.operation === 'stop'
  );

  await assert.rejects(
    bridge.startAsync(),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_FAILED'
  );
  assert.equal(bridge.state, 'failed');
  bridge.dispose();
});

test('WorkerLayoutBridge rejects pending acknowledged commands on disposal', async () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  });
  const pending = bridge.startAsync();
  bridge.dispose();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RESOURCE_ALREADY_DISPOSED'
  );
});

test('WorkerLayoutBridge accepts a settled acknowledgement after an empty start', () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  });

  bridge.start();
  assert.equal(bridge.isRunning, false);
  worker.emitMessage({ type: 'state', state: 'running', alpha: 1, revision: 0 });
  assert.equal(bridge.isRunning, true);
  worker.emitMessage({ type: 'settled', alpha: 0, revision: 0 });
  assert.equal(bridge.isRunning, false);
  assert.equal(bridge.state, 'ready');
  bridge.dispose();
});

test('WorkerLayoutBridge forwards only serializable initial solver configuration', () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  }, {
    configuration: {
      backend: 'worker',
      workerFactory: () => worker,
      workerStepTimeoutMs: 17,
      maxPendingWorkerSteps: 4,
      maxPendingWorkerCommands: 2,
      workerCommandTimeoutMs: 19,
      seed: 42,
      alphaDecay: 0.2,
      dimensions: 2
    }
  });

  assert.deepEqual(worker.commands[0], {
    type: 'configure',
    options: { maxPendingWorkerSteps: 4, seed: 42, alphaDecay: 0.2, dimensions: 2 }
  });
  bridge.dispose();
});

test('WorkerLayoutBridge separates acknowledged-command capacity from step capacity', async () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  }, {
    configuration: { maxPendingWorkerSteps: 1, maxPendingWorkerCommands: 2 }
  });

  const first = bridge.startAsync();
  const second = bridge.stopAsync();
  await assert.rejects(
    bridge.restartAsync(),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_QUEUE_FULL'
  );

  const pendingCommands = worker.commands.filter((command): command is { type: string; requestId?: number; revision?: number } =>
    typeof command === 'object' && command !== null && 'type' in command && typeof command.type === 'string'
  );
  assert.deepEqual(pendingCommands.slice(-2).map((command) => command.type), ['start', 'stop']);
  const start = pendingCommands.at(-2);
  const stop = pendingCommands.at(-1);
  worker.emitMessage({ type: 'ack', operation: 'start', requestId: start?.requestId, revision: 0, state: 'running', alpha: 1, running: true });
  worker.emitMessage({ type: 'ack', operation: 'stop', requestId: stop?.requestId, revision: 0, state: 'stopped', alpha: 1, running: false });
  await Promise.all([first, second]);
  bridge.dispose();
});

test('WorkerLayoutBridge transfers valid pooled snapshots back after synchronous consumption', () => {
  const worker = new FakeWorker();
  const delivered: number[] = [];
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: (value) => delivered.push(value.positions[0] ?? 0),
    onError: () => undefined
  });
  const value = snapshot();

  worker.emitMessage({
    type: 'snapshot',
    snapshot: value,
    steps: 1,
    lastStepMs: 1,
    revision: 0,
    poolId: 7
  });

  assert.deepEqual(delivered, [1]);
  const reclaim = worker.commands.at(-1) as {
    type?: unknown;
    revision?: unknown;
    poolId?: unknown;
    buffers?: { nodeIndices?: unknown; positions?: unknown; velocities?: unknown };
  } | undefined;
  assert.equal(reclaim?.type, 'reclaim');
  assert.equal(reclaim?.revision, 0);
  assert.equal(reclaim?.poolId, 7);
  assert.equal(reclaim?.buffers?.nodeIndices, value.nodeIndices);
  assert.equal(reclaim?.buffers?.positions, value.positions);
  assert.equal(reclaim?.buffers?.velocities, value.velocities);
  assert.equal(worker.transfers.at(-1)?.length, 3);
  bridge.dispose();
});

test('WorkerLayoutBridge preserves correction and verification separation diagnostics', () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  });
  const separation = {
    resolvableOverlapPairCount: 3,
    maximumPenetration: 0.75,
    pairChecks: 42,
    budgetExhausted: false,
    deferredPairCount: 0,
    consecutiveNoProgressSteps: 7,
    constrainedSettlement: false,
    correctionSweepsCompleted: 11,
    verificationSweepsCompleted: 8,
    verifiedOverlapPairCount: 3,
    verifiedMaximumPenetration: 0.75
  };

  worker.emitMessage({
    type: 'snapshot',
    snapshot: snapshot(),
    steps: 12,
    lastStepMs: 1,
    separation,
    revision: 0
  });

  assert.deepEqual(bridge.separationDiagnostics, separation);
  bridge.dispose();
});

test('WorkerLayoutBridge reports malformed worker messages as protocol failures', () => {
  const worker = new FakeWorker();
  const errors: Error[] = [];
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: (error) => errors.push(error)
  });

  worker.emitMessage({ type: 'snapshot', snapshot: {}, steps: 1, lastStepMs: 1 });

  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof GraphError);
  assert.equal((errors[0] as GraphError).code, 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED');
  assert.equal(bridge.state, 'failed');
  assert.equal(worker.terminated, true);
  assert.throws(
    () => bridge.start(),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED'
  );
  bridge.dispose();
});

test('WorkerLayoutBridge ignores a stale snapshot after data replacement', () => {
  const worker = new FakeWorker();
  const snapshots: number[] = [];
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: (value) => snapshots.push(value.positions[0] ?? 0),
    onError: () => undefined
  });
  const input = () => ({
    nodeIndices: new Uint32Array([0]),
    positions: new Float32Array(3),
    velocities: new Float32Array(3),
    fixedMask: new Uint8Array(1),
    fixedPositions: new Float32Array(3),
    links: new Uint32Array(0)
  });

  bridge.replace(input());
  bridge.replace(input());
  worker.emitMessage({ type: 'snapshot', snapshot: snapshot(), steps: 1, lastStepMs: 1, revision: 1 });
  worker.emitMessage({ type: 'snapshot', snapshot: snapshot(), steps: 1, lastStepMs: 1, revision: 2 });

  assert.deepEqual(snapshots, [1]);
  bridge.dispose();
});

test('WorkerLayoutBridge deduplicates transfers and times out an unacknowledged step', async () => {
  const worker = new FakeWorker();
  const errors: Error[] = [];
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: (error) => errors.push(error)
  }, { stepTimeoutMs: 10 });
  const shared = new ArrayBuffer(24);

  bridge.replace({
    nodeIndices: new Uint32Array(shared, 0, 1),
    positions: new Float32Array(shared, 0, 3),
    velocities: new Float32Array(shared, 0, 3),
    fixedMask: new Uint8Array(shared, 0, 1),
    fixedPositions: new Float32Array(shared, 0, 3),
    links: new Uint32Array(shared, 0, 0)
  });
  assert.equal(worker.transfers[0]?.length, 1);

  await assert.rejects(
    bridge.step(1),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_FAILED'
  );
  assert.equal(errors.length, 1);
  assert.equal(bridge.state, 'failed');
  assert.equal(worker.terminated, true);
  bridge.dispose();
});

test('WorkerLayoutBridge bounds manual work and pending acknowledgements', async () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  }, {
    configuration: { maxStepsPerRequest: 2, maxPendingWorkerSteps: 1 }
  });

  await assert.rejects(
    bridge.step(3),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_STEP_LIMIT_EXCEEDED'
  );
  const pending = bridge.step(1);
  await assert.rejects(
    bridge.step(1),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_WORKER_QUEUE_FULL'
  );
  const command = worker.commands.at(-1) as { requestId?: number } | undefined;
  worker.emitMessage({
    type: 'snapshot',
    snapshot: snapshot(),
    steps: 1,
    lastStepMs: 1,
    revision: 0,
    requestId: command?.requestId
  });
  await pending;
  bridge.dispose();
});

test('WorkerLayoutBridge clamps direct configuration at absolute resource ceilings', async () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  }, {
    stepTimeoutMs: Number.MAX_SAFE_INTEGER,
    configuration: {
      maxStepsPerRequest: Number.MAX_SAFE_INTEGER,
      maxPendingWorkerSteps: Number.MAX_SAFE_INTEGER,
      maxPendingWorkerCommands: Number.MAX_SAFE_INTEGER,
      workerCommandTimeoutMs: Number.MAX_SAFE_INTEGER
    }
  });
  const runtime = bridge as unknown as Record<string, unknown>;

  assert.equal(runtime.maxStepsPerRequest, RESOURCE_LIMITS.maxLayoutStepsPerRequest);
  assert.equal(runtime.maxPendingSteps, RESOURCE_LIMITS.maxPendingWorkerSteps);
  assert.equal(runtime.maxPendingCommands, RESOURCE_LIMITS.maxPendingWorkerCommands);
  assert.equal(runtime.stepTimeoutMs, RESOURCE_LIMITS.maxWorkerTimeoutMs);
  assert.equal(runtime.commandTimeoutMs, RESOURCE_LIMITS.maxWorkerTimeoutMs);
  await assert.rejects(
    bridge.step(RESOURCE_LIMITS.maxLayoutStepsPerRequest + 1),
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_LAYOUT_STEP_LIMIT_EXCEEDED'
      && error.context.maximum === RESOURCE_LIMITS.maxLayoutStepsPerRequest
  );
  bridge.dispose();
});

test('WorkerLayoutBridge rejects a snapshot whose epoch shape differs from the initialized graph', () => {
  const worker = new FakeWorker();
  const errors: Error[] = [];
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: (error) => errors.push(error)
  });
  bridge.replace({
    nodeIndices: new Uint32Array([0]),
    positions: new Float32Array(3),
    velocities: new Float32Array(3),
    fixedMask: new Uint8Array(1),
    fixedPositions: new Float32Array(3),
    links: new Uint32Array(0)
  });
  worker.emitMessage({
    type: 'snapshot',
    snapshot: {
      nodeIndices: new Uint32Array([0, 1]),
      positions: new Float32Array(6),
      velocities: new Float32Array(6),
      alpha: 0.5,
      settled: false
    },
    steps: 1,
    lastStepMs: 1,
    revision: 1
  });

  assert.equal(errors.length, 1);
  assert.equal((errors[0] as GraphError).code, 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED');
  assert.equal(worker.terminated, true);
  bridge.dispose();
});

test('WorkerLayoutBridge rejects non-finite trusted-session snapshot values', () => {
  const worker = new FakeWorker();
  const errors: Error[] = [];
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: (error) => errors.push(error)
  });
  worker.emitMessage({
    type: 'snapshot',
    snapshot: {
      nodeIndices: new Uint32Array([0]),
      positions: new Float32Array([Number.NaN, 0, 0]),
      velocities: new Float32Array(3),
      alpha: 0.5,
      settled: false
    },
    steps: 1,
    lastStepMs: 1,
    revision: 0
  });
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as GraphError).code, 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED');
  bridge.dispose();
});

test('WorkerLayoutBridge transfers and acknowledges a replacement alpha', async () => {
  const worker = new FakeWorker();
  const bridge = new WorkerLayoutBridge(worker, {
    onSnapshot: () => undefined,
    onError: () => undefined
  });
  const pending = bridge.replaceAsync(layoutInput(), true, 0.35);
  const command = worker.commands.at(-1) as {
    type?: unknown;
    alpha?: unknown;
    requestId?: number;
    revision?: number;
  };
  assert.equal(command.type, 'initialize');
  assert.equal(command.alpha, 0.35);
  worker.emitMessage({
    type: 'ack',
    operation: 'initialize',
    requestId: command.requestId,
    revision: command.revision,
    state: 'running',
    alpha: 0.35,
    running: true
  });
  await pending;
  assert.equal(bridge.alpha, 0.35);
  assert.equal(bridge.isRunning, true);
  bridge.dispose();
});
