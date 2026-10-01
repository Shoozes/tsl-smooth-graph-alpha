export type HeadlessGraphId = string | number;

export interface HeadlessVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface HeadlessGraphBounds {
  readonly min: Readonly<HeadlessVec3>;
  readonly max: Readonly<HeadlessVec3>;
}

export interface HeadlessNodeInput<TData = unknown> {
  readonly id: HeadlessGraphId;
  readonly data?: TData;
  readonly initialPosition?: Readonly<Partial<HeadlessVec3>>;
  readonly fixed?: Readonly<Partial<HeadlessVec3>>;
}

export interface HeadlessNodePatch<TData = unknown> {
  readonly id: HeadlessGraphId;
  readonly data?: TData;
  readonly initialPosition?: Readonly<Partial<HeadlessVec3>>;
  readonly fixed?: Readonly<Partial<HeadlessVec3>> | null;
  readonly resetPosition?: boolean;
}

export interface HeadlessLink<TData = unknown> {
  readonly id: HeadlessGraphId;
  readonly source: HeadlessGraphId;
  readonly target: HeadlessGraphId;
  readonly data?: TData;
}

export interface HeadlessGraphData<TNode = unknown, TLink = unknown> {
  readonly nodes: readonly HeadlessNodeInput<TNode>[];
  readonly links: readonly HeadlessLink<TLink>[];
}

export interface HeadlessGraphPatch<TNode = unknown, TLink = unknown> {
  readonly nodes?: {
    readonly upsert?: readonly HeadlessNodePatch<TNode>[];
    readonly remove?: readonly HeadlessGraphId[];
  };
  readonly links?: {
    readonly upsert?: readonly HeadlessLink<TLink>[];
    readonly remove?: readonly HeadlessGraphId[];
  };
}

export interface HeadlessGraphSnapshot<TNode = unknown, TLink = unknown> {
  readonly schema: 'tsl-smooth-graph/graph-snapshot';
  readonly version: 2;
  readonly data: HeadlessGraphData<TNode, TLink>;
}

export interface LegacyHeadlessGraphSnapshot<TNode = unknown, TLink = unknown> {
  readonly schema: '@ours/forcegraph-tsl/graph-snapshot';
  readonly version: 1;
  readonly data: HeadlessGraphData<TNode, TLink>;
}

export interface HeadlessGraphErrorLike {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface HeadlessMutationResult {
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly revision: number;
  readonly kind: 'set-data' | 'patch' | 'clear' | 'import-snapshot';
  readonly nodeCount: number;
  readonly linkCount: number;
  readonly topologyChanged: boolean;
  readonly simulationChanged: boolean;
  readonly payloadChanged: boolean;
  readonly visualChanged: boolean;
  readonly changedNodeIds: readonly HeadlessGraphId[];
  readonly changedLinkIds: readonly HeadlessGraphId[];
  readonly addedNodeIds: readonly HeadlessGraphId[];
  readonly updatedNodeIds: readonly HeadlessGraphId[];
  readonly removedNodeIds: readonly HeadlessGraphId[];
  readonly addedLinkIds: readonly HeadlessGraphId[];
  readonly updatedLinkIds: readonly HeadlessGraphId[];
  readonly removedLinkIds: readonly HeadlessGraphId[];
  readonly cascadedLinkIds: readonly HeadlessGraphId[];
  readonly skippedNodeIds: readonly HeadlessGraphId[];
  readonly skippedLinkIds: readonly HeadlessGraphId[];
  readonly unchangedNodeIds: readonly HeadlessGraphId[];
  readonly unchangedLinkIds: readonly HeadlessGraphId[];
  readonly warnings: readonly HeadlessGraphErrorLike[];
  readonly frameScheduled: boolean;
  readonly layoutRebuildScheduled: boolean;
}

export interface HeadlessGraphReadView<TNode = unknown, TLink = unknown> {
  readonly revision: number;
  readonly nodeCount: number;
  readonly linkCount: number;
  hasNode(id: HeadlessGraphId): boolean;
  hasLink(id: HeadlessGraphId): boolean;
  getNode(id: HeadlessGraphId): HeadlessNodeInput<TNode> | undefined;
  getLink(id: HeadlessGraphId): HeadlessLink<TLink> | undefined;
  getNodePosition(id: HeadlessGraphId): Readonly<HeadlessVec3> | undefined;
  getBounds(): HeadlessGraphBounds | undefined;
}

export interface HeadlessLayoutOptions {
  dimensions?: 2 | 3;
  seed?: number;
  autoStart?: boolean;
  fixedDeltaSeconds?: number;
  linkDistance?: number;
  linkStrength?: number;
  chargeStrength?: number;
  chargeTheta?: number;
  centerStrength?: number;
  velocityDecay?: number;
  alphaDecay?: number;
  alphaMinimum?: number;
  minimumNodeDistance?: number;
  separationStrength?: number;
  separationIterations?: number;
  topologyReheatAlpha?: number;
  interactionReheatAlpha?: number;
  maxSeparationPairChecksPerStep?: number;
  settleThreshold?: number;
  maxStepsPerUpdate?: number;
  maxStepsPerRequest?: number;
}

export interface HeadlessGraphOptions {
  validation?: { mode?: 'strict' | 'tolerant' };
  layout?: HeadlessLayoutOptions;
}

export interface HeadlessLayoutSnapshot {
  readonly nodeIndices: Uint32Array;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly alpha: number;
  readonly settled: boolean;
}

export interface HeadlessSeparationDiagnostics {
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

export interface HeadlessLayoutResult {
  readonly snapshot: HeadlessLayoutSnapshot;
  readonly steps: number;
  readonly running: boolean;
  readonly lastStepMs: number;
  readonly separation: HeadlessSeparationDiagnostics;
}
