import { GraphError } from '../core/errors.js';
import {
  NodeFlags,
  type GraphData,
  type GraphMutationResult,
  type GraphBounds,
  type GraphId,
  type GraphErrorLike,
  type GraphLink,
  type GraphNodeInput,
  type GraphNode,
  type GraphNodePatch,
  type GraphNodeHandle,
  type GraphPatch,
  type LayoutInput,
  type LayoutSnapshot,
  type ValidationMode,
  type Vec3
} from '../core/types.js';

const FIXED_X = 1 << 0;
const FIXED_Y = 1 << 1;
const FIXED_Z = 1 << 2;

interface GraphStoreOptions {
  seed?: number;
  validationMode?: ValidationMode;
}

interface ValidatedData<TNode, TLink> {
  nodes: GraphNode<TNode>[];
  links: GraphLink<TLink>[];
  preserveExisting: boolean;
}

interface ValidatedPatch<TNode, TLink> {
  nodeUpserts: GraphNodePatch<TNode>[];
  skippedNodeIds: GraphId[];
  nodeRemovals: GraphId[];
  linkUpserts: GraphLink<TLink>[];
  skippedLinkIds: GraphId[];
  linkRemovals: GraphId[];
}

export interface PreparedGraphMutation {
  readonly owner: object;
  readonly baseRevision: number;
  readonly change: GraphMutationResult;
  readonly createLayoutInput: () => LayoutInput;
  readonly commit: () => GraphMutationResult;
}

export interface GraphStoreStorageStats {
  readonly nodeCapacity: number;
  readonly linkCapacity: number;
  readonly nodeRecordSlots: number;
  readonly linkRecordSlots: number;
  readonly ownedArrayBytes: number;
  readonly mapEntries: number;
  readonly adjacencyEntries: number;
  readonly freeSlotCount: number;
  readonly released: boolean;
}

export interface NodeRenderState {
  id: GraphId;
  index: number;
  position: Vec3;
  radius: number;
  color: number;
  flags: number;
}

export interface LinkRenderState {
  id: GraphId;
  index: number;
  sourceIndex: number;
  targetIndex: number;
  width: number;
  color: number;
}

/**
 * Owns simulation and render state. Structural node/link fields are copied at
 * ingestion; caller payloads remain opaque references and are never decorated.
 */
export class GraphStore<TNode = unknown, TLink = unknown> {
  private readonly preparationOwner = {};
  private preparationEpoch = 0;
  private released = false;
  private readonly validationMode: ValidationMode;
  private readonly seed: number;
  private copyOnWrite = false;
  private sharedNodeLifecycle = false;
  private sharedNodeState = false;
  private sharedNodeVisual = false;
  private sharedLinkLifecycle = false;
  private sharedLinkEndpoints = false;
  private sharedLinkVisual = false;

  private nodeCapacity = 0;
  private nextNodeSlot = 0;
  private liveNodeCount = 0;
  private readonly nodeIndexById = new Map<GraphId, number>();
  private nodeIds: Array<GraphId | undefined> = [];
  private nodeRecords: Array<GraphNode<TNode> | undefined> = [];
  private nodeAlive = new Uint8Array(0);
  private nodeGenerations = new Uint32Array(0);
  private nodeFlags = new Uint32Array(0);
  private nodeFixedMask = new Uint8Array(0);
  private nodePositions = new Float32Array(0);
  private nodeVelocities = new Float32Array(0);
  private nodeFixedPositions = new Float32Array(0);
  private nodeRadii = new Float32Array(0);
  private nodeColors = new Uint32Array(0);
  private readonly nodeFreeSlots: number[] = [];

  private linkCapacity = 0;
  private nextLinkSlot = 0;
  private liveLinkCount = 0;
  private readonly linkIndexById = new Map<GraphId, number>();
  private readonly linkIdsByNodeId = new Map<GraphId, Set<GraphId>>();
  private linkIds: Array<GraphId | undefined> = [];
  private linkRecords: Array<GraphLink<TLink> | undefined> = [];
  private linkAlive = new Uint8Array(0);
  private linkGenerations = new Uint32Array(0);
  private linkEndpoints = new Uint32Array(0);
  private linkWidths = new Float32Array(0);
  private linkColors = new Uint32Array(0);
  private readonly linkFreeSlots: number[] = [];

  private revision = 0;
  private warnings: GraphError[] = [];
  private patchSkippedNodeIds: GraphId[] = [];
  private patchSkippedLinkIds: GraphId[] = [];

  constructor(options: GraphStoreOptions = {}) {
    this.validationMode = options.validationMode ?? 'strict';
    this.seed = options.seed ?? 1337;
  }

  get nodeCount(): number {
    return this.liveNodeCount;
  }

  get linkCount(): number {
    return this.liveLinkCount;
  }

  get currentRevision(): number {
    return this.revision;
  }

  get validationWarnings(): readonly GraphError[] {
    return this.warnings;
  }

  getStorageStats(): GraphStoreStorageStats {
    let adjacencyEntries = 0;
    for (const links of this.linkIdsByNodeId.values()) {
      adjacencyEntries += links.size;
    }
    const ownedArrayBytes = this.nodeAlive.byteLength
      + this.nodeGenerations.byteLength
      + this.nodeFlags.byteLength
      + this.nodeFixedMask.byteLength
      + this.nodePositions.byteLength
      + this.nodeVelocities.byteLength
      + this.nodeFixedPositions.byteLength
      + this.nodeRadii.byteLength
      + this.nodeColors.byteLength
      + this.linkAlive.byteLength
      + this.linkGenerations.byteLength
      + this.linkEndpoints.byteLength
      + this.linkWidths.byteLength
      + this.linkColors.byteLength;
    return Object.freeze({
      nodeCapacity: this.nodeCapacity,
      linkCapacity: this.linkCapacity,
      nodeRecordSlots: this.nodeRecords.length,
      linkRecordSlots: this.linkRecords.length,
      ownedArrayBytes,
      mapEntries: this.nodeIndexById.size + this.linkIndexById.size,
      adjacencyEntries,
      freeSlotCount: this.nodeFreeSlots.length + this.linkFreeSlots.length,
      released: this.released
    });
  }

  /** Creates a private state-preserving copy for explicit diagnostic callers. */
  clone(): GraphStore<TNode, TLink> {
    return this.copyForPreparation(true);
  }

  prepareSetData(data: GraphData<TNode, TLink>): PreparedGraphMutation {
    return this.prepareMutation((candidate) => candidate.setData(data));
  }

  preparePatch(patch: GraphPatch<TNode, TLink>): PreparedGraphMutation {
    return this.prepareMutation((candidate) => candidate.applyPatch(patch));
  }

  prepareClear(): PreparedGraphMutation {
    return this.prepareMutation((candidate) => candidate.clear());
  }

  commitPrepared(plan: PreparedGraphMutation): GraphMutationResult {
    if (this.released) {
      throw new GraphError(
        'FG_RESOURCE_ALREADY_DISPOSED',
        'The graph store was released before the prepared mutation could be committed.'
      );
    }
    if (plan.owner !== this.preparationOwner) {
      throw new GraphError(
        'FG_DATA_STALE_MUTATION_PLAN',
        'The prepared graph mutation belongs to a different graph store.',
        { baseRevision: plan.baseRevision, currentRevision: this.revision, committed: false }
      );
    }
    return plan.commit();
  }

  private prepareMutation(
    mutate: (candidate: GraphStore<TNode, TLink>) => GraphMutationResult
  ): PreparedGraphMutation {
    if (this.released) {
      throw new GraphError('FG_RESOURCE_ALREADY_DISPOSED', 'The graph store has been released.');
    }
    const baseRevision = this.revision;
    const preparationEpoch = this.preparationEpoch;
    const candidate = this.copyForPreparation();
    candidate.revision = baseRevision;
    const change = mutate(candidate);
    const createLayoutInput = (): LayoutInput => candidate.createLayoutInput();
    let committed = false;
    const commit = (): GraphMutationResult => {
      if (this.released) {
        throw new GraphError(
          'FG_RESOURCE_ALREADY_DISPOSED',
          'The graph store was released before the prepared mutation could be committed.'
        );
      }
      if (committed || this.preparationEpoch !== preparationEpoch || this.revision !== baseRevision) {
        throw new GraphError(
          'FG_DATA_STALE_MUTATION_PLAN',
          'The prepared graph mutation is stale and cannot be committed.',
          { baseRevision, currentRevision: this.revision, committed }
        );
      }
      committed = true;
      this.adoptPreparedState(candidate);
      return change;
    };
    return Object.freeze({
      owner: this.preparationOwner,
      baseRevision,
      change,
      createLayoutInput,
      commit
    });
  }

  private copyForPreparation(copyBuffers = false): GraphStore<TNode, TLink> {
    const copy = new GraphStore<TNode, TLink>({ seed: this.seed, validationMode: this.validationMode });
    copy.nodeCapacity = this.nodeCapacity;
    copy.nextNodeSlot = this.nextNodeSlot;
    copy.liveNodeCount = this.liveNodeCount;
    copy.nodeIds = [...this.nodeIds];
    copy.nodeRecords = [...this.nodeRecords];
    copy.nodeAlive = copyBuffers ? this.nodeAlive.slice() : this.nodeAlive;
    copy.nodeGenerations = copyBuffers ? this.nodeGenerations.slice() : this.nodeGenerations;
    copy.nodeFlags = copyBuffers ? this.nodeFlags.slice() : this.nodeFlags;
    copy.nodeFixedMask = copyBuffers ? this.nodeFixedMask.slice() : this.nodeFixedMask;
    copy.nodePositions = copyBuffers ? this.nodePositions.slice() : this.nodePositions;
    copy.nodeVelocities = copyBuffers ? this.nodeVelocities.slice() : this.nodeVelocities;
    copy.nodeFixedPositions = copyBuffers ? this.nodeFixedPositions.slice() : this.nodeFixedPositions;
    copy.nodeRadii = copyBuffers ? this.nodeRadii.slice() : this.nodeRadii;
    copy.nodeColors = copyBuffers ? this.nodeColors.slice() : this.nodeColors;
    for (const [id, index] of this.nodeIndexById) copy.nodeIndexById.set(id, index);
    appendValues(copy.nodeFreeSlots, this.nodeFreeSlots);

    copy.linkCapacity = this.linkCapacity;
    copy.nextLinkSlot = this.nextLinkSlot;
    copy.liveLinkCount = this.liveLinkCount;
    copy.linkIds = [...this.linkIds];
    copy.linkRecords = [...this.linkRecords];
    copy.linkAlive = copyBuffers ? this.linkAlive.slice() : this.linkAlive;
    copy.linkGenerations = copyBuffers ? this.linkGenerations.slice() : this.linkGenerations;
    copy.linkEndpoints = copyBuffers ? this.linkEndpoints.slice() : this.linkEndpoints;
    copy.linkWidths = copyBuffers ? this.linkWidths.slice() : this.linkWidths;
    copy.linkColors = copyBuffers ? this.linkColors.slice() : this.linkColors;
    for (const [id, index] of this.linkIndexById) copy.linkIndexById.set(id, index);
    for (const [id, links] of this.linkIdsByNodeId) copy.linkIdsByNodeId.set(id, new Set(links));
    appendValues(copy.linkFreeSlots, this.linkFreeSlots);
    copy.revision = this.revision;
    copy.warnings = [...this.warnings];
    copy.copyOnWrite = !copyBuffers;
    copy.sharedNodeLifecycle = !copyBuffers;
    copy.sharedNodeState = !copyBuffers;
    copy.sharedNodeVisual = !copyBuffers;
    copy.sharedLinkLifecycle = !copyBuffers;
    copy.sharedLinkEndpoints = !copyBuffers;
    copy.sharedLinkVisual = !copyBuffers;
    return copy;
  }

  /** Drops every engine-owned graph buffer and invalidates outstanding plans. */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.preparationEpoch += 1;
    this.nodeIndexById.clear();
    this.linkIndexById.clear();
    this.linkIdsByNodeId.clear();
    this.nodeIds = [];
    this.nodeRecords = [];
    this.nodeAlive = new Uint8Array(0);
    this.nodeGenerations = new Uint32Array(0);
    this.nodeFlags = new Uint32Array(0);
    this.nodeFixedMask = new Uint8Array(0);
    this.nodePositions = new Float32Array(0);
    this.nodeVelocities = new Float32Array(0);
    this.nodeFixedPositions = new Float32Array(0);
    this.nodeRadii = new Float32Array(0);
    this.nodeColors = new Uint32Array(0);
    this.nodeFreeSlots.length = 0;
    this.nodeCapacity = 0;
    this.nextNodeSlot = 0;
    this.liveNodeCount = 0;
    this.linkIds = [];
    this.linkRecords = [];
    this.linkAlive = new Uint8Array(0);
    this.linkGenerations = new Uint32Array(0);
    this.linkEndpoints = new Uint32Array(0);
    this.linkWidths = new Float32Array(0);
    this.linkColors = new Uint32Array(0);
    this.linkFreeSlots.length = 0;
    this.linkCapacity = 0;
    this.nextLinkSlot = 0;
    this.liveLinkCount = 0;
    this.warnings = [];
    this.patchSkippedNodeIds = [];
    this.patchSkippedLinkIds = [];
  }

  private adoptPreparedState(candidate: GraphStore<TNode, TLink>): void {
    this.nodeCapacity = candidate.nodeCapacity;
    this.nextNodeSlot = candidate.nextNodeSlot;
    this.liveNodeCount = candidate.liveNodeCount;
    this.nodeIds = candidate.nodeIds;
    this.nodeRecords = candidate.nodeRecords;
    this.nodeAlive = candidate.nodeAlive;
    this.nodeGenerations = candidate.nodeGenerations;
    this.nodeFlags = candidate.nodeFlags;
    this.nodeFixedMask = candidate.nodeFixedMask;
    this.nodePositions = candidate.nodePositions;
    this.nodeVelocities = candidate.nodeVelocities;
    this.nodeFixedPositions = candidate.nodeFixedPositions;
    this.nodeRadii = candidate.nodeRadii;
    this.nodeColors = candidate.nodeColors;
    this.nodeIndexById.clear();
    for (const [id, index] of candidate.nodeIndexById) this.nodeIndexById.set(id, index);
    this.nodeFreeSlots.length = 0;
    appendValues(this.nodeFreeSlots, candidate.nodeFreeSlots);

    this.linkCapacity = candidate.linkCapacity;
    this.nextLinkSlot = candidate.nextLinkSlot;
    this.liveLinkCount = candidate.liveLinkCount;
    this.linkIds = candidate.linkIds;
    this.linkRecords = candidate.linkRecords;
    this.linkAlive = candidate.linkAlive;
    this.linkGenerations = candidate.linkGenerations;
    this.linkEndpoints = candidate.linkEndpoints;
    this.linkWidths = candidate.linkWidths;
    this.linkColors = candidate.linkColors;
    this.linkIndexById.clear();
    for (const [id, index] of candidate.linkIndexById) this.linkIndexById.set(id, index);
    this.linkIdsByNodeId.clear();
    for (const [id, links] of candidate.linkIdsByNodeId) this.linkIdsByNodeId.set(id, new Set(links));
    this.linkFreeSlots.length = 0;
    appendValues(this.linkFreeSlots, candidate.linkFreeSlots);

    this.revision = candidate.revision;
    this.warnings = candidate.warnings;
    this.patchSkippedNodeIds = candidate.patchSkippedNodeIds;
    this.patchSkippedLinkIds = candidate.patchSkippedLinkIds;
    this.copyOnWrite = false;
    this.sharedNodeLifecycle = false;
    this.sharedNodeState = false;
    this.sharedNodeVisual = false;
    this.sharedLinkLifecycle = false;
    this.sharedLinkEndpoints = false;
    this.sharedLinkVisual = false;
  }

  /** Returns copied min/max extents for live nodes, or undefined for an empty graph. */
  getBounds(): GraphBounds | undefined {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (let index = 0; index < this.nextNodeSlot; index += 1) {
      if (this.nodeAlive[index] !== 1) {
        continue;
      }
      const offset = index * 3;
      const x = this.nodePositions[offset] ?? Number.NaN;
      const y = this.nodePositions[offset + 1] ?? Number.NaN;
      const z = this.nodePositions[offset + 2] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
      count += 1;
    }
    if (count === 0) {
      return undefined;
    }
    return Object.freeze({
      min: Object.freeze({ x: minX, y: minY, z: minZ }),
      max: Object.freeze({ x: maxX, y: maxY, z: maxZ })
    });
  }

  setData(data: GraphData<TNode, TLink>): GraphMutationResult {
    const validated = this.validateData(data);
    return this.replaceData(validated, 'set-data');
  }

  applyPatch(patch: GraphPatch<TNode, TLink>): GraphMutationResult {
    const revisionBefore = this.revision;
    const validatedPatch = this.validatePatch(patch);
    if (this.isPayloadOnlyPatch(validatedPatch)) {
      return this.applyPayloadOnlyPatch(revisionBefore, validatedPatch);
    }
    const beforeNodeIds = new Set(this.nodeIndexById.keys());
    const beforeLinkIds = new Set(this.linkIndexById.keys());
    const nodeRemovals = new Set(validatedPatch.nodeRemovals);
    const nodeUpserts = new Map(validatedPatch.nodeUpserts.map((node) => [node.id, node]));
    const linkRemovals = new Set<GraphId>();
    const acceptedLinkUpserts: GraphLink<TLink>[] = [];
    const changedNodeIds = new Set<GraphId>();
    const changedLinkIds = new Set<GraphId>();
    const cascadedLinkIds = new Set<GraphId>();
    let topologyChanged = false;
    let simulationChanged = false;
    let payloadChanged = false;

    for (const id of validatedPatch.nodeRemovals) {
      if (this.nodeIndexById.has(id)) {
        topologyChanged = true;
      }
    }
    for (const node of validatedPatch.nodeUpserts) {
      const survivesRemoval = this.nodeIndexById.has(node.id) && !nodeRemovals.has(node.id);
      if (!survivesRemoval) {
        topologyChanged = true;
      } else {
        const index = this.nodeIndexById.get(node.id);
        const previous = index === undefined ? undefined : this.nodeRecords[index];
        const merged = previous === undefined ? undefined : mergeNodePatch(previous, node);
        const recordChanged = merged !== undefined && previous !== undefined && !sameNodeRecord(previous, merged);
        const fixedStateChanged = hasOwn(node, 'fixed') && merged !== undefined && !samePartialVec3(previous?.fixed, merged.fixed);
        payloadChanged ||= recordChanged;
        simulationChanged ||= node.resetPosition === true || fixedStateChanged;
        if (!recordChanged && !fixedStateChanged && !node.resetPosition) {
          continue;
        }
      }
      changedNodeIds.add(node.id);
    }
    for (const id of validatedPatch.linkRemovals) {
      if (this.linkIndexById.has(id)) {
        linkRemovals.add(id);
        topologyChanged = true;
      }
    }

    // Only links incident to nodes that will actually disappear are cascade
    // candidates. A remove followed by an upsert of the same node preserves
    // the current remove/upsert ordering and therefore keeps its links.
    for (const id of validatedPatch.nodeRemovals) {
      if (nodeUpserts.has(id)) {
        continue;
      }
      for (const linkId of this.linkIdsByNodeId.get(id) ?? []) {
        linkRemovals.add(linkId);
        cascadedLinkIds.add(linkId);
      }
    }

    const nodeExistsAfterPatch = (id: GraphId): boolean => nodeUpserts.has(id)
      || (!nodeRemovals.has(id) && this.nodeIndexById.has(id));
    for (const link of validatedPatch.linkUpserts) {
      if (!nodeExistsAfterPatch(link.source)) {
        this.report(new GraphError('FG_DATA_MISSING_SOURCE', `Patch link '${String(link.id)}' references a missing source node.`, { id: link.id, source: link.source }));
        validatedPatch.skippedLinkIds.push(link.id);
        continue;
      }
      if (!nodeExistsAfterPatch(link.target)) {
        this.report(new GraphError('FG_DATA_MISSING_TARGET', `Patch link '${String(link.id)}' references a missing target node.`, { id: link.id, target: link.target }));
        validatedPatch.skippedLinkIds.push(link.id);
        continue;
      }
      const existingIndex = this.linkIndexById.get(link.id);
      const existing = existingIndex === undefined ? undefined : this.linkRecords[existingIndex];
      if (existing === undefined || linkRemovals.has(link.id) || existing.source !== link.source || existing.target !== link.target) {
        topologyChanged = true;
      } else if (!sameLinkRecord(existing, link)) {
        payloadChanged = true;
      } else {
        continue;
      }
      acceptedLinkUpserts.push(link);
      linkRemovals.delete(link.id);
      cascadedLinkIds.delete(link.id);
      changedLinkIds.add(link.id);
    }

    if (!topologyChanged && !simulationChanged && !payloadChanged) {
      return this.change('patch', {
        revisionBefore,
        changedNodeIds: [],
        changedLinkIds: [],
        cascadedLinkIds: [...cascadedLinkIds],
        ...classifyPatchIds(beforeNodeIds, beforeLinkIds, validatedPatch, this.nodeIndexById, this.linkIndexById, changedNodeIds, changedLinkIds)
      });
    }

    for (const id of linkRemovals) {
      this.removeLink(id);
    }
    for (const id of validatedPatch.nodeRemovals) {
      if (!nodeUpserts.has(id)) {
        this.removeNode(id);
      }
    }
    for (const node of validatedPatch.nodeUpserts) {
      const index = this.nodeIndexById.get(node.id);
      if (index === undefined) {
        this.insertNode(copyNode(node));
        continue;
      }
      const previous = this.nodeRecords[index];
      if (!previous) {
        continue;
      }
      const merged = mergeNodePatch(previous, node);
      this.nodeRecords[index] = merged;
      this.applyExistingNodePatchState(index, previous, merged, node);
    }
    for (const link of acceptedLinkUpserts) {
      const index = this.linkIndexById.get(link.id);
      if (index === undefined) {
        this.insertLink(link);
        continue;
      }
      this.updateLink(index, link);
    }
    this.revision += 1;
    const classifications = classifyPatchIds(
      beforeNodeIds,
      beforeLinkIds,
      validatedPatch,
      this.nodeIndexById,
      this.linkIndexById,
      changedNodeIds,
      changedLinkIds
    );
    return this.change('patch', {
      revisionBefore,
      topologyChanged,
      simulationChanged: topologyChanged || simulationChanged,
      payloadChanged,
      visualChanged: topologyChanged || simulationChanged || payloadChanged,
      changedNodeIds: [...changedNodeIds].filter((id) => this.nodeIndexById.has(id)),
      changedLinkIds: [...changedLinkIds].filter((id) => this.linkIndexById.has(id)),
      ...classifications,
      removedLinkIds: [...new Set([
        ...classifications.removedLinkIds,
        ...linkRemovals
      ])].filter((id) => !this.linkIndexById.has(id)),
      cascadedLinkIds: [...cascadedLinkIds].filter((id) => !this.linkIndexById.has(id))
    });
  }

  private isPayloadOnlyPatch(patch: ValidatedPatch<TNode, TLink>): boolean {
    if (patch.nodeRemovals.length > 0 || patch.linkRemovals.length > 0) {
      return false;
    }
    for (const node of patch.nodeUpserts) {
      if (!this.nodeIndexById.has(node.id)
        || node.initialPosition !== undefined
        || node.fixed !== undefined
        || node.resetPosition === true) {
        return false;
      }
    }
    for (const link of patch.linkUpserts) {
      const index = this.linkIndexById.get(link.id);
      const existing = index === undefined ? undefined : this.linkRecords[index];
      if (!existing || existing.source !== link.source || existing.target !== link.target) {
        return false;
      }
    }
    return true;
  }

  private applyPayloadOnlyPatch(
    revisionBefore: number,
    patch: ValidatedPatch<TNode, TLink>
  ): GraphMutationResult {
    const changedNodeIds: GraphId[] = [];
    const unchangedNodeIds: GraphId[] = [];
    const changedLinkIds: GraphId[] = [];
    const unchangedLinkIds: GraphId[] = [];
    for (const node of patch.nodeUpserts) {
      const index = this.nodeIndexById.get(node.id);
      const previous = index === undefined ? undefined : this.nodeRecords[index];
      if (index === undefined || !previous) {
        throw new GraphError('FG_DATA_INVALID_ID', `Payload patch node '${String(node.id)}' disappeared before commit.`, { id: node.id });
      }
      const merged = mergeNodePatch(previous, node);
      if (sameNodeRecord(previous, merged)) {
        unchangedNodeIds.push(node.id);
      } else {
        this.nodeRecords[index] = merged;
        changedNodeIds.push(node.id);
      }
    }
    for (const link of patch.linkUpserts) {
      const index = this.linkIndexById.get(link.id);
      const previous = index === undefined ? undefined : this.linkRecords[index];
      if (index === undefined || !previous) {
        throw new GraphError('FG_DATA_INVALID_ID', `Payload patch link '${String(link.id)}' disappeared before commit.`, { id: link.id });
      }
      if (sameLinkRecord(previous, link)) {
        unchangedLinkIds.push(link.id);
      } else {
        this.linkRecords[index] = link;
        changedLinkIds.push(link.id);
      }
    }
    const payloadChanged = changedNodeIds.length > 0 || changedLinkIds.length > 0;
    if (payloadChanged) {
      this.revision += 1;
    }
    return this.change('patch', {
      revisionBefore,
      payloadChanged,
      visualChanged: payloadChanged,
      changedNodeIds,
      changedLinkIds,
      updatedNodeIds: changedNodeIds,
      updatedLinkIds: changedLinkIds,
      unchangedNodeIds,
      unchangedLinkIds,
      skippedNodeIds: patch.skippedNodeIds,
      skippedLinkIds: patch.skippedLinkIds
    });
  }

  clear(): GraphMutationResult {
    const revisionBefore = this.revision;
    if (this.liveNodeCount === 0 && this.liveLinkCount === 0) {
      return this.change('clear', { revisionBefore });
    }
    const removedNodeIds = [...this.nodeIndexById.keys()];
    const removedLinkIds = [...this.linkIndexById.keys()];
    this.clearInternal();
    this.revision += 1;
    return this.change('clear', {
      revisionBefore,
      topologyChanged: true,
      simulationChanged: true,
      removedNodeIds,
      removedLinkIds,
      cascadedLinkIds: removedLinkIds
    });
  }

  hasNode(id: GraphId): boolean {
    return this.nodeIndexById.has(id);
  }

  hasLink(id: GraphId): boolean {
    return this.linkIndexById.has(id);
  }

  getNode(id: GraphId): GraphNode<TNode> | undefined {
    const index = this.nodeIndexById.get(id);
    const node = index === undefined ? undefined : this.nodeRecords[index];
    return node === undefined ? undefined : copyNode(node);
  }

  getLink(id: GraphId): GraphLink<TLink> | undefined {
    const index = this.linkIndexById.get(id);
    const link = index === undefined ? undefined : this.linkRecords[index];
    return link === undefined ? undefined : copyLink(link);
  }

  /** Returns copied unique IDs of links touching any supplied live node. */
  getIncidentLinkIds(nodeIds: Iterable<GraphId>): readonly GraphId[] {
    const ids = new Set<GraphId>();
    for (const nodeId of nodeIds) {
      for (const linkId of this.linkIdsByNodeId.get(nodeId) ?? []) {
        ids.add(linkId);
      }
    }
    return Object.freeze([...ids]);
  }

  /** Returns a fresh structural graph copy suitable for a host-owned snapshot. */
  toGraphData(): GraphData<TNode, TLink> {
    const nodes: GraphNode<TNode>[] = [];
    const links: GraphLink<TLink>[] = [];
    this.forEachNode((_index, node) => nodes.push(copyNode(node)));
    this.forEachLink((_index, link) => links.push(copyLink(link)));
    return Object.freeze({
      nodes: Object.freeze(nodes),
      links: Object.freeze(links)
    });
  }

  getNodePosition(id: GraphId): Vec3 | undefined {
    const index = this.nodeIndexById.get(id);
    return index === undefined ? undefined : this.readVec3(this.nodePositions, index);
  }

  getNodeHandle(id: GraphId): GraphNodeHandle | undefined {
    const index = this.nodeIndexById.get(id);
    if (index === undefined) {
      return undefined;
    }
    return { index, generation: this.nodeGenerations[index] ?? 0 };
  }

  isNodeHandleValid(handle: GraphNodeHandle): boolean {
    return handle.index >= 0
      && handle.index < this.nextNodeSlot
      && this.nodeAlive[handle.index] === 1
      && this.nodeGenerations[handle.index] === handle.generation;
  }

  setNodeFixed(id: GraphId, position: Vec3): boolean {
    const index = this.nodeIndexById.get(id);
    if (index === undefined || !isFiniteVec3(position)) {
      return false;
    }
    this.ensureNodeLifecycleWritable();
    this.ensureNodeStateWritable();
    this.writeVec3(this.nodePositions, index, position);
    this.writeVec3(this.nodeFixedPositions, index, position);
    this.nodeFixedMask[index] = FIXED_X | FIXED_Y | FIXED_Z;
    this.nodeFlags[index] = (this.nodeFlags[index] ?? 0) | NodeFlags.Pinned;
    return true;
  }

  isNodeFixed(id: GraphId): boolean {
    const index = this.nodeIndexById.get(id);
    return index !== undefined && (this.nodeFixedMask[index] ?? 0) !== 0;
  }

  releaseNode(id: GraphId): boolean {
    const index = this.nodeIndexById.get(id);
    if (index === undefined || (this.nodeFixedMask[index] ?? 0) === 0) {
      return false;
    }
    this.ensureNodeLifecycleWritable();
    this.nodeFixedMask[index] = 0;
    this.nodeFlags[index] = (this.nodeFlags[index] ?? 0) & ~NodeFlags.Pinned;
    return true;
  }

  setNodeFlags(id: GraphId, set: number = NodeFlags.Visible, clear: number = 0): boolean {
    const index = this.nodeIndexById.get(id);
    if (index === undefined) {
      return false;
    }
    const current = this.nodeFlags[index] ?? 0;
    const next = (current | set) & ~clear;
    if (current === next) {
      return false;
    }
    this.ensureNodeLifecycleWritable();
    this.nodeFlags[index] = next;
    return true;
  }

  setNodeRenderStyle(index: number, radius: number, color: number): boolean {
    if (this.nodeAlive[index] !== 1) {
      return false;
    }
    const nextRadius = Number.isFinite(radius) && radius > 0 ? radius : 1;
    const nextColor = normalizeColor(color, 0x71a7ff);
    if (this.nodeRadii[index] === nextRadius && this.nodeColors[index] === nextColor) {
      return false;
    }
    this.ensureNodeVisualWritable();
    this.nodeRadii[index] = nextRadius;
    this.nodeColors[index] = nextColor;
    return true;
  }

  setLinkRenderStyle(index: number, width: number, color: number): boolean {
    if (this.linkAlive[index] !== 1) {
      return false;
    }
    const nextWidth = Number.isFinite(width) && width > 0 ? width : 1;
    const nextColor = normalizeColor(color, 0x8ca0c8);
    if (this.linkWidths[index] === nextWidth && this.linkColors[index] === nextColor) {
      return false;
    }
    this.ensureLinkVisualWritable();
    this.linkWidths[index] = nextWidth;
    this.linkColors[index] = nextColor;
    return true;
  }

  applyLayoutSnapshot(snapshot: LayoutSnapshot): boolean {
    const count = Math.min(snapshot.nodeIndices.length, Math.floor(snapshot.positions.length / 3));
    let applied = false;
    for (let denseIndex = 0; denseIndex < count; denseIndex += 1) {
      const nodeIndex = snapshot.nodeIndices[denseIndex];
      if (nodeIndex === undefined || this.nodeAlive[nodeIndex] !== 1) {
        continue;
      }
      const source = denseIndex * 3;
      const x = snapshot.positions[source] ?? Number.NaN;
      const y = snapshot.positions[source + 1] ?? Number.NaN;
      const z = snapshot.positions[source + 2] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }
      this.ensureNodeStateWritable();
      const destination = nodeIndex * 3;
      this.nodePositions[destination] = x;
      this.nodePositions[destination + 1] = y;
      this.nodePositions[destination + 2] = z;
      if (snapshot.velocities.length >= source + 3) {
        this.nodeVelocities[destination] = snapshot.velocities[source] ?? 0;
        this.nodeVelocities[destination + 1] = snapshot.velocities[source + 1] ?? 0;
        this.nodeVelocities[destination + 2] = snapshot.velocities[source + 2] ?? 0;
      }
      applied = true;
    }
    return applied;
  }

  createLayoutInput(): LayoutInput {
    const indices: number[] = [];
    const denseBySlot = new Map<number, number>();
    this.forEachNode((slot) => {
      denseBySlot.set(slot, indices.length);
      indices.push(slot);
    });
    const nodeIndices = Uint32Array.from(indices);
    const positions = new Float32Array(indices.length * 3);
    const velocities = new Float32Array(indices.length * 3);
    const fixedMask = new Uint8Array(indices.length);
    const fixedPositions = new Float32Array(indices.length * 3);
    indices.forEach((slot, denseIndex) => {
      const source = slot * 3;
      const target = denseIndex * 3;
      positions[target] = this.nodePositions[source] ?? 0;
      positions[target + 1] = this.nodePositions[source + 1] ?? 0;
      positions[target + 2] = this.nodePositions[source + 2] ?? 0;
      velocities[target] = this.nodeVelocities[source] ?? 0;
      velocities[target + 1] = this.nodeVelocities[source + 1] ?? 0;
      velocities[target + 2] = this.nodeVelocities[source + 2] ?? 0;
      fixedMask[denseIndex] = this.nodeFixedMask[slot] ?? 0;
      fixedPositions[target] = this.nodeFixedPositions[source] ?? 0;
      fixedPositions[target + 1] = this.nodeFixedPositions[source + 1] ?? 0;
      fixedPositions[target + 2] = this.nodeFixedPositions[source + 2] ?? 0;
    });

    const links: number[] = [];
    this.forEachLink((linkIndex) => {
      const endpoint = linkIndex * 2;
      const sourceSlot = this.linkEndpoints[endpoint];
      const targetSlot = this.linkEndpoints[endpoint + 1];
      if (sourceSlot === undefined || targetSlot === undefined) {
        return;
      }
      const sourceDense = denseBySlot.get(sourceSlot);
      const targetDense = denseBySlot.get(targetSlot);
      if (sourceDense === undefined || targetDense === undefined) {
        return;
      }
      links.push(sourceDense, targetDense);
    });

    return {
      nodeIndices,
      positions,
      velocities,
      fixedMask,
      fixedPositions,
      links: Uint32Array.from(links)
    };
  }

  forEachNode(callback: (index: number, node: GraphNode<TNode>) => void): void {
    for (let index = 0; index < this.nextNodeSlot; index += 1) {
      const node = this.nodeRecords[index];
      if (this.nodeAlive[index] === 1 && node) {
        callback(index, node);
      }
    }
  }

  forEachLink(callback: (index: number, link: GraphLink<TLink>) => void): void {
    for (let index = 0; index < this.nextLinkSlot; index += 1) {
      const link = this.linkRecords[index];
      if (this.linkAlive[index] === 1 && link) {
        callback(index, link);
      }
    }
  }

  getNodeRenderState(index: number): NodeRenderState | undefined {
    const id = this.nodeIds[index];
    if (this.nodeAlive[index] !== 1 || id === undefined) {
      return undefined;
    }
    return {
      id,
      index,
      position: this.readVec3(this.nodePositions, index),
      radius: this.nodeRadii[index] ?? 1,
      color: this.nodeColors[index] ?? 0x71a7ff,
      flags: this.nodeFlags[index] ?? NodeFlags.Visible
    };
  }

  getLinkRenderState(index: number): LinkRenderState | undefined {
    const id = this.linkIds[index];
    if (this.linkAlive[index] !== 1 || id === undefined) {
      return undefined;
    }
    const endpoint = index * 2;
    const sourceIndex = this.linkEndpoints[endpoint];
    const targetIndex = this.linkEndpoints[endpoint + 1];
    if (sourceIndex === undefined || targetIndex === undefined) {
      return undefined;
    }
    return {
      id,
      index,
      sourceIndex,
      targetIndex,
      width: this.linkWidths[index] ?? 1,
      color: this.linkColors[index] ?? 0x8ca0c8
    };
  }

  getLinkRenderStateById(id: GraphId): LinkRenderState | undefined {
    const index = this.linkIndexById.get(id);
    return index === undefined ? undefined : this.getLinkRenderState(index);
  }

  private replaceData(validated: ValidatedData<TNode, TLink>, kind: 'set-data'): GraphMutationResult {
    const revisionBefore = this.revision;
    const previousNodeIds = new Set(this.nodeIndexById.keys());
    const previousLinkIds = new Set(this.linkIndexById.keys());
    if (validated.preserveExisting) {
      return this.change(kind, {
        revisionBefore,
        unchangedNodeIds: [...previousNodeIds],
        unchangedLinkIds: [...previousLinkIds]
      });
    }
    const previousLinks = new Map<GraphId, GraphLink<TLink>>();
    for (const link of this.linkRecords) {
      if (link) {
        previousLinks.set(link.id, link);
      }
    }
    const nextNodeIds = new Set(validated.nodes.map((node) => node.id));
    const nextLinkIds = new Set(validated.links.map((link) => link.id));
    this.clearInternal();
    for (const node of validated.nodes) {
      this.insertNode(node);
    }
    for (const link of validated.links) {
      this.insertLink(link);
    }
    this.revision += 1;
    return this.change(kind, {
      revisionBefore,
      topologyChanged: true,
      simulationChanged: true,
      changedNodeIds: validated.nodes.map((node) => node.id),
      changedLinkIds: validated.links.map((link) => link.id),
      addedNodeIds: [...nextNodeIds].filter((id) => !previousNodeIds.has(id)),
      updatedNodeIds: [...nextNodeIds].filter((id) => previousNodeIds.has(id)),
      removedNodeIds: [...previousNodeIds].filter((id) => !nextNodeIds.has(id)),
      addedLinkIds: [...nextLinkIds].filter((id) => !previousLinkIds.has(id)),
      updatedLinkIds: [...nextLinkIds].filter((id) => previousLinkIds.has(id)),
      removedLinkIds: [...previousLinkIds].filter((id) => !nextLinkIds.has(id)),
      cascadedLinkIds: [...previousLinkIds].filter((id) => {
        const link = previousLinks.get(id);
        return !nextLinkIds.has(id)
          && link !== undefined
          && (!nextNodeIds.has(link.source) || !nextNodeIds.has(link.target));
      })
    });
  }

  private change(
    kind: 'set-data' | 'patch' | 'clear',
    options: Partial<GraphMutationResult> = {}
  ): GraphMutationResult {
    const freezeIds = (ids: readonly GraphId[] | undefined): readonly GraphId[] => Object.freeze([...(ids ?? [])]);
    const topologyChanged = options.topologyChanged ?? false;
    const simulationChanged = options.simulationChanged ?? false;
    const payloadChanged = options.payloadChanged ?? false;
    return Object.freeze({
      revisionBefore: options.revisionBefore ?? this.revision,
      revisionAfter: this.revision,
      revision: this.revision,
      kind,
      nodeCount: this.liveNodeCount,
      linkCount: this.liveLinkCount,
      topologyChanged,
      simulationChanged,
      payloadChanged,
      visualChanged: options.visualChanged ?? (topologyChanged || simulationChanged || payloadChanged),
      changedNodeIds: freezeIds(options.changedNodeIds),
      changedLinkIds: freezeIds(options.changedLinkIds),
      addedNodeIds: freezeIds(options.addedNodeIds),
      updatedNodeIds: freezeIds(options.updatedNodeIds),
      removedNodeIds: freezeIds(options.removedNodeIds),
      addedLinkIds: freezeIds(options.addedLinkIds),
      updatedLinkIds: freezeIds(options.updatedLinkIds),
      removedLinkIds: freezeIds(options.removedLinkIds),
      cascadedLinkIds: freezeIds(options.cascadedLinkIds),
      skippedNodeIds: freezeIds(options.skippedNodeIds),
      skippedLinkIds: freezeIds(options.skippedLinkIds),
      unchangedNodeIds: freezeIds(options.unchangedNodeIds),
      unchangedLinkIds: freezeIds(options.unchangedLinkIds),
      warnings: Object.freeze(this.warnings.map(toGraphErrorLike)),
      frameScheduled: options.frameScheduled ?? false,
      layoutRebuildScheduled: options.layoutRebuildScheduled ?? false
    });
  }

  private validateData(data: GraphData<TNode, TLink>): ValidatedData<TNode, TLink> {
    this.warnings = [];
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.links)) {
      throw new GraphError('FG_DATA_INVALID_ID', 'Graph data must contain node and link arrays.');
    }

    const nodes: GraphNode<TNode>[] = [];
    const nodeIds = new Set<GraphId>();
    for (const node of data.nodes) {
      if (!node || !isValidGraphId(node.id)) {
        this.report(new GraphError('FG_DATA_INVALID_ID', 'Each node requires a string or finite numeric id.'));
        continue;
      }
      if (nodeIds.has(node.id)) {
        this.report(new GraphError('FG_DATA_DUPLICATE_NODE_ID', `Duplicate node id '${String(node.id)}'.`, { id: node.id }));
        continue;
      }
      if (!isPartialVec3(node.initialPosition) || !isPartialVec3(node.fixed) || hasOwn(node, 'resetPosition')) {
        this.report(new GraphError('FG_DATA_INVALID_POSITION', `Node '${String(node.id)}' has a non-finite position.`, { id: node.id }));
        continue;
      }
      if (!isFloat32PartialVec3(node.initialPosition) || !isFloat32PartialVec3(node.fixed)) {
        this.report(new GraphError(
          'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
          `Node '${String(node.id)}' has a coordinate that cannot be represented as a finite Float32 value.`,
          { id: node.id }
        ));
        continue;
      }
      nodeIds.add(node.id);
      nodes.push(copyNode(node));
    }

    const links: GraphLink<TLink>[] = [];
    const linkIds = new Set<GraphId>();
    for (const link of data.links) {
      if (!link || !isValidGraphId(link.id)) {
        this.report(new GraphError('FG_DATA_INVALID_ID', 'Each link requires a string or finite numeric id.'));
        continue;
      }
      if (linkIds.has(link.id)) {
        this.report(new GraphError('FG_DATA_DUPLICATE_LINK_ID', `Duplicate link id '${String(link.id)}'.`, { id: link.id }));
        continue;
      }
      if (!nodeIds.has(link.source)) {
        this.report(new GraphError('FG_DATA_MISSING_SOURCE', `Link '${String(link.id)}' references a missing source node.`, { id: link.id, source: link.source }));
        continue;
      }
      if (!nodeIds.has(link.target)) {
        this.report(new GraphError('FG_DATA_MISSING_TARGET', `Link '${String(link.id)}' references a missing target node.`, { id: link.id, target: link.target }));
        continue;
      }
      linkIds.add(link.id);
      links.push(copyLink(link));
    }
    return {
      nodes,
      links,
      preserveExisting: data.nodes.length + data.links.length > 0
        && nodes.length === 0
        && links.length === 0
        && this.warnings.length > 0
    };
  }

  /**
   * Patch entries are validated independently before they touch the candidate
   * graph. In tolerant mode, a bad upsert therefore cannot replace a valid
   * record that already owns the same ID.
   */
  private validatePatch(patch: GraphPatch<TNode, TLink>): ValidatedPatch<TNode, TLink> {
    this.warnings = [];
    this.patchSkippedNodeIds = [];
    this.patchSkippedLinkIds = [];
    if (!isRecord(patch)) {
      this.report(new GraphError('FG_DATA_INVALID_ID', 'Graph patch must be an object.'));
      return emptyPatch();
    }
    const nodes = this.readPatchSection(patch.nodes, 'nodes');
    const links = this.readPatchSection(patch.links, 'links');
    return {
      nodeUpserts: this.validateNodePatchUpserts(this.readPatchEntries(nodes, 'nodes', 'upsert')),
      skippedNodeIds: this.patchSkippedNodeIds,
      nodeRemovals: this.validatePatchRemovals(this.readPatchEntries(nodes, 'nodes', 'remove'), 'node'),
      linkUpserts: this.validateLinkPatchUpserts(this.readPatchEntries(links, 'links', 'upsert')),
      skippedLinkIds: this.patchSkippedLinkIds,
      linkRemovals: this.validatePatchRemovals(this.readPatchEntries(links, 'links', 'remove'), 'link')
    };
  }

  private readPatchSection(value: unknown, label: string): Record<string, unknown> | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!isRecord(value) || Array.isArray(value)) {
      this.report(new GraphError('FG_DATA_INVALID_ID', `Patch '${label}' section must be an object.`));
      return undefined;
    }
    return value;
  }

  private readPatchEntries(section: Record<string, unknown> | undefined, sectionName: string, field: string): readonly unknown[] {
    const value = section?.[field];
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      this.report(new GraphError('FG_DATA_INVALID_ID', `Patch '${sectionName}.${field}' must be an array.`));
      return [];
    }
    return value;
  }

  private validateNodePatchUpserts(entries: readonly unknown[]): GraphNodePatch<TNode>[] {
    const nodes: GraphNodePatch<TNode>[] = [];
    const ids = new Set<GraphId>();
    for (const entry of entries) {
      if (!isRecord(entry) || !isValidGraphId(entry.id)) {
        this.report(new GraphError('FG_DATA_INVALID_ID', 'Each patch node upsert requires a string or finite numeric id.'));
        continue;
      }
      const node = entry as unknown as GraphNodePatch<TNode>;
      if (hasOwn(node, 'resetPosition') && node.resetPosition !== undefined && typeof node.resetPosition !== 'boolean') {
        this.report(new GraphError('FG_DATA_INVALID_POSITION', `Patch node '${String(node.id)}' has an invalid resetPosition value.`, { id: node.id }));
        this.patchSkippedNodeIds.push(node.id);
        continue;
      }
      if (ids.has(node.id)) {
        this.report(new GraphError('FG_DATA_DUPLICATE_NODE_ID', `Patch contains duplicate node id '${String(node.id)}'.`, { id: node.id }));
        this.patchSkippedNodeIds.push(node.id);
        continue;
      }
      if (!isPartialVec3(node.initialPosition) || !isPartialVec3(node.fixed, true)) {
        this.report(new GraphError('FG_DATA_INVALID_POSITION', `Patch node '${String(node.id)}' has a non-finite position.`, { id: node.id }));
        this.patchSkippedNodeIds.push(node.id);
        continue;
      }
      if (!isFloat32PartialVec3(node.initialPosition) || !isFloat32PartialVec3(node.fixed, true)) {
        this.report(new GraphError(
          'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
          `Patch node '${String(node.id)}' has a coordinate that cannot be represented as a finite Float32 value.`,
          { id: node.id }
        ));
        this.patchSkippedNodeIds.push(node.id);
        continue;
      }
      ids.add(node.id);
      nodes.push(copyNodePatch(node));
    }
    return nodes;
  }

  private validateLinkPatchUpserts(entries: readonly unknown[]): GraphLink<TLink>[] {
    const links: GraphLink<TLink>[] = [];
    const ids = new Set<GraphId>();
    for (const entry of entries) {
      if (!isRecord(entry) || !isValidGraphId(entry.id)) {
        this.report(new GraphError('FG_DATA_INVALID_ID', 'Each patch link upsert requires a string or finite numeric id.'));
        continue;
      }
      const link = entry as unknown as GraphLink<TLink>;
      if (ids.has(link.id)) {
        this.report(new GraphError('FG_DATA_DUPLICATE_LINK_ID', `Patch contains duplicate link id '${String(link.id)}'.`, { id: link.id }));
        this.patchSkippedLinkIds.push(link.id);
        continue;
      }
      if (!isValidGraphId(link.source)) {
        this.report(new GraphError('FG_DATA_MISSING_SOURCE', `Patch link '${String(link.id)}' has an invalid source id.`, { id: link.id, source: link.source }));
        this.patchSkippedLinkIds.push(link.id);
        continue;
      }
      if (!isValidGraphId(link.target)) {
        this.report(new GraphError('FG_DATA_MISSING_TARGET', `Patch link '${String(link.id)}' has an invalid target id.`, { id: link.id, target: link.target }));
        this.patchSkippedLinkIds.push(link.id);
        continue;
      }
      ids.add(link.id);
      links.push(copyLink(link));
    }
    return links;
  }

  private validatePatchRemovals(entries: readonly unknown[], label: 'node' | 'link'): GraphId[] {
    const removals: GraphId[] = [];
    const ids = new Set<GraphId>();
    for (const id of entries) {
      if (!isValidGraphId(id)) {
        this.report(new GraphError('FG_DATA_INVALID_ID', `Each patch ${label} removal requires a string or finite numeric id.`));
        continue;
      }
      if (!ids.has(id)) {
        ids.add(id);
        removals.push(id);
      }
    }
    return removals;
  }

  private report(error: GraphError): void {
    if (this.validationMode === 'strict') {
      throw error;
    }
    this.warnings.push(error);
  }

  private insertNode(node: GraphNode<TNode>): void {
    const index = this.allocateNodeSlot();
    this.ensureNodeLifecycleWritable();
    this.ensureNodeVisualWritable();
    this.ensureNodeStateWritable();
    this.nodeIndexById.set(node.id, index);
    this.nodeIds[index] = node.id;
    this.nodeRecords[index] = node;
    this.nodeAlive[index] = 1;
    this.nodeFlags[index] = NodeFlags.Visible;
    this.nodeRadii[index] = 1;
    this.nodeColors[index] = 0x71a7ff;

    this.resetNodeStateFromInput(index, node);
    this.liveNodeCount += 1;
  }

  private insertLink(link: GraphLink<TLink>): void {
    const sourceIndex = this.nodeIndexById.get(link.source);
    const targetIndex = this.nodeIndexById.get(link.target);
    if (sourceIndex === undefined) {
      throw new GraphError('FG_DATA_MISSING_SOURCE', `Validated link '${String(link.id)}' lost an endpoint.`, { id: link.id });
    }
    if (targetIndex === undefined) {
      throw new GraphError('FG_DATA_MISSING_TARGET', `Validated link '${String(link.id)}' lost an endpoint.`, { id: link.id });
    }
    const index = this.allocateLinkSlot();
    this.ensureLinkLifecycleWritable();
    this.ensureLinkEndpointsWritable();
    this.ensureLinkVisualWritable();
    this.linkIndexById.set(link.id, index);
    this.linkIds[index] = link.id;
    this.linkRecords[index] = link;
    this.linkAlive[index] = 1;
    this.linkEndpoints[index * 2] = sourceIndex;
    this.linkEndpoints[index * 2 + 1] = targetIndex;
    this.linkWidths[index] = 1;
    this.linkColors[index] = 0x8ca0c8;
    this.connectLink(link);
    this.liveLinkCount += 1;
  }

  private updateLink(index: number, link: GraphLink<TLink>): void {
    const sourceIndex = this.nodeIndexById.get(link.source);
    const targetIndex = this.nodeIndexById.get(link.target);
    if (sourceIndex === undefined) {
      throw new GraphError('FG_DATA_MISSING_SOURCE', `Validated link '${String(link.id)}' lost an endpoint.`, { id: link.id });
    }
    if (targetIndex === undefined) {
      throw new GraphError('FG_DATA_MISSING_TARGET', `Validated link '${String(link.id)}' lost an endpoint.`, { id: link.id });
    }
    this.ensureLinkEndpointsWritable();
    const previous = this.linkRecords[index];
    if (previous) {
      this.disconnectLink(previous);
    }
    this.linkRecords[index] = link;
    this.linkEndpoints[index * 2] = sourceIndex;
    this.linkEndpoints[index * 2 + 1] = targetIndex;
    this.connectLink(link);
  }

  private clearInternal(): void {
    this.ensureNodeLifecycleWritable();
    this.ensureLinkLifecycleWritable();
    for (let index = 0; index < this.nextNodeSlot; index += 1) {
      if (this.nodeAlive[index] !== 1) {
        continue;
      }
      this.nodeAlive[index] = 0;
      this.nodeIds[index] = undefined;
      this.nodeRecords[index] = undefined;
      this.nodeFlags[index] = 0;
      this.nodeFixedMask[index] = 0;
      this.nodeGenerations[index] = (this.nodeGenerations[index] ?? 0) + 1;
      this.nodeFreeSlots.push(index);
    }
    for (let index = 0; index < this.nextLinkSlot; index += 1) {
      if (this.linkAlive[index] !== 1) {
        continue;
      }
      this.linkAlive[index] = 0;
      this.linkIds[index] = undefined;
      this.linkRecords[index] = undefined;
      this.linkGenerations[index] = (this.linkGenerations[index] ?? 0) + 1;
      this.linkFreeSlots.push(index);
    }
    this.nodeIndexById.clear();
    this.linkIndexById.clear();
    this.linkIdsByNodeId.clear();
    this.liveNodeCount = 0;
    this.liveLinkCount = 0;
  }

  private resetNodeStateFromInput(index: number, node: GraphNode<TNode>): void {
    this.ensureNodeLifecycleWritable();
    this.ensureNodeStateWritable();
    const position = this.initialPositionFor(node);
    const fixedMask = this.fixedMaskFor(node.fixed);
    const fixedPosition = {
      x: node.fixed?.x ?? position.x,
      y: node.fixed?.y ?? position.y,
      z: node.fixed?.z ?? position.z
    };
    if ((fixedMask & FIXED_X) !== 0) position.x = fixedPosition.x;
    if ((fixedMask & FIXED_Y) !== 0) position.y = fixedPosition.y;
    if ((fixedMask & FIXED_Z) !== 0) position.z = fixedPosition.z;
    this.writeVec3(this.nodePositions, index, position);
    this.writeVec3(this.nodeVelocities, index, { x: 0, y: 0, z: 0 });
    this.writeVec3(this.nodeFixedPositions, index, fixedPosition);
    this.nodeFixedMask[index] = fixedMask;
    const flags = this.nodeFlags[index] ?? NodeFlags.Visible;
    this.nodeFlags[index] = fixedMask === 0 ? flags & ~NodeFlags.Pinned : flags | NodeFlags.Pinned;
  }

  private applyExistingNodePatchState(
    index: number,
    previous: GraphNode<TNode>,
    merged: GraphNode<TNode>,
    patch: GraphNodePatch<TNode>
  ): void {
    const hasFixedPatch = hasOwn(patch, 'fixed');
    if (!patch.resetPosition && !hasFixedPatch) {
      return;
    }
    this.ensureNodeLifecycleWritable();
    this.ensureNodeStateWritable();

    let position = this.readVec3(this.nodePositions, index);
    let fixedPosition = this.readVec3(this.nodeFixedPositions, index);
    let fixedMask = this.nodeFixedMask[index] ?? 0;
    if (patch.resetPosition) {
      position = this.initialPositionFor(merged);
      this.writeVec3(this.nodeVelocities, index, { x: 0, y: 0, z: 0 });
    }
    if (hasFixedPatch) {
      if (patch.fixed === null) {
        fixedMask = 0;
      } else {
        const fixed = merged.fixed;
        if (fixed?.x !== undefined) {
          fixedPosition.x = fixed.x;
          fixedMask |= FIXED_X;
          position.x = fixed.x;
        }
        if (fixed?.y !== undefined) {
          fixedPosition.y = fixed.y;
          fixedMask |= FIXED_Y;
          position.y = fixed.y;
        }
        if (fixed?.z !== undefined) {
          fixedPosition.z = fixed.z;
          fixedMask |= FIXED_Z;
          position.z = fixed.z;
        }
      }
    }
    if (patch.resetPosition && !hasFixedPatch) {
      fixedPosition = {
        x: previous.fixed?.x ?? position.x,
        y: previous.fixed?.y ?? position.y,
        z: previous.fixed?.z ?? position.z
      };
      fixedMask = this.fixedMaskFor(previous.fixed);
      if ((fixedMask & FIXED_X) !== 0) position.x = fixedPosition.x;
      if ((fixedMask & FIXED_Y) !== 0) position.y = fixedPosition.y;
      if ((fixedMask & FIXED_Z) !== 0) position.z = fixedPosition.z;
    }
    this.writeVec3(this.nodePositions, index, position);
    this.writeVec3(this.nodeFixedPositions, index, fixedPosition);
    this.nodeFixedMask[index] = fixedMask;
    const flags = this.nodeFlags[index] ?? NodeFlags.Visible;
    this.nodeFlags[index] = fixedMask === 0 ? flags & ~NodeFlags.Pinned : flags | NodeFlags.Pinned;
  }

  private removeNode(id: GraphId): void {
    const index = this.nodeIndexById.get(id);
    if (index === undefined) {
      return;
    }
    this.ensureNodeLifecycleWritable();
    this.nodeIndexById.delete(id);
    this.linkIdsByNodeId.delete(id);
    this.nodeAlive[index] = 0;
    this.nodeIds[index] = undefined;
    this.nodeRecords[index] = undefined;
    this.nodeFlags[index] = 0;
    this.nodeFixedMask[index] = 0;
    this.nodeGenerations[index] = (this.nodeGenerations[index] ?? 0) + 1;
    this.nodeFreeSlots.push(index);
    this.liveNodeCount -= 1;
  }

  private removeLink(id: GraphId): void {
    const index = this.linkIndexById.get(id);
    if (index === undefined) {
      return;
    }
    this.ensureLinkLifecycleWritable();
    const link = this.linkRecords[index];
    if (link) {
      this.disconnectLink(link);
    }
    this.linkIndexById.delete(id);
    this.linkAlive[index] = 0;
    this.linkIds[index] = undefined;
    this.linkRecords[index] = undefined;
    this.linkGenerations[index] = (this.linkGenerations[index] ?? 0) + 1;
    this.linkFreeSlots.push(index);
    this.liveLinkCount -= 1;
  }

  private connectLink(link: GraphLink<TLink>): void {
    this.linkSetForNode(link.source).add(link.id);
    this.linkSetForNode(link.target).add(link.id);
  }

  private disconnectLink(link: GraphLink<TLink>): void {
    this.removeLinkFromNode(link.source, link.id);
    this.removeLinkFromNode(link.target, link.id);
  }

  private linkSetForNode(id: GraphId): Set<GraphId> {
    const existing = this.linkIdsByNodeId.get(id);
    if (existing) {
      return existing;
    }
    const created = new Set<GraphId>();
    this.linkIdsByNodeId.set(id, created);
    return created;
  }

  private removeLinkFromNode(nodeId: GraphId, linkId: GraphId): void {
    const links = this.linkIdsByNodeId.get(nodeId);
    if (!links) {
      return;
    }
    links.delete(linkId);
    if (links.size === 0) {
      this.linkIdsByNodeId.delete(nodeId);
    }
  }

  private allocateNodeSlot(): number {
    const free = this.nodeFreeSlots.pop();
    const index = free ?? this.nextNodeSlot++;
    this.ensureNodeCapacity(index + 1);
    this.ensureNodeLifecycleWritable();
    if ((this.nodeGenerations[index] ?? 0) === 0) {
      this.nodeGenerations[index] = 1;
    }
    return index;
  }

  private allocateLinkSlot(): number {
    const free = this.linkFreeSlots.pop();
    const index = free ?? this.nextLinkSlot++;
    this.ensureLinkCapacity(index + 1);
    this.ensureLinkLifecycleWritable();
    if ((this.linkGenerations[index] ?? 0) === 0) {
      this.linkGenerations[index] = 1;
    }
    return index;
  }

  private ensureNodeCapacity(required: number): void {
    if (required <= this.nodeCapacity) {
      return;
    }
    const capacity = growCapacity(this.nodeCapacity, required);
    this.nodeIds.length = capacity;
    this.nodeRecords.length = capacity;
    this.nodeAlive = growTypedArray(this.nodeAlive, capacity);
    this.nodeGenerations = growTypedArray(this.nodeGenerations, capacity);
    this.nodeFlags = growTypedArray(this.nodeFlags, capacity);
    this.nodeFixedMask = growTypedArray(this.nodeFixedMask, capacity);
    this.nodePositions = growTypedArray(this.nodePositions, capacity * 3);
    this.nodeVelocities = growTypedArray(this.nodeVelocities, capacity * 3);
    this.nodeFixedPositions = growTypedArray(this.nodeFixedPositions, capacity * 3);
    this.nodeRadii = growTypedArray(this.nodeRadii, capacity);
    this.nodeColors = growTypedArray(this.nodeColors, capacity);
    this.nodeCapacity = capacity;
    this.sharedNodeLifecycle = false;
    this.sharedNodeState = false;
    this.sharedNodeVisual = false;
  }

  private ensureLinkCapacity(required: number): void {
    if (required <= this.linkCapacity) {
      return;
    }
    const capacity = growCapacity(this.linkCapacity, required);
    this.linkIds.length = capacity;
    this.linkRecords.length = capacity;
    this.linkAlive = growTypedArray(this.linkAlive, capacity);
    this.linkGenerations = growTypedArray(this.linkGenerations, capacity);
    this.linkEndpoints = growTypedArray(this.linkEndpoints, capacity * 2);
    this.linkWidths = growTypedArray(this.linkWidths, capacity);
    this.linkColors = growTypedArray(this.linkColors, capacity);
    this.linkCapacity = capacity;
    this.sharedLinkLifecycle = false;
    this.sharedLinkEndpoints = false;
    this.sharedLinkVisual = false;
  }

  private ensureNodeLifecycleWritable(): void {
    if (!this.copyOnWrite || !this.sharedNodeLifecycle) {
      return;
    }
    this.nodeAlive = this.nodeAlive.slice();
    this.nodeGenerations = this.nodeGenerations.slice();
    this.nodeFlags = this.nodeFlags.slice();
    this.nodeFixedMask = this.nodeFixedMask.slice();
    this.sharedNodeLifecycle = false;
  }

  private ensureNodeStateWritable(): void {
    if (!this.copyOnWrite || !this.sharedNodeState) {
      return;
    }
    this.nodePositions = this.nodePositions.slice();
    this.nodeVelocities = this.nodeVelocities.slice();
    this.nodeFixedPositions = this.nodeFixedPositions.slice();
    this.sharedNodeState = false;
  }

  private ensureNodeVisualWritable(): void {
    if (!this.copyOnWrite || !this.sharedNodeVisual) {
      return;
    }
    this.nodeRadii = this.nodeRadii.slice();
    this.nodeColors = this.nodeColors.slice();
    this.sharedNodeVisual = false;
  }

  private ensureLinkLifecycleWritable(): void {
    if (!this.copyOnWrite || !this.sharedLinkLifecycle) {
      return;
    }
    this.linkAlive = this.linkAlive.slice();
    this.linkGenerations = this.linkGenerations.slice();
    this.sharedLinkLifecycle = false;
  }

  private ensureLinkEndpointsWritable(): void {
    if (!this.copyOnWrite || !this.sharedLinkEndpoints) {
      return;
    }
    this.linkEndpoints = this.linkEndpoints.slice();
    this.sharedLinkEndpoints = false;
  }

  private ensureLinkVisualWritable(): void {
    if (!this.copyOnWrite || !this.sharedLinkVisual) {
      return;
    }
    this.linkWidths = this.linkWidths.slice();
    this.linkColors = this.linkColors.slice();
    this.sharedLinkVisual = false;
  }

  private initialPositionFor(node: GraphNode<TNode>): Vec3 {
    return {
      x: node.initialPosition?.x ?? deterministicCoordinate(this.seed, node.id, 0),
      y: node.initialPosition?.y ?? deterministicCoordinate(this.seed, node.id, 1),
      z: node.initialPosition?.z ?? deterministicCoordinate(this.seed, node.id, 2)
    };
  }

  private fixedMaskFor(position: Readonly<Partial<Vec3>> | null | undefined): number {
    let mask = 0;
    if (position?.x !== undefined) mask |= FIXED_X;
    if (position?.y !== undefined) mask |= FIXED_Y;
    if (position?.z !== undefined) mask |= FIXED_Z;
    return mask;
  }

  private readVec3(array: Float32Array, index: number): Vec3 {
    const base = index * 3;
    return {
      x: array[base] ?? 0,
      y: array[base + 1] ?? 0,
      z: array[base + 2] ?? 0
    };
  }

  private writeVec3(array: Float32Array, index: number, value: Vec3): void {
    const base = index * 3;
    const x = Math.fround(value.x);
    const y = Math.fround(value.y);
    const z = Math.fround(value.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new GraphError(
        'FG_LAYOUT_BUFFER_PROTOCOL_FAILED',
        'Graph coordinates must remain representable as finite Float32 values.',
        { x: value.x, y: value.y, z: value.z }
      );
    }
    array[base] = x;
    array[base + 1] = y;
    array[base + 2] = z;
  }
}

function copyNode<TData>(node: GraphNodeInput<TData> | GraphNodePatch<TData>): GraphNodeInput<TData> {
  const initialPosition = node.initialPosition === undefined
    ? undefined
    : copyPartialVec3(node.initialPosition) as Readonly<Partial<Vec3>>;
  const fixed = node.fixed === null
    ? undefined
    : copyPartialVec3(node.fixed) as Readonly<Partial<Vec3>> | undefined;
  return Object.freeze({
    id: node.id,
    ...(node.data === undefined ? {} : { data: node.data }),
    ...(initialPosition === undefined ? {} : { initialPosition }),
    ...(fixed === undefined ? {} : { fixed })
  });
}

function copyNodePatch<TData>(node: GraphNodePatch<TData>): GraphNodePatch<TData> {
  return Object.freeze({
    id: node.id,
    ...(node.data === undefined ? {} : { data: node.data }),
    ...(node.initialPosition === undefined ? {} : { initialPosition: copyPartialVec3(node.initialPosition) as Readonly<Partial<Vec3>> }),
    ...(node.fixed === undefined ? {} : { fixed: node.fixed === null ? null : copyPartialVec3(node.fixed) as Readonly<Partial<Vec3>> }),
    ...(node.resetPosition === undefined ? {} : { resetPosition: node.resetPosition })
  });
}

function copyLink<TData>(link: GraphLink<TData>): GraphLink<TData> {
  return Object.freeze({
    id: link.id,
    source: link.source,
    target: link.target,
    ...(link.data === undefined ? {} : { data: link.data })
  });
}

function copyPartialVec3(value: Readonly<Partial<Vec3>> | null | undefined): Readonly<Partial<Vec3>> | null | undefined {
  if (value === null) {
    return null;
  }
  if (!value) {
    return undefined;
  }
  return Object.freeze({
    ...(value.x === undefined ? {} : { x: value.x }),
    ...(value.y === undefined ? {} : { y: value.y }),
    ...(value.z === undefined ? {} : { z: value.z })
  });
}

function mergeNodePatch<TData>(previous: GraphNodeInput<TData>, patch: GraphNodePatch<TData>): GraphNodeInput<TData> {
  const nextInitial = hasOwn(patch, 'initialPosition')
    ? mergePartialVec3(previous.initialPosition, patch.initialPosition)
    : previous.initialPosition;
  const nextFixed = hasOwn(patch, 'fixed')
    ? patch.fixed === null
      ? undefined
      : mergePartialVec3(previous.fixed, patch.fixed)
    : previous.fixed;
  return copyNode({
    id: patch.id,
    ...(hasOwn(patch, 'data') ? { data: patch.data } : hasOwn(previous, 'data') ? { data: previous.data } : {}),
    ...(nextInitial === undefined ? {} : { initialPosition: nextInitial }),
    ...(nextFixed === undefined ? {} : { fixed: nextFixed })
  });
}

function mergePartialVec3(
  previous: Readonly<Partial<Vec3>> | undefined,
  next: Readonly<Partial<Vec3>> | null | undefined
): Readonly<Partial<Vec3>> | undefined {
  if (next === null) {
    return undefined;
  }
  const merged = copyPartialVec3({
    ...(previous ?? {}),
    ...(next ?? {})
  });
  return merged === null ? undefined : merged;
}

function sameNodeRecord<TData>(first: GraphNode<TData>, second: GraphNode<TData>): boolean {
  return Object.is(first.data, second.data)
    && samePartialVec3(first.initialPosition, second.initialPosition)
    && samePartialVec3(first.fixed, second.fixed);
}

function sameLinkRecord<TData>(first: GraphLink<TData>, second: GraphLink<TData>): boolean {
  return first.source === second.source
    && first.target === second.target
    && Object.is(first.data, second.data);
}

function samePartialVec3(
  first: Readonly<Partial<Vec3>> | null | undefined,
  second: Readonly<Partial<Vec3>> | null | undefined
): boolean {
  return (first?.x ?? undefined) === (second?.x ?? undefined)
    && (first?.y ?? undefined) === (second?.y ?? undefined)
    && (first?.z ?? undefined) === (second?.z ?? undefined)
    && (first === null) === (second === null);
}

function classifyPatchIds<TNode, TLink>(
  beforeNodeIds: ReadonlySet<GraphId>,
  beforeLinkIds: ReadonlySet<GraphId>,
  patch: ValidatedPatch<TNode, TLink>,
  nodeIndexById: ReadonlyMap<GraphId, number>,
  linkIndexById: ReadonlyMap<GraphId, number>,
  changedNodeIds: ReadonlySet<GraphId>,
  changedLinkIds: ReadonlySet<GraphId>
): Pick<GraphMutationResult, 'addedNodeIds' | 'updatedNodeIds' | 'removedNodeIds' | 'addedLinkIds' | 'updatedLinkIds' | 'removedLinkIds' | 'skippedNodeIds' | 'skippedLinkIds' | 'unchangedNodeIds' | 'unchangedLinkIds'> {
  const nodeUpsertIds = new Set(patch.nodeUpserts.map((node) => node.id));
  const linkUpsertIds = new Set(patch.linkUpserts.map((link) => link.id));
  const afterNode = (id: GraphId): boolean => nodeIndexById.has(id);
  const afterLink = (id: GraphId): boolean => linkIndexById.has(id);
  return {
    addedNodeIds: [...nodeUpsertIds].filter((id) => !beforeNodeIds.has(id) && afterNode(id)),
    updatedNodeIds: [...nodeUpsertIds].filter((id) => beforeNodeIds.has(id) && afterNode(id) && changedNodeIds.has(id)),
    removedNodeIds: patch.nodeRemovals.filter((id) => beforeNodeIds.has(id) && !afterNode(id)),
    addedLinkIds: [...linkUpsertIds].filter((id) => !beforeLinkIds.has(id) && afterLink(id)),
    updatedLinkIds: [...linkUpsertIds].filter((id) => beforeLinkIds.has(id) && afterLink(id) && changedLinkIds.has(id)),
    removedLinkIds: patch.linkRemovals.filter((id) => beforeLinkIds.has(id) && !afterLink(id)),
    skippedNodeIds: [...new Set([...patch.skippedNodeIds, ...patch.nodeRemovals.filter((id) => !beforeNodeIds.has(id))])],
    skippedLinkIds: [...new Set([...patch.skippedLinkIds, ...patch.linkRemovals.filter((id) => !beforeLinkIds.has(id))])],
    unchangedNodeIds: [...nodeUpsertIds].filter((id) => beforeNodeIds.has(id) && afterNode(id) && !changedNodeIds.has(id)),
    unchangedLinkIds: [...linkUpsertIds].filter((id) => beforeLinkIds.has(id) && afterLink(id) && !changedLinkIds.has(id))
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function toGraphErrorLike(error: GraphError): GraphErrorLike {
  return Object.freeze({
    name: error.name,
    code: error.code,
    message: error.message,
    context: freezeJsonValue(toJsonSafe(error.context)) as Readonly<Record<string, unknown>>
  });
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (value === undefined) {
    return null;
  }
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.code === 'string' ? { code: error.code } : {})
    };
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => toJsonSafe(entry, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = toJsonSafe(entry, seen);
    }
    return result;
  } finally {
    // Only objects on the active traversal path are circular. Reusing the
    // same object in separate branches must remain a repeated value.
    seen.delete(value);
  }
}

function freezeJsonValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    freezeJsonValue(child);
  }
  return Object.freeze(value);
}

function isValidGraphId(value: unknown): value is GraphId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function emptyPatch<TNode, TLink>(): ValidatedPatch<TNode, TLink> {
  return {
    nodeUpserts: [],
    skippedNodeIds: [],
    nodeRemovals: [],
    linkUpserts: [],
    skippedLinkIds: [],
    linkRemovals: []
  };
}

function isPartialVec3(value: unknown, allowNull = false): value is Partial<Vec3> | null | undefined {
  if (value === undefined) {
    return true;
  }
  if (value === null) {
    return allowNull;
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<Vec3>;
  return (candidate.x === undefined || Number.isFinite(candidate.x))
    && (candidate.y === undefined || Number.isFinite(candidate.y))
    && (candidate.z === undefined || Number.isFinite(candidate.z));
}

function isFloat32PartialVec3(value: Readonly<Partial<Vec3>> | null | undefined, allowNull = false): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === null) {
    return allowNull;
  }
  return (value.x === undefined || Number.isFinite(Math.fround(value.x)))
    && (value.y === undefined || Number.isFinite(Math.fround(value.y)))
    && (value.z === undefined || Number.isFinite(Math.fround(value.z)));
}

function isFiniteVec3(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function deterministicCoordinate(seed: number, id: GraphId, axis: number): number {
  const input = `${seed}|${typeof id}|${String(id)}|${axis}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  return (((hash >>> 0) / 0xffffffff) - 0.5) * 50;
}

function normalizeColor(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(0xffffff, Math.trunc(value))) >>> 0;
}

function growCapacity(current: number, required: number): number {
  let next = Math.max(4, current);
  while (next < required) {
    next *= 2;
  }
  return next;
}

/** Avoids exceeding the JavaScript call-argument limit on large free-slot pools. */
function appendValues<T>(target: T[], values: readonly T[]): void {
  for (const value of values) {
    target.push(value);
  }
}

function growTypedArray<T extends Float32Array | Uint8Array | Uint32Array>(source: T, length: number): T {
  const target = new (source.constructor as { new(length: number): T })(length);
  target.set(source);
  return target;
}
