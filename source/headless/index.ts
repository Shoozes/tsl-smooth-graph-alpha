import { GraphError } from '../core/errors.js';
import { normalizeHeadlessForceGraphOptions } from '../core/options.js';
import { GraphStore, type PreparedGraphMutation } from '../data/GraphStore.js';
import { DeterministicForceLayout, resolveLayoutConfiguration } from '../layout/ForceLayout.js';
import type {
  HeadlessGraphBounds,
  HeadlessGraphData,
  HeadlessGraphId,
  HeadlessGraphOptions,
  HeadlessGraphPatch,
  HeadlessGraphReadView,
  HeadlessGraphSnapshot,
  HeadlessLayoutResult,
  HeadlessLayoutSnapshot,
  HeadlessLink,
  HeadlessMutationResult,
  HeadlessNodeInput,
  HeadlessVec3,
  LegacyHeadlessGraphSnapshot
} from './types.js';

export { GraphError } from '../core/errors.js';
export type {
  HeadlessGraphBounds,
  HeadlessGraphData,
  HeadlessGraphErrorLike,
  HeadlessGraphId,
  HeadlessGraphOptions,
  HeadlessGraphPatch,
  HeadlessGraphReadView,
  HeadlessGraphSnapshot,
  HeadlessLayoutOptions,
  HeadlessLayoutResult,
  HeadlessLayoutSnapshot,
  HeadlessLink,
  HeadlessMutationResult,
  HeadlessNodeInput,
  HeadlessNodePatch,
  HeadlessSeparationDiagnostics,
  HeadlessVec3,
  LegacyHeadlessGraphSnapshot
} from './types.js';

/** DOM-free graph state and deterministic local-layout owner for Node and Workers. */
export class HeadlessForceGraph<TNode = unknown, TLink = unknown> {
  readonly #store: GraphStore<TNode, TLink>;
  readonly #layout: DeterministicForceLayout;
  readonly #readView: HeadlessGraphReadView<TNode, TLink>;
  readonly #autoStart: boolean;
  readonly #topologyReheatAlpha: number;
  #disposed = false;

  constructor(options: HeadlessGraphOptions = {}) {
    const normalized = normalizeHeadlessForceGraphOptions(options);
    const layoutOptions = normalized.layout ?? {};
    const resolvedLayout = resolveLayoutConfiguration(layoutOptions);
    this.#autoStart = layoutOptions.autoStart ?? true;
    this.#topologyReheatAlpha = resolvedLayout.topologyReheatAlpha;
    this.#store = new GraphStore<TNode, TLink>({
      seed: layoutOptions.seed ?? 1337,
      validationMode: normalized.validation?.mode ?? 'strict'
    });
    this.#layout = new DeterministicForceLayout(layoutOptions);
    const graph = this;
    this.#readView = Object.freeze({
      get revision() { graph.assertActive(); return graph.#store.currentRevision; },
      get nodeCount() { graph.assertActive(); return graph.#store.nodeCount; },
      get linkCount() { graph.assertActive(); return graph.#store.linkCount; },
      hasNode(id: HeadlessGraphId) { graph.assertActive(); return graph.#store.hasNode(id); },
      hasLink(id: HeadlessGraphId) { graph.assertActive(); return graph.#store.hasLink(id); },
      getNode(id: HeadlessGraphId) { graph.assertActive(); return graph.#store.getNode(id) as HeadlessNodeInput<TNode> | undefined; },
      getLink(id: HeadlessGraphId) { graph.assertActive(); return graph.#store.getLink(id) as HeadlessLink<TLink> | undefined; },
      getNodePosition(id: HeadlessGraphId) { graph.assertActive(); return freezePosition(graph.#store.getNodePosition(id)); },
      getBounds() { graph.assertActive(); return freezeBounds(graph.#store.getBounds()); }
    });
    this.#layout.initialize(this.#store.createLayoutInput(), { alpha: 0, running: false });
  }

  get isDisposed(): boolean { return this.#disposed; }
  get graph(): HeadlessGraphReadView<TNode, TLink> { this.assertActive(); return this.#readView; }

  setData(data: HeadlessGraphData<TNode, TLink>): HeadlessMutationResult {
    this.assertActive();
    return this.commitPreparedMutation(this.#store.prepareSetData(data as never));
  }

  applyPatch(patch: HeadlessGraphPatch<TNode, TLink>): HeadlessMutationResult {
    this.assertActive();
    return this.commitPreparedMutation(this.#store.preparePatch(patch as never));
  }

  clear(): HeadlessMutationResult {
    this.assertActive();
    return this.commitPreparedMutation(this.#store.prepareClear());
  }

  startLayout(): void { this.assertActive(); this.#layout.start(); }
  stopLayout(): void { this.assertActive(); this.#layout.stop(); }
  restartLayout(): void { this.assertActive(); this.#layout.restart(); }

  stepLayout(steps = 1): HeadlessLayoutResult {
    this.assertActive();
    const snapshot = this.#layout.step(steps);
    this.#store.applyLayoutSnapshot(snapshot);
    return this.layoutResult(snapshot);
  }

  advanceLayout(seconds: number): HeadlessLayoutResult {
    this.assertActive();
    const snapshot = this.#layout.advance(seconds);
    this.#store.applyLayoutSnapshot(snapshot);
    return this.layoutResult(snapshot);
  }

  getLayoutSnapshot(): HeadlessLayoutSnapshot {
    this.assertActive();
    return copySnapshot(this.#layout.snapshot());
  }

  exportSnapshot(): HeadlessGraphSnapshot<TNode, TLink> {
    this.assertActive();
    return Object.freeze({
      schema: 'tsl-smooth-graph/graph-snapshot' as const,
      version: 2 as const,
      data: this.#store.toGraphData() as HeadlessGraphData<TNode, TLink>
    });
  }

  importSnapshot(snapshot: HeadlessGraphSnapshot<TNode, TLink> | LegacyHeadlessGraphSnapshot<TNode, TLink>): HeadlessMutationResult {
    this.assertActive();
    if (!isSupportedSnapshot(snapshot)) {
      throw new GraphError('FG_DATA_INVALID_ID', 'Graph snapshot schema or version is invalid.');
    }
    const result = this.setData(snapshot.data);
    return Object.freeze({ ...result, kind: 'import-snapshot' as const });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#layout.dispose();
    this.#store.release();
  }

  private commitPreparedMutation(plan: PreparedGraphMutation): HeadlessMutationResult {
    if (!plan.change.simulationChanged && !plan.change.topologyChanged) {
      return this.#store.commitPrepared(plan) as HeadlessMutationResult;
    }
    const previousInput = this.#store.createLayoutInput();
    const previousState = {
      alpha: this.#layout.currentAlpha,
      steps: this.#layout.steps,
      lastStepMs: this.#layout.lastStepMs,
      running: this.#layout.isRunning
    };
    const input = plan.createLayoutInput();
    const initialAlpha = this.replacementAlpha(plan, input);
    try {
      this.#layout.initialize(input, {
        alpha: initialAlpha,
        running: this.#autoStart && input.nodeIndices.length > 0
      });
      return this.#store.commitPrepared(plan) as HeadlessMutationResult;
    } catch (cause) {
      try {
        this.#layout.initialize(previousInput, previousState);
      } catch (rollbackCause) {
        throw new GraphError(
          'FG_LAYOUT_MUTATION_ROLLBACK_FAILED',
          'The failed headless layout replacement could not be rolled back to the previous state.',
          { cause: rollbackCause, original: cause }
        );
      }
      throw cause;
    }
  }

  private replacementAlpha(plan: PreparedGraphMutation, input: ReturnType<GraphStore<TNode, TLink>['createLayoutInput']>): number {
    if (input.nodeIndices.length === 0) return 0;
    const isIncrementalTopologyPatch = plan.change.kind === 'patch'
      && plan.change.topologyChanged
      && this.#store.nodeCount > 0;
    if (!isIncrementalTopologyPatch) return 1;
    return Math.max(this.#layout.currentAlpha, this.#topologyReheatAlpha);
  }

  private layoutResult(snapshot: ReturnType<DeterministicForceLayout['snapshot']>): HeadlessLayoutResult {
    return Object.freeze({
      snapshot: copySnapshot(snapshot),
      steps: this.#layout.steps,
      running: this.#layout.isRunning,
      lastStepMs: this.#layout.lastStepMs,
      separation: Object.freeze({ ...this.#layout.separationDiagnostics })
    });
  }

  private assertActive(): void {
    if (this.#disposed) throw new GraphError('FG_RESOURCE_ALREADY_DISPOSED', 'Headless graph is disposed.');
  }
}

export function createHeadlessForceGraph<TNode = unknown, TLink = unknown>(
  options: HeadlessGraphOptions = {}
): HeadlessForceGraph<TNode, TLink> {
  return new HeadlessForceGraph<TNode, TLink>(options);
}

function isSupportedSnapshot(value: unknown): value is HeadlessGraphSnapshot | LegacyHeadlessGraphSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { schema?: string; version?: number; data?: unknown };
  return ((candidate.schema === 'tsl-smooth-graph/graph-snapshot' && candidate.version === 2)
    || (candidate.schema === '@ours/forcegraph-tsl/graph-snapshot' && candidate.version === 1))
    && !!candidate.data
    && typeof candidate.data === 'object';
}

function freezePosition(value: { x: number; y: number; z: number } | undefined): Readonly<HeadlessVec3> | undefined {
  return value ? Object.freeze({ x: value.x, y: value.y, z: value.z }) : undefined;
}

function freezeBounds(value: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | undefined): HeadlessGraphBounds | undefined {
  return value ? Object.freeze({ min: Object.freeze({ ...value.min }), max: Object.freeze({ ...value.max }) }) : undefined;
}

function copySnapshot(snapshot: ReturnType<DeterministicForceLayout['snapshot']>): HeadlessLayoutSnapshot {
  return Object.freeze({
    nodeIndices: new Uint32Array(snapshot.nodeIndices),
    positions: new Float32Array(snapshot.positions),
    velocities: new Float32Array(snapshot.velocities),
    alpha: snapshot.alpha,
    settled: snapshot.settled
  });
}
