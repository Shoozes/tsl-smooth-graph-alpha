import { GraphError } from '../core/errors.js';
import type {
  LayoutConfiguration,
  LayoutInput,
  LayoutSeparationDiagnostics,
  LayoutSnapshot,
  Vec3,
  WorkerLike
} from '../core/types.js';
import { DEFAULT_LAYOUT_CONFIGURATION, DeterministicForceLayout } from './ForceLayout.js';
import { assertValidLayoutInput, isNonNegativeInteger } from './layoutProtocol.js';
import type { SnapshotTransferBuffers } from './SnapshotTransferPool.js';
import { RESOURCE_LIMITS } from '../core/resourceLimits.js';

const DEFAULT_WORKER_STEP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_WORKER_STEPS = 8;
const DEFAULT_WORKER_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_WORKER_COMMANDS = 8;

export type LayoutBridgeState = 'starting' | 'ready' | 'running' | 'stopped' | 'failed' | 'disposed';

export interface LayoutBridgeCallbacks {
  onSnapshot(snapshot: LayoutSnapshot): void;
  onError(error: Error): void;
}

export interface LayoutBridge {
  readonly backend: 'local' | 'worker';
  readonly state: LayoutBridgeState;
  readonly revision: number;
  readonly isRunning: boolean;
  /** Whether the bridge was running immediately before a terminal failure. */
  readonly wasRunningAtFailure: boolean;
  readonly alpha: number;
  readonly steps: number;
  readonly lastStepMs: number;
  readonly separationDiagnostics: LayoutSeparationDiagnostics;
  replace(input: LayoutInput, initialAlpha?: number): void;
  replaceAsync(input: LayoutInput, startAfterInitialize?: boolean, initialAlpha?: number): Promise<void>;
  configure(options: LayoutConfiguration): void;
  configureAsync(options: LayoutConfiguration): Promise<void>;
  start(): void;
  startAsync(): Promise<void>;
  stop(): void;
  stopAsync(): Promise<void>;
  restart(): void;
  restartAsync(): Promise<void>;
  step(count: number): Promise<void>;
  advance(seconds: number): void;
  pin(nodeIndex: number, position: Vec3): void;
  pinAsync(nodeIndex: number, position: Vec3): Promise<void>;
  release(nodeIndex: number): void;
  releaseAsync(nodeIndex: number): Promise<void>;
  dispose(): void;
}

export type LayoutWorkerOperation =
  | 'initialize'
  | 'patch'
  | 'configure'
  | 'pin'
  | 'release'
  | 'start'
  | 'stop'
  | 'restart'
  | 'step';

export type LayoutWorkerCommand =
  | { type: 'initialize'; input: LayoutInput; revision: number; requestId?: number; startAfterInitialize?: boolean; alpha?: number }
  | { type: 'patch'; input: LayoutInput; revision: number; requestId?: number; startAfterInitialize?: boolean; alpha?: number }
  | { type: 'configure'; options: LayoutConfiguration; requestId?: number; revision?: number }
  | { type: 'pin'; nodeIndex: number; position: Vec3; requestId?: number; revision?: number }
  | { type: 'release'; nodeIndex: number; requestId?: number; revision?: number }
  | { type: 'start'; requestId?: number; revision?: number }
  | { type: 'stop'; requestId?: number; revision?: number }
  | { type: 'restart'; requestId?: number; revision?: number }
  | { type: 'step'; count: number; revision?: number; requestId?: number }
  | { type: 'reclaim'; revision: number; poolId: number; buffers: SnapshotTransferBuffers }
  | { type: 'dispose' };

export type LayoutWorkerMessage =
  | { type: 'snapshot'; snapshot: LayoutSnapshot; steps: number; lastStepMs: number; separation?: LayoutSeparationDiagnostics; revision: number; requestId?: number; poolId?: number }
  | { type: 'settled'; alpha: number; revision: number }
  | { type: 'state'; state: 'ready' | 'running' | 'stopped'; alpha: number; revision: number }
  | { type: 'ack'; operation: LayoutWorkerOperation; requestId: number; revision: number; state: 'ready' | 'running' | 'stopped'; alpha: number; running: boolean }
  | { type: 'nack'; operation: LayoutWorkerOperation; requestId: number; revision: number; code: string; message: string }
  | { type: 'error'; code: string; message: string; revision?: number };

export class LocalLayoutBridge implements LayoutBridge {
  readonly backend = 'local' as const;
  private readonly layout: DeterministicForceLayout;
  private readonly callbacks: LayoutBridgeCallbacks;
  private currentState: LayoutBridgeState = 'ready';
  private currentRevision = 0;

  constructor(options: LayoutConfiguration, callbacks: LayoutBridgeCallbacks) {
    this.layout = new DeterministicForceLayout(options);
    this.callbacks = callbacks;
  }

  get isRunning(): boolean {
    return this.layout.isRunning;
  }

  get wasRunningAtFailure(): boolean {
    return false;
  }

  get state(): LayoutBridgeState {
    return this.currentState;
  }

  get revision(): number {
    return this.currentRevision;
  }

  get alpha(): number {
    return this.layout.currentAlpha;
  }

  get steps(): number {
    return this.layout.steps;
  }

  get lastStepMs(): number {
    return this.layout.lastStepMs;
  }

  get separationDiagnostics(): LayoutSeparationDiagnostics {
    return this.layout.separationDiagnostics;
  }

  replace(input: LayoutInput, initialAlpha = 1): void {
    this.initialize(input, this.currentRevision + 1, initialAlpha);
  }

  async replaceAsync(input: LayoutInput, startAfterInitialize = false, initialAlpha = 1): Promise<void> {
    this.replace(input, initialAlpha);
    if (startAfterInitialize && input.nodeIndices.length > 0) {
      this.start();
    }
  }

  /** Restores a failed synchronous replacement without advancing its epoch. */
  restore(
    input: LayoutInput,
    revision: number,
    state: Readonly<{ alpha: number; steps: number; lastStepMs: number; running: boolean }>
  ): void {
    this.layout.initialize(input, state);
    this.currentRevision = revision;
    this.currentState = state.running && this.layout.isRunning ? 'running' : 'ready';
    this.publish();
  }

  configure(options: LayoutConfiguration): void {
    this.layout.configure(options);
  }

  async configureAsync(options: LayoutConfiguration): Promise<void> {
    this.configure(options);
  }

  start(): void {
    this.layout.start();
    this.currentState = this.layout.isRunning ? 'running' : 'ready';
  }

  async startAsync(): Promise<void> {
    this.start();
  }

  stop(): void {
    this.layout.stop();
    this.currentState = 'stopped';
  }

  async stopAsync(): Promise<void> {
    this.stop();
  }

  restart(): void {
    this.layout.restart();
    this.currentState = this.layout.isRunning ? 'running' : 'ready';
  }

  async restartAsync(): Promise<void> {
    this.restart();
  }

  async step(count: number): Promise<void> {
    this.layout.runSteps(count);
    this.publish();
  }

  advance(seconds: number): void {
    if (!this.layout.isRunning) {
      return;
    }
    this.layout.advanceWithoutSnapshot(seconds);
    this.publish();
  }

  pin(nodeIndex: number, position: Vec3): void {
    this.layout.setPinnedNode(nodeIndex, position);
    this.publish();
  }

  async pinAsync(nodeIndex: number, position: Vec3): Promise<void> {
    this.pin(nodeIndex, position);
  }

  release(nodeIndex: number): void {
    this.layout.releasePinnedNode(nodeIndex);
    this.publish();
  }

  async releaseAsync(nodeIndex: number): Promise<void> {
    this.release(nodeIndex);
  }

  dispose(): void {
    this.layout.dispose();
    this.currentState = 'disposed';
  }

  private publish(): void {
    if (this.currentState !== 'disposed') {
      this.currentState = this.layout.isRunning ? 'running' : 'ready';
    }
    this.callbacks.onSnapshot(this.layout.snapshot());
  }

  private initialize(input: LayoutInput, revision: number, initialAlpha: number): void {
    this.layout.initialize(input, { alpha: initialAlpha });
    this.currentRevision = revision;
    this.currentState = 'ready';
    this.publish();
  }
}

interface PendingStep {
  revision: number;
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingCommand {
  operation: LayoutWorkerOperation;
  revision: number;
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingReplacement {
  requestId: number;
  candidateRevision: number;
  candidateNodeCount: number;
  previousState: LayoutBridgeState;
  previousRunning: boolean;
  previousAlpha: number;
  previousSteps: number;
  previousLastStepMs: number;
  previousExpectedSnapshotNodeCount: number | undefined;
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  snapshot?: Extract<LayoutWorkerMessage, { type: 'snapshot' }>;
  state?: { state: 'ready' | 'running' | 'stopped'; alpha: number };
}

export interface WorkerLayoutBridgeOptions {
  stepTimeoutMs?: number;
  configuration?: LayoutConfiguration;
}

/**
 * Browser-worker transport. It uses transferable typed arrays on every data
 * replacement and keeps the rendered snapshot independent of worker state.
 */
export class WorkerLayoutBridge implements LayoutBridge {
  readonly backend = 'worker' as const;
  private readonly worker: WorkerLike;
  private readonly callbacks: LayoutBridgeCallbacks;
  private running = false;
  private currentAlpha = 0;
  private currentSteps = 0;
  private currentLastStepMs = 0;
  private currentSeparationDiagnostics: LayoutSeparationDiagnostics = {
    resolvableOverlapPairCount: 0,
    maximumPenetration: 0,
    pairChecks: 0,
    budgetExhausted: false,
    deferredPairCount: 0,
    consecutiveNoProgressSteps: 0,
    constrainedSettlement: false,
    correctionSweepsCompleted: 0,
    verificationSweepsCompleted: 0,
    verifiedOverlapPairCount: 0,
    verifiedMaximumPenetration: 0
  };
  private disposed = false;
  private currentState: LayoutBridgeState = 'starting';
  private failure: GraphError | undefined;
  private failureWasRunning = false;
  private readonly onMessageBound: EventListener;
  private readonly onErrorBound: EventListener;
  private listenersAttached = false;
  private readonly pendingSteps = new Map<number, PendingStep>();
  private readonly pendingCommands = new Map<number, PendingCommand>();
  private pendingReplacement: PendingReplacement | undefined;
  private pendingAcknowledgedState: Extract<LayoutWorkerMessage, { type: 'state' | 'settled' }> | undefined;
  private pendingAcknowledgedSnapshot: Extract<LayoutWorkerMessage, { type: 'snapshot' }> | undefined;
  private readonly stepTimeoutMs: number;
  private commandTimeoutMs: number;
  private maxStepsPerRequest: number;
  private maxPendingSteps: number;
  private maxPendingCommands: number;
  private nextRequestId = 1;
  private currentRevision = 0;
  private expectedSnapshotNodeCount: number | undefined;

  constructor(worker: WorkerLike, callbacks: LayoutBridgeCallbacks, options: WorkerLayoutBridgeOptions = {}) {
    this.worker = worker;
    this.callbacks = callbacks;
    this.stepTimeoutMs = resolveWorkerStepTimeoutMs(options.stepTimeoutMs);
    this.commandTimeoutMs = resolveWorkerCommandTimeoutMs(
      options.configuration?.workerCommandTimeoutMs,
      options.stepTimeoutMs
    );
    this.maxStepsPerRequest = resolvePositiveInteger(
      options.configuration?.maxStepsPerRequest,
      DEFAULT_LAYOUT_CONFIGURATION.maxStepsPerRequest,
      RESOURCE_LIMITS.maxLayoutStepsPerRequest
    );
    this.maxPendingSteps = resolvePositiveInteger(
      options.configuration?.maxPendingWorkerSteps,
      DEFAULT_MAX_PENDING_WORKER_STEPS,
      RESOURCE_LIMITS.maxPendingWorkerSteps
    );
    this.maxPendingCommands = resolvePositiveInteger(
      options.configuration?.maxPendingWorkerCommands,
      options.configuration?.maxPendingWorkerSteps === undefined
        ? DEFAULT_MAX_PENDING_WORKER_COMMANDS
        : this.maxPendingSteps,
      RESOURCE_LIMITS.maxPendingWorkerCommands
    );
    this.onMessageBound = this.handleMessage.bind(this) as EventListener;
    this.onErrorBound = this.handleError.bind(this) as EventListener;
    if (worker.addEventListener) {
      worker.addEventListener('message', this.onMessageBound);
      worker.addEventListener('error', this.onErrorBound);
    } else {
      worker.onmessage = this.onMessageBound as unknown as (event: MessageEvent<unknown>) => void;
      worker.onerror = this.onErrorBound as unknown as (event: ErrorEvent) => void;
    }
    this.listenersAttached = true;
    const configuration = workerConfiguration(options.configuration);
    if (Object.keys(configuration).length > 0) {
      this.post({ type: 'configure', options: configuration });
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get wasRunningAtFailure(): boolean {
    return this.failureWasRunning;
  }

  get state(): LayoutBridgeState {
    return this.currentState;
  }

  get revision(): number {
    return this.currentRevision;
  }

  get alpha(): number {
    return this.currentAlpha;
  }

  get steps(): number {
    return this.currentSteps;
  }

  get lastStepMs(): number {
    return this.currentLastStepMs;
  }

  get separationDiagnostics(): LayoutSeparationDiagnostics {
    return this.currentSeparationDiagnostics;
  }

  replace(input: LayoutInput, initialAlpha = 1): void {
    this.assertUsable();
    assertValidLayoutInput(input);
    const alpha = normalizeInitialAlpha(initialAlpha, input.nodeIndices.length);
    const revision = this.prepareReplacement(input, alpha);
    if (!this.post({ type: 'initialize', input, revision, alpha }, transferableBuffers(input))) {
      throw this.failure ?? new GraphError('FG_LAYOUT_WORKER_FAILED', 'Could not initialize the layout worker.');
    }
  }

  replaceAsync(input: LayoutInput, startAfterInitialize = false, initialAlpha = 1): Promise<void> {
    this.assertUsable();
    assertValidLayoutInput(input);
    if (this.pendingReplacement) {
      return Promise.reject(new GraphError(
        'FG_LAYOUT_WORKER_QUEUE_FULL',
        'The layout worker already has a replacement transaction in flight.'
      ));
    }
    const queueError = this.pendingCommandCapacityError('initialize');
    if (queueError) {
      return Promise.reject(queueError);
    }
    const candidateRevision = this.currentRevision + 1;
    const alpha = normalizeInitialAlpha(initialAlpha, input.nodeIndices.length);
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve, reject) => {
      const pending: PendingReplacement = {
        requestId,
        candidateRevision,
        candidateNodeCount: input.nodeIndices.length,
        previousState: this.currentState,
        previousRunning: this.running,
        previousAlpha: this.currentAlpha,
        previousSteps: this.currentSteps,
        previousLastStepMs: this.currentLastStepMs,
        previousExpectedSnapshotNodeCount: this.expectedSnapshotNodeCount,
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (this.pendingReplacement?.requestId === requestId) {
            this.fail(new GraphError(
              'FG_LAYOUT_WORKER_FAILED',
              'The layout worker did not acknowledge a replacement before the timeout.',
              { operation: 'initialize', requestId, revision: candidateRevision, timeoutMs: this.commandTimeoutMs }
            ));
          }
        }, this.commandTimeoutMs)
      };
      this.pendingReplacement = pending;
      if (!this.post(
        { type: 'initialize', input, revision: candidateRevision, requestId, startAfterInitialize, alpha },
        transferableBuffers(input)
      )) {
        this.rejectPendingReplacement(requestId, this.failure ?? new GraphError(
          'FG_LAYOUT_WORKER_FAILED',
          'Could not queue a layout worker replacement.',
          { operation: 'initialize', requestId, revision: candidateRevision }
        ), 'initialize', candidateRevision);
      }
    });
  }

  configure(options: LayoutConfiguration): void {
    this.assertUsable();
    this.applyConfiguration(options);
    this.post({ type: 'configure', options: workerConfiguration(options) });
  }

  configureAsync(options: LayoutConfiguration): Promise<void> {
    this.assertUsable();
    const configuration = workerConfiguration(options);
    const revision = this.currentRevision;
    return this.postAcknowledged(
      { type: 'configure', options: configuration, revision },
      [],
      'configure',
      revision
    ).then(() => {
      this.applyConfiguration(options);
    });
  }

  start(): void {
    this.assertUsable();
    if (!this.post({ type: 'start' })) {
      throw this.failure ?? new GraphError('FG_LAYOUT_WORKER_FAILED', 'Could not start the layout worker.');
    }
  }

  startAsync(): Promise<void> {
    this.assertUsable();
    return this.postAcknowledged({ type: 'start', revision: this.currentRevision }, [], 'start', this.currentRevision);
  }

  stop(): void {
    this.assertUsable();
    this.running = false;
    this.currentState = 'stopped';
    if (!this.post({ type: 'stop' })) {
      throw this.failure ?? new GraphError('FG_LAYOUT_WORKER_FAILED', 'Could not stop the layout worker.');
    }
  }

  stopAsync(): Promise<void> {
    this.assertUsable();
    return this.postAcknowledged({ type: 'stop', revision: this.currentRevision }, [], 'stop', this.currentRevision);
  }

  restart(): void {
    this.assertUsable();
    if (!this.post({ type: 'restart' })) {
      throw this.failure ?? new GraphError('FG_LAYOUT_WORKER_FAILED', 'Could not restart the layout worker.');
    }
  }

  restartAsync(): Promise<void> {
    this.assertUsable();
    return this.postAcknowledged({ type: 'restart', revision: this.currentRevision }, [], 'restart', this.currentRevision);
  }

  async step(count: number): Promise<void> {
    this.assertUsable();
    const normalizedCount = normalizeStepCount(count);
    if (normalizedCount > this.maxStepsPerRequest) {
      throw new GraphError(
        'FG_LAYOUT_STEP_LIMIT_EXCEEDED',
        'The requested layout step count exceeds the configured per-request limit.',
        { requested: normalizedCount, maximum: this.maxStepsPerRequest }
      );
    }
    if (this.pendingSteps.size >= this.maxPendingSteps) {
      throw new GraphError(
        'FG_LAYOUT_WORKER_QUEUE_FULL',
        'The layout worker already has the maximum number of pending step acknowledgements.',
        { maximum: this.maxPendingSteps }
      );
    }
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingSteps.has(requestId)) {
          this.fail(new GraphError(
            'FG_LAYOUT_WORKER_FAILED',
            'The layout worker did not acknowledge a requested step before the timeout.',
            { requestId, timeoutMs: this.stepTimeoutMs }
          ));
        }
      }, this.stepTimeoutMs);
      this.pendingSteps.set(requestId, { revision: this.currentRevision, resolve, reject, timeout });
      if (!this.post({ type: 'step', count: normalizedCount, revision: this.currentRevision, requestId })) {
        this.rejectPendingStep(requestId, new GraphError('FG_LAYOUT_WORKER_FAILED', 'Could not queue a layout worker step.'));
      }
    });
  }

  advance(_seconds: number): void {
    // The worker owns its fixed-rate tick. The host only consumes snapshots.
  }

  pin(nodeIndex: number, position: Vec3): void {
    this.assertUsable();
    if (!this.post({ type: 'pin', nodeIndex, position })) {
      throw this.failure ?? new GraphError('FG_LAYOUT_WORKER_FAILED', 'Could not pin a node in the layout worker.');
    }
  }

  pinAsync(nodeIndex: number, position: Vec3): Promise<void> {
    this.assertUsable();
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      return Promise.reject(new GraphError('FG_DATA_INVALID_POSITION', 'Pinned node coordinates must be finite.'));
    }
    return this.postAcknowledged(
      { type: 'pin', nodeIndex, position, revision: this.currentRevision },
      [],
      'pin',
      this.currentRevision
    );
  }

  release(nodeIndex: number): void {
    this.assertUsable();
    if (!this.post({ type: 'release', nodeIndex })) {
      throw this.failure ?? new GraphError('FG_LAYOUT_WORKER_FAILED', 'Could not release a node in the layout worker.');
    }
  }

  releaseAsync(nodeIndex: number): Promise<void> {
    this.assertUsable();
    return this.postAcknowledged({ type: 'release', nodeIndex, revision: this.currentRevision }, [], 'release', this.currentRevision);
  }

  dispose(): void {
    if (this.currentState === 'disposed') {
      return;
    }
    try {
      if (this.currentState !== 'failed') {
        this.post({ type: 'dispose' });
      }
    } finally {
      this.disposed = true;
      this.currentState = 'disposed';
      this.detachWorker();
      this.worker.terminate?.();
      this.rejectPending(new GraphError('FG_RESOURCE_ALREADY_DISPOSED', 'The layout worker bridge was disposed before a requested step completed.'));
    }
  }

  private post(command: LayoutWorkerCommand, transfer: Transferable[] = []): boolean {
    if (this.disposed || this.currentState === 'failed') {
      return false;
    }
    try {
      this.worker.postMessage(command, transfer);
      return true;
    } catch (cause) {
      this.fail(new GraphError('FG_LAYOUT_WORKER_FAILED', 'Could not post a layout worker command.', { cause }));
      return false;
    }
  }

  private prepareReplacement(input: LayoutInput, initialAlpha: number): number {
    const revision = this.currentRevision + 1;
    this.currentRevision = revision;
    const superseded = new GraphError(
      'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
      'A layout data replacement superseded pending worker commands.'
    );
    this.rejectPending(superseded);
    this.running = false;
    this.currentState = 'ready';
    this.currentAlpha = initialAlpha;
    this.currentSteps = 0;
    this.expectedSnapshotNodeCount = input.nodeIndices.length;
    return revision;
  }

  private applyConfiguration(options: LayoutConfiguration): void {
    this.maxStepsPerRequest = resolvePositiveInteger(
      options.maxStepsPerRequest,
      this.maxStepsPerRequest,
      RESOURCE_LIMITS.maxLayoutStepsPerRequest
    );
    this.maxPendingSteps = resolvePositiveInteger(
      options.maxPendingWorkerSteps,
      this.maxPendingSteps,
      RESOURCE_LIMITS.maxPendingWorkerSteps
    );
    this.maxPendingCommands = options.maxPendingWorkerCommands !== undefined
      ? resolvePositiveInteger(
        options.maxPendingWorkerCommands,
        this.maxPendingCommands,
        RESOURCE_LIMITS.maxPendingWorkerCommands
      )
      : options.maxPendingWorkerSteps !== undefined
        ? this.maxPendingSteps
        : this.maxPendingCommands;
    this.commandTimeoutMs = resolveWorkerCommandTimeoutMs(options.workerCommandTimeoutMs, this.commandTimeoutMs);
  }

  private postAcknowledged(
    command: LayoutWorkerCommand,
    transfer: Transferable[],
    operation: LayoutWorkerOperation,
    revision: number
  ): Promise<void> {
    const queueError = this.pendingCommandCapacityError(operation);
    if (queueError) {
      return Promise.reject(queueError);
    }
    const requestId = this.nextRequestId++;
    const request = { ...command, requestId } as LayoutWorkerCommand;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingCommands.has(requestId)) {
          this.fail(new GraphError(
            'FG_LAYOUT_WORKER_FAILED',
            'The layout worker did not acknowledge a command before the timeout.',
            { operation, requestId, revision, timeoutMs: this.commandTimeoutMs }
          ));
        }
      }, this.commandTimeoutMs);
      this.pendingCommands.set(requestId, { operation, revision, resolve, reject, timeout });
      if (!this.post(request, transfer)) {
        this.rejectPendingCommand(requestId, this.failure ?? new GraphError(
          'FG_LAYOUT_WORKER_FAILED',
          `Could not queue the ${operation} layout worker command.`,
          { operation, requestId, revision }
        ));
      }
    });
  }

  private pendingCommandCapacityError(operation: LayoutWorkerOperation): GraphError | undefined {
    const pendingCount = this.pendingCommands.size + (this.pendingReplacement ? 1 : 0);
    if (pendingCount < this.maxPendingCommands) {
      return undefined;
    }
    return new GraphError(
      'FG_LAYOUT_WORKER_QUEUE_FULL',
      'The layout worker already has the maximum number of pending acknowledged commands.',
      { maximum: this.maxPendingCommands, operation }
    );
  }

  private handleMessage(event: Event): void {
    if (this.disposed || this.currentState === 'failed') {
      return;
    }
    const message = (event as MessageEvent<unknown>).data;
    if (!isLayoutWorkerMessage(
      message,
      this.expectedSnapshotNodeCount,
      this.pendingReplacement?.candidateNodeCount
    )) {
      if (hasKnownLayoutWorkerMessageType(message)) {
        this.fail(new GraphError('FG_LAYOUT_BUFFER_PROTOCOL_FAILED', 'The layout worker returned a malformed protocol message.'));
      }
      return;
    }
    if (message.type === 'ack') {
      if (this.resolvePendingReplacement(message)) {
        return;
      }
      this.resolvePendingCommand(message);
      return;
    }
    if (message.type === 'nack') {
      const error = new GraphError('FG_LAYOUT_WORKER_FAILED', message.message, {
        workerCode: message.code,
        operation: message.operation,
        requestId: message.requestId,
        revision: message.revision
      });
      if (this.rejectPendingReplacement(message.requestId, error, message.operation, message.revision)) {
        return;
      }
      if (message.operation === 'step') {
        this.rejectPendingStep(message.requestId, error, message.revision);
      } else {
        this.rejectPendingCommand(message.requestId, error, message.operation, message.revision);
      }
      return;
    }
    if (message.type === 'error') {
      if (this.pendingReplacement && message.revision === this.pendingReplacement.candidateRevision) {
        this.rejectPendingReplacement(
          this.pendingReplacement.requestId,
          new GraphError('FG_LAYOUT_WORKER_FAILED', message.message, { workerCode: message.code }),
          'initialize',
          message.revision
        );
        return;
      }
      if (message.revision !== undefined && message.revision !== this.currentRevision) {
        return;
      }
      this.fail(new GraphError('FG_LAYOUT_WORKER_FAILED', message.message, { workerCode: message.code }));
      return;
    }
    if (message.type === 'settled') {
      if (this.pendingReplacement && message.revision === this.pendingReplacement.candidateRevision) {
        this.pendingReplacement.state = { state: 'ready', alpha: message.alpha };
        return;
      }
      if (this.hasPendingCommandForRevision(message.revision)) {
        this.pendingAcknowledgedState = message;
        return;
      }
      if (message.revision !== this.currentRevision) {
        return;
      }
      if (this.currentState !== 'stopped') {
        this.running = false;
        this.currentState = 'ready';
      }
      this.currentAlpha = message.alpha;
      return;
    }
    if (message.type === 'state') {
      if (this.pendingReplacement && message.revision === this.pendingReplacement.candidateRevision) {
        this.pendingReplacement.state = { state: message.state, alpha: message.alpha };
        return;
      }
      if (this.hasPendingCommandForRevision(message.revision)) {
        this.pendingAcknowledgedState = message;
        return;
      }
      if (message.revision !== this.currentRevision) {
        return;
      }
      this.currentAlpha = message.alpha;
      this.running = message.state === 'running';
      this.currentState = message.state;
      return;
    }
    if (this.pendingReplacement && message.revision === this.pendingReplacement.candidateRevision) {
      this.capturePendingReplacementSnapshot(message);
      return;
    }
    if (this.hasPendingCommandForRevision(message.revision)) {
      if (this.pendingAcknowledgedSnapshot) {
        this.reclaimSnapshot(this.pendingAcknowledgedSnapshot);
      }
      this.pendingAcknowledgedSnapshot = message;
      return;
    }
    try {
      if (message.revision !== this.currentRevision) {
        return;
      }
      this.consumeSnapshot(message);
    } catch (cause) {
      this.fail(new GraphError('FG_LAYOUT_WORKER_FAILED', 'A layout snapshot consumer threw an exception.', { cause }));
    }
  }

  private handleError(event: Event): void {
    const errorEvent = event as ErrorEvent;
    this.fail(new GraphError('FG_LAYOUT_WORKER_FAILED', errorEvent.message || 'The layout worker failed.'));
  }

  private fail(error: GraphError): void {
    if (this.disposed || this.currentState === 'failed') {
      return;
    }
    this.failureWasRunning = this.running;
    this.failure = error;
    this.running = false;
    this.currentState = 'failed';
    this.rejectPending(error);
    this.detachWorker();
    this.worker.terminate?.();
    try {
      this.callbacks.onError(error);
    } catch {
      // Observer failures must not revive or interrupt a terminal worker failure.
    }
  }

  private assertUsable(): void {
    if (this.currentState === 'failed') {
      throw this.failure ?? new GraphError('FG_LAYOUT_WORKER_FAILED', 'The layout worker bridge has failed and was terminated.');
    }
    if (this.disposed || this.currentState === 'disposed') {
      throw new GraphError('FG_RESOURCE_ALREADY_DISPOSED', 'The layout worker bridge has already been disposed.');
    }
  }

  private detachWorker(): void {
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    if (this.worker.removeEventListener) {
      this.worker.removeEventListener('message', this.onMessageBound);
      this.worker.removeEventListener('error', this.onErrorBound);
    } else {
      this.worker.onmessage = null;
      this.worker.onerror = null;
    }
  }

  private rejectPending(error: Error): void {
    for (const requestId of [...this.pendingSteps.keys()]) {
      this.rejectPendingStep(requestId, error);
    }
    for (const requestId of [...this.pendingCommands.keys()]) {
      this.rejectPendingCommand(requestId, error);
    }
    if (this.pendingReplacement) {
      this.rejectPendingReplacement(this.pendingReplacement.requestId, error);
    }
    this.discardPendingAcknowledgedMessages();
  }

  private hasPendingCommandForRevision(revision: number): boolean {
    for (const pending of this.pendingCommands.values()) {
      if (pending.revision === revision) {
        return true;
      }
    }
    return false;
  }

  private flushPendingAcknowledgedMessages(revision: number): void {
    if (this.disposed || this.currentState === 'failed') {
      return;
    }
    if (this.hasPendingCommandForRevision(revision)) {
      return;
    }
    const state = this.pendingAcknowledgedState;
    if (state && state.revision === revision) {
      this.pendingAcknowledgedState = undefined;
      if (state.type === 'settled') {
        this.running = false;
        this.currentState = 'ready';
        this.currentAlpha = state.alpha;
      } else {
        this.currentAlpha = state.alpha;
        this.running = state.state === 'running';
        this.currentState = state.state;
      }
    }
    const snapshot = this.pendingAcknowledgedSnapshot;
    if (snapshot && snapshot.revision === revision) {
      this.pendingAcknowledgedSnapshot = undefined;
      try {
        this.consumeSnapshot(snapshot);
      } catch (cause) {
        this.fail(new GraphError('FG_LAYOUT_WORKER_FAILED', 'A layout snapshot consumer threw an exception.', { cause }));
      }
    }
  }

  private discardPendingAcknowledgedMessages(): void {
    this.pendingAcknowledgedState = undefined;
    if (this.pendingAcknowledgedSnapshot) {
      this.reclaimSnapshot(this.pendingAcknowledgedSnapshot);
      this.pendingAcknowledgedSnapshot = undefined;
    }
  }

  private capturePendingReplacementSnapshot(message: Extract<LayoutWorkerMessage, { type: 'snapshot' }>): void {
    const pending = this.pendingReplacement;
    if (!pending) {
      return;
    }
    if (pending.snapshot) {
      this.reclaimSnapshot(pending.snapshot);
    }
    pending.snapshot = message;
  }

  private resolvePendingReplacement(message: Extract<LayoutWorkerMessage, { type: 'ack' }>): boolean {
    const pending = this.pendingReplacement;
    if (!pending
      || pending.requestId !== message.requestId
      || message.operation !== 'initialize'
      || pending.candidateRevision !== message.revision) {
      return false;
    }
    this.pendingReplacement = undefined;
    clearTimeout(pending.timeout);
    this.currentRevision = pending.candidateRevision;
    this.expectedSnapshotNodeCount = pending.candidateNodeCount;
    this.currentState = message.state;
    this.currentAlpha = message.alpha;
    this.running = message.running;
    try {
      if (pending.snapshot) {
        this.consumeSnapshot(pending.snapshot);
      }
      pending.resolve();
    } catch (cause) {
      const error = new GraphError('FG_LAYOUT_WORKER_FAILED', 'A layout snapshot consumer threw an exception.', { cause });
      pending.reject(error);
      this.fail(error);
    }
    return true;
  }

  private rejectPendingReplacement(
    requestId: number,
    error: Error,
    operation?: LayoutWorkerOperation,
    revision?: number
  ): boolean {
    const pending = this.pendingReplacement;
    if (!pending
      || pending.requestId !== requestId
      || (operation !== undefined && operation !== 'initialize')
      || (revision !== undefined && pending.candidateRevision !== revision)) {
      return false;
    }
    this.pendingReplacement = undefined;
    clearTimeout(pending.timeout);
    if (this.currentState !== 'failed' && !this.disposed) {
      this.currentState = pending.previousState;
      this.running = pending.previousRunning;
      this.currentAlpha = pending.previousAlpha;
      this.currentSteps = pending.previousSteps;
      this.currentLastStepMs = pending.previousLastStepMs;
      this.expectedSnapshotNodeCount = pending.previousExpectedSnapshotNodeCount;
    }
    if (pending.snapshot) {
      this.reclaimSnapshot(pending.snapshot);
    }
    pending.reject(error);
    return true;
  }

  private consumeSnapshot(message: Extract<LayoutWorkerMessage, { type: 'snapshot' }>): void {
    this.currentAlpha = message.snapshot.alpha;
    this.currentSteps = message.steps;
    this.currentLastStepMs = message.lastStepMs;
    this.currentSeparationDiagnostics = message.separation ?? {
      resolvableOverlapPairCount: 0,
      maximumPenetration: 0,
      pairChecks: 0,
      budgetExhausted: false,
      deferredPairCount: 0,
      consecutiveNoProgressSteps: 0,
      constrainedSettlement: false,
      correctionSweepsCompleted: 0,
      verificationSweepsCompleted: 0,
      verifiedOverlapPairCount: 0,
      verifiedMaximumPenetration: 0
    };
    if (this.currentState === 'starting' || this.currentState === 'running') {
      this.running = !message.snapshot.settled;
      this.currentState = this.running ? 'running' : 'ready';
    }
    try {
      this.callbacks.onSnapshot(message.snapshot);
      if (message.requestId !== undefined) {
        this.resolvePendingStep(message.requestId, message.revision);
      }
    } finally {
      this.reclaimSnapshot(message);
    }
  }

  private resolvePendingStep(requestId: number, revision: number): void {
    const pending = this.pendingSteps.get(requestId);
    if (!pending || pending.revision !== revision) {
      return;
    }
    this.pendingSteps.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve();
  }

  private rejectPendingStep(requestId: number, error: Error, revision?: number): void {
    const pending = this.pendingSteps.get(requestId);
    if (!pending || (revision !== undefined && pending.revision !== revision)) {
      return;
    }
    this.pendingSteps.delete(requestId);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private resolvePendingCommand(message: Extract<LayoutWorkerMessage, { type: 'ack' }>): void {
    const pending = this.pendingCommands.get(message.requestId);
    if (!pending || pending.operation !== message.operation || pending.revision !== message.revision) {
      return;
    }
    this.pendingCommands.delete(message.requestId);
    clearTimeout(pending.timeout);
    this.currentState = message.state;
    this.currentAlpha = message.alpha;
    this.running = message.running;
    pending.resolve();
    queueMicrotask(() => this.flushPendingAcknowledgedMessages(message.revision));
  }

  private rejectPendingCommand(
    requestId: number,
    error: Error,
    operation?: LayoutWorkerOperation,
    revision?: number
  ): void {
    const pending = this.pendingCommands.get(requestId);
    if (!pending
      || (operation !== undefined && pending.operation !== operation)
      || (revision !== undefined && pending.revision !== revision)) {
      return;
    }
    this.pendingCommands.delete(requestId);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private reclaimSnapshot(message: Extract<LayoutWorkerMessage, { type: 'snapshot' }>): void {
    if (message.poolId === undefined) {
      return;
    }
    const buffers: SnapshotTransferBuffers = {
      nodeIndices: message.snapshot.nodeIndices,
      positions: message.snapshot.positions,
      velocities: message.snapshot.velocities
    };
    this.post(
      { type: 'reclaim', revision: message.revision, poolId: message.poolId, buffers },
      transferableSnapshotBuffers(buffers)
    );
  }
}

export function createDefaultWorkerFactory(): (() => WorkerLike) | undefined {
  if (typeof Worker === 'undefined') {
    return undefined;
  }
  return () => new Worker(new URL('../worker/force-worker-entry.js', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

function transferableBuffers(input: LayoutInput): Transferable[] {
  return [...new Set([
    input.nodeIndices.buffer,
    input.positions.buffer,
    input.velocities.buffer,
    input.fixedMask.buffer,
    input.fixedPositions.buffer,
    input.links.buffer
  ].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer))];
}

function transferableSnapshotBuffers(buffers: SnapshotTransferBuffers): Transferable[] {
  return [...new Set([
    buffers.nodeIndices.buffer,
    buffers.positions.buffer,
    buffers.velocities.buffer
  ].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer))];
}

function isLayoutWorkerMessage(
  value: unknown,
  expectedSnapshotNodeCount: number | undefined,
  pendingSnapshotNodeCount: number | undefined
): value is LayoutWorkerMessage {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'snapshot') {
    return isTrustedLayoutSnapshot(value.snapshot, expectedSnapshotNodeCount, pendingSnapshotNodeCount)
      && isFiniteNumber(value.steps)
      && isFiniteNumber(value.lastStepMs)
      && isOptionalSeparationDiagnostics(value.separation)
      && isRevision(value.revision)
      && isOptionalRequestId(value.requestId)
      && isOptionalPoolId(value.poolId);
  }
  if (value.type === 'settled') {
    return isFiniteNumber(value.alpha) && isRevision(value.revision);
  }
  if (value.type === 'state') {
    return (value.state === 'ready' || value.state === 'running' || value.state === 'stopped')
      && isFiniteNumber(value.alpha)
      && isRevision(value.revision);
  }
  if (value.type === 'ack') {
    return isLayoutWorkerOperation(value.operation)
      && isRevision(value.requestId)
      && isRevision(value.revision)
      && (value.state === 'ready' || value.state === 'running' || value.state === 'stopped')
      && isFiniteNumber(value.alpha)
      && typeof value.running === 'boolean';
  }
  if (value.type === 'nack') {
    return isLayoutWorkerOperation(value.operation)
      && isRevision(value.requestId)
      && isRevision(value.revision)
      && typeof value.code === 'string'
      && typeof value.message === 'string';
  }
  return value.type === 'error'
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && (value.revision === undefined || isRevision(value.revision));
}

function isOptionalSeparationDiagnostics(value: unknown): boolean {
  return value === undefined
    || (isRecord(value)
      && isNonNegativeInteger(value.resolvableOverlapPairCount)
      && isFiniteNumber(value.maximumPenetration)
      && value.maximumPenetration >= 0
      && isNonNegativeInteger(value.pairChecks)
      && typeof value.budgetExhausted === 'boolean'
      && isNonNegativeInteger(value.deferredPairCount)
      && isNonNegativeInteger(value.consecutiveNoProgressSteps)
      && typeof value.constrainedSettlement === 'boolean'
      && isNonNegativeInteger(value.correctionSweepsCompleted)
      && isNonNegativeInteger(value.verificationSweepsCompleted)
      && isNonNegativeInteger(value.verifiedOverlapPairCount)
      && isFiniteNumber(value.verifiedMaximumPenetration)
      && value.verifiedMaximumPenetration >= 0);
}

function hasKnownLayoutWorkerMessageType(value: unknown): boolean {
  return isRecord(value)
    && (value.type === 'snapshot'
      || value.type === 'settled'
      || value.type === 'state'
      || value.type === 'ack'
      || value.type === 'nack'
      || value.type === 'error');
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

/**
 * Input uniqueness is validated before each worker epoch. Snapshots from that
 * trusted session need exact typed-array shape, not a new allocation-heavy
 * uniqueness Set on every frame.
 */
function isTrustedLayoutSnapshot(
  value: unknown,
  expectedNodeCount: number | undefined,
  pendingNodeCount: number | undefined
): value is LayoutSnapshot {
  return isRecord(value)
    && value.nodeIndices instanceof Uint32Array
    && value.positions instanceof Float32Array
    && value.velocities instanceof Float32Array
    && isFiniteNumber(value.alpha)
    && typeof value.settled === 'boolean'
    && value.positions.length === value.nodeIndices.length * 3
    && value.velocities.length === value.nodeIndices.length * 3
    && hasFiniteValues(value.positions)
    && hasFiniteValues(value.velocities)
    && (expectedNodeCount === undefined
      || value.nodeIndices.length === expectedNodeCount
      || (pendingNodeCount !== undefined && value.nodeIndices.length === pendingNodeCount));
}

function isOptionalRequestId(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalPoolId(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasFiniteValues(values: Float32Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      return false;
    }
  }
  return true;
}

function isRevision(value: unknown): value is number {
  return isNonNegativeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normalizeStepCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function normalizeInitialAlpha(alpha: number, nodeCount: number): number {
  if (nodeCount === 0) return 0;
  return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
}

function resolveWorkerStepTimeoutMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(RESOURCE_LIMITS.maxWorkerTimeoutMs, Math.max(1, Math.floor(value)))
    : DEFAULT_WORKER_STEP_TIMEOUT_MS;
}

function resolveWorkerCommandTimeoutMs(value: number | undefined, compatibilityFallback: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(RESOURCE_LIMITS.maxWorkerTimeoutMs, Math.max(1, Math.floor(value)))
    : compatibilityFallback !== undefined
      ? resolveWorkerStepTimeoutMs(compatibilityFallback)
      : DEFAULT_WORKER_COMMAND_TIMEOUT_MS;
}

function resolvePositiveInteger(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : fallback;
}

function workerConfiguration(options: LayoutConfiguration | undefined): LayoutConfiguration {
  if (!options) {
    return {};
  }
  const {
    backend: _backend,
    workerFactory: _workerFactory,
    workerStepTimeoutMs: _workerStepTimeoutMs,
    workerCommandTimeoutMs: _workerCommandTimeoutMs,
    maxPendingWorkerCommands: _maxPendingWorkerCommands,
    failurePolicy: _failurePolicy,
    ...configuration
  } = options;
  return configuration;
}
