import { GraphError } from '../core/errors.js';
import type {
  LayoutConfiguration,
  LayoutInput,
  LayoutSeparationDiagnostics,
  LayoutSnapshot,
  Vec3
} from '../core/types.js';
import { BarnesHutOctree } from './BarnesHutOctree.js';
import { deterministicPairDirection } from './deterministicPairDirection.js';
import { assertValidLayoutInput } from './layoutProtocol.js';
import type { SnapshotTransferBuffers } from './SnapshotTransferPool.js';
import { RESOURCE_LIMITS } from '../core/resourceLimits.js';
import { MinimumDistanceIndex } from './MinimumDistanceIndex.js';
import type { MinimumDistanceCursor } from './MinimumDistanceIndex.js';

const FIXED_X = 1 << 0;
const FIXED_Y = 1 << 1;
const FIXED_Z = 1 << 2;
const FLOAT32_MAX = 3.4028234663852886e38;

export interface ResolvedLayoutConfiguration {
  dimensions: 2 | 3;
  fixedDeltaSeconds: number;
  linkDistance: number;
  linkStrength: number;
  chargeStrength: number;
  chargeTheta: number;
  centerStrength: number;
  velocityDecay: number;
  alphaDecay: number;
  alphaMinimum: number;
  minimumNodeDistance: number;
  separationStrength: number;
  separationIterations: number;
  topologyReheatAlpha: number;
  interactionReheatAlpha: number;
  maxSeparationPairChecksPerStep: number;
  settleThreshold: number;
  maxStepsPerUpdate: number;
  maxStepsPerRequest: number;
}

export const DEFAULT_LAYOUT_CONFIGURATION: ResolvedLayoutConfiguration = {
  dimensions: 3,
  fixedDeltaSeconds: 1 / 60,
  linkDistance: 30,
  linkStrength: 0.08,
  chargeStrength: -220,
  chargeTheta: 0.8,
  centerStrength: 0.04,
  velocityDecay: 0.82,
  alphaDecay: 0.025,
  alphaMinimum: 0.001,
  minimumNodeDistance: 0,
  separationStrength: 0.75,
  separationIterations: 1,
  topologyReheatAlpha: 0.35,
  interactionReheatAlpha: 0.2,
  maxSeparationPairChecksPerStep: 250_000,
  settleThreshold: 0.001,
  maxStepsPerUpdate: 8,
  maxStepsPerRequest: 256
};

export function resolveLayoutConfiguration(options: LayoutConfiguration = {}): ResolvedLayoutConfiguration {
  const maxStepsPerRequest = positiveInteger(
    options.maxStepsPerRequest,
    DEFAULT_LAYOUT_CONFIGURATION.maxStepsPerRequest,
    RESOURCE_LIMITS.maxLayoutStepsPerRequest
  );
  return {
    dimensions: options.dimensions === 2 || options.dimensions === 3
      ? options.dimensions
      : DEFAULT_LAYOUT_CONFIGURATION.dimensions,
    fixedDeltaSeconds: positive(options.fixedDeltaSeconds, DEFAULT_LAYOUT_CONFIGURATION.fixedDeltaSeconds),
    linkDistance: positive(options.linkDistance, DEFAULT_LAYOUT_CONFIGURATION.linkDistance),
    linkStrength: nonNegative(options.linkStrength, DEFAULT_LAYOUT_CONFIGURATION.linkStrength),
    chargeStrength: finite(options.chargeStrength, DEFAULT_LAYOUT_CONFIGURATION.chargeStrength),
    chargeTheta: positive(options.chargeTheta, DEFAULT_LAYOUT_CONFIGURATION.chargeTheta),
    centerStrength: nonNegative(options.centerStrength, DEFAULT_LAYOUT_CONFIGURATION.centerStrength),
    velocityDecay: clamp(finite(options.velocityDecay, DEFAULT_LAYOUT_CONFIGURATION.velocityDecay), 0, 1),
    alphaDecay: clamp(finite(options.alphaDecay, DEFAULT_LAYOUT_CONFIGURATION.alphaDecay), 0, 1),
    alphaMinimum: positive(options.alphaMinimum, DEFAULT_LAYOUT_CONFIGURATION.alphaMinimum),
    minimumNodeDistance: nonNegative(options.minimumNodeDistance, DEFAULT_LAYOUT_CONFIGURATION.minimumNodeDistance),
    separationStrength: clamp(finite(options.separationStrength, DEFAULT_LAYOUT_CONFIGURATION.separationStrength), 0, 1),
    separationIterations: positiveInteger(options.separationIterations, DEFAULT_LAYOUT_CONFIGURATION.separationIterations, 4),
    topologyReheatAlpha: clamp(finite(options.topologyReheatAlpha, DEFAULT_LAYOUT_CONFIGURATION.topologyReheatAlpha), 0, 1),
    interactionReheatAlpha: clamp(finite(options.interactionReheatAlpha, DEFAULT_LAYOUT_CONFIGURATION.interactionReheatAlpha), 0, 1),
    maxSeparationPairChecksPerStep: positiveInteger(
      options.maxSeparationPairChecksPerStep,
      DEFAULT_LAYOUT_CONFIGURATION.maxSeparationPairChecksPerStep,
      RESOURCE_LIMITS.maxSeparationPairChecksPerStep
    ),
    settleThreshold: positive(options.settleThreshold, DEFAULT_LAYOUT_CONFIGURATION.settleThreshold),
    maxStepsPerUpdate: Math.min(
      positiveInteger(
        options.maxStepsPerUpdate,
        DEFAULT_LAYOUT_CONFIGURATION.maxStepsPerUpdate,
        RESOURCE_LIMITS.maxLayoutStepsPerUpdate
      ),
      maxStepsPerRequest
    ),
    maxStepsPerRequest
  };
}

/**
 * A fixed-step deterministic solver. It has no DOM, Three.js, or worker
 * dependency and can run in a Worker, a test harness, or a headless graph.
 */
export class DeterministicForceLayout {
  private configuration: ResolvedLayoutConfiguration;
  private nodeIndices = new Uint32Array(0);
  private readonly denseIndexByNodeIndex = new Map<number, number>();
  private positions = new Float32Array(0);
  private velocities = new Float32Array(0);
  private fixedMask = new Uint8Array(0);
  private fixedPositions = new Float32Array(0);
  private links = new Uint32Array(0);
  private forces = new Float64Array(0);
  private separationPositionDeltas = new Float64Array(0);
  private separationVelocityDeltas = new Float64Array(0);
  private readonly minimumDistanceIndex = new MinimumDistanceIndex();
  private separationResolvableOverlapPairCount = 0;
  private separationMaximumPenetration = 0;
  private separationPairChecks = 0;
  private separationBudgetExhausted = false;
  private separationDeferredPairCount = 0;
  private separationConsecutiveNoProgressSteps = 0;
  private separationConstrainedSettlement = false;
  private separationPreviousMaximumPenetration = Number.POSITIVE_INFINITY;
  private separationSweepOverlapPairCount = 0;
  private separationSweepMaximumPenetration = 0;
  private separationCursor: MinimumDistanceCursor = { node: 0, pairOffset: 0 };
  private separationCorrectionSweepsSinceVerification = 0;
  private separationVerificationActive = false;
  private separationVerificationCursor: MinimumDistanceCursor = { node: 0, pairOffset: 0 };
  private separationVerificationSweepOverlapPairCount = 0;
  private separationVerificationSweepMaximumPenetration = 0;
  private separationCorrectionSweepsCompleted = 0;
  private separationVerificationSweepsCompleted = 0;
  private separationVerifiedOverlapPairCount = 0;
  private separationVerifiedMaximumPenetration = 0;
  private readonly octree = new BarnesHutOctree();
  private alpha = 1;
  private running = false;
  private stepCount = 0;
  private lastStepDurationMs = 0;
  private accumulatedSeconds = 0;

  constructor(configuration: LayoutConfiguration = {}) {
    this.configuration = resolveLayoutConfiguration(configuration);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentAlpha(): number {
    return this.alpha;
  }

  get steps(): number {
    return this.stepCount;
  }

  get lastStepMs(): number {
    return this.lastStepDurationMs;
  }

  get snapshotNodeCount(): number {
    return this.nodeIndices.length;
  }

  get separationDiagnostics(): LayoutSeparationDiagnostics {
    return {
      resolvableOverlapPairCount: this.separationResolvableOverlapPairCount,
      maximumPenetration: this.separationMaximumPenetration,
      pairChecks: this.separationPairChecks,
      budgetExhausted: this.separationBudgetExhausted,
      deferredPairCount: this.separationDeferredPairCount,
      consecutiveNoProgressSteps: this.separationConsecutiveNoProgressSteps,
      constrainedSettlement: this.separationConstrainedSettlement,
      correctionSweepsCompleted: this.separationCorrectionSweepsCompleted,
      verificationSweepsCompleted: this.separationVerificationSweepsCompleted,
      verifiedOverlapPairCount: this.separationVerifiedOverlapPairCount,
      verifiedMaximumPenetration: this.separationVerifiedMaximumPenetration
    };
  }

  configure(configuration: LayoutConfiguration): void {
    this.configuration = resolveLayoutConfiguration({ ...this.configuration, ...configuration });
    if (this.configuration.dimensions === 2) {
      this.zeroTwoDimensionalState();
    }
    this.resetSeparationDiagnostics();
    this.resetSeparationProgress();
    this.accumulatedSeconds = Math.min(this.accumulatedSeconds, this.maximumAccumulatedSeconds());
  }

  initialize(
    input: LayoutInput,
    state: Readonly<{ alpha?: number; steps?: number; lastStepMs?: number; running?: boolean }> = {}
  ): void {
    assertValidLayoutInput(input);
    this.nodeIndices = new Uint32Array(input.nodeIndices);
    this.positions = new Float32Array(input.positions);
    this.velocities = new Float32Array(input.velocities);
    this.fixedMask = new Uint8Array(input.fixedMask);
    this.fixedPositions = new Float32Array(input.fixedPositions);
    this.links = new Uint32Array(input.links);
    this.denseIndexByNodeIndex.clear();
    this.nodeIndices.forEach((nodeIndex, denseIndex) => this.denseIndexByNodeIndex.set(nodeIndex, denseIndex));
    if (this.configuration.dimensions === 2) {
      this.zeroTwoDimensionalState();
    }
    this.forces = new Float64Array(this.positions.length);
    this.separationPositionDeltas = new Float64Array(this.positions.length);
    this.separationVelocityDeltas = new Float64Array(this.positions.length);
    this.alpha = this.nodeIndices.length > 0 ? clamp(finite(state.alpha, 1), 0, 1) : 0;
    this.stepCount = Math.max(0, Math.floor(finite(state.steps, 0)));
    this.lastStepDurationMs = Math.max(0, finite(state.lastStepMs, 0));
    this.running = state.running === true
      && this.nodeIndices.length > 0
      && this.alpha > this.configuration.alphaMinimum;
    this.resetSeparationDiagnostics();
    this.resetSeparationProgress();
    this.accumulatedSeconds = 0;
  }

  start(): void {
    if (this.nodeIndices.length > 0 && this.alpha > this.configuration.alphaMinimum) {
      this.running = true;
    }
  }

  stop(): void {
    this.running = false;
  }

  restart(): void {
    if (this.nodeIndices.length === 0) {
      return;
    }
    this.alpha = 1;
    this.running = true;
    this.accumulatedSeconds = 0;
    this.resetSeparationDiagnostics();
    this.resetSeparationProgress();
  }

  reheatTo(alpha: number): void {
    if (this.nodeIndices.length === 0) return;
    this.alpha = Math.max(this.alpha, clamp(finite(alpha, 0), 0, 1));
    if (this.alpha > this.configuration.alphaMinimum) this.running = true;
  }

  step(count = 1): LayoutSnapshot {
    this.runSteps(count);
    return this.snapshot();
  }

  runSteps(count = 1): void {
    const steps = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (steps > this.configuration.maxStepsPerRequest) {
      throw new GraphError(
        'FG_LAYOUT_STEP_LIMIT_EXCEEDED',
        'The requested layout step count exceeds the configured per-request limit.',
        { requested: steps, maximum: this.configuration.maxStepsPerRequest }
      );
    }
    if (steps > 0 && this.nodeIndices.length > 0 && !this.running) {
      this.running = true;
    }
    for (let step = 0; step < steps; step += 1) {
      if (!this.running) {
        break;
      }
      this.stepOnce();
    }
  }

  advance(seconds: number): LayoutSnapshot {
    this.advanceWithoutSnapshot(seconds);
    return this.snapshot();
  }

  advanceWithoutSnapshot(seconds: number): void {
    if (!this.running || !Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    this.accumulatedSeconds = Math.min(
      this.maximumAccumulatedSeconds(),
      this.accumulatedSeconds + seconds
    );
    const count = Math.floor(this.accumulatedSeconds / this.configuration.fixedDeltaSeconds);
    this.accumulatedSeconds -= count * this.configuration.fixedDeltaSeconds;
    if (count > 0) {
      this.runSteps(count);
    }
  }

  setPinnedNode(nodeIndex: number, position: Vec3): boolean {
    const denseIndex = this.denseIndexByNodeIndex.get(nodeIndex);
    if (denseIndex === undefined) {
      return false;
    }
    const offset = denseIndex * 3;
    const x = Math.fround(position.x);
    const y = Math.fround(position.y);
    const z = Math.fround(this.configuration.dimensions === 3 ? position.z : 0);
    const mask = this.configuration.dimensions === 3 ? FIXED_X | FIXED_Y | FIXED_Z : FIXED_X | FIXED_Y;
    if (this.fixedMask[denseIndex] === mask
      && this.fixedPositions[offset] === x
      && this.fixedPositions[offset + 1] === y
      && this.fixedPositions[offset + 2] === z) {
      return false;
    }
    this.fixedMask[denseIndex] = mask;
    this.fixedPositions[offset] = x;
    this.fixedPositions[offset + 1] = y;
    this.fixedPositions[offset + 2] = z;
    this.positions[offset] = x;
    this.positions[offset + 1] = y;
    this.positions[offset + 2] = z;
    this.velocities[offset] = 0;
    this.velocities[offset + 1] = 0;
    this.velocities[offset + 2] = 0;
    this.resetSeparationDiagnostics();
    this.resetSeparationProgress();
    this.reheatTo(this.configuration.interactionReheatAlpha);
    return true;
  }

  releasePinnedNode(nodeIndex: number): boolean {
    const denseIndex = this.denseIndexByNodeIndex.get(nodeIndex);
    if (denseIndex === undefined || this.fixedMask[denseIndex] === 0) return false;
    this.fixedMask[denseIndex] = 0;
    this.resetSeparationDiagnostics();
    this.resetSeparationProgress();
    this.reheatTo(this.configuration.interactionReheatAlpha);
    return true;
  }

  snapshot(): LayoutSnapshot {
    return {
      nodeIndices: new Uint32Array(this.nodeIndices),
      positions: new Float32Array(this.positions),
      velocities: new Float32Array(this.velocities),
      alpha: this.alpha,
      settled: !this.running
    };
  }

  snapshotInto(buffers: SnapshotTransferBuffers): LayoutSnapshot {
    if (buffers.nodeIndices.length !== this.nodeIndices.length
      || buffers.positions.length !== this.positions.length
      || buffers.velocities.length !== this.velocities.length) {
      throw new GraphError(
        'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
        'Snapshot transfer buffers do not match the active layout dimensions.'
      );
    }
    buffers.nodeIndices.set(this.nodeIndices);
    buffers.positions.set(this.positions);
    buffers.velocities.set(this.velocities);
    return {
      ...buffers,
      alpha: this.alpha,
      settled: !this.running
    };
  }

  dispose(): void {
    this.stop();
    this.nodeIndices = new Uint32Array(0);
    this.positions = new Float32Array(0);
    this.velocities = new Float32Array(0);
    this.fixedMask = new Uint8Array(0);
    this.fixedPositions = new Float32Array(0);
    this.links = new Uint32Array(0);
    this.denseIndexByNodeIndex.clear();
    this.forces = new Float64Array(0);
    this.separationPositionDeltas = new Float64Array(0);
    this.separationVelocityDeltas = new Float64Array(0);
    this.resetSeparationDiagnostics();
    this.resetSeparationProgress();
    this.accumulatedSeconds = 0;
  }

  private stepOnce(): void {
    const start = now();
    const nodeCount = this.nodeIndices.length;
    if (nodeCount === 0) {
      this.running = false;
      return;
    }
    if (this.separationVerificationActive) {
      const separationPending = this.applyMinimumDistance(nodeCount);
      this.stepCount += 1;
      if (!separationPending
        && (this.alpha <= this.configuration.alphaMinimum
          || this.meanMovableAxisVelocitySquared(nodeCount) <= this.configuration.settleThreshold ** 2)) {
        this.running = false;
      }
      this.lastStepDurationMs = now() - start;
      return;
    }
    this.forces.fill(0);
    this.applyLinkForces(nodeCount);
    this.octree.build(this.positions, nodeCount, this.configuration.dimensions);
    for (let node = 0; node < nodeCount; node += 1) {
      this.octree.apply(node, this.forces, {
        theta: this.configuration.chargeTheta,
        strength: this.configuration.chargeStrength * this.alpha,
        softening: 0.5,
        dimensions: this.configuration.dimensions
      });
    }
    this.applyCenterForce(nodeCount);
    if (!hasFiniteValues(this.forces)) {
      this.running = false;
      throw new GraphError(
        'FG_LAYOUT_NONFINITE_OUTPUT',
        'The layout solver produced a non-finite force; the current step was rejected.'
      );
    }
    this.integrate(nodeCount);
    const separationPending = this.applyMinimumDistance(nodeCount);
    this.alpha *= 1 - this.configuration.alphaDecay;
    this.stepCount += 1;
    if (!separationPending
      && (this.alpha <= this.configuration.alphaMinimum
        || this.meanMovableAxisVelocitySquared(nodeCount) <= this.configuration.settleThreshold ** 2)) {
      this.alpha = Math.max(0, this.alpha);
      this.running = false;
    }
    this.lastStepDurationMs = now() - start;
  }

  private applyLinkForces(nodeCount: number): void {
    for (let offset = 0; offset + 1 < this.links.length; offset += 2) {
      const source = this.links[offset];
      const target = this.links[offset + 1];
      if (source === undefined || target === undefined || source >= nodeCount || target >= nodeCount || source === target) {
        continue;
      }
      const sourceOffset = source * 3;
      const targetOffset = target * 3;
      let dx = (this.positions[targetOffset] ?? 0) - (this.positions[sourceOffset] ?? 0);
      let dy = (this.positions[targetOffset + 1] ?? 0) - (this.positions[sourceOffset + 1] ?? 0);
      let dz = this.configuration.dimensions === 3
        ? (this.positions[targetOffset + 2] ?? 0) - (this.positions[sourceOffset + 2] ?? 0)
        : 0;
      let distance = Math.hypot(dx, dy, dz);
      if (distance < 1e-6) {
        const direction = deterministicPairDirection(source, target, this.configuration.dimensions);
        dx = direction.x * 1e-3;
        dy = direction.y * 1e-3;
        dz = direction.z * 1e-3;
        distance = 1e-3;
      }
      const magnitude = ((distance - this.configuration.linkDistance) / distance) * this.configuration.linkStrength * this.alpha;
      const fx = dx * magnitude;
      const fy = dy * magnitude;
      const fz = dz * magnitude;
      this.forces[sourceOffset] = (this.forces[sourceOffset] ?? 0) + fx;
      this.forces[sourceOffset + 1] = (this.forces[sourceOffset + 1] ?? 0) + fy;
      this.forces[targetOffset] = (this.forces[targetOffset] ?? 0) - fx;
      this.forces[targetOffset + 1] = (this.forces[targetOffset + 1] ?? 0) - fy;
      if (this.configuration.dimensions === 3) {
        this.forces[sourceOffset + 2] = (this.forces[sourceOffset + 2] ?? 0) + fz;
        this.forces[targetOffset + 2] = (this.forces[targetOffset + 2] ?? 0) - fz;
      }
    }
  }

  private applyCenterForce(nodeCount: number): void {
    const multiplier = this.configuration.centerStrength * this.alpha;
    for (let node = 0; node < nodeCount; node += 1) {
      const offset = node * 3;
      this.forces[offset] = (this.forces[offset] ?? 0) - (this.positions[offset] ?? 0) * multiplier;
      this.forces[offset + 1] = (this.forces[offset + 1] ?? 0) - (this.positions[offset + 1] ?? 0) * multiplier;
      if (this.configuration.dimensions === 3) {
        this.forces[offset + 2] = (this.forces[offset + 2] ?? 0) - (this.positions[offset + 2] ?? 0) * multiplier;
      }
    }
  }

  private integrate(nodeCount: number): void {
    const delta = this.configuration.fixedDeltaSeconds;
    for (let node = 0; node < nodeCount; node += 1) {
      const offset = node * 3;
      const mask = this.fixedMask[node] ?? 0;
      this.assertIntegrableAxis(offset, offset, mask, FIXED_X, delta);
      this.assertIntegrableAxis(offset + 1, offset + 1, mask, FIXED_Y, delta);
      if (this.configuration.dimensions === 3) {
        this.assertIntegrableAxis(offset + 2, offset + 2, mask, FIXED_Z, delta);
      }
    }
    for (let node = 0; node < nodeCount; node += 1) {
      const offset = node * 3;
      const mask = this.fixedMask[node] ?? 0;
      this.integrateAxis(offset, offset, mask, FIXED_X, delta);
      this.integrateAxis(offset + 1, offset + 1, mask, FIXED_Y, delta);
      if (this.configuration.dimensions === 3) {
        this.integrateAxis(offset + 2, offset + 2, mask, FIXED_Z, delta);
      } else {
        this.positions[offset + 2] = 0;
        this.velocities[offset + 2] = 0;
      }
    }
  }

  private applyMinimumDistance(nodeCount: number): boolean {
    const minimumDistance = this.configuration.minimumNodeDistance;
    const strength = this.configuration.separationStrength;
    this.resetSeparationDiagnostics();
    if (minimumDistance <= 0 || strength <= 0 || nodeCount < 2) {
      this.resetSeparationProgress();
      return false;
    }
    let remainingBudget = this.configuration.maxSeparationPairChecksPerStep;
    if (this.separationVerificationActive) {
      return this.continueSeparationVerification(nodeCount, minimumDistance, remainingBudget);
    }

    while (this.separationCorrectionSweepsSinceVerification < this.configuration.separationIterations
      && remainingBudget > 0) {
      let iterationOverlapCount = 0;
      let iterationMaximumPenetration = 0;
      this.separationPositionDeltas.fill(0);
      this.separationVelocityDeltas.fill(0);
      const result = this.minimumDistanceIndex.forEachNearbyPairBounded(
        this.positions,
        nodeCount,
        this.configuration.dimensions,
        minimumDistance,
        remainingBudget,
        this.separationCursor,
        (first, second) => {
          const pair = this.resolveSeparationPair(first, second, minimumDistance);
          if (!pair || pair.penetration <= minimumDistance * 1e-4) return;
          iterationOverlapCount += 1;
          iterationMaximumPenetration = Math.max(iterationMaximumPenetration, pair.penetration);
          this.accumulateResolvedSeparation(first, second, pair, strength);
        }
      );
      this.separationCursor = result.cursor;
      this.separationPairChecks += result.pairChecks;
      this.separationBudgetExhausted ||= result.budgetExhausted;
      this.separationDeferredPairCount = Math.max(this.separationDeferredPairCount, result.deferredPairCount);
      remainingBudget -= result.pairChecks;
      this.applySeparationDeltas(nodeCount);
      this.separationSweepOverlapPairCount += iterationOverlapCount;
      this.separationSweepMaximumPenetration = Math.max(
        this.separationSweepMaximumPenetration,
        iterationMaximumPenetration
      );
      if (result.budgetExhausted) return true;

      this.separationCorrectionSweepsCompleted += 1;
      this.separationCorrectionSweepsSinceVerification += 1;
      this.separationSweepOverlapPairCount = 0;
      this.separationSweepMaximumPenetration = 0;
      this.separationCursor = { node: 0, pairOffset: 0 };
    }

    if (this.separationCorrectionSweepsSinceVerification < this.configuration.separationIterations) {
      return true;
    }
    this.beginSeparationVerification();
    return remainingBudget > 0
      ? this.continueSeparationVerification(nodeCount, minimumDistance, remainingBudget)
      : true;
  }

  private beginSeparationVerification(): void {
    this.minimumDistanceIndex.resetSweep();
    this.separationVerificationActive = true;
    this.separationVerificationCursor = { node: 0, pairOffset: 0 };
    this.separationVerificationSweepOverlapPairCount = 0;
    this.separationVerificationSweepMaximumPenetration = 0;
  }

  private continueSeparationVerification(
    nodeCount: number,
    minimumDistance: number,
    remainingBudget: number
  ): boolean {
    const verification = this.minimumDistanceIndex.forEachNearbyPairBounded(
      this.positions,
      nodeCount,
      this.configuration.dimensions,
      minimumDistance,
      remainingBudget,
      this.separationVerificationCursor,
      (first, second) => {
        const pair = this.resolveSeparationPair(first, second, minimumDistance);
        if (!pair || pair.penetration <= minimumDistance * 1e-4) return;
        this.separationVerificationSweepOverlapPairCount += 1;
        this.separationVerificationSweepMaximumPenetration = Math.max(
          this.separationVerificationSweepMaximumPenetration,
          pair.penetration
        );
      }
    );
    this.separationVerificationCursor = verification.cursor;
    this.separationPairChecks += verification.pairChecks;
    this.separationBudgetExhausted ||= verification.budgetExhausted;
    this.separationDeferredPairCount = Math.max(this.separationDeferredPairCount, verification.deferredPairCount);
    if (verification.budgetExhausted) return true;

    const overlapCount = this.separationVerificationSweepOverlapPairCount;
    const maximumPenetration = this.separationVerificationSweepMaximumPenetration;
    this.separationVerificationActive = false;
    this.separationVerificationCursor = { node: 0, pairOffset: 0 };
    this.separationVerificationSweepOverlapPairCount = 0;
    this.separationVerificationSweepMaximumPenetration = 0;
    this.separationCorrectionSweepsSinceVerification = 0;
    this.separationVerificationSweepsCompleted += 1;
    this.separationVerifiedOverlapPairCount = overlapCount;
    this.separationVerifiedMaximumPenetration = maximumPenetration;
    this.separationResolvableOverlapPairCount = overlapCount;
    this.separationMaximumPenetration = maximumPenetration;
    return this.recordVerifiedSeparationSweep(overlapCount, maximumPenetration, minimumDistance);
  }

  private recordVerifiedSeparationSweep(
    overlapCount: number,
    maximumPenetration: number,
    minimumDistance: number
  ): boolean {
    if (overlapCount === 0) {
      this.separationConsecutiveNoProgressSteps = 0;
      this.separationPreviousMaximumPenetration = Number.POSITIVE_INFINITY;
      return false;
    }
    if (maximumPenetration < this.separationPreviousMaximumPenetration - minimumDistance * 1e-6) {
      this.separationConsecutiveNoProgressSteps = 0;
    } else {
      this.separationConsecutiveNoProgressSteps += 1;
    }
    this.separationPreviousMaximumPenetration = maximumPenetration;
    if (this.separationConsecutiveNoProgressSteps < 120) return true;
    this.separationConstrainedSettlement = true;
    this.running = false;
    return false;
  }

  private accumulateResolvedSeparation(
    first: number,
    second: number,
    pair: { x: number; y: number; z: number; penetration: number; requiredCorrection: number; movableWeight: number },
    strength: number
  ): void {
    const firstOffset = first * 3;
    const secondOffset = second * 3;
    const firstMask = this.fixedMask[first] ?? 0;
    const secondMask = this.fixedMask[second] ?? 0;
    const positionScale = pair.requiredCorrection * strength / pair.movableWeight;
    const relativeVelocity = pair.x * ((this.velocities[secondOffset] ?? 0) - (this.velocities[firstOffset] ?? 0))
      + pair.y * ((this.velocities[secondOffset + 1] ?? 0) - (this.velocities[firstOffset + 1] ?? 0))
      + pair.z * ((this.velocities[secondOffset + 2] ?? 0) - (this.velocities[firstOffset + 2] ?? 0));
    const velocityScale = relativeVelocity < 0 ? -relativeVelocity / pair.movableWeight : 0;
    this.accumulateAxis(firstOffset, secondOffset, firstMask, secondMask, FIXED_X, pair.x, positionScale, velocityScale);
    this.accumulateAxis(firstOffset + 1, secondOffset + 1, firstMask, secondMask, FIXED_Y, pair.y, positionScale, velocityScale);
    if (this.configuration.dimensions === 3) {
      this.accumulateAxis(firstOffset + 2, secondOffset + 2, firstMask, secondMask, FIXED_Z, pair.z, positionScale, velocityScale);
    }
  }

  private resolveSeparationPair(
    first: number,
    second: number,
    minimumDistance: number
  ): { x: number; y: number; z: number; penetration: number; requiredCorrection: number; movableWeight: number } | undefined {
    const firstOffset = first * 3;
    const secondOffset = second * 3;
    const dx = (this.positions[secondOffset] ?? 0) - (this.positions[firstOffset] ?? 0);
    const dy = (this.positions[secondOffset + 1] ?? 0) - (this.positions[firstOffset + 1] ?? 0);
    const dz = this.configuration.dimensions === 3
      ? (this.positions[secondOffset + 2] ?? 0) - (this.positions[firstOffset + 2] ?? 0)
      : 0;
    const distance = Math.hypot(dx, dy, dz);
    if (distance >= minimumDistance) return undefined;
    const firstMask = this.fixedMask[first] ?? 0;
    const secondMask = this.fixedMask[second] ?? 0;
    let x: number;
    let y: number;
    let z: number;
    let usesAlternateAxis = false;
    if (distance > 1e-9) {
      x = dx / distance;
      y = dy / distance;
      z = dz / distance;
    } else {
      const direction = deterministicPairDirection(
        this.nodeIndices[first] ?? first,
        this.nodeIndices[second] ?? second,
        this.configuration.dimensions
      );
      ({ x, y, z } = direction);
    }
    let movableWeight = pairMovableWeight(x, y, z, firstMask, secondMask, this.configuration.dimensions);
    if (movableWeight <= 1e-12) {
      const alternate = deterministicMovableAxis(
        this.nodeIndices[first] ?? first,
        this.nodeIndices[second] ?? second,
        firstMask,
        secondMask,
        this.configuration.dimensions
      );
      if (!alternate) return undefined;
      ({ x, y, z } = alternate);
      movableWeight = pairMovableWeight(x, y, z, firstMask, secondMask, this.configuration.dimensions);
      usesAlternateAxis = true;
    }
    const penetration = minimumDistance - distance;
    return {
      x,
      y,
      z,
      penetration,
      requiredCorrection: usesAlternateAxis
        ? Math.sqrt(Math.max(0, minimumDistance * minimumDistance - distance * distance))
        : penetration,
      movableWeight
    };
  }

  private accumulateAxis(
    firstOffset: number,
    secondOffset: number,
    firstMask: number,
    secondMask: number,
    fixedBit: number,
    direction: number,
    positionScale: number,
    velocityScale: number
  ): void {
    if ((firstMask & fixedBit) === 0) {
      this.separationPositionDeltas[firstOffset] = (this.separationPositionDeltas[firstOffset] ?? 0) - direction * positionScale;
      this.separationVelocityDeltas[firstOffset] = (this.separationVelocityDeltas[firstOffset] ?? 0) - direction * velocityScale;
    }
    if ((secondMask & fixedBit) === 0) {
      this.separationPositionDeltas[secondOffset] = (this.separationPositionDeltas[secondOffset] ?? 0) + direction * positionScale;
      this.separationVelocityDeltas[secondOffset] = (this.separationVelocityDeltas[secondOffset] ?? 0) + direction * velocityScale;
    }
  }

  private applySeparationDeltas(nodeCount: number): void {
    for (let node = 0; node < nodeCount; node += 1) {
      const offset = node * 3;
      const mask = this.fixedMask[node] ?? 0;
      this.assertSeparationAxis(offset, mask, FIXED_X);
      this.assertSeparationAxis(offset + 1, mask, FIXED_Y);
      if (this.configuration.dimensions === 3) this.assertSeparationAxis(offset + 2, mask, FIXED_Z);
    }
    for (let node = 0; node < nodeCount; node += 1) {
      const offset = node * 3;
      const mask = this.fixedMask[node] ?? 0;
      this.applySeparationAxis(offset, mask, FIXED_X);
      this.applySeparationAxis(offset + 1, mask, FIXED_Y);
      if (this.configuration.dimensions === 3) this.applySeparationAxis(offset + 2, mask, FIXED_Z);
    }
  }

  private assertSeparationAxis(offset: number, mask: number, fixedBit: number): void {
    if ((mask & fixedBit) !== 0) return;
    const position = (this.positions[offset] ?? 0) + (this.separationPositionDeltas[offset] ?? 0);
    const velocity = (this.velocities[offset] ?? 0) + (this.separationVelocityDeltas[offset] ?? 0);
    if (!isFiniteFloat32(position) || !isFiniteFloat32(velocity)) {
      this.running = false;
      throw new GraphError(
        'FG_LAYOUT_NONFINITE_OUTPUT',
        'The minimum-distance constraint produced a non-finite or out-of-range position/velocity; the current step was rejected.'
      );
    }
  }

  private applySeparationAxis(offset: number, mask: number, fixedBit: number): void {
    if ((mask & fixedBit) !== 0) return;
    this.positions[offset] = (this.positions[offset] ?? 0) + (this.separationPositionDeltas[offset] ?? 0);
    this.velocities[offset] = (this.velocities[offset] ?? 0) + (this.separationVelocityDeltas[offset] ?? 0);
  }

  private resetSeparationDiagnostics(): void {
    this.separationResolvableOverlapPairCount = this.separationVerifiedOverlapPairCount;
    this.separationMaximumPenetration = this.separationVerifiedMaximumPenetration;
    this.separationPairChecks = 0;
    this.separationBudgetExhausted = false;
    this.separationDeferredPairCount = 0;
  }

  private resetSeparationProgress(): void {
    this.minimumDistanceIndex.resetSweep();
    this.separationResolvableOverlapPairCount = 0;
    this.separationMaximumPenetration = 0;
    this.separationConsecutiveNoProgressSteps = 0;
    this.separationConstrainedSettlement = false;
    this.separationCorrectionSweepsSinceVerification = 0;
    this.separationVerificationActive = false;
    this.separationVerificationCursor = { node: 0, pairOffset: 0 };
    this.separationVerificationSweepOverlapPairCount = 0;
    this.separationVerificationSweepMaximumPenetration = 0;
    this.separationCorrectionSweepsCompleted = 0;
    this.separationVerificationSweepsCompleted = 0;
    this.separationVerifiedOverlapPairCount = 0;
    this.separationVerifiedMaximumPenetration = 0;
    this.separationPreviousMaximumPenetration = Number.POSITIVE_INFINITY;
    this.separationSweepOverlapPairCount = 0;
    this.separationSweepMaximumPenetration = 0;
    this.separationCursor = { node: 0, pairOffset: 0 };
  }

  private assertIntegrableAxis(
    positionOffset: number,
    forceOffset: number,
    mask: number,
    fixedBit: number,
    delta: number
  ): void {
    if ((mask & fixedBit) !== 0) {
      return;
    }
    const velocity = ((this.velocities[positionOffset] ?? 0) + (this.forces[forceOffset] ?? 0) * delta) * this.configuration.velocityDecay;
    const position = (this.positions[positionOffset] ?? 0) + velocity * delta;
    if (!isFiniteFloat32(velocity) || !isFiniteFloat32(position)) {
      this.running = false;
      throw new GraphError(
        'FG_LAYOUT_NONFINITE_OUTPUT',
        'The layout solver produced a non-finite or out-of-range position/velocity; the current step was rejected.'
      );
    }
  }

  private integrateAxis(positionOffset: number, forceOffset: number, mask: number, fixedBit: number, delta: number): void {
    if ((mask & fixedBit) !== 0) {
      this.positions[positionOffset] = this.fixedPositions[positionOffset] ?? 0;
      this.velocities[positionOffset] = 0;
      return;
    }
    const velocity = ((this.velocities[positionOffset] ?? 0) + (this.forces[forceOffset] ?? 0) * delta) * this.configuration.velocityDecay;
    this.velocities[positionOffset] = velocity;
    this.positions[positionOffset] = (this.positions[positionOffset] ?? 0) + velocity * delta;
  }

  private zeroTwoDimensionalState(): void {
    for (let denseIndex = 0; denseIndex < this.nodeIndices.length; denseIndex += 1) {
      const offset = denseIndex * 3;
      this.positions[offset + 2] = 0;
      this.velocities[offset + 2] = 0;
      this.fixedPositions[offset + 2] = 0;
      this.fixedMask[denseIndex] = (this.fixedMask[denseIndex] ?? 0) & ~FIXED_Z;
    }
  }

  private meanMovableAxisVelocitySquared(nodeCount: number): number {
    let sum = 0;
    let movableAxes = 0;
    for (let node = 0; node < nodeCount; node += 1) {
      const offset = node * 3;
      const mask = this.fixedMask[node] ?? 0;
      if ((mask & FIXED_X) === 0) {
        const velocity = this.velocities[offset] ?? 0;
        sum += velocity * velocity;
        movableAxes += 1;
      }
      if ((mask & FIXED_Y) === 0) {
        const velocity = this.velocities[offset + 1] ?? 0;
        sum += velocity * velocity;
        movableAxes += 1;
      }
      if (this.configuration.dimensions === 3 && (mask & FIXED_Z) === 0) {
        const velocity = this.velocities[offset + 2] ?? 0;
        sum += velocity * velocity;
        movableAxes += 1;
      }
    }
    return sum / Math.max(1, movableAxes);
  }

  private maximumAccumulatedSeconds(): number {
    return this.configuration.fixedDeltaSeconds * this.configuration.maxStepsPerUpdate;
  }
}

function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function positive(value: number | undefined, fallback: number): number {
  const candidate = finite(value, fallback);
  return candidate > 0 ? candidate : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  const candidate = finite(value, fallback);
  return candidate >= 0 ? candidate : fallback;
}

function positiveInteger(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const candidate = finite(value, fallback);
  return candidate > 0 ? Math.min(maximum, Math.max(1, Math.floor(candidate))) : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function pairMovableWeight(
  x: number,
  y: number,
  z: number,
  firstMask: number,
  secondMask: number,
  dimensions: 2 | 3
): number {
  let weight = 0;
  if ((firstMask & FIXED_X) === 0) weight += x * x;
  if ((secondMask & FIXED_X) === 0) weight += x * x;
  if ((firstMask & FIXED_Y) === 0) weight += y * y;
  if ((secondMask & FIXED_Y) === 0) weight += y * y;
  if (dimensions === 3) {
    if ((firstMask & FIXED_Z) === 0) weight += z * z;
    if ((secondMask & FIXED_Z) === 0) weight += z * z;
  }
  return weight;
}

function deterministicMovableAxis(
  first: number,
  second: number,
  firstMask: number,
  secondMask: number,
  dimensions: 2 | 3
): Vec3 | undefined {
  const preferred = deterministicPairDirection(first, second, dimensions);
  const preferredAxis = preferred.x !== 0 ? 0 : preferred.y !== 0 ? 1 : 2;
  const sign = preferred.x || preferred.y || preferred.z || 1;
  const fixedBits = [FIXED_X, FIXED_Y, FIXED_Z] as const;
  for (let offset = 0; offset < dimensions; offset += 1) {
    const axis = (preferredAxis + offset) % dimensions;
    const fixedBit = fixedBits[axis]!;
    if ((firstMask & fixedBit) !== 0 && (secondMask & fixedBit) !== 0) continue;
    return {
      x: axis === 0 ? sign : 0,
      y: axis === 1 ? sign : 0,
      z: dimensions === 3 && axis === 2 ? sign : 0
    };
  }
  return undefined;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function hasFiniteValues(values: Float64Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      return false;
    }
  }
  return true;
}

function isFiniteFloat32(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= FLOAT32_MAX;
}
