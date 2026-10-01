import { GraphError } from '../core/errors.js';
import { DeterministicForceLayout } from '../layout/ForceLayout.js';
import { isNonNegativeInteger, isValidLayoutInput } from '../layout/layoutProtocol.js';
import { SnapshotTransferPool } from '../layout/SnapshotTransferPool.js';
import type { Vec3 } from '../core/types.js';
import type { LayoutWorkerCommand, LayoutWorkerMessage, LayoutWorkerOperation } from '../layout/LayoutBridge.js';
import { RESOURCE_LIMITS } from '../core/resourceLimits.js';

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<LayoutWorkerCommand>) => void): void;
  postMessage(message: LayoutWorkerMessage, transfer?: Transferable[]): void;
  close(): void;
}

const workerScope = globalThis as unknown as WorkerScope;
const layout = new DeterministicForceLayout();
let timer: ReturnType<typeof setTimeout> | undefined;
let lastTickAt: number | undefined;
let disposed = false;
let revision = 0;
const snapshotPool = new SnapshotTransferPool(3);
const pendingSnapshotRequests: number[] = [];
const DEFAULT_MAX_PENDING_SNAPSHOT_REQUESTS = 8;
let maxPendingSnapshotRequests = DEFAULT_MAX_PENDING_SNAPSHOT_REQUESTS;

workerScope.addEventListener('message', (event) => {
  if (disposed) {
    return;
  }
  try {
    const command = event.data;
    if (!isLayoutWorkerCommand(command)) {
      const malformed = command as unknown as Record<string, unknown>;
      const requestId = isRecord(malformed) ? malformed.requestId : undefined;
      const error = new GraphError('FG_LAYOUT_BUFFER_PROTOCOL_FAILED', 'The layout worker received a malformed protocol command.');
      if (isRecord(malformed) && isRevision(requestId)) {
        nack(requestId, malformed.type, error, revisionForInvalidCommand(malformed, revision));
      } else {
        workerScope.postMessage({
          type: 'error',
          code: error.code,
          message: error.message,
          revision: revisionForInvalidCommand(malformed, revision)
        });
      }
      return;
    }
    switch (command.type) {
      case 'initialize':
      case 'patch':
        assertReplacementRevision(command);
        layout.initialize(command.input, command.alpha === undefined ? {} : { alpha: command.alpha });
        cancelSchedule();
        revision = command.revision;
        snapshotPool.clear();
        pendingSnapshotRequests.length = 0;
        if (command.startAfterInitialize && layout.snapshotNodeCount > 0) {
          layout.start();
          lastTickAt = layout.isRunning ? monotonicNow() : undefined;
        }
        acknowledge(command);
        publishSnapshot();
        publishState();
        schedule();
        break;
      case 'configure':
        assertCurrentRevision(command);
        layout.configure(command.options);
        maxPendingSnapshotRequests = resolvePositiveInteger(
          command.options.maxPendingWorkerSteps,
          maxPendingSnapshotRequests,
          RESOURCE_LIMITS.maxPendingWorkerSteps
        );
        acknowledge(command);
        publishState();
        break;
      case 'pin':
        assertCurrentRevision(command);
        layout.setPinnedNode(command.nodeIndex, command.position);
        acknowledge(command);
        publishSnapshot();
        schedule();
        break;
      case 'release':
        assertCurrentRevision(command);
        layout.releasePinnedNode(command.nodeIndex);
        acknowledge(command);
        publishSnapshot();
        schedule();
        break;
      case 'start':
        assertCurrentRevision(command);
        layout.start();
        lastTickAt = layout.isRunning ? monotonicNow() : undefined;
        acknowledge(command);
        publishState();
        schedule();
        break;
      case 'stop':
        assertCurrentRevision(command);
        layout.stop();
        cancelSchedule();
        acknowledge(command);
        publishSnapshot();
        publishState('stopped');
        break;
      case 'restart':
        assertCurrentRevision(command);
        layout.restart();
        lastTickAt = layout.isRunning ? monotonicNow() : undefined;
        acknowledge(command);
        publishState();
        if (layout.isRunning) {
          publishSnapshot();
        }
        schedule();
        break;
      case 'step':
        assertCurrentRevision(command);
        layout.runSteps(command.count);
        lastTickAt = layout.isRunning ? monotonicNow() : undefined;
        publishSnapshot(command.requestId);
        schedule();
        break;
      case 'reclaim':
        reclaimSnapshot(command);
        break;
      case 'dispose':
        disposed = true;
        cancelSchedule();
        pendingSnapshotRequests.length = 0;
        snapshotPool.clear();
        layout.dispose();
        workerScope.close();
        break;
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const command = event.data;
    const requestId = isRecord(command) ? (command as { requestId?: unknown }).requestId : undefined;
    if (isRecord(command) && isRevision(requestId)) {
      nack(requestId, command.type, error, revisionForInvalidCommand(command, revision));
    } else {
      workerScope.postMessage({
        type: 'error',
        code: error instanceof GraphError ? error.code : 'FG_LAYOUT_WORKER_FAILED',
        message: error.message,
        revision
      });
    }
  }
});

function schedule(): void {
  if (timer !== undefined || !layout.isRunning || disposed) {
    return;
  }
  timer = setTimeout(() => {
    timer = undefined;
    const tickAt = monotonicNow();
    const elapsedSeconds = lastTickAt === undefined ? 0 : Math.max(0, (tickAt - lastTickAt) / 1000);
    lastTickAt = tickAt;
    layout.advanceWithoutSnapshot(elapsedSeconds);
    publishSnapshot();
    if (layout.isRunning) {
      schedule();
    } else {
      publishState();
    }
  }, 16);
}

function cancelSchedule(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  lastTickAt = undefined;
}

function publishSnapshot(requestId: number | undefined = undefined): void {
  const lease = snapshotPool.acquire(layout.snapshotNodeCount);
  if (!lease) {
    if (requestId !== undefined) {
      if (pendingSnapshotRequests.length >= maxPendingSnapshotRequests) {
        throw new GraphError(
          'FG_LAYOUT_WORKER_QUEUE_FULL',
          'The worker cannot queue another step acknowledgement while every snapshot slot is leased.',
          { maximum: maxPendingSnapshotRequests }
        );
      }
      pendingSnapshotRequests.push(requestId);
    }
    return;
  }
  const snapshot = layout.snapshotInto(lease.buffers);
  const effectiveRequestId = requestId ?? pendingSnapshotRequests.shift();
  const message: LayoutWorkerMessage = effectiveRequestId === undefined
    ? { type: 'snapshot', snapshot, steps: layout.steps, lastStepMs: layout.lastStepMs, separation: layout.separationDiagnostics, revision, poolId: lease.poolId }
    : { type: 'snapshot', snapshot, steps: layout.steps, lastStepMs: layout.lastStepMs, separation: layout.separationDiagnostics, revision, requestId: effectiveRequestId, poolId: lease.poolId };
  workerScope.postMessage(
    message,
    [snapshot.nodeIndices.buffer, snapshot.positions.buffer, snapshot.velocities.buffer]
  );
  if (snapshot.settled) {
    workerScope.postMessage({ type: 'settled', alpha: snapshot.alpha, revision });
  }
}

function publishState(state: 'ready' | 'running' | 'stopped' = layout.isRunning ? 'running' : 'ready'): void {
  workerScope.postMessage({ type: 'state', state, alpha: layout.currentAlpha, revision });
  if (state === 'ready') {
    workerScope.postMessage({ type: 'settled', alpha: layout.currentAlpha, revision });
  }
}

function acknowledge(command: Extract<LayoutWorkerCommand, { requestId?: number }>): void {
  if (!isRevision(command.requestId) || !isLayoutWorkerOperation(command.type)) {
    return;
  }
  workerScope.postMessage({
    type: 'ack',
    operation: command.type,
    requestId: command.requestId,
    revision,
    state: command.type === 'stop' ? 'stopped' : layout.isRunning ? 'running' : 'ready',
    alpha: layout.currentAlpha,
    running: layout.isRunning
  });
}

function assertReplacementRevision(command: Extract<LayoutWorkerCommand, { type: 'initialize' | 'patch' }>): void {
  if (command.requestId === undefined) {
    return;
  }
  if (command.revision !== revision + 1) {
    throw new GraphError(
      'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
      'The layout worker received a stale or out-of-order replacement revision.',
      { expectedRevision: revision + 1, receivedRevision: command.revision }
    );
  }
}

function assertCurrentRevision(command: Extract<LayoutWorkerCommand, { type: 'configure' | 'pin' | 'release' | 'start' | 'stop' | 'restart' | 'step' }>): void {
  if (command.requestId === undefined) {
    return;
  }
  if (command.revision !== revision) {
    throw new GraphError(
      'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
      'The layout worker received a stale or out-of-order command revision.',
      { expectedRevision: revision, receivedRevision: command.revision }
    );
  }
}

function nack(requestId: number, operation: unknown, error: Error, commandRevision: number): void {
  if (!isLayoutWorkerOperation(operation)) {
    workerScope.postMessage({
      type: 'error',
      code: error instanceof GraphError ? error.code : 'FG_LAYOUT_WORKER_FAILED',
      message: error.message,
      revision: commandRevision
    });
    return;
  }
  workerScope.postMessage({
    type: 'nack',
    operation,
    requestId,
    revision: commandRevision,
    code: error instanceof GraphError ? error.code : 'FG_LAYOUT_WORKER_FAILED',
    message: error.message
  });
}

function reclaimSnapshot(command: Extract<LayoutWorkerCommand, { type: 'reclaim' }>): void {
  if (command.revision !== revision || !snapshotPool.reclaim({ poolId: command.poolId, buffers: command.buffers })) {
    return;
  }
  const pendingRequestId = pendingSnapshotRequests.shift();
  if (pendingRequestId !== undefined) {
    publishSnapshot(pendingRequestId);
  }
}

function isLayoutWorkerCommand(value: unknown): value is LayoutWorkerCommand {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'initialize':
    case 'patch':
      return isValidLayoutInput(value.input)
        && isRevision(value.revision)
        && isOptionalRequestId(value.requestId)
        && isOptionalBoolean(value.startAfterInitialize)
        && isOptionalUnitInterval(value.alpha)
        && (value.requestId === undefined || value.revision === revision + 1);
    case 'configure':
      return isRecord(value.options)
        && isOptionalRequestId(value.requestId)
        && isOptionalRevision(value.revision)
        && (value.requestId === undefined || value.revision === revision);
    case 'pin':
      return isNodeIndex(value.nodeIndex)
        && isFiniteVec3(value.position)
        && isOptionalRequestId(value.requestId)
        && isOptionalRevision(value.revision)
        && (value.requestId === undefined || value.revision === revision);
    case 'release':
      return isNodeIndex(value.nodeIndex)
        && isOptionalRequestId(value.requestId)
        && isOptionalRevision(value.revision)
        && (value.requestId === undefined || value.revision === revision);
    case 'start':
    case 'stop':
    case 'restart':
    case 'dispose':
      return isOptionalRequestId(value.requestId)
        && (value.type === 'dispose'
          || (isOptionalRevision(value.revision) && (value.requestId === undefined || value.revision === revision)));
    case 'step':
      return typeof value.count === 'number'
        && Number.isFinite(value.count)
        && isOptionalRequestId(value.requestId)
        && isOptionalRevision(value.revision)
        && (value.requestId === undefined || value.revision === revision);
    case 'reclaim':
      return isRevision(value.revision)
        && isRevision(value.poolId)
        && hasValidSnapshotBuffers(value.buffers);
    default:
      return false;
  }
}

function hasValidSnapshotBuffers(value: unknown): value is { nodeIndices: Uint32Array; positions: Float32Array; velocities: Float32Array } {
  return isRecord(value)
    && value.nodeIndices instanceof Uint32Array
    && value.positions instanceof Float32Array
    && value.velocities instanceof Float32Array
    && value.positions.length === value.nodeIndices.length * 3
    && value.velocities.length === value.nodeIndices.length * 3;
}

function isFiniteVec3(value: unknown): value is Vec3 {
  return isRecord(value)
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && typeof value.z === 'number' && Number.isFinite(value.z);
}

function isNodeIndex(value: unknown): value is number {
  return isRevision(value);
}

function isRevision(value: unknown): value is number {
  return isNonNegativeInteger(value);
}

function isOptionalRequestId(value: unknown): value is number | undefined {
  return value === undefined || isRevision(value);
}

function isOptionalRevision(value: unknown): value is number | undefined {
  return value === undefined || isRevision(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalUnitInterval(value: unknown): value is number | undefined {
  return value === undefined
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function isLayoutWorkerOperation(value: unknown): value is LayoutWorkerOperation {
  return value === 'initialize'
    || value === 'patch'
    || value === 'configure'
    || value === 'pin'
    || value === 'release'
    || value === 'start'
    || value === 'stop'
    || value === 'restart'
    || value === 'step';
}

function revisionForInvalidCommand(value: unknown, fallback: number): number {
  return isRecord(value) && isRevision(value.revision) ? value.revision : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function resolvePositiveInteger(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : fallback;
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
