import { GraphEventEmitter } from './EventEmitter.js';
import { GraphError } from './errors.js';
import { normalizeForceGraphOptions } from './options.js';
import {
  InvalidationReason,
  NodeFlags,
  type ForceGraphOptions,
  type GraphData,
  type GraphDataChange,
  type GraphMutationResult,
  type GraphDiagnostics,
  type GraphBounds,
  type DeviceLostEvent,
  type GraphEventListener,
  type GraphEventName,
  type GraphObserverErrorEvent,
  type GraphObserverErrorListener,
  type GraphId,
  type GraphLink,
  type GraphNode,
  type GraphNodeHandle,
  type GraphPatch,
  type GraphReadView,
  type GraphSnapshot,
  type LegacyGraphSnapshot,
  type LayoutFailurePolicy,
  type RendererBackend,
  type RendererBackendPolicy,
  type GraphStartupReport,
  type GraphStartupWarning,
  type ForceGraph,
  type InteractionOptions,
  type LayoutInput,
  type LayoutSnapshot,
  type LinkStyleOptions,
  type LinkFlowOptions,
  type NodeStateTheme,
  type NodeSurfaceOptions,
  type NodeStyleOptions,
  type CameraPose,
  type Vec3
} from './types.js';
import { GraphStore, type PreparedGraphMutation } from '../data/GraphStore.js';
import { InteractionController } from '../interaction/InteractionController.js';
import {
  createDefaultWorkerFactory,
  LocalLayoutBridge,
  type LayoutBridge,
  WorkerLayoutBridge
} from '../layout/LayoutBridge.js';
import {
  createThreeHost,
  applyCameraPose,
  resizeManagedHost,
  type HostDeviceLossSignal,
  type ResolvedThreeHost
} from '../platform/three/ThreeHost.js';
import { ThreeGraphRenderer } from '../render/ThreeGraphRenderer.js';
import { preflightThreeCreation } from '../platform/three/creationPreflight.js';
import { DEFAULT_LAYOUT_CONFIGURATION } from '../layout/ForceLayout.js';

interface NodeStyleUpdate {
  readonly id?: GraphId;
  readonly index: number;
  readonly radius: number;
  readonly color: number;
}

interface LinkStyleUpdate {
  readonly id?: GraphId;
  readonly index: number;
  readonly width: number;
  readonly color: number;
}

interface StyleCacheRefreshResult {
  readonly nodeIds: GraphId[];
  readonly linkIds: GraphId[];
  readonly resolutionFailed: boolean;
}

interface PendingAsyncDragOperation {
  readonly kind: 'begin' | 'move' | 'end';
  readonly nodeId: GraphId;
  readonly position: Vec3;
  readonly originalEvent: unknown;
  resolve(): void;
  reject(error: unknown): void;
}

export class GraphController<TNode = unknown, TLink = unknown> implements ForceGraph<TNode, TLink> {
  readonly #store: GraphStore<TNode, TLink>;
  private readonly readView: GraphReadView<TNode, TLink>;
  private readonly options: ForceGraphOptions<TNode, TLink>;
  private readonly observerErrorListeners = new Set<GraphObserverErrorListener>();
  private readonly events = new GraphEventEmitter((eventName, error) => this.notifyObserverError(eventName, error));
  private layout!: LayoutBridge;
  private host: ResolvedThreeHost | undefined;
  private cameraTarget: Vec3 = { x: 0, y: 0, z: 0 };
  private renderer: ThreeGraphRenderer<TNode, TLink> | undefined;
  private interaction: InteractionController | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private pixelRatioUnsubscribe: (() => void) | undefined;
  private nodeStyle: NodeStyleOptions<TNode>;
  private linkStyle: LinkStyleOptions<TLink>;
  private nodeSurface: NodeSurfaceOptions | undefined;
  private linkFlow: LinkFlowOptions | undefined;
  private selection = new Set<GraphId>();
  private hoveredNode: GraphId | undefined;
  private frameRequest: number | undefined;
  private lastFrameAt = 0;
  private lastFrameDurationMs = 0;
  private lastLayoutSnapshotAt = 0;
  private renderPositionRevision = 0;
  private lastPickDurationMs = 0;
  private invalidationMask = InvalidationReason.None;
  private renderDataDirty = false;
  private readonly pendingNodeStateIds = new Set<GraphId>();
  private readonly pendingLinkStyleIds = new Set<GraphId>();
  private readonly pendingLinkEndpointRadiusIds = new Set<GraphId>();
  private stateThemeRefreshPending = false;
  private disposed = false;
  private deviceLossHandled = false;
  private layoutSettledNotified = false;
  private mutationInProgress = false;
  private mutationIdlePromise: Promise<void> = Promise.resolve();
  private readonly pendingAsyncDragOperations: PendingAsyncDragOperation[] = [];
  private asyncDragDrainRunning = false;
  private asyncDragDrainScheduled = false;
  private asyncDragNode: GraphId | undefined;
  private asyncDragAccepted = false;
  private bufferedLayoutSnapshot: LayoutSnapshot | undefined;
  private bufferedLayoutError: Error | undefined;
  private bufferedLayoutErrorBridge: LayoutBridge | undefined;
  private readonly startupWarnings: GraphStartupWarning[] = [];
  private startupReport!: GraphStartupReport;
  private readonly layoutFailurePolicy: LayoutFailurePolicy;
  private layoutFailure: Error | undefined;

  private constructor(options: ForceGraphOptions<TNode, TLink>) {
    this.options = options;
    this.#store = new GraphStore({
      seed: options.layout?.seed ?? 1337,
      validationMode: options.validation?.mode ?? 'strict'
    });
    const controller = this;
    this.readView = Object.freeze({
      get revision(): number {
        controller.assertActive();
        return controller.#store.currentRevision;
      },
      get nodeCount(): number {
        controller.assertActive();
        return controller.#store.nodeCount;
      },
      get linkCount(): number {
        controller.assertActive();
        return controller.#store.linkCount;
      },
      hasNode(id: GraphId): boolean {
        controller.assertActive();
        return controller.#store.hasNode(id);
      },
      hasLink(id: GraphId): boolean {
        controller.assertActive();
        return controller.#store.hasLink(id);
      },
      getNode(id: GraphId): GraphNode<TNode> | undefined {
        controller.assertActive();
        return controller.#store.getNode(id);
      },
      getLink(id: GraphId): GraphLink<TLink> | undefined {
        controller.assertActive();
        return controller.#store.getLink(id);
      },
      getNodeHandle(id: GraphId): GraphNodeHandle | undefined {
        controller.assertActive();
        return controller.#store.getNodeHandle(id);
      },
      getNodePosition(id: GraphId): Readonly<Vec3> | undefined {
        controller.assertActive();
        return freezeVec3(controller.#store.getNodePosition(id));
      },
      getBounds(): GraphBounds | undefined {
        controller.assertActive();
        return controller.#store.getBounds();
      }
    });
    this.nodeStyle = { ...options.nodes };
    this.linkStyle = { ...options.links };
    this.nodeSurface = options.renderer?.nodeSurface;
    this.linkFlow = options.renderer?.linkFlow;
    this.layoutFailurePolicy = options.layout?.failurePolicy ?? 'freeze';
  }

  static async create<TNode = unknown, TLink = unknown>(
    options: ForceGraphOptions<TNode, TLink> = {}
  ): Promise<GraphController<TNode, TLink>> {
    const normalized = normalizeForceGraphOptions(options);
    preflightThreeCreation(normalized);
    const controller = new GraphController(normalized);
    try {
      await controller.initialize();
      return controller;
    } catch (error) {
      controller.dispose();
      throw error;
    }
  }

  get object3D(): unknown | undefined {
    return this.renderer?.object3D;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Returns immutable initialization facts even after the graph is disposed. */
  getStartupReport(): GraphStartupReport {
    return this.startupReport;
  }

  setData(data: GraphData<TNode, TLink>): GraphMutationResult {
    this.assertActive();
    this.assertMutationIdle();
    const plan = this.#store.prepareSetData(data);
    const { change, layoutRebuilt } = this.commitPreparedMutation(plan);
    if (change.topologyChanged || change.simulationChanged) {
      this.interaction?.cancelActiveInteraction(undefined, false);
    }
    return this.afterDataChange(change, layoutRebuilt);
  }

  /**
   * Acknowledged mutation path for browser-worker layouts. Local layouts
   * resolve immediately; worker layouts commit only after replacement ACK.
   */
  async setDataAsync(data: GraphData<TNode, TLink>): Promise<GraphMutationResult> {
    this.assertActive();
    this.assertMutationIdle();
    const plan = this.#store.prepareSetData(data);
    const { change, layoutRebuilt } = await this.commitPreparedMutationAsync(plan);
    if (change.topologyChanged || change.simulationChanged) {
      this.interaction?.cancelActiveInteraction(undefined, false);
    }
    return this.afterDataChangeAsync(change, layoutRebuilt);
  }

  /** Exports a frozen, replayable graph envelope; serialization remains host-owned. */
  exportSnapshot(): GraphSnapshot<TNode, TLink> {
    this.assertActive();
    return Object.freeze({
      schema: 'tsl-smooth-graph/graph-snapshot' as const,
      version: 2 as const,
      data: this.#store.toGraphData()
    });
  }

  /** Imports a snapshot previously produced by this package's exportSnapshot contract. */
  importSnapshot(snapshot: GraphSnapshot<TNode, TLink> | LegacyGraphSnapshot<TNode, TLink>): GraphMutationResult {
    this.assertActive();
    this.assertMutationIdle();
    if (!isGraphSnapshot(snapshot)) {
      throw new GraphError('FG_DATA_INVALID_ID', 'Graph snapshot schema or version is invalid.');
    }
    const result = this.setData(snapshot.data);
    return Object.freeze({ ...result, kind: 'import-snapshot' as const });
  }

  async importSnapshotAsync(snapshot: GraphSnapshot<TNode, TLink> | LegacyGraphSnapshot<TNode, TLink>): Promise<GraphMutationResult> {
    this.assertActive();
    this.assertMutationIdle();
    if (!isGraphSnapshot(snapshot)) {
      throw new GraphError('FG_DATA_INVALID_ID', 'Graph snapshot schema or version is invalid.');
    }
    const result = await this.setDataAsync(snapshot.data);
    return Object.freeze({ ...result, kind: 'import-snapshot' as const });
  }

  applyPatch(patch: GraphPatch<TNode, TLink>): GraphMutationResult {
    this.assertActive();
    this.assertMutationIdle();
    if (isClearlyPayloadOnlyPatch(patch, this.#store)) {
      const change = this.#store.applyPatch(patch);
      const result = this.afterDataChange(change, false);
      return result;
    }
    const plan = this.#store.preparePatch(patch);
    const { change, layoutRebuilt } = this.commitPreparedMutation(plan);
    const activeNodeId = this.interaction?.activeNodeId;
    if (activeNodeId !== undefined && !this.#store.hasNode(activeNodeId)) {
      this.interaction?.cancelActiveInteraction(undefined, false);
    }
    return this.afterDataChange(change, layoutRebuilt);
  }

  async applyPatchAsync(patch: GraphPatch<TNode, TLink>): Promise<GraphMutationResult> {
    this.assertActive();
    this.assertMutationIdle();
    if (isClearlyPayloadOnlyPatch(patch, this.#store)) {
      const change = this.#store.applyPatch(patch);
      return this.afterDataChange(change, false);
    }
    const plan = this.#store.preparePatch(patch);
    const { change, layoutRebuilt } = await this.commitPreparedMutationAsync(plan);
    const activeNodeId = this.interaction?.activeNodeId;
    if (activeNodeId !== undefined && !this.#store.hasNode(activeNodeId)) {
      this.interaction?.cancelActiveInteraction(undefined, false);
    }
    return this.afterDataChangeAsync(change, layoutRebuilt);
  }

  clear(): GraphMutationResult {
    this.assertActive();
    this.assertMutationIdle();
    const plan = this.#store.prepareClear();
    const { change, layoutRebuilt } = this.commitPreparedMutation(plan);
    this.interaction?.cancelActiveInteraction(undefined, false);
    return this.afterDataChange(change, layoutRebuilt);
  }

  async clearAsync(): Promise<GraphMutationResult> {
    this.assertActive();
    this.assertMutationIdle();
    const plan = this.#store.prepareClear();
    const { change, layoutRebuilt } = await this.commitPreparedMutationAsync(plan);
    this.interaction?.cancelActiveInteraction(undefined, false);
    return this.afterDataChangeAsync(change, layoutRebuilt);
  }

  startLayout(): void {
    this.assertActive();
    this.assertMutationIdle();
    this.assertLayoutMutationAllowed();
    this.layoutSettledNotified = false;
    this.runLayoutCommand((bridge) => bridge.start());
    this.invalidate(InvalidationReason.Animation);
  }

  async startLayoutAsync(): Promise<void> {
    this.assertActive();
    this.assertMutationIdle();
    this.assertLayoutMutationAllowed();
    await this.runExclusiveLayoutMutation(async () => {
      const previousSettledNotified = this.layoutSettledNotified;
      this.layoutSettledNotified = false;
      try {
        await this.runLayoutCommandAsync((bridge) => bridge.startAsync());
        this.invalidate(InvalidationReason.Animation);
      } catch (cause) {
        this.layoutSettledNotified = previousSettledNotified;
        throw cause;
      }
    });
  }

  stopLayout(): void {
    this.assertActive();
    this.assertMutationIdle();
    this.assertLayoutMutationAllowed();
    this.runLayoutCommand((bridge) => bridge.stop());
    this.invalidate(InvalidationReason.Layout);
  }

  async stopLayoutAsync(): Promise<void> {
    this.assertActive();
    this.assertMutationIdle();
    this.assertLayoutMutationAllowed();
    await this.runExclusiveLayoutMutation(async () => {
      await this.runLayoutCommandAsync((bridge) => bridge.stopAsync());
      this.invalidate(InvalidationReason.Layout);
    });
  }

  restartLayout(): void {
    this.assertActive();
    this.assertMutationIdle();
    this.assertLayoutMutationAllowed();
    this.layoutSettledNotified = false;
    this.runLayoutCommand((bridge) => bridge.restart());
    this.invalidate(InvalidationReason.Animation);
  }

  async restartLayoutAsync(): Promise<void> {
    this.assertActive();
    this.assertMutationIdle();
    this.assertLayoutMutationAllowed();
    await this.runExclusiveLayoutMutation(async () => {
      const previousSettledNotified = this.layoutSettledNotified;
      this.layoutSettledNotified = false;
      try {
        await this.runLayoutCommandAsync((bridge) => bridge.restartAsync());
        this.invalidate(InvalidationReason.Animation);
      } catch (cause) {
        this.layoutSettledNotified = previousSettledNotified;
        throw cause;
      }
    });
  }

  async stepLayout(stepCount = 1): Promise<void> {
    this.assertActive();
    this.assertMutationIdle();
    this.assertLayoutMutationAllowed();
    await this.runExclusiveLayoutMutation(async () => {
      this.layoutSettledNotified = false;
      const bridge = this.layout;
      try {
        await bridge.step(stepCount);
      } catch (cause) {
        if (this.layout !== bridge && this.layoutFailurePolicy === 'fallback-local' && !this.disposed) {
          await this.layout.step(stepCount);
        } else {
          throw cause;
        }
      }
    });
  }

  setNodeFixed(nodeId: GraphId, position: Vec3): boolean {
    this.assertActive();
    this.assertMutationIdle();
    this.assertLayoutMutationAllowed();
    const handle = this.#store.getNodeHandle(nodeId);
    if (!handle || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      return false;
    }
    const bridge = this.layout;
    try {
      bridge.pin(handle.index, position);
    } catch (cause) {
      if (this.layout !== bridge && this.layoutFailurePolicy === 'fallback-local' && !this.disposed) {
        this.layout.pin(handle.index, position);
      } else {
        throw cause;
      }
    }
    const changed = this.#store.setNodeFixed(nodeId, position);
    if (!changed) return false;
    this.queueNodeAppearanceChanges([nodeId], true);
    this.layoutSettledNotified = false;
    this.markRendererPositionChanged();
    this.invalidate(InvalidationReason.Layout);
    return true;
  }

  async setNodeFixedAsync(nodeId: GraphId, position: Vec3): Promise<boolean> {
    this.assertActive();
    this.assertMutationIdle();
    return this.runExclusiveLayoutMutation(async () => {
      this.assertLayoutMutationAllowed();
      const handle = this.#store.getNodeHandle(nodeId);
      if (!handle || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
        return false;
      }
      await this.runLayoutCommandAsync((bridge) => bridge.pinAsync(handle.index, position));
      this.assertActive();
      const currentHandle = this.#store.getNodeHandle(nodeId);
      if (!currentHandle || currentHandle.index !== handle.index || currentHandle.generation !== handle.generation) {
        throw new GraphError(
          'FG_DATA_STALE_MUTATION_PLAN',
          'The pinned node handle became stale before the worker acknowledgement completed.',
          { nodeId, index: handle.index, generation: handle.generation }
        );
      }
      const changed = this.#store.setNodeFixed(nodeId, position);
      if (!changed) {
        return false;
      }
      this.queueNodeAppearanceChanges([nodeId], true);
      this.layoutSettledNotified = false;
      this.markRendererPositionChanged();
      this.invalidate(InvalidationReason.Layout);
      return true;
    });
  }

  releaseNode(nodeId: GraphId): boolean {
    this.assertActive();
    this.assertMutationIdle();
    this.assertLayoutMutationAllowed();
    const handle = this.#store.getNodeHandle(nodeId);
    if (!handle || !this.#store.isNodeFixed(nodeId)) {
      return false;
    }
    const bridge = this.layout;
    try {
      bridge.release(handle.index);
    } catch (cause) {
      if (this.layout !== bridge && this.layoutFailurePolicy === 'fallback-local' && !this.disposed) {
        this.layout.release(handle.index);
      } else {
        throw cause;
      }
    }
    const changed = this.#store.releaseNode(nodeId);
    if (!changed) return false;
    this.queueNodeAppearanceChanges([nodeId], true);
    this.layoutSettledNotified = false;
    this.markRendererPositionChanged();
    this.invalidate(InvalidationReason.Layout);
    return true;
  }

  async releaseNodeAsync(nodeId: GraphId): Promise<boolean> {
    this.assertActive();
    this.assertMutationIdle();
    return this.runExclusiveLayoutMutation(async () => {
      this.assertLayoutMutationAllowed();
      const handle = this.#store.getNodeHandle(nodeId);
      if (!handle || !this.#store.isNodeFixed(nodeId)) {
        return false;
      }
      await this.runLayoutCommandAsync((bridge) => bridge.releaseAsync(handle.index));
      this.assertActive();
      const currentHandle = this.#store.getNodeHandle(nodeId);
      if (!currentHandle || currentHandle.index !== handle.index || currentHandle.generation !== handle.generation) {
        throw new GraphError(
          'FG_DATA_STALE_MUTATION_PLAN',
          'The released node handle became stale before the worker acknowledgement completed.',
          { nodeId, index: handle.index, generation: handle.generation }
        );
      }
      const changed = this.#store.releaseNode(nodeId);
      if (!changed) {
        return false;
      }
      this.queueNodeAppearanceChanges([nodeId], true);
      this.layoutSettledNotified = false;
      this.markRendererPositionChanged();
      this.invalidate(InvalidationReason.Layout);
      return true;
    });
  }

  setNodeStyle(style: NodeStyleOptions<TNode>): void {
    this.assertActive();
    const normalized = normalizeForceGraphOptions<TNode, TLink>({ nodes: style }).nodes ?? {};
    const nextStyle = { ...this.nodeStyle, ...normalized };
    const refresh = this.refreshStyleCaches(undefined, nextStyle, this.linkStyle);
    if (refresh.resolutionFailed) {
      return;
    }
    this.nodeStyle = nextStyle;
    this.renderDataDirty = true;
    this.renderer?.invalidatePicking();
    this.invalidate(InvalidationReason.Style);
  }

  /** Re-resolves selected node accessors without mutating graph or layout state. */
  refreshNodeStyles(nodeIds: Iterable<GraphId>): readonly GraphId[] {
    this.assertActive();
    const requested = new Set<GraphId>();
    for (const nodeId of nodeIds) {
      if (this.#store.hasNode(nodeId)) requested.add(nodeId);
    }
    let resolutionFailed = false;
    const report = (error: GraphError): void => {
      resolutionFailed = true;
      this.events.emit('error', { error });
    };
    const updates = this.stageNodeStyleUpdates(requested, this.nodeStyle, report);
    if (resolutionFailed) return Object.freeze([]);

    const changedNodeIds: GraphId[] = [];
    const radiusChangedNodeIds: GraphId[] = [];
    for (const update of updates) {
      const previous = this.#store.getNodeRenderState(update.index);
      if (!previous || !this.#store.setNodeRenderStyle(update.index, update.radius, update.color)) continue;
      changedNodeIds.push(update.id!);
      if (previous.radius !== update.radius) radiusChangedNodeIds.push(update.id!);
    }
    if (changedNodeIds.length > 0) {
      addIds(this.pendingNodeStateIds, changedNodeIds);
      if (radiusChangedNodeIds.length > 0) {
        addIds(this.pendingLinkEndpointRadiusIds, this.#store.getIncidentLinkIds(radiusChangedNodeIds));
        this.renderer?.invalidatePicking();
      }
      this.invalidate(InvalidationReason.Style);
    }
    return Object.freeze(changedNodeIds);
  }

  setLinkStyle(style: LinkStyleOptions<TLink>): void {
    this.assertActive();
    const normalized = normalizeForceGraphOptions<TNode, TLink>({ links: style }).links ?? {};
    const nextStyle = { ...this.linkStyle, ...normalized };
    const refresh = this.refreshStyleCaches(undefined, this.nodeStyle, nextStyle);
    if (refresh.resolutionFailed) {
      return;
    }
    this.linkStyle = nextStyle;
    this.renderer?.setLinkOpacity(this.linkStyle.opacity);
    this.renderDataDirty = true;
    this.invalidate(InvalidationReason.Style);
  }

  /** Replaces the application-owned appearance for built-in node interaction states. */
  setStateTheme(theme: NodeStateTheme | undefined): void {
    this.assertActive();
    const normalized = theme === undefined
      ? undefined
      : normalizeForceGraphOptions({ stateTheme: theme }).stateTheme;
    const updatedInShader = this.renderer?.setStateTheme(normalized) ?? false;
    this.renderDataDirty = !updatedInShader;
    this.stateThemeRefreshPending = updatedInShader;
    this.invalidate(InvalidationReason.Style);
  }

  /** Updates the shared TSL node surface without allocating per-node materials. */
  setNodeSurface(surface: NodeSurfaceOptions | undefined): void {
    this.assertActive();
    const requested = surface === undefined ? undefined : {
      ...this.nodeSurface,
      ...surface,
      ...(surface.selectionEffect === undefined && this.nodeSurface?.selectionEffect === undefined
        ? {}
        : { selectionEffect: { ...this.nodeSurface?.selectionEffect, ...surface.selectionEffect } })
    };
    const normalized = requested === undefined
      ? undefined
      : normalizeForceGraphOptions({ renderer: { nodeSurface: requested } }).renderer?.nodeSurface;
    this.renderer?.setNodeSurface(normalized);
    this.nodeSurface = normalized;
    this.invalidate(InvalidationReason.Style);
  }

  /** Updates the configured source-to-target link pulse through shared shader uniforms. */
  setLinkFlow(flow: LinkFlowOptions | undefined): void {
    this.assertActive();
    const requested = flow === undefined
      ? undefined
      : {
          ...this.linkFlow,
          ...flow,
          ...(flow.nodeReaction === undefined
            ? {}
            : { nodeReaction: { ...this.linkFlow?.nodeReaction, ...flow.nodeReaction } })
        };
    const normalized = requested === undefined
      ? undefined
      : normalizeForceGraphOptions({ renderer: { linkFlow: requested } }).renderer?.linkFlow;
    this.renderer?.setLinkFlow(normalized);
    this.linkFlow = normalized;
    this.invalidate(InvalidationReason.Style);
  }

  /** Reclaims renderer capacity retained after a temporary graph-size peak. */
  compactRenderer(): boolean {
    this.assertActive();
    if (!this.renderer) {
      return false;
    }
    const compacted = this.renderer.compact(this.#store, this.host?.camera);
    if (compacted) {
      this.renderDataDirty = false;
      this.pendingNodeStateIds.clear();
      this.pendingLinkStyleIds.clear();
      this.pendingLinkEndpointRadiusIds.clear();
      this.invalidate(InvalidationReason.Style);
    }
    return compacted;
  }

  /**
   * Applies application-managed visual state flags to one node. Selection,
   * hover, and fixed-position state remain owned by their respective
   * interaction and layout APIs so their lifecycle invariants stay intact.
   */
  setNodeFlags(nodeId: GraphId, set = 0, clear = 0): boolean {
    return this.setNodeFlagsMany([nodeId], set, clear).length === 1;
  }

  /** Applies application-managed visual state flags to many nodes in one render invalidation. */
  setNodeFlagsMany(nodeIds: Iterable<GraphId>, set = 0, clear = 0): readonly GraphId[] {
    this.assertActive();
    assertApplicationManagedNodeFlags(set, clear);
    const changedNodeIds: GraphId[] = [];
    const seen = new Set<GraphId>();
    for (const nodeId of nodeIds) {
      if (!seen.has(nodeId) && this.#store.setNodeFlags(nodeId, set, clear)) {
        seen.add(nodeId);
        changedNodeIds.push(nodeId);
      }
    }
    if (changedNodeIds.length > 0) {
      this.renderer?.invalidatePicking();
      this.queueNodeAppearanceChanges(changedNodeIds, true);
      this.invalidate(InvalidationReason.Interaction);
    }
    return Object.freeze(changedNodeIds);
  }

  setSelection(nodeIds: Iterable<GraphId>): void {
    this.assertActive();
    const mode = this.options.interaction?.selection ?? 'single';
    if (mode === 'none') {
      return;
    }
    const next = new Set<GraphId>();
    for (const id of nodeIds) {
      if (this.#store.hasNode(id)) {
        next.add(id);
        if (mode === 'single') {
          break;
        }
      }
    }
    if (sameIds(this.selection, next)) {
      return;
    }
    const changedNodeIds: GraphId[] = [];
    for (const id of this.selection) {
      if (!next.has(id)) {
        if (this.#store.setNodeFlags(id, 0, NodeFlags.Selected)) {
          changedNodeIds.push(id);
        }
      }
    }
    for (const id of next) {
      if (this.#store.setNodeFlags(id, NodeFlags.Selected)) {
        changedNodeIds.push(id);
      }
    }
    this.selection = next;
    this.queueNodeAppearanceChanges(changedNodeIds, true);
    this.renderer?.invalidatePicking();
    this.events.emit('selection-change', { nodeIds: [...this.selection] });
    this.invalidate(InvalidationReason.Interaction);
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  getNodePosition(nodeId: GraphId): Vec3 | undefined {
    this.assertActive();
    return this.#store.getNodePosition(nodeId);
  }

  getNodeHandle(nodeId: GraphId): GraphNodeHandle | undefined {
    this.assertActive();
    return this.#store.getNodeHandle(nodeId);
  }

  /** Returns copied current node extents for host-owned camera framing. */
  getGraphBounds(): GraphBounds | undefined {
    this.assertActive();
    return this.#store.getBounds();
  }

  /** Returns the current host-camera position and the graph-managed look target, if a render host exists. */
  getCameraPose(): CameraPose | undefined {
    this.assertActive();
    const position = readCameraPosition(this.host?.camera);
    if (!position) {
      return undefined;
    }
    return Object.freeze({
      position: Object.freeze(position),
      target: Object.freeze({ ...this.cameraTarget })
    });
  }

  /**
   * Applies a finite camera pose to a managed or caller-owned embedded host.
   * Headless graphs intentionally have no camera to mutate.
   */
  setCameraPose(pose: CameraPose): void {
    this.assertActive();
    const host = this.host;
    if (!host) {
      throw new GraphError('FG_RENDER_CAPABILITY_UNAVAILABLE', 'Camera poses require a managed or embedded render host.');
    }
    const next = copyCameraPose(pose);
    applyCameraPose(host.camera, next);
    this.cameraTarget = { ...next.target };
    this.renderer?.invalidatePicking();
    this.invalidate(InvalidationReason.Camera);
  }

  /** Returns a stable, read-only graph view without exposing mutable engine state. */
  getGraphView(): GraphReadView<TNode, TLink> {
    this.assertActive();
    return this.readView;
  }

  on<TName extends GraphEventName>(name: TName, listener: GraphEventListener<TName>): () => void {
    this.assertActive();
    return this.events.on(name, listener);
  }

  /** Reports consumer callback failures without replaying the failed event. */
  onObserverError(listener: GraphObserverErrorListener): () => void {
    this.assertActive();
    this.observerErrorListeners.add(listener);
    return () => this.observerErrorListeners.delete(listener);
  }

  invalidate(reason: InvalidationReason = InvalidationReason.Explicit): void {
    this.assertActive();
    this.invalidationMask |= reason;
    this.requestFrame();
  }

  update(deltaSeconds: number): void {
    this.assertActive();
    if (this.layoutFailurePolicy === 'freeze' && this.layoutFailure !== undefined) {
      if (this.selection.size > 0) this.renderer?.advanceNodeSurface(Math.max(0, deltaSeconds));
      this.renderer?.advanceLinkFlow(Math.max(0, deltaSeconds));
      return;
    }
    this.assertLayoutMutationAllowed();
    if (this.selection.size > 0) this.renderer?.advanceNodeSurface(Math.max(0, deltaSeconds));
    this.renderer?.advanceLinkFlow(Math.max(0, deltaSeconds));
    this.layout.advance(Math.max(0, deltaSeconds));
  }

  render(): void {
    this.assertActive();
    const start = now();
    if (this.renderer) {
      const nodeStateIds = [...this.pendingNodeStateIds];
      const linkStyleIds = [...this.pendingLinkStyleIds];
      const linkEndpointRadiusIds = [...this.pendingLinkEndpointRadiusIds];
      this.renderer.syncFrame(this.#store, this.host?.camera, {
        full: this.renderDataDirty,
        positions: !this.renderDataDirty && (this.invalidationMask & (InvalidationReason.Layout | InvalidationReason.Animation)) !== 0,
        positionRevision: this.renderPositionRevision,
        themeDerived: this.stateThemeRefreshPending,
        nodeStateIds,
        linkStyleIds,
        linkEndpointRadiusIds
      });
      this.renderDataDirty = false;
      this.pendingNodeStateIds.clear();
      this.pendingLinkStyleIds.clear();
      this.pendingLinkEndpointRadiusIds.clear();
      this.stateThemeRefreshPending = false;
      if (this.host?.mode === 'managed') {
        call(this.host.renderer, 'render', this.host.scene, this.host.camera);
      }
    }
    this.invalidationMask = InvalidationReason.None;
    this.lastFrameDurationMs = now() - start;
  }

  /** Queues only links incident to node visual changes, preserving sparse renderer updates. */
  private queueNodeAppearanceChanges(nodeIds: Iterable<GraphId>, changesIncidentLinkStyle: boolean): void {
    const changed = [...nodeIds];
    addIds(this.pendingNodeStateIds, changed);
    const incidentLinks = this.#store.getIncidentLinkIds(changed);
    if (changesIncidentLinkStyle) {
      addIds(this.pendingLinkStyleIds, incidentLinks);
    } else {
      addIds(this.pendingLinkEndpointRadiusIds, incidentLinks);
    }
  }

  getDiagnostics(): GraphDiagnostics {
    const render = this.renderer?.getStats() ?? {
      nodeCount: 0,
      linkCount: 0,
      drawCalls: 0,
      triangleCount: 0,
      gpuBufferBytes: 0,
      positionAtlasAllocationBytes: 0,
      positionAtlasLogicalWriteBytes: 0,
      positionAtlasUploadRequestedBytes: 0,
      positionAtlasWidth: 0,
      positionAtlasMaxHeight: 0,
      positionAtlasMaxNodeCapacity: 0,
      deviceMaxTextureSize: undefined,
      topologyLogicalWriteBytes: 0,
      styleLogicalWriteBytes: 0,
      instanceMatrixAllocationBytes: 0,
      positionSyncRevision: 0,
      topologySyncRevision: 0,
      styleSyncRevision: 0,
      cameraRevision: 0,
      pickingRevision: 0,
      positionAtlasBytes: 0,
      topologyUploadBytes: 0,
      positionAtlasUploadBytes: 0,
      materialPath: 'fallback' as const,
      transformPath: 'cpu' as const,
      widthUnitRequested: 'world' as const,
      widthUnitSelected: 'world' as const,
      nodeMatrixWrites: 0,
      linkMatrixWrites: 0,
      nodeAttributeWrites: 0,
      linkAttributeWrites: 0,
      linkFlowEnabled: false,
      linkFlowTimeSeconds: 0,
      nodeSurfaceAnimating: false,
      nodeSurfaceTimeSeconds: 0,
      nodeDynamicOpacityRequested: false,
      nodeDynamicOpacitySelected: false,
      linkDynamicOpacityRequested: false,
      linkDynamicOpacitySelected: false,
      completeSyncs: 0,
      partialUpdateRanges: 0,
      skippedSyncPasses: 0,
      pickingMode: 'raycast' as const,
      pickCandidateCount: 0,
      pickScannedCellCount: 0,
      pickOrdinaryCandidateCount: 0,
      pickOversizedCandidateCount: 0
    };
    return {
      backend: this.host?.backend ?? 'none',
      hostMode: this.host?.mode ?? 'headless',
      nodeCount: this.#store.nodeCount,
      linkCount: this.#store.linkCount,
      renderedNodeCount: render.nodeCount,
      renderedLinkSegmentCount: render.linkCount,
      drawCalls: render.drawCalls,
      triangleCount: render.triangleCount,
      gpuBufferBytes: render.gpuBufferBytes,
      positionAtlasAllocationBytes: render.positionAtlasAllocationBytes,
      positionAtlasLogicalWriteBytes: render.positionAtlasLogicalWriteBytes,
      positionAtlasUploadRequestedBytes: render.positionAtlasUploadRequestedBytes,
      positionAtlasWidth: render.positionAtlasWidth,
      positionAtlasMaxHeight: render.positionAtlasMaxHeight,
      positionAtlasMaxNodeCapacity: render.positionAtlasMaxNodeCapacity,
      deviceMaxTextureSize: render.deviceMaxTextureSize,
      topologyLogicalWriteBytes: render.topologyLogicalWriteBytes,
      styleLogicalWriteBytes: render.styleLogicalWriteBytes,
      instanceMatrixAllocationBytes: render.instanceMatrixAllocationBytes,
      positionSyncRevision: render.positionSyncRevision,
      topologySyncRevision: render.topologySyncRevision,
      styleSyncRevision: render.styleSyncRevision,
      cameraRevision: render.cameraRevision,
      pickingRevision: render.pickingRevision,
      positionAtlasBytes: render.positionAtlasBytes,
      topologyUploadBytes: render.topologyUploadBytes,
      positionAtlasUploadBytes: render.positionAtlasUploadBytes,
      materialPath: render.materialPath,
      transformPath: render.transformPath,
      widthUnitRequested: render.widthUnitRequested,
      widthUnitSelected: render.widthUnitSelected,
      layoutBackend: this.layout.backend,
      layoutRevision: this.layout.revision,
      layoutState: this.layout.state,
      layoutRunning: this.layout.isRunning,
      layoutAlpha: this.layout.alpha,
      layoutStepsPerSecond: this.layout.lastStepMs > 0 ? 1000 / this.layout.lastStepMs : 0,
      layoutSnapshotAgeMs: this.lastLayoutSnapshotAt > 0 ? now() - this.lastLayoutSnapshotAt : Number.POSITIVE_INFINITY,
      separationResolvableOverlapPairCount: this.layout.separationDiagnostics.resolvableOverlapPairCount,
      separationMaximumPenetration: this.layout.separationDiagnostics.maximumPenetration,
      separationPairChecks: this.layout.separationDiagnostics.pairChecks,
      separationBudgetExhausted: this.layout.separationDiagnostics.budgetExhausted,
      separationDeferredPairCount: this.layout.separationDiagnostics.deferredPairCount,
      separationConsecutiveNoProgressSteps: this.layout.separationDiagnostics.consecutiveNoProgressSteps,
      separationConstrainedSettlement: this.layout.separationDiagnostics.constrainedSettlement,
      separationCorrectionSweepsCompleted: this.layout.separationDiagnostics.correctionSweepsCompleted,
      separationVerificationSweepsCompleted: this.layout.separationDiagnostics.verificationSweepsCompleted,
      separationVerifiedOverlapPairCount: this.layout.separationDiagnostics.verifiedOverlapPairCount,
      separationVerifiedMaximumPenetration: this.layout.separationDiagnostics.verifiedMaximumPenetration,
      pickingMode: this.renderer ? render.pickingMode : 'none',
      pickCandidateCount: render.pickCandidateCount,
      pickScannedCellCount: render.pickScannedCellCount,
      pickOrdinaryCandidateCount: render.pickOrdinaryCandidateCount,
      pickOversizedCandidateCount: render.pickOversizedCandidateCount,
      lastPickDurationMs: this.lastPickDurationMs,
      frameDurationMs: this.lastFrameDurationMs,
      frameLoopMode: this.options.renderer?.frameLoop ?? 'demand',
      invalidationMask: this.invalidationMask,
      nodeMatrixWrites: render.nodeMatrixWrites,
      linkMatrixWrites: render.linkMatrixWrites,
      nodeAttributeWrites: render.nodeAttributeWrites,
      linkAttributeWrites: render.linkAttributeWrites,
      linkFlowEnabled: render.linkFlowEnabled,
      linkFlowTimeSeconds: render.linkFlowTimeSeconds,
      nodeSurfaceAnimating: render.nodeSurfaceAnimating,
      nodeSurfaceTimeSeconds: render.nodeSurfaceTimeSeconds,
      nodeDynamicOpacityRequested: render.nodeDynamicOpacityRequested,
      nodeDynamicOpacitySelected: render.nodeDynamicOpacitySelected,
      linkDynamicOpacityRequested: render.linkDynamicOpacityRequested,
      linkDynamicOpacitySelected: render.linkDynamicOpacitySelected,
      completeSyncs: render.completeSyncs,
      partialUpdateRanges: render.partialUpdateRanges,
      skippedSyncPasses: render.skippedSyncPasses
    };
  }

  /** Enables headless hosts and custom integrations to emit semantic hover events. */
  setHoveredNode(nodeId: GraphId | undefined, originalEvent: unknown = undefined): void {
    this.assertActive();
    if (this.hoveredNode === nodeId) {
      return;
    }
    const changedNodeIds: GraphId[] = [];
    if (this.hoveredNode !== undefined) {
      if (this.#store.setNodeFlags(this.hoveredNode, 0, NodeFlags.Hovered)) {
        changedNodeIds.push(this.hoveredNode);
      }
    }
    this.hoveredNode = nodeId !== undefined && this.#store.hasNode(nodeId) ? nodeId : undefined;
    if (this.hoveredNode !== undefined) {
      if (this.#store.setNodeFlags(this.hoveredNode, NodeFlags.Hovered)) {
        changedNodeIds.push(this.hoveredNode);
      }
    }
    this.queueNodeAppearanceChanges(changedNodeIds, true);
    this.renderer?.invalidatePicking();
    this.events.emit('node-hover', {
      nodeId: this.hoveredNode,
      position: this.hoveredNode === undefined ? undefined : this.#store.getNodePosition(this.hoveredNode),
      originalEvent
    });
    this.invalidate(InvalidationReason.Interaction);
  }

  notifyNodeClick(nodeId: GraphId, originalEvent: unknown = undefined): void {
    this.assertActive();
    if (!this.#store.hasNode(nodeId)) {
      return;
    }
    this.applyClickSelection(nodeId, originalEvent);
    this.events.emit('node-click', {
      nodeId,
      modifiers: modifiersFor(originalEvent),
      originalEvent
    });
  }

  beginNodeDrag(nodeId: GraphId, position: Vec3, originalEvent: unknown = undefined): void {
    if (!this.setNodeFixed(nodeId, position)) {
      return;
    }
    this.events.emit('node-drag', { nodeId, position: { ...position }, phase: 'start', originalEvent });
  }

  moveNodeDrag(nodeId: GraphId, position: Vec3, originalEvent: unknown = undefined): void {
    if (!this.setNodeFixed(nodeId, position)) {
      return;
    }
    this.events.emit('node-drag', { nodeId, position: { ...position }, phase: 'move', originalEvent });
  }

  endNodeDrag(nodeId: GraphId, position: Vec3, originalEvent: unknown = undefined): void {
    this.assertActive();
    const release = typeof this.options.interaction?.dragNodes === 'object'
      ? this.options.interaction.dragNodes.releaseBehavior ?? 'unpin'
      : 'unpin';
    if (release === 'unpin') {
      this.releaseNode(nodeId);
    }
    this.events.emit('node-drag', { nodeId, position: { ...position }, phase: 'end', originalEvent });
  }

  /**
   * ACK-gated drag start used by the DOM interaction adapter. Consecutive
   * move operations are coalesced while the worker is busy; the final queued
   * position is always retained before the end operation.
   */
  beginNodeDragAsync(nodeId: GraphId, position: Vec3, originalEvent: unknown = undefined): Promise<void> {
    return this.enqueueAsyncDragOperation({ kind: 'begin', nodeId, position, originalEvent });
  }

  moveNodeDragAsync(nodeId: GraphId, position: Vec3, originalEvent: unknown = undefined): Promise<void> {
    return this.enqueueAsyncDragOperation({ kind: 'move', nodeId, position, originalEvent });
  }

  endNodeDragAsync(nodeId: GraphId, position: Vec3, originalEvent: unknown = undefined): Promise<void> {
    return this.enqueueAsyncDragOperation({ kind: 'end', nodeId, position, originalEvent });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rejectPendingAsyncDragOperations(new GraphError(
      'FG_RESOURCE_ALREADY_DISPOSED',
      'The graph was disposed before a queued drag operation could complete.'
    ));
    // Mark terminal state before callbacks so a cancelled drag cannot invoke
    // graph mutation after teardown has begun.
    try {
      this.interaction?.cancelActiveInteraction(undefined, false);
    } catch {
      // Teardown continues even when borrowed input infrastructure is faulty.
    }
    if (this.frameRequest !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.frameRequest);
    }
    this.frameRequest = undefined;
    try { this.resizeObserver?.disconnect(); } catch { /* best effort */ }
    try { this.pixelRatioUnsubscribe?.(); } catch { /* best effort */ }
    this.pixelRatioUnsubscribe = undefined;
    try { this.interaction?.dispose(); } catch { /* best effort */ }
    try { this.layout?.dispose(); } catch { /* best effort */ }
    if (this.renderer) {
      try {
        if (this.host) {
          call(this.host.scene, 'remove', this.renderer.object3D);
        }
      } catch { /* best effort */ }
      try { this.renderer.dispose(); } catch { /* best effort */ }
    }
    try { this.host?.dispose(); } catch { /* best effort */ }
    this.#store.release();
    this.events.clear();
    this.observerErrorListeners.clear();
  }

  private async initialize(): Promise<void> {
    const callbacks = {
      onSnapshot: (snapshot: LayoutSnapshot) => this.handleLayoutSnapshot(snapshot),
      onError: (error: Error) => this.handleLayoutError(error)
    };
    const hostOptions = this.options.host ?? { mode: 'headless' as const };
    if (hostOptions.mode !== 'headless') {
      if (!this.options.platform) {
        throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'Managed and embedded hosts require createThreePlatform({ THREE, TSL }).');
      }
      this.host = await createThreeHost(this.options.platform, hostOptions, this.options.renderer);
      this.cameraTarget = this.options.renderer?.cameraPose
        ? { ...this.options.renderer.cameraPose.target }
        : { x: 0, y: 0, z: 0 };
      if (this.options.renderer?.linkWidthUnit === 'pixel'
        && cameraProjectionFor(this.host.camera) === 'orthographic') {
        throw new GraphError(
          'FG_RENDER_CAPABILITY_UNAVAILABLE',
          'Pixel link widths are not available for orthographic cameras in this renderer path.'
        );
      }
      this.renderer = new ThreeGraphRenderer(
        this.options.platform,
        this.options.links?.opacity ?? 0.55,
        this.options.renderer?.linkWidthUnit ?? 'world',
        this.options.renderer?.maxPositionAtlasHeight,
        this.options.renderer?.picking,
        this.options.stateTheme,
        this.options.renderer?.nodeSurface,
        this.host.deviceMaxTextureSize,
        this.options.renderer?.linkFlow
      );
      call(this.host.scene, 'add', this.renderer.object3D);
    }

    const requestedBackend = this.options.layout?.backend ?? 'worker';
    const factory = this.options.layout?.workerFactory ?? createDefaultWorkerFactory();
    if (requestedBackend === 'worker' && factory) {
      try {
        const stepTimeoutMs = this.options.layout?.workerStepTimeoutMs;
        const workerLayout = new WorkerLayoutBridge(
          factory(),
          callbacks,
          {
            ...(stepTimeoutMs === undefined ? {} : { stepTimeoutMs }),
            configuration: this.options.layout ?? {}
          }
        );
        this.layout = workerLayout;
        if (workerLayout.state === 'failed') {
          throw new GraphError('FG_LAYOUT_WORKER_FAILED', 'The requested layout worker failed during initialization.');
        }
      } catch (cause) {
        this.layout = new LocalLayoutBridge(this.options.layout ?? {}, callbacks);
        this.startupWarnings.push(Object.freeze({
          code: 'FG_STARTUP_LAYOUT_FALLBACK',
          message: 'The requested layout worker could not be created; local layout was selected.',
          detail: errorMessage(cause)
        }));
        this.events.emit('error', {
          error: new GraphError('FG_LAYOUT_WORKER_FAILED', 'Could not create the requested layout worker; using the local headless bridge.', { cause })
        });
      }
    } else {
      this.layout = new LocalLayoutBridge(this.options.layout ?? {}, callbacks);
      if (requestedBackend === 'worker') {
        this.startupWarnings.push(Object.freeze({
          code: 'FG_STARTUP_LAYOUT_FALLBACK',
          message: 'The requested layout worker is unavailable in this runtime; local layout was selected.',
          detail: 'No Worker implementation or workerFactory was available.'
        }));
      }
    }

    if (hostOptions.mode === 'headless') {
      this.finalizeStartupReport();
      return;
    }
    const host = this.host;
    if (!host || !this.renderer) {
      throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'The render host did not initialize before layout acquisition.');
    }
    this.events.emit('backend-change', { backend: host.backend });
    host.onDeviceLost((signal) => this.handleDeviceLoss(signal));
    const rendererPolicy = rendererPolicyFor(this.options.renderer?.backend);
    if (rendererPolicy === 'webgpu-preferred' && host.backend === 'webgl2') {
      this.startupWarnings.push(Object.freeze({
        code: 'FG_STARTUP_RENDERER_FALLBACK',
        message: 'The WebGPU-preferred renderer selected WebGL2 for this host.'
      }));
    }
    this.finalizeStartupReport();
    if (this.disposed) {
      return;
    }
    this.attachInteraction();
    this.attachResizeObserver();
  }

  private afterDataChange(
    change: GraphDataChange,
    layoutAlreadyRebuilt = false,
    startLayout = true
  ): GraphMutationResult {
    let layoutRebuildScheduled = false;
    let frameScheduled = false;
    if (change.visualChanged || change.simulationChanged || change.topologyChanged) {
      this.renderer?.invalidatePicking();
    }
    if (change.simulationChanged || change.topologyChanged) {
      this.refreshStyleCaches();
      this.reconcileInteractionState();
      this.renderDataDirty = true;
      if (!layoutAlreadyRebuilt) {
        this.layout.replace(this.#store.createLayoutInput());
        layoutRebuildScheduled = true;
      } else {
        layoutRebuildScheduled = true;
      }
      if (startLayout && (this.options.layout?.autoStart ?? true) && this.#store.nodeCount > 0) {
        this.layoutSettledNotified = false;
        this.runLayoutCommand((bridge) => bridge.start());
      }
    } else if (change.payloadChanged) {
      const styles = this.refreshStyleCaches(change);
      this.queueNodeAppearanceChanges(styles.nodeIds, false);
      addIds(this.pendingLinkStyleIds, styles.linkIds);
    }
    if (change.visualChanged || change.simulationChanged || change.topologyChanged) {
      this.invalidate(InvalidationReason.Data);
      frameScheduled = true;
    }
    return Object.freeze({
      ...change,
      frameScheduled,
      layoutRebuildScheduled
    });
  }

  private async afterDataChangeAsync(
    change: GraphDataChange,
    layoutAlreadyRebuilt = false
  ): Promise<GraphMutationResult> {
    return this.afterDataChange(change, layoutAlreadyRebuilt, false);
  }

  private replacementAlpha(plan: PreparedGraphMutation, input: LayoutInput): number {
    if (input.nodeIndices.length === 0) return 0;
    const isIncrementalTopologyPatch = plan.change.kind === 'patch'
      && plan.change.topologyChanged
      && this.#store.nodeCount > 0;
    if (!isIncrementalTopologyPatch) return 1;
    return Math.max(
      this.layout.alpha,
      this.options.layout?.topologyReheatAlpha ?? DEFAULT_LAYOUT_CONFIGURATION.topologyReheatAlpha
    );
  }

  private preflightPreparedMutation(plan: PreparedGraphMutation): boolean {
    if (!plan.change.simulationChanged && !plan.change.topologyChanged) {
      return false;
    }
    this.assertLayoutMutationAllowed();
    const bridge = this.layout;
    const input = plan.createLayoutInput();
    const initialAlpha = this.replacementAlpha(plan, input);
    const previousSettledNotified = this.layoutSettledNotified;
    // Replacement publishes a neutral snapshot synchronously on the local
    // bridge. Suppress its settled event until the store candidate is live.
    this.layoutSettledNotified = true;
    try {
      bridge.replace(input, initialAlpha);
    } catch (cause) {
      // A worker can fail while queueing this command and replace itself under
      // the fallback-local policy. Retry the exact prepared input on recovery;
      // otherwise the store mutation is never committed.
      if (this.layout !== bridge && this.layoutFailurePolicy === 'fallback-local' && !this.disposed) {
        this.layout.replace(plan.createLayoutInput(), initialAlpha);
      } else if (this.layoutFailurePolicy === 'fallback-local'
        && bridge.backend === 'worker'
        && bridge.state === 'failed'
        && !this.disposed
        && this.recoverFailedWorkerLayout(bridge, plan.createLayoutInput(), initialAlpha)) {
        return true;
      } else {
        this.layoutSettledNotified = previousSettledNotified;
        throw cause;
      }
    }
    return true;
  }

  private async preflightPreparedMutationAsync(plan: PreparedGraphMutation): Promise<boolean> {
    if (!plan.change.simulationChanged && !plan.change.topologyChanged) {
      return false;
    }
    this.assertLayoutMutationAllowed();
    const bridge = this.layout;
    const previousSettledNotified = this.layoutSettledNotified;
    this.layoutSettledNotified = true;
    const input = plan.createLayoutInput();
    const initialAlpha = this.replacementAlpha(plan, input);
    const startAfterInitialize = (this.options.layout?.autoStart ?? true) && input.nodeIndices.length > 0;
    try {
      await bridge.replaceAsync(input, startAfterInitialize, initialAlpha);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (this.layout !== bridge && this.layoutFailurePolicy === 'fallback-local' && !this.disposed) {
        const recoveredInput = plan.createLayoutInput();
        await this.layout.replaceAsync(recoveredInput, startAfterInitialize, initialAlpha);
      } else if (this.layoutFailurePolicy === 'fallback-local'
        && bridge.backend === 'worker'
        && !this.disposed
        && ((bridge.state === 'failed' && this.recoverFailedWorkerLayout(bridge, plan.createLayoutInput(), initialAlpha))
          || (bridge.state !== 'failed'
            && this.recoverRejectedWorkerLayout(bridge, plan.createLayoutInput(), startAfterInitialize, initialAlpha)))) {
        if (this.bufferedLayoutError === undefined) {
          this.bufferedLayoutError = error;
          this.bufferedLayoutErrorBridge = bridge;
        }
        return true;
      } else {
        this.layoutSettledNotified = previousSettledNotified;
        throw cause;
      }
    }
    return true;
  }

  private commitPreparedMutation(plan: PreparedGraphMutation): { change: GraphDataChange; layoutRebuilt: boolean } {
    const needsLayoutReplacement = plan.change.simulationChanged || plan.change.topologyChanged;
    const previousLayout = needsLayoutReplacement ? this.#store.createLayoutInput() : undefined;
    const previousSettledNotified = this.layoutSettledNotified;
    const previousBridge = this.layout;
    const previousLayoutRevision = previousBridge.revision;
    const previousLayoutState = {
      alpha: previousBridge.alpha,
      steps: previousBridge.steps,
      lastStepMs: previousBridge.lastStepMs,
      running: previousBridge.isRunning
    };
    this.mutationInProgress = true;
    try {
      const layoutRebuilt = this.preflightPreparedMutation(plan);
      const change = this.#store.commitPrepared(plan);
      this.mutationInProgress = false;
      this.flushBufferedLayoutCallbacks();
      return { change, layoutRebuilt };
    } catch (cause) {
      this.mutationInProgress = false;
      this.bufferedLayoutSnapshot = undefined;
      this.bufferedLayoutError = undefined;
      this.bufferedLayoutErrorBridge = undefined;
      this.layoutSettledNotified = previousSettledNotified;
      if (previousLayout && previousBridge.backend === 'local' && this.layout === previousBridge && !this.disposed) {
        try {
          this.mutationInProgress = true;
          if (previousBridge instanceof LocalLayoutBridge) {
            previousBridge.restore(previousLayout, previousLayoutRevision, previousLayoutState);
          } else {
            previousBridge.replace(previousLayout);
          }
        } catch (rollbackCause) {
          throw new GraphError(
            'FG_LAYOUT_MUTATION_ROLLBACK_FAILED',
            'The failed layout replacement could not be rolled back to the previous local revision.',
            { cause: rollbackCause, original: cause }
          );
        } finally {
          this.mutationInProgress = false;
          this.bufferedLayoutSnapshot = undefined;
          this.bufferedLayoutError = undefined;
          this.bufferedLayoutErrorBridge = undefined;
        }
      }
      throw cause;
    } finally {
      this.mutationInProgress = false;
    }
  }

  private async commitPreparedMutationAsync(plan: PreparedGraphMutation): Promise<{ change: GraphDataChange; layoutRebuilt: boolean }> {
    return this.runExclusiveLayoutMutation(async () => {
      const needsLayoutReplacement = plan.change.simulationChanged || plan.change.topologyChanged;
      const previousLayout = needsLayoutReplacement ? this.#store.createLayoutInput() : undefined;
      const previousSettledNotified = this.layoutSettledNotified;
      const previousBridge = this.layout;
      const previousLayoutRevision = previousBridge.revision;
      const previousLayoutState = {
        alpha: previousBridge.alpha,
        steps: previousBridge.steps,
        lastStepMs: previousBridge.lastStepMs,
        running: previousBridge.isRunning
      };
      try {
        const layoutRebuilt = await this.preflightPreparedMutationAsync(plan);
        const change = this.#store.commitPrepared(plan);
        return { change, layoutRebuilt };
      } catch (cause) {
        this.bufferedLayoutSnapshot = undefined;
        this.bufferedLayoutError = undefined;
        this.bufferedLayoutErrorBridge = undefined;
        this.layoutSettledNotified = previousSettledNotified;
        if (previousLayout && previousBridge.backend === 'local' && this.layout === previousBridge && !this.disposed) {
          try {
            if (previousBridge instanceof LocalLayoutBridge) {
              previousBridge.restore(previousLayout, previousLayoutRevision, previousLayoutState);
            } else {
              previousBridge.replace(previousLayout);
            }
          } catch (rollbackCause) {
            throw new GraphError(
              'FG_LAYOUT_MUTATION_ROLLBACK_FAILED',
              'The failed layout replacement could not be rolled back to the previous local revision.',
              { cause: rollbackCause, original: cause }
            );
          } finally {
            this.bufferedLayoutSnapshot = undefined;
            this.bufferedLayoutError = undefined;
            this.bufferedLayoutErrorBridge = undefined;
          }
        }
        throw cause;
      }
    });
  }

  private flushBufferedLayoutCallbacks(): void {
    const snapshot = this.bufferedLayoutSnapshot;
    const error = this.bufferedLayoutError;
    const errorBridge = this.bufferedLayoutErrorBridge;
    this.bufferedLayoutSnapshot = undefined;
    this.bufferedLayoutError = undefined;
    this.bufferedLayoutErrorBridge = undefined;
    if (snapshot && !this.disposed) {
      this.handleLayoutSnapshot(snapshot);
    }
    if (error && !this.disposed) {
      this.handleLayoutError(error, errorBridge);
    }
  }

  private refreshStyleCaches(
    change: GraphDataChange | undefined = undefined,
    nodeStyle: NodeStyleOptions<TNode> = this.nodeStyle,
    linkStyle: LinkStyleOptions<TLink> = this.linkStyle
  ): StyleCacheRefreshResult {
    if (change) {
      return this.refreshChangedStyleCaches(change, nodeStyle, linkStyle);
    }
    let resolutionFailed = false;
    const report = (error: GraphError): void => {
      resolutionFailed = true;
      this.events.emit('error', { error });
    };
    const nodeUpdates: NodeStyleUpdate[] = [];
    this.#store.forEachNode((index, node) => {
      nodeUpdates.push({
        index,
        radius: resolveStyle(nodeStyle.radius, node, index, 1, 'node-radius', report),
        color: resolveStyle(nodeStyle.color, node, index, 0x71a7ff, 'node-color', report)
      });
    });
    const linkUpdates: LinkStyleUpdate[] = [];
    this.#store.forEachLink((index, link) => {
      linkUpdates.push({
        index,
        width: resolveStyle(linkStyle.width, link, index, 1, 'link-width', report),
        color: resolveStyle(linkStyle.color, link, index, 0x8ca0c8, 'link-color', report)
      });
    });
    if (resolutionFailed) {
      return { nodeIds: [], linkIds: [], resolutionFailed: true };
    }
    for (const update of nodeUpdates) {
      this.#store.setNodeRenderStyle(update.index, update.radius, update.color);
    }
    for (const update of linkUpdates) {
      this.#store.setLinkRenderStyle(update.index, update.width, update.color);
    }
    return { nodeIds: [], linkIds: [], resolutionFailed: false };
  }

  private refreshChangedStyleCaches(
    change: GraphDataChange,
    nodeStyle: NodeStyleOptions<TNode>,
    linkStyle: LinkStyleOptions<TLink>
  ): StyleCacheRefreshResult {
    const nodeIds: GraphId[] = [];
    let resolutionFailed = false;
    const report = (error: GraphError): void => {
      resolutionFailed = true;
      this.events.emit('error', { error });
    };
    const nodeUpdates = this.stageNodeStyleUpdates(change.changedNodeIds, nodeStyle, report);
    const linkIds: GraphId[] = [];
    const linkUpdates: LinkStyleUpdate[] = [];
    for (const id of change.changedLinkIds) {
      const state = this.#store.getLinkRenderStateById(id);
      const link = this.#store.getLink(id);
      if (!state || !link) {
        continue;
      }
      linkUpdates.push({
        id,
        index: state.index,
        width: resolveStyle(linkStyle.width, link, state.index, 1, 'link-width', report),
        color: resolveStyle(linkStyle.color, link, state.index, 0x8ca0c8, 'link-color', report)
      });
    }
    if (resolutionFailed) {
      return { nodeIds: [], linkIds: [], resolutionFailed: true };
    }
    for (const update of nodeUpdates) {
      if (this.#store.setNodeRenderStyle(update.index, update.radius, update.color)) {
        if (update.id !== undefined) {
          nodeIds.push(update.id);
        }
      }
    }
    for (const update of linkUpdates) {
      if (this.#store.setLinkRenderStyle(update.index, update.width, update.color)) {
        if (update.id !== undefined) {
          linkIds.push(update.id);
        }
      }
    }
    return { nodeIds, linkIds, resolutionFailed: false };
  }

  private stageNodeStyleUpdates(
    nodeIds: Iterable<GraphId>,
    nodeStyle: NodeStyleOptions<TNode>,
    report: (error: GraphError) => void
  ): NodeStyleUpdate[] {
    const updates: NodeStyleUpdate[] = [];
    const seen = new Set<GraphId>();
    for (const id of nodeIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const handle = this.#store.getNodeHandle(id);
      const node = this.#store.getNode(id);
      if (!handle || !node) continue;
      updates.push({
        id,
        index: handle.index,
        radius: resolveStyle(nodeStyle.radius, node, handle.index, 1, 'node-radius', report),
        color: resolveStyle(nodeStyle.color, node, handle.index, 0x71a7ff, 'node-color', report)
      });
    }
    return updates;
  }

  private applyClickSelection(nodeId: GraphId, originalEvent: unknown): void {
    const mode = this.options.interaction?.selection ?? 'single';
    if (mode === 'none') {
      return;
    }
    if (mode === 'single') {
      this.setSelection([nodeId]);
      return;
    }
    const modifiers = modifiersFor(originalEvent);
    const next = new Set(this.selection);
    if (modifiers.has('ctrl') || modifiers.has('meta')) {
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
    } else if (modifiers.has('shift')) {
      next.add(nodeId);
    } else {
      next.clear();
      next.add(nodeId);
    }
    this.setSelection(next);
  }

  private reconcileInteractionState(): void {
    let selectionChanged = false;
    for (const nodeId of [...this.selection]) {
      if (!this.#store.hasNode(nodeId)) {
        this.selection.delete(nodeId);
        selectionChanged = true;
      } else {
        this.#store.setNodeFlags(nodeId, NodeFlags.Selected);
      }
    }
    if (this.hoveredNode !== undefined && !this.#store.hasNode(this.hoveredNode)) {
      this.hoveredNode = undefined;
      this.events.emit('node-hover', { nodeId: undefined, position: undefined, originalEvent: undefined });
    } else if (this.hoveredNode !== undefined) {
      this.#store.setNodeFlags(this.hoveredNode, NodeFlags.Hovered);
    }
    if (selectionChanged) {
      this.events.emit('selection-change', { nodeIds: [...this.selection] });
    }
  }

  /** Keeps asynchronous renderer picking invalidated with every visible position change. */
  private markRendererPositionChanged(): void {
    this.renderPositionRevision += 1;
    this.renderer?.invalidatePicking();
  }

  private handleLayoutSnapshot(snapshot: LayoutSnapshot): void {
    if (this.disposed) {
      return;
    }
    if (this.mutationInProgress) {
      this.bufferedLayoutSnapshot = copyLayoutSnapshot(snapshot);
      return;
    }
    this.#store.applyLayoutSnapshot(snapshot);
    this.lastLayoutSnapshotAt = now();
    this.markRendererPositionChanged();
    if (snapshot.settled && snapshot.alpha < 1 && !this.layoutSettledNotified) {
      this.layoutSettledNotified = true;
      this.events.emit('layout-settled', { alpha: snapshot.alpha });
    }
    this.invalidationMask |= InvalidationReason.Layout;
    this.requestFrame();
  }

  private handleLayoutError(error: Error, failedLayoutOverride?: LayoutBridge): void {
    if (this.disposed) {
      return;
    }
    if (this.mutationInProgress) {
      this.bufferedLayoutError = error;
      this.bufferedLayoutErrorBridge = this.layout;
      return;
    }
    const failedLayout = failedLayoutOverride ?? this.layout;
    if (!failedLayout) {
      this.events.emit('error', { error });
      return;
    }
    const backend = failedLayout.backend;
    let recovered = false;
    if (this.layoutFailurePolicy === 'fallback-local' && backend === 'worker') {
      recovered = failedLayout !== this.layout
        || this.recoverFailedWorkerLayout(failedLayout, this.#store.createLayoutInput(), failedLayout.alpha);
      if (!recovered) {
        error = new GraphError('FG_LAYOUT_WORKER_FAILED', 'The failed layout worker could not be replaced with local layout.', {
          original: error
        });
      }
    } else {
      this.layoutFailure = error;
    }
    this.events.emit('layout-failed', {
      error,
      policy: this.layoutFailurePolicy,
      backend,
      recovered
    });
    this.events.emit('error', { error });
    if (this.layoutFailurePolicy === 'dispose' || (this.layoutFailurePolicy === 'fallback-local' && !recovered)) {
      this.dispose();
    }
  }

  private handleDeviceLoss(signal: HostDeviceLossSignal): void {
    const host = this.host;
    if (this.disposed || this.deviceLossHandled || host?.mode !== 'managed') {
      return;
    }
    this.deviceLossHandled = true;
    const event: DeviceLostEvent = {
      backend: host.backend,
      api: signal.api,
      message: signal.message,
      reason: signal.reason
    };
    try {
      this.events.emit('device-lost', event);
    } finally {
      this.dispose();
    }
  }

  private attachInteraction(): void {
    const host = this.host;
    const renderer = this.renderer;
    const canvas = host?.canvas;
    if (!host || !canvas || !renderer) {
      return;
    }
    this.interaction = new InteractionController(canvas, this.options.interaction ?? {}, {
      pickNode: (event) => {
        const start = now();
        const picked = renderer.pickNode(event, host.camera, canvas);
        this.lastPickDurationMs = now() - start;
        return picked;
      },
      pickNodeAsync: async (event) => {
        const start = now();
        const picked = await renderer.pickNodeAsync(event, host.camera, canvas);
        this.lastPickDurationMs = now() - start;
        return picked;
      },
      projectDrag: (event, nodeId) => {
        const position = this.#store.getNodePosition(nodeId);
        return position
          ? renderer.projectPointerToDragPlane(event, host.camera, canvas, position)
          : undefined;
      },
      hover: (nodeId, event) => this.setHoveredNode(nodeId, event),
      click: (nodeId, event) => this.notifyNodeClick(nodeId, event),
      beginDrag: (nodeId, position, event) => this.beginNodeDrag(nodeId, position, event),
      moveDrag: (nodeId, position, event) => this.moveNodeDrag(nodeId, position, event),
      endDrag: (nodeId, position, event) => this.endNodeDrag(nodeId, position, event),
      beginDragAsync: (nodeId, position, event) => this.beginNodeDragAsync(nodeId, position, event),
      moveDragAsync: (nodeId, position, event) => this.moveNodeDragAsync(nodeId, position, event),
      endDragAsync: (nodeId, position, event) => this.endNodeDragAsync(nodeId, position, event),
      reportError: (error) => this.reportInteractionError(error),
      getNavigationEnabled: () => host.controls?.enabled,
      setNavigationEnabled: (enabled) => {
        if (host.controls) {
          host.controls.enabled = enabled;
        }
      }
    });
  }

  private attachResizeObserver(): void {
    if (this.host?.mode !== 'managed' || !this.host.canvas) {
      return;
    }
    this.pixelRatioUnsubscribe = this.host.onPixelRatioChanged(() => {
      if (!this.disposed) this.invalidate(InvalidationReason.Resize);
    });
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.host || this.disposed) {
        return;
      }
      resizeManagedHost(this.host.renderer, this.host.camera, this.host.canvas as HTMLCanvasElement);
      this.invalidate(InvalidationReason.Resize);
    });
    this.resizeObserver.observe(this.host.canvas);
  }

  private requestFrame(): void {
    if (this.disposed || this.host?.mode !== 'managed' || this.frameRequest !== undefined || typeof requestAnimationFrame !== 'function') {
      return;
    }
    if ((this.options.renderer?.frameLoop ?? 'demand') === 'external') {
      return;
    }
    this.frameRequest = requestAnimationFrame((timestamp) => {
      this.frameRequest = undefined;
      const deltaSeconds = this.lastFrameAt === 0 ? 1 / 60 : Math.max(0, (timestamp - this.lastFrameAt) / 1000);
      this.lastFrameAt = timestamp;
      this.update(deltaSeconds);
      this.render();
      if (!this.disposed && ((this.options.renderer?.frameLoop ?? 'demand') === 'continuous'
        || this.layout.isRunning
        || (this.selection.size > 0 && this.renderer?.nodeSurfaceAnimating === true)
        || this.renderer?.linkFlowAnimating === true)) {
        this.requestFrame();
      }
    });
  }

  private notifyObserverError(eventName: GraphEventName, error: Error): void {
    const event: GraphObserverErrorEvent = Object.freeze({ eventName, error });
    for (const listener of [...this.observerErrorListeners]) {
      try {
        listener(event);
      } catch {
        // A broken observer-error listener must never disrupt graph work.
      }
    }
  }

  private reportInteractionError(cause: unknown): void {
    if (this.disposed) {
      return;
    }
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.events.emit('error', { error });
  }

  private finalizeStartupReport(): void {
    const render = this.renderer?.getStats();
    this.startupReport = Object.freeze({
      hostMode: this.host?.mode ?? 'headless',
      layout: Object.freeze({
        requested: this.options.layout?.backend ?? 'worker',
        selected: this.layout.backend
      }),
      renderer: Object.freeze({
        policy: rendererPolicyFor(this.options.renderer?.backend),
        selected: this.host?.backend ?? 'none',
        materialPath: render?.materialPath ?? 'none',
        transformPath: render?.transformPath ?? 'none',
        requestedWidthUnit: render?.widthUnitRequested ?? this.options.renderer?.linkWidthUnit ?? 'world',
        selectedWidthUnit: render?.widthUnitSelected ?? 'none',
        cameraProjection: cameraProjectionFor(this.host?.camera),
        positionAtlasWidth: render?.positionAtlasWidth ?? 0,
        positionAtlasMaxHeight: render?.positionAtlasMaxHeight ?? 0,
        positionAtlasMaxNodeCapacity: render?.positionAtlasMaxNodeCapacity ?? 0,
        nodeDynamicOpacityRequested: render?.nodeDynamicOpacityRequested
          ?? this.options.renderer?.nodeSurface?.selectionEffect !== undefined,
        nodeDynamicOpacitySelected: render?.nodeDynamicOpacitySelected ?? false,
        linkDynamicOpacityRequested: render?.linkDynamicOpacityRequested
          ?? this.options.renderer?.linkFlow !== undefined,
        linkDynamicOpacitySelected: render?.linkDynamicOpacitySelected ?? false,
        ...(this.host?.deviceMaxTextureSize === undefined ? {} : { deviceMaxTextureSize: this.host.deviceMaxTextureSize })
      }),
      warnings: Object.freeze([...this.startupWarnings])
    });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new GraphError('FG_RESOURCE_ALREADY_DISPOSED', 'This graph has already been disposed.');
    }
  }

  private assertMutationIdle(): void {
    if (this.mutationInProgress) {
      throw new GraphError(
        'FG_DATA_MUTATION_IN_PROGRESS',
        'A graph mutation cannot be re-entered while its layout transaction is being committed.'
      );
    }
  }

  private recoverFailedWorkerLayout(
    failedLayout: LayoutBridge,
    input: LayoutInput,
    initialAlpha = failedLayout.alpha
  ): boolean {
    if (failedLayout.backend !== 'worker' || this.layoutFailurePolicy !== 'fallback-local' || this.disposed) {
      return false;
    }
    const wasRunning = failedLayout.isRunning || failedLayout.wasRunningAtFailure;
    try {
      const callbacks = {
        onSnapshot: (snapshot: LayoutSnapshot) => this.handleLayoutSnapshot(snapshot),
        onError: (nextError: Error) => this.handleLayoutError(nextError)
      };
      const local = new LocalLayoutBridge(this.options.layout ?? {}, callbacks);
      local.replace(input, initialAlpha);
      if (wasRunning && input.nodeIndices.length > 0) {
        local.start();
      }
      this.layout = local;
      this.layoutFailure = undefined;
      failedLayout.dispose();
      return true;
    } catch (cause) {
      this.layoutFailure = new GraphError('FG_LAYOUT_WORKER_FAILED', 'The failed layout worker could not be replaced with local layout.', { cause });
      return false;
    }
  }

  private recoverRejectedWorkerLayout(
    rejectedLayout: LayoutBridge,
    input: LayoutInput,
    startAfterInitialize = false,
    initialAlpha = rejectedLayout.alpha
  ): boolean {
    if (rejectedLayout.backend !== 'worker' || this.layoutFailurePolicy !== 'fallback-local' || this.disposed) {
      return false;
    }
    try {
      const callbacks = {
        onSnapshot: (snapshot: LayoutSnapshot) => this.handleLayoutSnapshot(snapshot),
        onError: (nextError: Error) => this.handleLayoutError(nextError)
      };
      const local = new LocalLayoutBridge(this.options.layout ?? {}, callbacks);
      local.replace(input, initialAlpha);
      if (startAfterInitialize && input.nodeIndices.length > 0) {
        local.start();
      }
      this.layout = local;
      this.layoutFailure = undefined;
      rejectedLayout.dispose();
      return true;
    } catch (cause) {
      this.layoutFailure = new GraphError('FG_LAYOUT_WORKER_FAILED', 'The rejected worker layout could not be replaced with local layout.', { cause });
      return false;
    }
  }

  private assertLayoutMutationAllowed(): void {
    if (this.layoutFailure !== undefined || this.layout?.state === 'failed') {
      throw new GraphError(
        'FG_LAYOUT_MUTATION_FROZEN',
        'Layout mutations are frozen because the active layout backend failed.',
        { policy: this.layoutFailurePolicy, cause: this.layoutFailure }
      );
    }
  }

  private runLayoutCommand(command: (bridge: LayoutBridge) => void): void {
    const bridge = this.layout;
    try {
      command(bridge);
    } catch (cause) {
      if (this.layout !== bridge && this.layoutFailurePolicy === 'fallback-local' && !this.disposed) {
        command(this.layout);
      } else {
        throw cause;
      }
    }
  }

  private async runExclusiveLayoutMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutationInProgress) {
      throw new GraphError(
        'FG_DATA_MUTATION_IN_PROGRESS',
        'A graph layout operation cannot be re-entered while another transaction is pending.'
      );
    }
    this.mutationInProgress = true;
    let releaseMutationIdle!: () => void;
    this.mutationIdlePromise = new Promise<void>((resolve) => {
      releaseMutationIdle = resolve;
    });
    let completed = false;
    try {
      const result = await operation();
      completed = true;
      return result;
    } finally {
      this.mutationInProgress = false;
      releaseMutationIdle();
      this.mutationIdlePromise = Promise.resolve();
      if (completed) {
        this.flushBufferedLayoutCallbacks();
      } else {
        this.bufferedLayoutSnapshot = undefined;
        this.bufferedLayoutError = undefined;
        this.bufferedLayoutErrorBridge = undefined;
      }
    }
  }

  private enqueueAsyncDragOperation(operation: Omit<PendingAsyncDragOperation, 'resolve' | 'reject'>): Promise<void> {
    this.assertActive();
    return new Promise<void>((resolve, reject) => {
      const pending: PendingAsyncDragOperation = { ...operation, resolve, reject };
      const previous = this.pendingAsyncDragOperations.at(-1);
      if (operation.kind === 'move' && previous?.kind === 'move') {
        previous.resolve();
        this.pendingAsyncDragOperations[this.pendingAsyncDragOperations.length - 1] = pending;
      } else {
        this.pendingAsyncDragOperations.push(pending);
      }
      if (!this.asyncDragDrainRunning && !this.asyncDragDrainScheduled) {
        this.asyncDragDrainScheduled = true;
        queueMicrotask(() => {
          this.asyncDragDrainScheduled = false;
          void this.drainAsyncDragOperations();
        });
      }
    });
  }

  private rejectPendingAsyncDragOperations(error: Error): void {
    for (const operation of this.pendingAsyncDragOperations.splice(0)) {
      operation.reject(error);
    }
    this.asyncDragNode = undefined;
    this.asyncDragAccepted = false;
  }

  private async drainAsyncDragOperations(): Promise<void> {
    if (this.asyncDragDrainRunning) {
      return;
    }
    this.asyncDragDrainRunning = true;
    try {
      while (this.pendingAsyncDragOperations.length > 0) {
        const operation = this.pendingAsyncDragOperations.shift();
        if (!operation) {
          continue;
        }
        try {
          await this.executeAsyncDragOperation(operation);
          operation.resolve();
        } catch (error) {
          operation.reject(error);
        }
      }
    } finally {
      this.asyncDragDrainRunning = false;
    }
  }

  private async executeAsyncDragOperation(operation: PendingAsyncDragOperation): Promise<void> {
    while (this.mutationInProgress) {
      await this.mutationIdlePromise;
    }
    this.assertActive();
    if (operation.kind === 'begin') {
      this.asyncDragNode = operation.nodeId;
      try {
        this.asyncDragAccepted = await this.setNodeFixedAsync(operation.nodeId, operation.position);
        if (this.asyncDragAccepted) {
          this.events.emit('node-drag', {
            nodeId: operation.nodeId,
            position: { ...operation.position },
            phase: 'start',
            originalEvent: operation.originalEvent
          });
        } else {
          this.asyncDragNode = undefined;
        }
      } catch (cause) {
        this.asyncDragNode = undefined;
        this.asyncDragAccepted = false;
        throw cause;
      }
      return;
    }
    if (this.asyncDragNode !== operation.nodeId || !this.asyncDragAccepted) {
      return;
    }
    if (operation.kind === 'move') {
      try {
        if (await this.setNodeFixedAsync(operation.nodeId, operation.position)) {
          this.events.emit('node-drag', {
            nodeId: operation.nodeId,
            position: { ...operation.position },
            phase: 'move',
            originalEvent: operation.originalEvent
          });
        }
      } catch (cause) {
        this.asyncDragNode = undefined;
        this.asyncDragAccepted = false;
        throw cause;
      }
      return;
    }
    const release = typeof this.options.interaction?.dragNodes === 'object'
      ? this.options.interaction.dragNodes.releaseBehavior ?? 'unpin'
      : 'unpin';
    try {
      if (release === 'unpin') {
        await this.releaseNodeAsync(operation.nodeId);
      }
      this.events.emit('node-drag', {
        nodeId: operation.nodeId,
        position: { ...operation.position },
        phase: 'end',
        originalEvent: operation.originalEvent
      });
    } finally {
      this.asyncDragNode = undefined;
      this.asyncDragAccepted = false;
    }
  }

  private async runLayoutCommandAsync(command: (bridge: LayoutBridge) => Promise<void>): Promise<void> {
    const bridge = this.layout;
    try {
      await command(bridge);
    } catch (cause) {
      if (this.layout !== bridge && this.layoutFailurePolicy === 'fallback-local' && !this.disposed) {
        await command(this.layout);
      } else if (this.layoutFailurePolicy === 'fallback-local'
        && bridge.backend === 'worker'
        && !this.disposed
        && ((bridge.state === 'failed'
          && this.recoverFailedWorkerLayout(bridge, this.#store.createLayoutInput(), bridge.alpha))
          || (bridge.state !== 'failed'
            && this.recoverRejectedWorkerLayout(
              bridge,
              this.#store.createLayoutInput(),
              bridge.isRunning,
              bridge.alpha
            )))) {
        await command(this.layout);
      } else {
        throw cause;
      }
    }
  }
}

function rendererPolicyFor(backend: RendererBackend | undefined): RendererBackendPolicy {
  if (backend === 'webgpu' || backend === 'webgpu-preferred') {
    return 'webgpu-preferred';
  }
  return backend ?? 'auto';
}

function cameraProjectionFor(camera: unknown): 'perspective' | 'orthographic' | 'unknown' {
  if (!camera || typeof camera !== 'object') {
    return 'unknown';
  }
  const value = camera as { isPerspectiveCamera?: unknown; isOrthographicCamera?: unknown };
  if (value.isPerspectiveCamera === true) {
    return 'perspective';
  }
  if (value.isOrthographicCamera === true) {
    return 'orthographic';
  }
  return 'unknown';
}

function readCameraPosition(camera: unknown): Vec3 | undefined {
  if (!isRecord(camera) || !isRecord(camera.position)) {
    return undefined;
  }
  const { x, y, z } = camera.position;
  return typeof x === 'number' && Number.isFinite(x)
    && typeof y === 'number' && Number.isFinite(y)
    && typeof z === 'number' && Number.isFinite(z)
    ? { x, y, z }
    : undefined;
}

function copyCameraPose(pose: CameraPose): CameraPose {
  if (!isRecord(pose) || !isFiniteVec3(pose.position) || !isFiniteVec3(pose.target)) {
    throw new GraphError('FG_CAMERA_INVALID_OPTIONS', 'Camera poses require finite position and target vectors.');
  }
  return Object.freeze({
    position: Object.freeze({ ...pose.position }),
    target: Object.freeze({ ...pose.target })
  });
}

function isFiniteVec3(value: unknown): value is Vec3 {
  return isRecord(value)
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && typeof value.z === 'number' && Number.isFinite(value.z);
}

function isGraphSnapshot<TNode, TLink>(
  value: unknown
): value is GraphSnapshot<TNode, TLink> | LegacyGraphSnapshot<TNode, TLink> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as {
    schema?: string;
    version?: number;
    data?: GraphData<TNode, TLink>;
  };
  return ((candidate.schema === 'tsl-smooth-graph/graph-snapshot' && candidate.version === 2)
    || (candidate.schema === '@ours/forcegraph-tsl/graph-snapshot' && candidate.version === 1))
    && !!candidate.data
    && typeof candidate.data === 'object';
}

function isClearlyPayloadOnlyPatch<TNode, TLink>(
  patch: GraphPatch<TNode, TLink>,
  store: GraphStore<TNode, TLink>
): boolean {
  if (!isRecord(patch)) {
    return false;
  }
  for (const [sectionName, section] of [['nodes', patch.nodes], ['links', patch.links]] as const) {
    if (section === undefined) {
      continue;
    }
    if (!isRecord(section) || !onlyKeys(section, ['upsert', 'remove'])) {
      return false;
    }
    if (section.remove !== undefined && (!Array.isArray(section.remove) || section.remove.length > 0)) {
      return false;
    }
    if (section.upsert === undefined) {
      continue;
    }
    if (!Array.isArray(section.upsert)) {
      return false;
    }
    for (const entry of section.upsert) {
      if (!isRecord(entry)) {
        return false;
      }
      if (sectionName === 'nodes') {
        if (!onlyKeys(entry, ['id', 'data']) || !store.hasNode(entry.id as GraphId)) {
          return false;
        }
      } else {
        if (!onlyKeys(entry, ['id', 'source', 'target', 'data']) || !store.hasLink(entry.id as GraphId)) {
          return false;
        }
        const existing = store.getLink(entry.id as GraphId);
        if (!existing || existing.source !== entry.source || existing.target !== entry.target) {
          return false;
        }
      }
    }
  }
  return true;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function resolveStyle<TItem>(
  value: number | ((item: Readonly<TItem>, index: number) => number) | undefined,
  item: TItem,
  index: number,
  fallback: number,
  styleName: string,
  report: (error: GraphError) => void
): number {
  try {
    const resolved = typeof value === 'function' ? value(item, index) : value;
    return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : fallback;
  } catch (cause) {
    report(new GraphError(
      'FG_STYLE_RESOLUTION_FAILED',
      `The ${styleName} style accessor failed; the default style was used.`,
      { style: styleName, index, cause }
    ));
    return fallback;
  }
}

function modifiersFor(event: unknown): ReadonlySet<string> {
  const candidate = event as Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', unknown>> | undefined;
  const modifiers = new Set<string>();
  if (candidate?.altKey === true) modifiers.add('alt');
  if (candidate?.ctrlKey === true) modifiers.add('ctrl');
  if (candidate?.metaKey === true) modifiers.add('meta');
  if (candidate?.shiftKey === true) modifiers.add('shift');
  return modifiers;
}

const APPLICATION_MANAGED_NODE_FLAGS = NodeFlags.Visible | NodeFlags.Dimmed | NodeFlags.Focused | NodeFlags.Hidden;

function assertApplicationManagedNodeFlags(set: number, clear: number): void {
  if (!Number.isSafeInteger(set) || !Number.isSafeInteger(clear)
    || (set & ~APPLICATION_MANAGED_NODE_FLAGS) !== 0
    || (clear & ~APPLICATION_MANAGED_NODE_FLAGS) !== 0) {
    throw new GraphError(
      'FG_RENDER_PLATFORM_INVALID',
      'setNodeFlags accepts only Visible, Dimmed, Focused, and Hidden; selection, hover, and pinning are interaction-owned.'
    );
  }
}

function sameIds(first: ReadonlySet<GraphId>, second: ReadonlySet<GraphId>): boolean {
  if (first.size !== second.size) {
    return false;
  }
  for (const id of first) {
    if (!second.has(id)) {
      return false;
    }
  }
  return true;
}

function addIds(target: Set<GraphId>, ids: Iterable<GraphId>): void {
  for (const id of ids) {
    target.add(id);
  }
}

function freezeVec3(value: Vec3 | undefined): Readonly<Vec3> | undefined {
  return value === undefined ? undefined : Object.freeze({ ...value });
}

function copyLayoutSnapshot(snapshot: LayoutSnapshot): LayoutSnapshot {
  return {
    nodeIndices: new Uint32Array(snapshot.nodeIndices),
    positions: new Float32Array(snapshot.positions),
    velocities: new Float32Array(snapshot.velocities),
    alpha: snapshot.alpha,
    settled: snapshot.settled
  };
}

function call(target: Record<string, unknown>, method: string, ...args: unknown[]): unknown {
  const value = target[method];
  return typeof value === 'function' ? value.apply(target, args) : undefined;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
