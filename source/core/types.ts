import type { ThreePlatform } from '../platform/three/createThreePlatform.js';

export type GraphId = string | number;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Immutable min/max extent of the graph's current finite node positions. */
export interface GraphBounds {
  readonly min: Readonly<Vec3>;
  readonly max: Readonly<Vec3>;
}

export interface GraphNodeInput<TData = unknown> {
  readonly id: GraphId;
  /** Opaque caller-owned application payload; structural fields are copied by the engine. */
  readonly data?: TData;
  readonly initialPosition?: Readonly<Partial<Vec3>>;
  readonly fixed?: Readonly<Partial<Vec3>>;
}

/** Backward-compatible name for full graph and snapshot node inputs. */
export type GraphNode<TData = unknown> = GraphNodeInput<TData>;

/** Patch-only node controls; omitted fields preserve the existing record/state. */
export interface GraphNodePatch<TData = unknown> {
  readonly id: GraphId;
  readonly data?: TData;
  readonly initialPosition?: Readonly<Partial<Vec3>>;
  /** `null` explicitly releases every fixed axis in a patch. */
  readonly fixed?: Readonly<Partial<Vec3>> | null;
  /** Replaces live coordinates from the merged initialPosition configuration. */
  readonly resetPosition?: boolean;
}

export interface GraphLink<TData = unknown> {
  readonly id: GraphId;
  readonly source: GraphId;
  readonly target: GraphId;
  /** Opaque caller-owned application payload; structural fields are copied by the engine. */
  readonly data?: TData;
}

export interface GraphData<TNode = unknown, TLink = unknown> {
  readonly nodes: readonly GraphNodeInput<TNode>[];
  readonly links: readonly GraphLink<TLink>[];
}

/** Stable host-owned persistence envelope for graph topology and caller data. */
export interface GraphSnapshot<TNode = unknown, TLink = unknown> {
  readonly schema: 'tsl-smooth-graph/graph-snapshot';
  readonly version: 2;
  readonly data: GraphData<TNode, TLink>;
}

/** Read-only migration envelope accepted from pre-alpha development builds. */
export interface LegacyGraphSnapshot<TNode = unknown, TLink = unknown> {
  readonly schema: '@ours/forcegraph-tsl/graph-snapshot';
  readonly version: 1;
  readonly data: GraphData<TNode, TLink>;
}

export interface GraphPatch<TNode = unknown, TLink = unknown> {
  readonly nodes?: {
    readonly upsert?: readonly GraphNodePatch<TNode>[];
    readonly remove?: readonly GraphId[];
  };
  readonly links?: {
    readonly upsert?: readonly GraphLink<TLink>[];
    readonly remove?: readonly GraphId[];
  };
}

export interface GraphNodeHandle {
  readonly index: number;
  readonly generation: number;
}

/**
 * Read-only graph state exposed by GraphController. Structural wrappers and
 * vectors are copied/frozen; `data` remains an opaque caller-owned reference.
 */
export interface GraphReadView<TNode = unknown, TLink = unknown> {
  readonly revision: number;
  readonly nodeCount: number;
  readonly linkCount: number;
  hasNode(id: GraphId): boolean;
  hasLink(id: GraphId): boolean;
  getNode(id: GraphId): GraphNode<TNode> | undefined;
  getLink(id: GraphId): GraphLink<TLink> | undefined;
  getNodeHandle(id: GraphId): GraphNodeHandle | undefined;
  getNodePosition(id: GraphId): Readonly<Vec3> | undefined;
  getBounds(): GraphBounds | undefined;
}

export type ValidationMode = 'strict' | 'tolerant';

export interface ValidationOptions {
  mode?: ValidationMode;
}

export enum NodeFlags {
  Visible = 1 << 0,
  Hovered = 1 << 1,
  Selected = 1 << 2,
  Pinned = 1 << 3,
  Dimmed = 1 << 4,
  Focused = 1 << 5,
  Hidden = 1 << 6
}

export enum InvalidationReason {
  None = 0,
  Data = 1 << 0,
  Layout = 1 << 1,
  Style = 1 << 2,
  Camera = 1 << 3,
  Interaction = 1 << 4,
  Animation = 1 << 5,
  Resize = 1 << 6,
  Picking = 1 << 7,
  Explicit = 1 << 8
}

export type FrameLoopMode = 'continuous' | 'demand' | 'external';
/** `webgpu` is retained as a compatibility alias for `webgpu-preferred`. */
export type RendererBackend = 'auto' | 'webgpu' | 'webgpu-preferred' | 'webgl2';
export type RendererBackendPolicy = Exclude<RendererBackend, 'webgpu'>;
export type LayoutBackend = 'worker' | 'local';
export type LayoutFailurePolicy = 'freeze' | 'fallback-local' | 'dispose';

/** Host-owned managed-camera pose used for deterministic visual proof fixtures. */
export interface CameraPose {
  readonly position: Readonly<Vec3>;
  readonly target: Readonly<Vec3>;
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener?(type: 'message' | 'error', listener: EventListener): void;
  removeEventListener?(type: 'message' | 'error', listener: EventListener): void;
  onmessage?: ((event: MessageEvent<unknown>) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  terminate?(): void;
}

export interface LayoutConfiguration {
  backend?: LayoutBackend;
  /** Runtime worker failure behavior; freeze is the safe default. */
  failurePolicy?: LayoutFailurePolicy;
  workerFactory?: () => WorkerLike;
  dimensions?: 2 | 3;
  seed?: number;
  autoStart?: boolean;
  settleThreshold?: number;
  fixedDeltaSeconds?: number;
  linkDistance?: number;
  linkStrength?: number;
  chargeStrength?: number;
  chargeTheta?: number;
  centerStrength?: number;
  velocityDecay?: number;
  alphaDecay?: number;
  alphaMinimum?: number;
  /** Minimum center-to-center world distance. Zero preserves legacy behavior. */
  minimumNodeDistance?: number;
  /** Fraction of resolvable penetration corrected per separation iteration. */
  separationStrength?: number;
  /** Bounded positional relaxation passes per solver step. */
  separationIterations?: number;
  /** Minimum alpha used by nonempty-to-nonempty topology patches. */
  topologyReheatAlpha?: number;
  /** Minimum alpha used by pin, drag, and release interaction updates. */
  interactionReheatAlpha?: number;
  /** Bounds candidate-pair work performed by minimum-distance relaxation per solver step. */
  maxSeparationPairChecksPerStep?: number;
  /** Caps catch-up work performed by one update(deltaSeconds) call. */
  maxStepsPerUpdate?: number;
  /** Rejects one explicit stepLayout() request above this bounded count. */
  maxStepsPerRequest?: number;
  /** Rejects new worker step requests while this many acknowledgements are pending. */
  maxPendingWorkerSteps?: number;
  /** Rejects an unacknowledged browser-worker step after this many milliseconds. */
  workerStepTimeoutMs?: number;
  /** Rejects new acknowledged worker commands while this many commands are pending. */
  maxPendingWorkerCommands?: number;
  /** Rejects an unacknowledged browser-worker command after this many milliseconds. */
  workerCommandTimeoutMs?: number;
}

export interface RendererOptions {
  backend?: RendererBackend;
  antialias?: boolean;
  alpha?: boolean;
  /**
   * Shared appearance profile for batched camera-facing node discs. `metallic`
   * is a TSL sphere-impostor highlight, not a per-node Three material.
   */
  nodeSurface?: NodeSurfaceOptions;
  /**
   * Optional GPU-batched pulse profile for showing travel along directed links.
   * The effect follows each link's source-to-target UV without allocating
   * particles, meshes, or per-link animation timers.
   */
  linkFlow?: LinkFlowOptions;
  /** Link width interpretation for the TSL layer. Pixel widths use perspective camera depth. */
  linkWidthUnit?: 'world' | 'pixel';
  /**
   * Maximum supported row count for the internal TSL position atlas. Set this
   * from a known renderer texture limit when the host has one; the default is
   * a conservative WebGL2-compatible value.
   */
  maxPositionAtlasHeight?: number;
  /** Hover/click strategy. `gpu-id` uses the supplied host-owned GPU ID callback when the graph is large enough. */
  picking?: RendererPickingOptions;
  /** Optional managed-host camera pose; embedded hosts retain camera ownership. */
  cameraPose?: CameraPose;
  pixelRatio?: {
    minimum?: number;
    maximum?: number;
  };
  frameLoop?: FrameLoopMode;
}

/**
 * Uniform-controlled surface parameters for the shared batched node material.
 * These values do not allocate a Three object or material per graph node.
 */
export interface NodeSurfaceOptions {
  profile?: 'flat' | 'metallic';
  /** Strength of the directional/specular contribution, from 0 to 1. */
  metalness?: number;
  /** Broadens the sphere-impostor highlight, from 0 (sharp) to 1 (soft). */
  roughness?: number;
  /** Retains some base color through the surface treatment, from 0 to 1. */
  emissive?: number;
  /** Optional selected-node bubble and breathing treatment, controlled by shared uniforms. */
  selectionEffect?: NodeSelectionEffectOptions;
}

/** Shared selected-node treatment for the batched node material. */
export interface NodeSelectionEffectOptions {
  /** Defaults to true when a selection-effect profile is supplied. */
  enabled?: boolean;
  /** Outer bubble radius relative to the node body, from 1 through 3. */
  bubbleScale?: number;
  /** Bubble color and opacity contribution, from 0 through 1. */
  intensity?: number;
  /** Twenty-four-bit RGB bubble color. */
  color?: number;
  /** Selected-node breathing amplitude, from 0 through 0.25. */
  breathAmount?: number;
  /** Selected-node breathing cycles per second, from 0 through 10. */
  breathSpeed?: number;
}

/** Shared uniforms for a directional pulse rendered inside the batched link material. */
export interface LinkFlowOptions {
  /** Defaults to true when a link-flow profile is supplied. */
  enabled?: boolean;
  /** Positive motion follows source-to-target; the reverse option flips only the visual travel direction. */
  direction?: 'source-to-target' | 'target-to-source';
  /** Pulse cycles per second, from 0 (stationary) through 100. */
  speed?: number;
  /** Number of repeating pulses across one clipped link, from 0.1 through 64. */
  frequency?: number;
  /** Normalized pulse breadth, from 0.02 (tight) through 1 (broad). */
  pulseWidth?: number;
  /** Blend strength of the pulse color, from 0 through 1. */
  intensity?: number;
  /** Twenty-four-bit RGB pulse color. */
  color?: number;
  /** Optional shared arrival response for nodes at the active flow endpoint. */
  nodeReaction?: LinkFlowNodeReactionOptions;
}

/** Shared uniforms for the node response when a directional pulse arrives. */
export interface LinkFlowNodeReactionOptions {
  /** Defaults to true when a node-reaction profile is supplied. */
  enabled?: boolean;
  /** Peak radius multiplier, from 1 (no scale response) through 3. */
  scale?: number;
  /** Blend strength of the reaction color, from 0 through 1. */
  intensity?: number;
  /** Twenty-four-bit RGB reaction color. Defaults to the link pulse color. */
  color?: number;
}

export interface GpuIdPickRequest {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly positionRevision: number;
  readonly cameraRevision: number;
  /** Renderer topology revision captured before the host begins a readback. */
  readonly topologyRevision: number;
  /** Includes position, state, visibility, remapping, and theme invalidation. */
  readonly pickingRevision: number;
}

export interface RendererPickingOptions {
  mode?: 'auto' | 'raycast' | 'spatial' | 'gpu-id';
  /** Minimum rendered node count before an auto/GPU-ID route is considered. */
  gpuIdThreshold?: number;
  /** Projected CPU-grid cell size in CSS pixels. */
  spatialCellSize?: number;
  /** Host-owned GPU ID readback. Stale graph/camera revisions are discarded by the graph. */
  gpuIdPicker?: (request: GpuIdPickRequest) => GraphId | undefined | Promise<GraphId | undefined>;
}

export interface ManagedHostOptions {
  mode: 'managed';
  canvas: HTMLCanvasElement;
}

export interface EmbeddedHostOptions {
  mode: 'embedded';
  renderer: unknown;
  scene: unknown;
  camera: unknown;
  canvas?: HTMLCanvasElement;
  controls?: { enabled: boolean };
}

export interface HeadlessHostOptions {
  mode: 'headless';
}

export type GraphHostOptions = ManagedHostOptions | EmbeddedHostOptions | HeadlessHostOptions;

export type StyleValue<TData, TValue> =
  | TValue
  | ((item: Readonly<TData>, index: number) => TValue);

export interface NodeStyleOptions<TData = unknown> {
  radius?: StyleValue<GraphNode<TData>, number>;
  color?: StyleValue<GraphNode<TData>, number>;
}

/** Appearance applied cumulatively when the corresponding built-in node state is active. */
export interface NodeStateAppearance {
  /** Multiplies the resolved base node radius. */
  scale?: number;
  /** Blends the resolved base color toward this RGB value. */
  color?: number;
  /** Blend amount for color, from 0 (base) to 1 (theme color). */
  colorMix?: number;
  /** Hides the node by collapsing its owned geometry without changing graph data. */
  visible?: boolean;
}

export interface NodeStateTheme {
  dimmed?: NodeStateAppearance;
  pinned?: NodeStateAppearance;
  selected?: NodeStateAppearance;
  hovered?: NodeStateAppearance;
  focused?: NodeStateAppearance;
  hidden?: NodeStateAppearance;
  /** Appearance applied to links incident to dimmed or hidden nodes. */
  incidentLinks?: {
    dimmed?: NodeStateAppearance;
    hidden?: NodeStateAppearance;
  };
}

export interface LinkStyleOptions<TData = unknown> {
  width?: StyleValue<GraphLink<TData>, number>;
  color?: StyleValue<GraphLink<TData>, number>;
  opacity?: number;
}

export interface InteractionOptions {
  hover?: boolean;
  dragNodes?: boolean | {
    enabled?: boolean;
    releaseBehavior?: 'unpin' | 'keep-pinned';
  };
  selection?: 'none' | 'single' | 'multiple';
  navigation?: boolean;
}

export interface ForceGraphOptions<TNode = unknown, TLink = unknown> {
  platform?: ThreePlatform;
  host?: GraphHostOptions;
  renderer?: RendererOptions;
  layout?: LayoutConfiguration;
  nodes?: NodeStyleOptions<TNode>;
  links?: LinkStyleOptions<TLink>;
  /** Application-owned visual theme for built-in node interaction flags. */
  stateTheme?: NodeStateTheme;
  interaction?: InteractionOptions;
  validation?: ValidationOptions;
}

export type GraphMutationKind = 'set-data' | 'patch' | 'clear' | 'import-snapshot';

export interface GraphMutationResult {
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly revision: number;
  readonly kind: GraphMutationKind;
  readonly nodeCount: number;
  readonly linkCount: number;
  /** True when node/link membership or link endpoints changed. */
  readonly topologyChanged: boolean;
  /** True when layout input/state must be rebuilt. */
  readonly simulationChanged: boolean;
  /** True when an existing node or link payload/record was upserted. */
  readonly payloadChanged: boolean;
  /** True when a node/link visual may need recomputation. */
  readonly visualChanged: boolean;
  /** Live node IDs whose data-backed visual style may need recomputation. */
  readonly changedNodeIds: readonly GraphId[];
  /** Live link IDs whose data-backed visual style may need recomputation. */
  readonly changedLinkIds: readonly GraphId[];
  readonly addedNodeIds: readonly GraphId[];
  readonly updatedNodeIds: readonly GraphId[];
  readonly removedNodeIds: readonly GraphId[];
  readonly addedLinkIds: readonly GraphId[];
  readonly updatedLinkIds: readonly GraphId[];
  readonly removedLinkIds: readonly GraphId[];
  readonly cascadedLinkIds: readonly GraphId[];
  readonly skippedNodeIds: readonly GraphId[];
  readonly skippedLinkIds: readonly GraphId[];
  readonly unchangedNodeIds: readonly GraphId[];
  readonly unchangedLinkIds: readonly GraphId[];
  readonly warnings: readonly GraphErrorLike[];
  readonly frameScheduled: boolean;
  readonly layoutRebuildScheduled: boolean;
}

/** Serializable shape used for tolerant-validation warnings in mutation receipts. */
export interface GraphErrorLike {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
}

/** Backward-compatible name for store/controller mutation receipts. */
export type GraphDataChange = GraphMutationResult;

export interface LayoutInput {
  nodeIndices: Uint32Array;
  positions: Float32Array;
  velocities: Float32Array;
  fixedMask: Uint8Array;
  fixedPositions: Float32Array;
  links: Uint32Array;
}

export interface LayoutSnapshot {
  nodeIndices: Uint32Array;
  positions: Float32Array;
  velocities: Float32Array;
  alpha: number;
  settled: boolean;
}

export interface LayoutSeparationDiagnostics {
  readonly resolvableOverlapPairCount: number;
  readonly maximumPenetration: number;
  readonly pairChecks: number;
  readonly budgetExhausted: boolean;
  readonly deferredPairCount: number;
  readonly consecutiveNoProgressSteps: number;
  readonly constrainedSettlement: boolean;
  readonly correctionSweepsCompleted: number;
  readonly verificationSweepsCompleted: number;
  readonly verifiedOverlapPairCount: number;
  readonly verifiedMaximumPenetration: number;
}

export interface NodeHoverEvent {
  nodeId: GraphId | undefined;
  position: Vec3 | undefined;
  originalEvent: unknown | undefined;
}

export interface NodeClickEvent {
  nodeId: GraphId;
  modifiers: ReadonlySet<string>;
  originalEvent: unknown | undefined;
}

export interface NodeDragEvent {
  nodeId: GraphId;
  position: Vec3;
  phase: 'start' | 'move' | 'end';
  originalEvent: unknown | undefined;
}

export interface SelectionChangeEvent {
  nodeIds: readonly GraphId[];
}

export interface LayoutSettledEvent {
  alpha: number;
}

export interface LayoutFailedEvent {
  readonly error: Error;
  readonly policy: LayoutFailurePolicy;
  readonly backend: LayoutBackend;
  readonly recovered: boolean;
}

export interface BackendChangeEvent {
  backend: 'webgpu' | 'webgl2' | 'none';
}

export interface DeviceLostEvent {
  backend: 'webgpu' | 'webgl2';
  api: string;
  message: string;
  reason: string | null;
}

export interface GraphErrorEvent {
  error: Error;
}

/** Reports a consumer callback failure without re-emitting through that callback. */
export interface GraphObserverErrorEvent {
  readonly eventName: GraphEventName;
  readonly error: Error;
}

export interface GraphEventMap {
  'node-hover': NodeHoverEvent;
  'node-click': NodeClickEvent;
  'node-drag': NodeDragEvent;
  'selection-change': SelectionChangeEvent;
  'layout-settled': LayoutSettledEvent;
  'layout-failed': LayoutFailedEvent;
  'backend-change': BackendChangeEvent;
  'device-lost': DeviceLostEvent;
  error: GraphErrorEvent;
}

export type GraphEventName = keyof GraphEventMap;
export type GraphEventListener<TName extends GraphEventName> = (event: GraphEventMap[TName]) => void;
export type GraphObserverErrorListener = (event: GraphObserverErrorEvent) => void;

export interface GraphDiagnostics {
  backend: 'webgpu' | 'webgl2' | 'none';
  hostMode: 'managed' | 'embedded' | 'headless';
  nodeCount: number;
  linkCount: number;
  renderedNodeCount: number;
  renderedLinkSegmentCount: number;
  drawCalls: number;
  triangleCount: number;
  gpuBufferBytes: number;
  /** Total allocated bytes for the RGBA float position atlas. */
  positionAtlasAllocationBytes: number;
  /** Cumulative logical bytes written to atlas entries (four float channels per node). */
  positionAtlasLogicalWriteBytes: number;
  /** Cumulative bytes requested for atlas texture upload; this is full-allocation per dirty texture. */
  positionAtlasUploadRequestedBytes: number;
  /** Effective atlas dimensions after caller and device capability limits are applied. */
  positionAtlasWidth: number;
  positionAtlasMaxHeight: number;
  positionAtlasMaxNodeCapacity: number;
  deviceMaxTextureSize: number | undefined;
  /** Cumulative logical bytes written to topology index attributes. */
  topologyLogicalWriteBytes: number;
  /** Cumulative logical bytes written to node/link style attributes. */
  styleLogicalWriteBytes: number;
  /** Allocated InstancedMesh matrix bytes retained by the current renderer path. */
  instanceMatrixAllocationBytes: number;
  /** Monotonic renderer-side sync counters for position, topology, style, camera, and picking changes. */
  positionSyncRevision: number;
  topologySyncRevision: number;
  styleSyncRevision: number;
  cameraRevision: number;
  pickingRevision: number;
  /** @deprecated Use positionAtlasAllocationBytes. */
  positionAtlasBytes: number;
  /** @deprecated Use topologyLogicalWriteBytes. */
  topologyUploadBytes: number;
  /** @deprecated Use positionAtlasUploadRequestedBytes. */
  positionAtlasUploadBytes: number;
  materialPath: 'tsl' | 'fallback';
  transformPath: 'tsl' | 'cpu';
  widthUnitRequested: 'world' | 'pixel';
  widthUnitSelected: 'world' | 'pixel';
  layoutBackend: 'local' | 'worker';
  layoutRevision: number;
  layoutState: 'starting' | 'ready' | 'running' | 'stopped' | 'failed' | 'disposed';
  layoutRunning: boolean;
  layoutAlpha: number;
  layoutStepsPerSecond: number;
  layoutSnapshotAgeMs: number;
  separationResolvableOverlapPairCount: number;
  separationMaximumPenetration: number;
  separationPairChecks: number;
  separationBudgetExhausted: boolean;
  separationDeferredPairCount: number;
  separationConsecutiveNoProgressSteps: number;
  separationConstrainedSettlement: boolean;
  separationCorrectionSweepsCompleted: number;
  separationVerificationSweepsCompleted: number;
  separationVerifiedOverlapPairCount: number;
  separationVerifiedMaximumPenetration: number;
  pickingMode: 'raycast' | 'spatial' | 'gpu-id' | 'none';
  pickCandidateCount: number;
  /** Work split for the latest spatial pick; one occupied cell per populated level. */
  pickScannedCellCount: number;
  pickOrdinaryCandidateCount: number;
  pickOversizedCandidateCount: number;
  lastPickDurationMs: number;
  frameDurationMs: number;
  frameLoopMode: FrameLoopMode;
  invalidationMask: number;
  nodeMatrixWrites: number;
  linkMatrixWrites: number;
  nodeAttributeWrites: number;
  linkAttributeWrites: number;
  /** True when the configured shared link-flow profile is currently visible. */
  linkFlowEnabled: boolean;
  /** Wrapped shader clock advanced only while link-flow motion is active. */
  linkFlowTimeSeconds: number;
  /** True while the selected-node surface breath animation is active. */
  nodeSurfaceAnimating: boolean;
  /** Wrapped shader clock advanced only while selected-node surface motion is active. */
  nodeSurfaceTimeSeconds: number;
  /** Dynamic opacity was requested/retained for the shared node and link materials. */
  nodeDynamicOpacityRequested: boolean;
  nodeDynamicOpacitySelected: boolean;
  linkDynamicOpacityRequested: boolean;
  linkDynamicOpacitySelected: boolean;
  completeSyncs: number;
  partialUpdateRanges: number;
  skippedSyncPasses: number;
}

export type GraphStartupWarningCode =
  | 'FG_STARTUP_LAYOUT_FALLBACK'
  | 'FG_STARTUP_RENDERER_FALLBACK';

export interface GraphStartupWarning {
  readonly code: GraphStartupWarningCode;
  readonly message: string;
  readonly detail?: string;
}

/** Immutable, replayable facts captured while the graph was being created. */
export interface GraphStartupReport {
  readonly hostMode: 'managed' | 'embedded' | 'headless';
  readonly layout: Readonly<{
    requested: LayoutBackend;
    selected: LayoutBackend;
  }>;
  readonly renderer: Readonly<{
    policy: RendererBackendPolicy;
    selected: 'webgpu' | 'webgl2' | 'none';
    materialPath: 'tsl' | 'fallback' | 'none';
    transformPath: 'tsl' | 'cpu' | 'none';
    requestedWidthUnit: 'world' | 'pixel';
    selectedWidthUnit: 'world' | 'pixel' | 'none';
    cameraProjection: 'perspective' | 'orthographic' | 'unknown';
    positionAtlasWidth: number;
    positionAtlasMaxHeight: number;
    positionAtlasMaxNodeCapacity: number;
    nodeDynamicOpacityRequested: boolean;
    nodeDynamicOpacitySelected: boolean;
    linkDynamicOpacityRequested: boolean;
    linkDynamicOpacitySelected: boolean;
    deviceMaxTextureSize?: number;
  }>;
  readonly warnings: readonly GraphStartupWarning[];
}

/**
 * Stable application-facing graph contract returned by the root factory.
 *
 * The concrete controller remains available from the explicit `./core`
 * subpath for integrations that need its implementation identity. Consumers
 * of the root package should depend on this interface so the host/runtime
 * implementation can evolve without widening the default public contract.
 */
export interface ForceGraph<TNode = unknown, TLink = unknown> {
  readonly object3D: unknown | undefined;
  readonly isDisposed: boolean;
  getStartupReport(): GraphStartupReport;
  setData(data: GraphData<TNode, TLink>): GraphMutationResult;
  setDataAsync(data: GraphData<TNode, TLink>): Promise<GraphMutationResult>;
  exportSnapshot(): GraphSnapshot<TNode, TLink>;
  importSnapshot(snapshot: GraphSnapshot<TNode, TLink> | LegacyGraphSnapshot<TNode, TLink>): GraphMutationResult;
  importSnapshotAsync(snapshot: GraphSnapshot<TNode, TLink> | LegacyGraphSnapshot<TNode, TLink>): Promise<GraphMutationResult>;
  applyPatch(patch: GraphPatch<TNode, TLink>): GraphMutationResult;
  applyPatchAsync(patch: GraphPatch<TNode, TLink>): Promise<GraphMutationResult>;
  clear(): GraphMutationResult;
  clearAsync(): Promise<GraphMutationResult>;
  startLayout(): void;
  startLayoutAsync(): Promise<void>;
  stopLayout(): void;
  stopLayoutAsync(): Promise<void>;
  restartLayout(): void;
  restartLayoutAsync(): Promise<void>;
  stepLayout(stepCount?: number): Promise<void>;
  setNodeFixed(nodeId: GraphId, position: Vec3): boolean;
  setNodeFixedAsync(nodeId: GraphId, position: Vec3): Promise<boolean>;
  releaseNode(nodeId: GraphId): boolean;
  releaseNodeAsync(nodeId: GraphId): Promise<boolean>;
  setNodeStyle(style: NodeStyleOptions<TNode>): void;
  refreshNodeStyles(nodeIds: Iterable<GraphId>): readonly GraphId[];
  setLinkStyle(style: LinkStyleOptions<TLink>): void;
  setStateTheme(theme: NodeStateTheme | undefined): void;
  setNodeSurface(surface: NodeSurfaceOptions | undefined): void;
  setLinkFlow(flow: LinkFlowOptions | undefined): void;
  compactRenderer(): boolean;
  setNodeFlags(nodeId: GraphId, set?: number, clear?: number): boolean;
  setNodeFlagsMany(nodeIds: Iterable<GraphId>, set?: number, clear?: number): readonly GraphId[];
  setSelection(nodeIds: Iterable<GraphId>): void;
  clearSelection(): void;
  getNodePosition(nodeId: GraphId): Vec3 | undefined;
  getNodeHandle(nodeId: GraphId): GraphNodeHandle | undefined;
  getGraphBounds(): GraphBounds | undefined;
  getCameraPose(): CameraPose | undefined;
  setCameraPose(pose: CameraPose): void;
  getGraphView(): GraphReadView<TNode, TLink>;
  on<TName extends GraphEventName>(name: TName, listener: GraphEventListener<TName>): () => void;
  onObserverError(listener: GraphObserverErrorListener): () => void;
  invalidate(reason?: InvalidationReason): void;
  update(deltaSeconds: number): void;
  render(): void;
  getDiagnostics(): GraphDiagnostics;
  setHoveredNode(nodeId: GraphId | undefined, originalEvent?: unknown): void;
  notifyNodeClick(nodeId: GraphId, originalEvent?: unknown): void;
  beginNodeDrag(nodeId: GraphId, position: Vec3, originalEvent?: unknown): void;
  moveNodeDrag(nodeId: GraphId, position: Vec3, originalEvent?: unknown): void;
  endNodeDrag(nodeId: GraphId, position: Vec3, originalEvent?: unknown): void;
  beginNodeDragAsync(nodeId: GraphId, position: Vec3, originalEvent?: unknown): Promise<void>;
  moveNodeDragAsync(nodeId: GraphId, position: Vec3, originalEvent?: unknown): Promise<void>;
  endNodeDragAsync(nodeId: GraphId, position: Vec3, originalEvent?: unknown): Promise<void>;
  dispose(): void;
}
