import { GraphError } from '../core/errors.js';
import {
  type GpuIdPickRequest,
  type GraphId,
  type LinkFlowOptions,
  type NodeStateTheme,
  type NodeSurfaceOptions,
  type RendererPickingOptions,
  type Vec3
} from '../core/types.js';
import type { GraphStore } from '../data/GraphStore.js';
import type { ThreePlatform } from '../platform/three/createThreePlatform.js';
import {
  createLinkAttributes,
  createNodeAttributes,
  createTslTransformDefinition,
  markAttributeNeedsUpdate,
  writeColorAttribute,
  writeScalarAttribute,
  type LinkAttributeSet,
  type NodeAttributeSet,
  type NumericAttribute,
  type TslTransformDefinition
} from './TslGraphLayers.js';
import {
  GraphPickingState,
  OwnedRenderLayer,
  disposeRenderLayerResources,
  type LinkLayerResources,
  type NodeLayerResources
} from './RenderLayerResources.js';
import { SpatialPickingIndex } from './SpatialPickingIndex.js';
import {
  clearGraphAttributes,
  createGraphLayerMesh,
  createLinkGeometry,
  createNodeGeometry,
  setGraphLayerInstanceCount
} from './InstancedGraphLayers.js';
import {
  DEFAULT_POSITION_ATLAS_MAX_HEIGHT,
  DEFAULT_POSITION_ATLAS_WIDTH,
  POSITION_ATLAS_ENTRY_BYTES,
  createPositionAtlas,
  disposePositionAtlas,
  writePositionAtlas,
  type PositionAtlasResources
} from './PositionAtlas.js';
import { mergeNodeStateTheme, resolveIncidentLinkVisual, resolveNodeVisual } from './StateAppearance.js';

type ThreeObject = Record<string, unknown>;
type ThreeConstructor = new (...args: unknown[]) => object;

export interface RenderStats {
  nodeCount: number;
  linkCount: number;
  drawCalls: number;
  triangleCount: number;
  gpuBufferBytes: number;
  positionAtlasAllocationBytes: number;
  positionAtlasLogicalWriteBytes: number;
  positionAtlasUploadRequestedBytes: number;
  positionAtlasWidth: number;
  positionAtlasMaxHeight: number;
  positionAtlasMaxNodeCapacity: number;
  deviceMaxTextureSize: number | undefined;
  topologyLogicalWriteBytes: number;
  styleLogicalWriteBytes: number;
  instanceMatrixAllocationBytes: number;
  positionSyncRevision: number;
  topologySyncRevision: number;
  styleSyncRevision: number;
  cameraRevision: number;
  /** Monotonic invalidation revision for spatial and asynchronous GPU-ID picking. */
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
  nodeMatrixWrites: number;
  linkMatrixWrites: number;
  nodeAttributeWrites: number;
  linkAttributeWrites: number;
  linkFlowEnabled: boolean;
  linkFlowTimeSeconds: number;
  nodeSurfaceAnimating: boolean;
  nodeSurfaceTimeSeconds: number;
  nodeDynamicOpacityRequested: boolean;
  nodeDynamicOpacitySelected: boolean;
  linkDynamicOpacityRequested: boolean;
  linkDynamicOpacitySelected: boolean;
  completeSyncs: number;
  partialUpdateRanges: number;
  skippedSyncPasses: number;
  pickingMode: 'raycast' | 'spatial' | 'gpu-id';
  pickCandidateCount: number;
  pickScannedCellCount: number;
  pickOrdinaryCandidateCount: number;
  pickOversizedCandidateCount: number;
}

export interface RenderSyncRequest {
  readonly full?: boolean;
  readonly positions?: boolean;
  /** Monotonic layout position revision used to ignore redundant invalidations. */
  readonly positionRevision?: number;
  /** Recomputes CPU picking and incident-link attributes after shared TSL theme uniforms change. */
  readonly themeDerived?: boolean;
  readonly nodeStateIds?: Iterable<GraphId>;
  readonly linkStyleIds?: Iterable<GraphId>;
  /** Links whose endpoint radii changed through a node visual state or style update. */
  readonly linkEndpointRadiusIds?: Iterable<GraphId>;
}

interface MaterialBinding {
  readonly material: ThreeObject;
  readonly usesTransform: boolean;
  readonly usesTslColor: boolean;
  readonly usesDynamicOpacity: boolean;
  setOpacity(opacity: number | undefined): void;
}

interface TslMaterialInputs {
  readonly opacityInput: ThreeObject;
  readonly usesTslColor: boolean;
  readonly usesDynamicOpacity: boolean;
}

interface CapacityPlan {
  readonly node: NodeLayerResources | undefined;
  readonly link: LinkLayerResources | undefined;
  readonly positionAtlas: PositionAtlasPlan | undefined;
  committed: boolean;
}

interface RenderTarget {
  readonly node: NodeLayerResources;
  readonly link: LinkLayerResources;
  readonly positionAtlas: PositionAtlasResources | undefined;
}

interface PositionAtlasPlan {
  readonly next: PositionAtlasResources;
  committed: boolean;
}

interface RenderPopulation {
  readonly nodeInstanceIds: Array<GraphId | undefined>;
  readonly nodePickPositions: Array<Vec3 | undefined>;
  readonly nodePickRadii: number[];
  readonly nodePickable: boolean[];
  readonly nodeInstanceByStoreIndex: Array<number | undefined>;
  readonly linkInstanceByStoreIndex: Array<number | undefined>;
  readonly renderedNodes: number;
  readonly renderedLinks: number;
}

interface RendererWriteStats {
  readonly nodeMatrixWrites: number;
  readonly linkMatrixWrites: number;
  readonly nodeAttributeWrites: number;
  readonly linkAttributeWrites: number;
  readonly topologyLogicalWriteBytes: number;
  readonly positionAtlasLogicalWriteBytes: number;
  readonly positionAtlasUploadRequestedBytes: number;
  readonly styleLogicalWriteBytes: number;
  readonly partialUpdateRanges: number;
}

interface NodeWriteChannels {
  readonly position: boolean;
  readonly radius: boolean;
  readonly color: boolean;
  readonly state?: boolean;
}

interface LinkWriteChannels {
  readonly endpoints: boolean;
  readonly radii: boolean;
  readonly width: boolean;
  readonly color: boolean;
}

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

interface CameraFrame {
  valid: boolean;
  readonly right: MutableVec3;
  readonly up: MutableVec3;
  readonly backward: MutableVec3;
  readonly position: MutableVec3;
  projection: MatrixElements | undefined;
}

type MatrixElements = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

/**
 * The default Three adapter owns exactly one group plus one shared node layer
 * and one shared link layer. It uses camera-facing disc and ribbon transforms
 * without creating a Three object per graph item.
 */
export class ThreeGraphRenderer<TNode = unknown, TLink = unknown> {
  readonly object3D!: ThreeObject;
  private readonly THREE: ThreeObject;
  private readonly nodeMaterial!: MaterialBinding;
  private readonly linkMaterial!: MaterialBinding;
  private readonly nodeMatrix!: ThreeObject;
  private readonly linkMatrix!: ThreeObject;
  private readonly colorScratch!: ThreeObject | undefined;
  private readonly cameraFrame = createCameraFrame();
  private readonly nodeTriangleCount!: number;
  private readonly transformPath!: 'tsl' | 'cpu';
  private readonly widthUnitRequested: 'world' | 'pixel';
  private readonly widthUnitSelected!: 'world' | 'pixel';
  private readonly maxPositionAtlasHeight: number;
  private readonly positionAtlasWidth: number;
  private readonly deviceMaxTextureSize: number | undefined;
  private readonly pickingOptions: RendererPickingOptions;
  private readonly spatialPicking: SpatialPickingIndex;
  private stateTheme: NodeStateTheme;
  private stateThemeBinding: TslTransformDefinition['stateTheme'] | undefined;
  private nodeSurface: NodeSurfaceOptions | undefined;
  private nodeSurfaceBinding: TslTransformDefinition['nodeSurface'] | undefined;
  private readonly nodeSelectionEffectCapable: boolean;
  private nodeSurfaceTimeSeconds = 0;
  private linkFlow: LinkFlowOptions | undefined;
  private linkFlowBinding: TslTransformDefinition['linkFlow'] | undefined;
  private linkFlowTimeSeconds = 0;
  private positionAtlasNode: ThreeObject | undefined;
  private positionAtlas: PositionAtlasResources | undefined;
  private readonly nodeLayer!: OwnedRenderLayer<NodeAttributeSet>;
  private readonly linkLayer!: OwnedRenderLayer<LinkAttributeSet>;
  private readonly picking = new GraphPickingState();
  private renderedNodes = 0;
  private renderedLinks = 0;
  private nodeMatrixWrites = 0;
  private linkMatrixWrites = 0;
  private nodeAttributeWrites = 0;
  private linkAttributeWrites = 0;
  private topologyLogicalWriteBytes = 0;
  private positionAtlasLogicalWriteBytes = 0;
  private positionAtlasUploadRequestedBytes = 0;
  private styleLogicalWriteBytes = 0;
  private positionSyncRevision = 0;
  private topologySyncRevision = 0;
  private styleSyncRevision = 0;
  private cameraRevision = 0;
  private pickingRevision = 0;
  private themeDerivedDirty = false;
  private lastPositionRevision: number | undefined;
  private completeSyncs = 0;
  private partialUpdateRanges = 0;
  private skippedSyncPasses = 0;
  private lastPickCandidateCount = 0;
  private lastPickScannedCellCount = 0;
  private lastPickOrdinaryCandidateCount = 0;
  private lastPickOversizedCandidateCount = 0;
  private disposed = false;

  constructor(
    platform: ThreePlatform,
    linkOpacity = 0.55,
    linkWidthUnit: 'world' | 'pixel' = 'world',
    maxPositionAtlasHeight?: number,
    pickingOptions: RendererPickingOptions = {},
    stateTheme: NodeStateTheme | undefined = undefined,
    nodeSurface: NodeSurfaceOptions | undefined = undefined,
    deviceMaxTextureSize: number | undefined = undefined,
    linkFlow: LinkFlowOptions | undefined = undefined
  ) {
    this.widthUnitRequested = linkWidthUnit;
    this.deviceMaxTextureSize = deviceMaxTextureSize;
    this.positionAtlasWidth = Math.min(DEFAULT_POSITION_ATLAS_WIDTH, deviceMaxTextureSize ?? DEFAULT_POSITION_ATLAS_WIDTH);
    this.maxPositionAtlasHeight = Math.min(
      maxPositionAtlasHeight ?? deviceMaxTextureSize ?? DEFAULT_POSITION_ATLAS_MAX_HEIGHT,
      deviceMaxTextureSize ?? Number.MAX_SAFE_INTEGER
    );
    this.pickingOptions = pickingOptions;
    this.spatialPicking = new SpatialPickingIndex(pickingOptions.spatialCellSize ?? 48);
    this.stateTheme = mergeNodeStateTheme(stateTheme);
    this.nodeSurface = nodeSurface;
    this.linkFlow = linkFlow;
    this.THREE = platform.THREE;
    let object3D: ThreeObject | undefined;
    let nodeGeometry: ThreeObject | undefined;
    let linkGeometry: ThreeObject | undefined;
    let nodeMaterial: MaterialBinding | undefined;
    let linkMaterial: MaterialBinding | undefined;
    let nodeMesh: ThreeObject | undefined;
    let linkMesh: ThreeObject | undefined;
    let nodeAttributes: NodeAttributeSet | undefined;
    let linkAttributes: LinkAttributeSet | undefined;
    let positionAtlas: PositionAtlasResources | undefined;
    try {
      object3D = construct(this.THREE.Group);
      nodeGeometry = createNodeGeometry(this.THREE);
      this.nodeTriangleCount = asConstructor(this.THREE.CircleGeometry) ? 16 : 2;
      linkGeometry = createLinkGeometry(this.THREE);
      positionAtlas = createPositionAtlas(this.THREE, 1, this.maxPositionAtlasHeight, this.positionAtlasWidth);
      const tslTransform = positionAtlas
        ? createTslTransformDefinition(platform.TSL, linkWidthUnit, positionAtlas, this.stateTheme, nodeSurface, linkFlow)
        : undefined;
      if (!tslTransform) {
        disposePositionAtlas(positionAtlas);
        positionAtlas = undefined;
      }
      let transformPath: 'tsl' | 'cpu' = tslTransform ? 'tsl' : 'cpu';
      if (tslTransform) {
        nodeAttributes = createNodeAttributes(this.THREE, nodeGeometry, 1, linkFlow !== undefined);
        linkAttributes = createLinkAttributes(this.THREE, linkGeometry, 1);
        if (!nodeAttributes || !linkAttributes) {
          transformPath = 'cpu';
          clearGraphAttributes(nodeGeometry, linkGeometry);
        }
      }
      nodeMaterial = createNodeMaterial(platform, 1, tslTransform && transformPath === 'tsl'
        ? {
            positionNode: tslTransform.nodePosition,
            colorNode: tslTransform.nodeColor,
            ...(tslTransform.nodeOpacity === undefined ? {} : { opacityNode: tslTransform.nodeOpacity })
          }
        : undefined);
      linkMaterial = createNodeMaterial(platform, linkOpacity, tslTransform && transformPath === 'tsl'
        ? {
            positionNode: tslTransform.linkPosition,
            colorNode: tslTransform.linkColor,
            ...(tslTransform.linkOpacity === undefined ? {} : { opacityNode: tslTransform.linkOpacity })
          }
        : undefined);
      if (transformPath === 'tsl'
        && (!nodeMaterial.usesTransform
          || !nodeMaterial.usesTslColor
          || !linkMaterial.usesTransform
          || !linkMaterial.usesTslColor)) {
        transformPath = 'cpu';
        disposePositionAtlas(positionAtlas);
        positionAtlas = undefined;
        clearGraphAttributes(nodeGeometry, linkGeometry);
        nodeAttributes = undefined;
        linkAttributes = undefined;
        call(nodeMaterial.material, 'dispose');
        call(linkMaterial.material, 'dispose');
        nodeMaterial = createNodeMaterial(platform, 1, undefined);
        linkMaterial = createNodeMaterial(platform, linkOpacity, undefined);
      }
      if (linkWidthUnit === 'pixel' && transformPath !== 'tsl') {
        throw new GraphError(
          'FG_RENDER_CAPABILITY_UNAVAILABLE',
          'Pixel link widths require a validated TSL transform path; the injected renderer cannot provide one.'
        );
      }
      if (nodeSurface?.profile === 'metallic' && (transformPath !== 'tsl' || !tslTransform?.nodeSurface)) {
        throw new GraphError(
          'FG_RENDER_CAPABILITY_UNAVAILABLE',
          'The metallic node surface requires a validated TSL node-material transform path.'
        );
      }
      if (nodeSurface?.selectionEffect !== undefined
        && (transformPath !== 'tsl'
          || tslTransform?.nodeOpacity === undefined
          || !nodeMaterial.usesDynamicOpacity)) {
        throw new GraphError(
          'FG_RENDER_CAPABILITY_UNAVAILABLE',
          'The selected-node surface effect requires a validated TSL node-material opacity path.'
        );
      }
      if (linkFlow !== undefined
        && (transformPath !== 'tsl'
          || !tslTransform?.linkFlow
          || !linkMaterial.usesDynamicOpacity)) {
        throw new GraphError(
          'FG_RENDER_CAPABILITY_UNAVAILABLE',
          'Directional link flow requires a validated TSL node-material transform path.'
        );
      }
      this.transformPath = transformPath;
      this.widthUnitSelected = transformPath === 'tsl' ? linkWidthUnit : 'world';
      this.positionAtlas = transformPath === 'tsl' ? positionAtlas : undefined;
      this.positionAtlasNode = transformPath === 'tsl' ? tslTransform?.positionAtlasNode : undefined;
      this.stateThemeBinding = transformPath === 'tsl' ? tslTransform?.stateTheme : undefined;
      this.nodeSurfaceBinding = transformPath === 'tsl' ? tslTransform?.nodeSurface : undefined;
      this.nodeSelectionEffectCapable = transformPath === 'tsl'
        && tslTransform?.nodeOpacity !== undefined
        && nodeMaterial.usesDynamicOpacity;
      this.linkFlowBinding = transformPath === 'tsl' ? tslTransform?.linkFlow : undefined;
      this.nodeMaterial = nodeMaterial;
      this.linkMaterial = linkMaterial;
      this.nodeMatrix = createMatrix(this.THREE);
      this.linkMatrix = createMatrix(this.THREE);
      this.colorScratch = createColor(this.THREE);
      nodeMesh = createGraphLayerMesh(this.THREE, nodeGeometry, nodeMaterial.material, 1, transformPath);
      linkMesh = createGraphLayerMesh(this.THREE, linkGeometry, linkMaterial.material, 1, transformPath);
      call(object3D, 'add', linkMesh);
      call(object3D, 'add', nodeMesh);
      this.object3D = object3D;
      this.nodeLayer = new OwnedRenderLayer({
        geometry: nodeGeometry,
        mesh: nodeMesh,
        attributes: transformPath === 'tsl' ? nodeAttributes : undefined,
        capacity: 1
      });
      this.linkLayer = new OwnedRenderLayer({
        geometry: linkGeometry,
        mesh: linkMesh,
        attributes: transformPath === 'tsl' ? linkAttributes : undefined,
        capacity: 1
      });
    } catch (error) {
      call(nodeMesh, 'dispose');
      call(linkMesh, 'dispose');
      call(nodeMaterial?.material, 'dispose');
      call(linkMaterial?.material, 'dispose');
      call(nodeGeometry, 'dispose');
      call(linkGeometry, 'dispose');
      disposePositionAtlas(positionAtlas);
      throw error;
    }
  }

  syncData(store: GraphStore<TNode, TLink>, camera?: ThreeObject): void {
    this.assertActive();
    if (readCameraFrame(this.cameraFrame, camera)) {
      this.cameraRevision += 1;
    }
    this.syncDataContent(store);
  }

  /** Rebuilds owned layer buffers at current graph size after a temporary capacity peak. */
  compact(store: GraphStore<TNode, TLink>, camera?: ThreeObject): boolean {
    this.assertActive();
    if (readCameraFrame(this.cameraFrame, camera)) {
      this.cameraRevision += 1;
    }
    if (Math.max(1, store.nodeCount) >= this.nodeLayer.capacity && Math.max(1, store.linkCount) >= this.linkLayer.capacity) {
      return false;
    }
    this.syncDataContent(store, true);
    return true;
  }

  /** Replaces appearance rules without changing topology, picking ownership, or material allocation. */
  setStateTheme(theme: NodeStateTheme | undefined): boolean {
    this.assertActive();
    this.stateTheme = mergeNodeStateTheme(theme);
    this.stateThemeBinding?.update(this.stateTheme);
    this.themeDerivedDirty = true;
    this.invalidatePicking();
    return this.transformPath === 'tsl' && this.stateThemeBinding !== undefined;
  }

  /** Replaces shared node-surface uniforms without changing layer ownership or draw count. */
  setNodeSurface(surface: NodeSurfaceOptions | undefined): boolean {
    this.assertActive();
    const next = surface === undefined ? undefined : {
      ...this.nodeSurface,
      ...surface,
      ...(surface.selectionEffect === undefined && this.nodeSurface?.selectionEffect === undefined
        ? {}
        : { selectionEffect: { ...this.nodeSurface?.selectionEffect, ...surface.selectionEffect } })
    };
    if (next?.profile === 'metallic' && !this.nodeSurfaceBinding) {
      throw new GraphError(
        'FG_RENDER_CAPABILITY_UNAVAILABLE',
        'The metallic node surface requires a validated TSL node-material transform path.'
      );
    }
    if (next?.selectionEffect !== undefined && !this.nodeSelectionEffectCapable) {
      throw new GraphError(
        'FG_RENDER_CAPABILITY_UNAVAILABLE',
        'The selected-node surface effect must be configured at graph creation on a validated TSL path.'
      );
    }
    this.nodeSurface = next;
    this.nodeSurfaceBinding?.update(next);
    return this.transformPath === 'tsl' && this.nodeSurfaceBinding !== undefined;
  }

  /** Advances the shared selected-node surface clock without rewriting graph buffers. */
  advanceNodeSurface(deltaSeconds: number): boolean {
    this.assertActive();
    if (!this.nodeSurfaceAnimating || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      return false;
    }
    this.nodeSurfaceTimeSeconds = (this.nodeSurfaceTimeSeconds + deltaSeconds) % 3_600;
    this.nodeSurfaceBinding?.setTime(this.nodeSurfaceTimeSeconds);
    return true;
  }

  get nodeSurfaceAnimating(): boolean {
    const effect = this.nodeSurface?.selectionEffect;
    return effect !== undefined
      && effect.enabled !== false
      && (effect.breathAmount ?? 0.015) > 0
      && (effect.breathSpeed ?? 2.1) > 0;
  }

  /** Updates the configured shared link-flow uniforms without touching link instances. */
  setLinkFlow(flow: LinkFlowOptions | undefined): boolean {
    this.assertActive();
    if (flow !== undefined && !this.linkFlowBinding) {
      throw new GraphError(
        'FG_RENDER_CAPABILITY_UNAVAILABLE',
        'Directional link flow must be configured at graph creation on a validated TSL path.'
      );
    }
    this.linkFlow = flow;
    this.linkFlowBinding?.update(flow);
    return this.linkFlowEnabled;
  }

  /** Advances one wrapped shader clock; no graph buffer or per-link value is rewritten. */
  advanceLinkFlow(deltaSeconds: number): boolean {
    this.assertActive();
    if (!this.linkFlowAnimating || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      return false;
    }
    this.linkFlowTimeSeconds = (this.linkFlowTimeSeconds + deltaSeconds) % 3_600;
    this.linkFlowBinding?.setTime(this.linkFlowTimeSeconds);
    return true;
  }

  get linkFlowAnimating(): boolean {
    return this.linkFlowEnabled && (this.linkFlow?.speed ?? 0.45) > 0;
  }

  private get linkFlowEnabled(): boolean {
    if (this.linkFlow === undefined || this.linkFlow.enabled === false) {
      return false;
    }
    const reaction = this.linkFlow.nodeReaction;
    const reactionVisible = reaction !== undefined
      && reaction.enabled !== false
      && ((reaction.scale ?? 1.32) > 1 || (reaction.intensity ?? 0.72) > 0);
    return (this.linkFlow.intensity ?? 0.92) > 0 || reactionVisible;
  }

  /** Invalidates pending asynchronous picking before the next render synchronization. */
  invalidatePicking(): void {
    this.pickingRevision += 1;
    this.lastPickCandidateCount = 0;
    this.lastPickScannedCellCount = 0;
    this.lastPickOrdinaryCandidateCount = 0;
    this.lastPickOversizedCandidateCount = 0;
  }

  /** Consumes controller dirty channels once and avoids idle whole-graph writes. */
  syncFrame(store: GraphStore<TNode, TLink>, camera: ThreeObject | undefined, request: RenderSyncRequest = {}): void {
    this.assertActive();
    const cameraChanged = readCameraFrame(this.cameraFrame, camera);
    if (cameraChanged) {
      this.cameraRevision += 1;
    }
    const full = request.full === true;
    // TSL reads the camera in the shader, so camera motion does not require
    // rewriting graph attributes. CPU billboards still bake the camera basis
    // into every instance matrix and therefore need a complete pass.
    const positionsChanged = request.positions === true
      && (request.positionRevision === undefined || request.positionRevision !== this.lastPositionRevision);
    const complete = full || positionsChanged || (cameraChanged && this.transformPath === 'cpu');
    if (full) {
      this.syncDataContent(store);
      this.lastPositionRevision = request.positionRevision;
    } else if (complete) {
      // A complete position pass must also consume visual dirty IDs. The
      // controller clears those IDs only after this call succeeds, so a
      // renderer failure remains retryable with the same immutable request.
      this.syncPositionsContent(store, request.nodeStateIds, request.linkStyleIds, request.linkEndpointRadiusIds);
      if (positionsChanged) {
        this.lastPositionRevision = request.positionRevision;
      }
    } else {
      this.skippedSyncPasses += 1;
    }
    if (!complete) {
      if (request.nodeStateIds !== undefined) {
        this.syncNodeStatesContent(store, request.nodeStateIds);
      }
      if (request.linkStyleIds !== undefined) {
        this.syncLinkStylesContent(store, request.linkStyleIds);
      }
      if (request.linkEndpointRadiusIds !== undefined) {
        this.syncLinkEndpointRadiiContent(store, request.linkEndpointRadiusIds);
      }
    }
    if (!full && request.themeDerived === true) {
      this.syncThemeDerivedContent(store);
    }
  }

  /** Keeps CPU picking and link visibility aligned with shader-resolved state appearances. */
  private syncThemeDerivedContent(store: GraphStore<TNode, TLink>): void {
    const target = this.renderTarget();
    const updatedLinks = new Set<number>();
    let missingMapping = false;
    store.forEachNode((storeIndex) => {
      const state = store.getNodeRenderState(storeIndex);
      const instance = this.picking.nodeInstancesByStoreIndex[storeIndex];
      if (!state || instance === undefined) {
        missingMapping = true;
        return;
      }
      const visual = resolveNodeVisual(state.radius, state.color, state.flags, this.stateTheme);
      this.picking.nodeRadii[instance] = visual.radius;
      this.picking.nodePickable[instance] = visual.visible;
    });
    store.forEachLink((storeIndex) => {
      const state = store.getLinkRenderState(storeIndex);
      const instance = this.picking.linkInstancesByStoreIndex[storeIndex];
      if (!state || instance === undefined) {
        missingMapping = true;
        return;
      }
      const source = store.getNodeRenderState(state.sourceIndex);
      const targetState = store.getNodeRenderState(state.targetIndex);
      const sourceInstance = this.picking.nodeInstancesByStoreIndex[state.sourceIndex];
      const targetInstance = this.picking.nodeInstancesByStoreIndex[state.targetIndex];
      if (!source || !targetState || sourceInstance === undefined || targetInstance === undefined) {
        missingMapping = true;
        return;
      }
      this.writeLinkInstance(
        target.link,
        instance,
        source.position,
        targetState.position,
        source.radius,
        targetState.radius,
        sourceInstance,
        targetInstance,
        state.width,
        state.color,
        source.flags,
        targetState.flags,
        { endpoints: false, radii: true, width: true, color: true }
      );
      updatedLinks.add(instance);
    });
    if (missingMapping) {
      this.syncDataContent(store);
      return;
    }
    if (updatedLinks.size > 0) {
      this.markLinkInstancesDirty(updatedLinks);
    }
    this.styleSyncRevision += 1;
    this.themeDerivedDirty = false;
    this.invalidatePicking();
  }

  private syncDataContent(store: GraphStore<TNode, TLink>, compact = false): void {
    const plan = this.prepareCapacity(store.nodeCount, store.linkCount, compact);
    const target = this.renderTarget(plan);
    const writeStats = this.captureWriteStats();
    let population: RenderPopulation;
    try {
      population = this.populateData(store, target);
      this.markPositionAtlasDirty(target.positionAtlas);
      this.commitCapacity(plan);
    } catch (error) {
      this.restoreWriteStats(writeStats);
      this.disposeCapacityPlan(plan);
      throw error;
    }
    this.picking.replace({
      nodeInstanceIds: population.nodeInstanceIds,
      nodePositions: population.nodePickPositions,
      nodeRadii: population.nodePickRadii,
      nodePickable: population.nodePickable,
      nodeInstancesByStoreIndex: population.nodeInstanceByStoreIndex,
      linkInstancesByStoreIndex: population.linkInstanceByStoreIndex
    });
    this.renderedNodes = population.renderedNodes;
    this.renderedLinks = population.renderedLinks;
    this.setLayerCount(this.nodeLayer.resources, population.renderedNodes);
    this.setLayerCount(this.linkLayer.resources, population.renderedLinks);
    this.markMatricesDirty(true);
    this.completeSyncs += 1;
    this.topologySyncRevision += 1;
    this.positionSyncRevision += 1;
    this.themeDerivedDirty = false;
    this.invalidatePicking();
  }

  private populateData(store: GraphStore<TNode, TLink>, target: RenderTarget): RenderPopulation {
    const nodeInstanceIds: Array<GraphId | undefined> = [];
    const nodePickPositions: Array<Vec3 | undefined> = [];
    const nodePickRadii: number[] = [];
    const nodePickable: boolean[] = [];
    const nodeInstanceByStoreIndex: Array<number | undefined> = [];
    const nodeFlowRoles: number[] = [];
    if (target.node.attributes?.flowRole) {
      store.forEachLink((storeIndex) => {
        const state = store.getLinkRenderState(storeIndex);
        if (!state) return;
        nodeFlowRoles[state.sourceIndex] = (nodeFlowRoles[state.sourceIndex] ?? 0) | 2;
        nodeFlowRoles[state.targetIndex] = (nodeFlowRoles[state.targetIndex] ?? 0) | 1;
      });
    }
    let nodeInstance = 0;
    store.forEachNode((storeIndex) => {
      const state = store.getNodeRenderState(storeIndex);
      if (!state) {
        return;
      }
      nodeInstanceIds[nodeInstance] = state.id;
      nodeInstanceByStoreIndex[storeIndex] = nodeInstance;
      this.writeNodeInstance(target.node, target.positionAtlas, nodeInstance, state.position, state.radius, state.color, state.flags);
      if (target.node.attributes?.flowRole) {
        writeScalarAttribute(target.node.attributes.flowRole, nodeInstance, nodeFlowRoles[storeIndex] ?? 0);
        this.topologyLogicalWriteBytes += Float32Array.BYTES_PER_ELEMENT;
      }
      nodePickPositions[nodeInstance] = { ...state.position };
      const visual = resolveNodeVisual(state.radius, state.color, state.flags, this.stateTheme);
      nodePickRadii[nodeInstance] = visual.radius;
      nodePickable[nodeInstance] = visual.visible;
      nodeInstance += 1;
    });

    const linkInstanceByStoreIndex: Array<number | undefined> = [];
    let linkInstance = 0;
    store.forEachLink((storeIndex) => {
      const state = store.getLinkRenderState(storeIndex);
      if (!state) {
        return;
      }
      const source = store.getNodeRenderState(state.sourceIndex);
      const targetState = store.getNodeRenderState(state.targetIndex);
      if (!source || !targetState) {
        return;
      }
      linkInstanceByStoreIndex[storeIndex] = linkInstance;
      const sourceInstance = nodeInstanceByStoreIndex[state.sourceIndex];
      const targetInstance = nodeInstanceByStoreIndex[state.targetIndex];
      if (sourceInstance === undefined || targetInstance === undefined) {
        return;
      }
      this.writeLinkInstance(
        target.link,
        linkInstance,
        source.position,
        targetState.position,
        source.radius,
        targetState.radius,
        sourceInstance,
        targetInstance,
        state.width,
        state.color,
        source.flags,
        targetState.flags
      );
      linkInstance += 1;
    });
    this.setLayerCount(target.node, nodeInstance);
    this.setLayerCount(target.link, linkInstance);
    return {
      nodeInstanceIds,
      nodePickPositions,
      nodePickRadii,
      nodePickable,
      nodeInstanceByStoreIndex,
      linkInstanceByStoreIndex,
      renderedNodes: nodeInstance,
      renderedLinks: linkInstance
    };
  }

  syncPositions(store: GraphStore<TNode, TLink>, camera?: ThreeObject): void {
    this.assertActive();
    if (readCameraFrame(this.cameraFrame, camera)) {
      this.cameraRevision += 1;
    }
    this.syncPositionsContent(store);
  }

  private syncPositionsContent(
    store: GraphStore<TNode, TLink>,
    nodeStateIds?: Iterable<GraphId>,
    linkStyleIds?: Iterable<GraphId>,
    linkEndpointRadiusIds?: Iterable<GraphId>
  ): void {
    if (this.transformPath === 'tsl') {
      this.syncTslPositionsContent(store, nodeStateIds, linkStyleIds, linkEndpointRadiusIds);
      return;
    }
    const nodeStateSet = nodeStateIds === undefined ? undefined : new Set(nodeStateIds);
    const linkStyleSet = linkStyleIds === undefined ? undefined : new Set(linkStyleIds);
    const nodeColorInstances = new Set<number>();
    const linkColorInstances = new Set<number>();
    const target = this.renderTarget();
    this.picking.beginNodeRebuild();
    let nodeInstance = 0;
    store.forEachNode((storeIndex) => {
      const state = store.getNodeRenderState(storeIndex);
      if (!state) {
        return;
      }
      this.writeNodeInstance(
        target.node,
        target.positionAtlas,
        nodeInstance,
        state.position,
        state.radius,
        state.color,
        state.flags,
        {
          position: true,
          radius: this.transformPath === 'cpu' && (nodeStateSet === undefined || nodeStateSet.has(state.id)),
          color: this.transformPath === 'cpu' && (nodeStateSet === undefined || nodeStateSet.has(state.id)),
          state: this.transformPath === 'tsl' && nodeStateSet !== undefined && nodeStateSet.has(state.id)
        }
      );
      const visual = resolveNodeVisual(state.radius, state.color, state.flags, this.stateTheme);
      this.picking.setNode(nodeInstance, storeIndex, state.id, state.position, visual.radius, visual.visible);
      if (nodeStateSet === undefined || nodeStateSet.has(state.id)) {
        nodeColorInstances.add(nodeInstance);
      }
      nodeInstance += 1;
    });
    this.renderedNodes = nodeInstance;
    this.setLayerCount(this.nodeLayer.resources, nodeInstance);
    this.picking.linkInstancesByStoreIndex = [];
    let linkInstance = 0;
    store.forEachLink((storeIndex) => {
      const state = store.getLinkRenderState(storeIndex);
      if (!state) {
        return;
      }
      const source = store.getNodeRenderState(state.sourceIndex);
      const targetState = store.getNodeRenderState(state.targetIndex);
      if (!source || !targetState) {
        return;
      }
      this.picking.linkInstancesByStoreIndex[storeIndex] = linkInstance;
      const sourceInstance = this.picking.nodeInstancesByStoreIndex[state.sourceIndex];
      const targetInstance = this.picking.nodeInstancesByStoreIndex[state.targetIndex];
      if (sourceInstance === undefined || targetInstance === undefined) {
        return;
      }
      this.writeLinkInstance(
        target.link,
        linkInstance,
        source.position,
        targetState.position,
        source.radius,
        targetState.radius,
        sourceInstance,
        targetInstance,
        state.width,
        state.color,
        source.flags,
        targetState.flags,
        {
          endpoints: this.transformPath !== 'tsl',
          radii: this.transformPath !== 'tsl'
            || linkStyleSet === undefined
            || linkStyleSet.has(state.id),
          width: this.transformPath !== 'tsl'
            || linkStyleSet === undefined
            || linkStyleSet.has(state.id),
          color: linkStyleSet === undefined || linkStyleSet.has(state.id)
        }
      );
      if (linkStyleSet === undefined || linkStyleSet.has(state.id)) {
        linkColorInstances.add(linkInstance);
      }
      linkInstance += 1;
    });
    this.renderedLinks = linkInstance;
    this.setLayerCount(this.linkLayer.resources, linkInstance);
    this.markMatricesDirty();
    this.markColorInstancesDirty(nodeColorInstances, linkColorInstances);
    this.completeSyncs += 1;
    this.positionSyncRevision += 1;
    this.invalidatePicking();
  }

  /**
   * TSL resolves link endpoints through dense topology indices, so a pure
   * position frame only rewrites node atlas entries and picking positions.
   */
  private syncTslPositionsContent(
    store: GraphStore<TNode, TLink>,
    nodeStateIds?: Iterable<GraphId>,
    linkStyleIds?: Iterable<GraphId>,
    linkEndpointRadiusIds?: Iterable<GraphId>
  ): void {
    const target = this.renderTarget();
    let missingMapping = false;
    let wrotePosition = false;
    store.forEachNode((storeIndex) => {
      const state = store.getNodeRenderState(storeIndex);
      if (!state) {
        return;
      }
      const instance = this.picking.nodeInstancesByStoreIndex[storeIndex];
      if (instance === undefined) {
        missingMapping = true;
        return;
      }
      this.writeNodeInstance(target.node, target.positionAtlas, instance, state.position, state.radius, state.color, state.flags, {
        position: true,
        radius: false,
        color: false
      });
      this.picking.nodePositions[instance] = { ...state.position };
      wrotePosition = true;
    });
    if (missingMapping) {
      this.syncDataContent(store);
      return;
    }
    if (wrotePosition) {
      this.markPositionAtlasDirty(target.positionAtlas);
      this.invalidatePicking();
    }
    const nodeStates = nodeStateIds === undefined ? [] : nodeStateIds;
    const linkStyles = linkStyleIds === undefined ? [] : linkStyleIds;
    const linkEndpointRadii = linkEndpointRadiusIds === undefined ? [] : linkEndpointRadiusIds;
    this.syncNodeStatesContent(store, nodeStates);
    this.syncLinkStylesContent(store, linkStyles);
    this.syncLinkEndpointRadiiContent(store, linkEndpointRadii);
    this.completeSyncs += 1;
    this.positionSyncRevision += 1;
  }

  /** Updates only existing node instances affected by a visual state change. */
  syncNodeStates(store: GraphStore<TNode, TLink>, nodeIds: Iterable<GraphId>, camera?: ThreeObject): void {
    this.assertActive();
    if (readCameraFrame(this.cameraFrame, camera)) {
      this.cameraRevision += 1;
    }
    this.syncNodeStatesContent(store, nodeIds);
  }

  private syncNodeStatesContent(store: GraphStore<TNode, TLink>, nodeIds: Iterable<GraphId>): void {
    const updated = new Set<number>();
    const target = this.renderTarget();
    for (const nodeId of nodeIds) {
      const handle = store.getNodeHandle(nodeId);
      if (!handle) {
        continue;
      }
      const instance = this.picking.nodeInstancesByStoreIndex[handle.index];
      if (instance === undefined || updated.has(instance)) {
        continue;
      }
      const state = store.getNodeRenderState(handle.index);
      if (!state) {
        continue;
      }
      updated.add(instance);
      const visual = resolveNodeVisual(state.radius, state.color, state.flags, this.stateTheme);
      this.picking.nodePositions[instance] = { ...state.position };
      this.picking.nodeRadii[instance] = visual.radius;
      this.picking.nodePickable[instance] = visual.visible;
      this.writeNodeInstance(target.node, target.positionAtlas, instance, state.position, state.radius, state.color, state.flags, {
        position: false,
        radius: true,
        color: true,
        state: this.transformPath === 'tsl'
      });
    }
    if (updated.size > 0) {
      this.markNodeInstancesDirty(updated);
      this.styleSyncRevision += 1;
      this.invalidatePicking();
    }
  }

  /** Updates only existing link instances affected by a data-backed visual style change. */
  syncLinkStyles(store: GraphStore<TNode, TLink>, linkIds: Iterable<GraphId>, camera?: ThreeObject): void {
    this.assertActive();
    if (readCameraFrame(this.cameraFrame, camera)) {
      this.cameraRevision += 1;
    }
    this.syncLinkStylesContent(store, linkIds);
  }

  private syncLinkStylesContent(store: GraphStore<TNode, TLink>, linkIds: Iterable<GraphId>): void {
    const updated = new Set<number>();
    const target = this.renderTarget();
    for (const linkId of linkIds) {
      const state = store.getLinkRenderStateById(linkId);
      if (!state) {
        continue;
      }
      const instance = this.picking.linkInstancesByStoreIndex[state.index];
      if (instance === undefined || updated.has(instance)) {
        continue;
      }
      const source = store.getNodeRenderState(state.sourceIndex);
      const targetState = store.getNodeRenderState(state.targetIndex);
      if (!source || !targetState) {
        continue;
      }
      updated.add(instance);
      const sourceInstance = this.picking.nodeInstancesByStoreIndex[state.sourceIndex];
      const targetInstance = this.picking.nodeInstancesByStoreIndex[state.targetIndex];
      if (sourceInstance === undefined || targetInstance === undefined) {
        continue;
      }
      this.writeLinkInstance(
        target.link,
        instance,
        source.position,
        targetState.position,
        source.radius,
        targetState.radius,
        sourceInstance,
        targetInstance,
        state.width,
        state.color,
        source.flags,
        targetState.flags,
        {
        endpoints: false,
        radii: true,
        width: true,
        color: true
        }
      );
    }
    if (updated.size > 0) {
      this.markLinkInstancesDirty(updated);
      this.styleSyncRevision += 1;
    }
  }

  /** Refreshes only endpoint radii for links touching nodes with a changed visual scale. */
  private syncLinkEndpointRadiiContent(store: GraphStore<TNode, TLink>, linkIds: Iterable<GraphId>): void {
    const updated = new Set<number>();
    const target = this.renderTarget();
    for (const linkId of linkIds) {
      const state = store.getLinkRenderStateById(linkId);
      if (!state) {
        continue;
      }
      const instance = this.picking.linkInstancesByStoreIndex[state.index];
      if (instance === undefined || updated.has(instance)) {
        continue;
      }
      const source = store.getNodeRenderState(state.sourceIndex);
      const targetState = store.getNodeRenderState(state.targetIndex);
      const sourceInstance = this.picking.nodeInstancesByStoreIndex[state.sourceIndex];
      const targetInstance = this.picking.nodeInstancesByStoreIndex[state.targetIndex];
      if (!source || !targetState || sourceInstance === undefined || targetInstance === undefined) {
        continue;
      }
      updated.add(instance);
      this.writeLinkInstance(
        target.link,
        instance,
        source.position,
        targetState.position,
        source.radius,
        targetState.radius,
        sourceInstance,
        targetInstance,
        state.width,
        state.color,
        source.flags,
        targetState.flags,
        { endpoints: false, radii: true, width: false, color: false }
      );
    }
    if (updated.size > 0) {
      this.markLinkEndpointRadiiDirty(updated);
      this.styleSyncRevision += 1;
    }
  }

  setLinkOpacity(opacity: number | undefined): void {
    this.assertActive();
    this.linkMaterial.setOpacity(opacity);
  }

  pickNode(event: PointerEvent, camera: ThreeObject, canvas: HTMLCanvasElement): GraphId | undefined {
    if (this.disposed || this.renderedNodes === 0 || this.themeDerivedDirty) {
      return undefined;
    }
    const mode = this.resolvePickingMode();
    if (mode === 'spatial' || mode === 'gpu-id') {
      // Pointer-down remains bounded even when a host opts into asynchronous
      // GPU-ID hover: the synchronous path never falls through to O(N) ray work.
      return this.pickNodeFromSpatialIndex(event, camera, canvas);
    }
    const Raycaster = asConstructor(this.THREE.Raycaster);
    const Vector2 = asConstructor(this.THREE.Vector2);
    if (!Raycaster || !Vector2 || typeof camera !== 'object') {
      return undefined;
    }
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return undefined;
    }
    try {
      const pointer = new Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1
      ) as ThreeObject;
      const raycaster = new Raycaster() as ThreeObject;
      call(raycaster, 'setFromCamera', pointer, camera);
      if (this.transformPath === 'tsl') {
        return this.pickNodeFromRay(raycaster);
      }
      const intersections = call(raycaster, 'intersectObject', this.nodeLayer.resources.mesh, false);
      if (!Array.isArray(intersections) || intersections.length === 0) {
        return undefined;
      }
      const instanceId = asRecord(intersections[0]).instanceId;
      return typeof instanceId === 'number' && this.picking.nodePickable[instanceId] === true
        ? this.picking.nodeInstanceIds[instanceId]
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Uses the host-owned GPU ID readback only when configured, and discards stale revisions. */
  async pickNodeAsync(event: PointerEvent, camera: ThreeObject, canvas: HTMLCanvasElement): Promise<GraphId | undefined> {
    if (this.themeDerivedDirty) {
      return undefined;
    }
    const mode = this.resolvePickingMode();
    const picker = this.pickingOptions.gpuIdPicker;
    const bounds = canvas.getBoundingClientRect();
    if (mode !== 'gpu-id' || !picker || bounds.width <= 0 || bounds.height <= 0) {
      return this.pickNode(event, camera, canvas);
    }
    const request: GpuIdPickRequest = Object.freeze({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
      positionRevision: this.positionSyncRevision,
      cameraRevision: this.cameraRevision,
      topologyRevision: this.topologySyncRevision,
      pickingRevision: this.pickingRevision
    });
    const result = await picker(request);
    if (request.positionRevision !== this.positionSyncRevision
      || request.cameraRevision !== this.cameraRevision
      || request.topologyRevision !== this.topologySyncRevision
      || request.pickingRevision !== this.pickingRevision) {
      return undefined;
    }
    return this.picking.resolveVisibleId(result);
  }

  private pickNodeFromSpatialIndex(event: PointerEvent, camera: ThreeObject, canvas: HTMLCanvasElement): GraphId | undefined {
    const bounds = canvas.getBoundingClientRect();
    const view = asMatrixElements(asOptionalRecord(camera.matrixWorldInverse)?.elements);
    const projection = asMatrixElements(asOptionalRecord(camera.projectionMatrix)?.elements);
    if (!view || !projection || bounds.width <= 0 || bounds.height <= 0) {
      return undefined;
    }
    const result = this.spatialPicking.query(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      this.picking.nodePositions,
      this.picking.nodeRadii,
      this.picking.nodePickable,
      { view, projection },
      bounds,
      this.pickingRevision,
      this.cameraRevision
    );
    this.lastPickCandidateCount = result.candidateCount;
    this.lastPickScannedCellCount = result.scannedCellCount;
    this.lastPickOrdinaryCandidateCount = result.ordinaryCandidateCount;
    this.lastPickOversizedCandidateCount = result.oversizedCandidateCount;
    return result.instance === undefined ? undefined : this.picking.nodeInstanceIds[result.instance];
  }

  private resolvePickingMode(): 'raycast' | 'spatial' | 'gpu-id' {
    const requested = this.pickingOptions.mode ?? 'auto';
    const gpuThreshold = this.pickingOptions.gpuIdThreshold ?? 2_048;
    const canUseGpuId = typeof this.pickingOptions.gpuIdPicker === 'function' && this.renderedNodes >= gpuThreshold;
    if ((requested === 'gpu-id' || requested === 'auto') && canUseGpuId) {
      return 'gpu-id';
    }
    if (requested === 'spatial' || (requested === 'auto' && this.transformPath === 'tsl')) {
      return 'spatial';
    }
    return 'raycast';
  }

  private pickNodeFromRay(raycaster: ThreeObject): GraphId | undefined {
    const ray = asRecord(raycaster.ray);
    const origin = asRecord(ray.origin);
    const direction = asRecord(ray.direction);
    if (![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z].every(Number.isFinite)) {
      return undefined;
    }
    let bestInstance = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let instance = 0; instance < this.renderedNodes; instance += 1) {
      const position = this.picking.nodePositions[instance];
      const radius = this.picking.nodeRadii[instance] ?? 0;
      if (!position || this.picking.nodePickable[instance] !== true || !Number.isFinite(radius)) {
        continue;
      }
      const dx = position.x - Number(origin.x);
      const dy = position.y - Number(origin.y);
      const dz = position.z - Number(origin.z);
      const along = dx * Number(direction.x) + dy * Number(direction.y) + dz * Number(direction.z);
      if (along < 0) {
        continue;
      }
      const distanceX = dx - Number(direction.x) * along;
      const distanceY = dy - Number(direction.y) * along;
      const distanceZ = dz - Number(direction.z) * along;
      const distance = distanceX * distanceX + distanceY * distanceY + distanceZ * distanceZ;
      if (distance <= radius * radius && along < bestDistance) {
        bestDistance = along;
        bestInstance = instance;
      }
    }
    return bestInstance >= 0 ? this.picking.nodeInstanceIds[bestInstance] : undefined;
  }

  projectPointerToDragPlane(
    event: PointerEvent,
    camera: ThreeObject,
    canvas: HTMLCanvasElement,
    point: Vec3
  ): Vec3 | undefined {
    const Raycaster = asConstructor(this.THREE.Raycaster);
    const Vector2 = asConstructor(this.THREE.Vector2);
    const Vector3 = asConstructor(this.THREE.Vector3);
    const Plane = asConstructor(this.THREE.Plane);
    if (!Raycaster || !Vector2 || !Vector3 || !Plane) {
      return undefined;
    }
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return undefined;
    }
    try {
      const pointer = new Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1
      ) as ThreeObject;
      const raycaster = new Raycaster() as ThreeObject;
      call(raycaster, 'setFromCamera', pointer, camera);
      const normal = new Vector3(0, 0, 1) as ThreeObject;
      call(camera, 'getWorldDirection', normal);
      const plane = new Plane() as ThreeObject;
      const planePoint = new Vector3(point.x, point.y, point.z) as ThreeObject;
      call(plane, 'setFromNormalAndCoplanarPoint', normal, planePoint);
      const output = new Vector3() as ThreeObject;
      const ray = asRecord(raycaster.ray);
      const hit = call(ray, 'intersectPlane', plane, output);
      if (!hit) {
        return undefined;
      }
      return {
        x: numeric(output.x),
        y: numeric(output.y),
        z: numeric(output.z)
      };
    } catch {
      return undefined;
    }
  }

  getStats(): RenderStats {
    const positionAtlasAllocationBytes = this.positionAtlas?.data.byteLength ?? 0;
    const positionAtlasWidth = this.transformPath === 'tsl' ? this.positionAtlasWidth : 0;
    const positionAtlasMaxHeight = this.transformPath === 'tsl' ? this.maxPositionAtlasHeight : 0;
    const instanceMatrixAllocationBytes = this.transformPath === 'cpu'
      ? (this.nodeLayer.capacity + this.linkLayer.capacity) * 16 * Float32Array.BYTES_PER_ELEMENT
      : 0;
    const attributeBytes = this.transformPath === 'tsl'
      ? (this.nodeLayer.capacity * (1 + 3 + 1 + (this.nodeLayer.resources.attributes?.flowRole ? 1 : 0))
        + this.linkLayer.capacity * (1 + 1 + 1 + 1 + 1 + 3)) * Float32Array.BYTES_PER_ELEMENT
      : (this.nodeLayer.capacity + this.linkLayer.capacity) * 3 * Float32Array.BYTES_PER_ELEMENT;
    return {
      nodeCount: this.renderedNodes,
      linkCount: this.renderedLinks,
      drawCalls: (this.renderedNodes > 0 ? 1 : 0) + (this.renderedLinks > 0 ? 1 : 0),
      triangleCount: this.renderedNodes * this.nodeTriangleCount + this.renderedLinks * 2,
      gpuBufferBytes: attributeBytes + instanceMatrixAllocationBytes + positionAtlasAllocationBytes,
      positionAtlasAllocationBytes,
      positionAtlasLogicalWriteBytes: this.positionAtlasLogicalWriteBytes,
      positionAtlasUploadRequestedBytes: this.positionAtlasUploadRequestedBytes,
      positionAtlasWidth,
      positionAtlasMaxHeight,
      positionAtlasMaxNodeCapacity: positionAtlasWidth * positionAtlasMaxHeight,
      deviceMaxTextureSize: this.deviceMaxTextureSize,
      topologyLogicalWriteBytes: this.topologyLogicalWriteBytes,
      styleLogicalWriteBytes: this.styleLogicalWriteBytes,
      instanceMatrixAllocationBytes,
      positionSyncRevision: this.positionSyncRevision,
      topologySyncRevision: this.topologySyncRevision,
      styleSyncRevision: this.styleSyncRevision,
      cameraRevision: this.cameraRevision,
      pickingRevision: this.pickingRevision,
      positionAtlasBytes: positionAtlasAllocationBytes,
      topologyUploadBytes: this.topologyLogicalWriteBytes,
      positionAtlasUploadBytes: this.positionAtlasUploadRequestedBytes,
      materialPath: this.nodeMaterial.usesTslColor && this.linkMaterial.usesTslColor ? 'tsl' : 'fallback',
      transformPath: this.transformPath,
      widthUnitRequested: this.widthUnitRequested,
      widthUnitSelected: this.widthUnitSelected,
      nodeMatrixWrites: this.nodeMatrixWrites,
      linkMatrixWrites: this.linkMatrixWrites,
      nodeAttributeWrites: this.nodeAttributeWrites,
      linkAttributeWrites: this.linkAttributeWrites,
      linkFlowEnabled: this.linkFlowEnabled,
      linkFlowTimeSeconds: this.linkFlowTimeSeconds,
      nodeSurfaceAnimating: this.nodeSurfaceAnimating,
      nodeSurfaceTimeSeconds: this.nodeSurfaceTimeSeconds,
      nodeDynamicOpacityRequested: this.nodeSurface?.selectionEffect !== undefined,
      nodeDynamicOpacitySelected: this.nodeMaterial.usesDynamicOpacity,
      linkDynamicOpacityRequested: this.linkFlow !== undefined,
      linkDynamicOpacitySelected: this.linkMaterial.usesDynamicOpacity,
      completeSyncs: this.completeSyncs,
      partialUpdateRanges: this.partialUpdateRanges,
      skippedSyncPasses: this.skippedSyncPasses,
      pickingMode: this.resolvePickingMode(),
      pickCandidateCount: this.lastPickCandidateCount,
      pickScannedCellCount: this.lastPickScannedCellCount,
      pickOrdinaryCandidateCount: this.lastPickOrdinaryCandidateCount,
      pickOversizedCandidateCount: this.lastPickOversizedCandidateCount
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    call(this.object3D, 'remove', this.nodeLayer.resources.mesh);
    call(this.object3D, 'remove', this.linkLayer.resources.mesh);
    this.nodeLayer.dispose();
    this.linkLayer.dispose();
    disposePositionAtlas(this.positionAtlas);
    call(this.nodeMaterial.material, 'dispose');
    call(this.linkMaterial.material, 'dispose');
    this.picking.clear();
    this.invalidatePicking();
  }

  private renderTarget(plan?: CapacityPlan): RenderTarget {
    return {
      node: plan?.node ?? this.nodeLayer.resources,
      link: plan?.link ?? this.linkLayer.resources,
      positionAtlas: plan?.positionAtlas?.next ?? this.positionAtlas
    };
  }

  private prepareCapacity(requiredNodes: number, requiredLinks: number, compact = false): CapacityPlan {
    const compactNodeCapacity = Math.max(1, requiredNodes);
    const compactLinkCapacity = Math.max(1, requiredLinks);
    const resizeNodes = requiredNodes > this.nodeLayer.capacity || (compact && compactNodeCapacity < this.nodeLayer.capacity);
    const resizeLinks = requiredLinks > this.linkLayer.capacity || (compact && compactLinkCapacity < this.linkLayer.capacity);
    const nextNodeCapacity = resizeNodes ? (compact ? compactNodeCapacity : nextCapacity(this.nodeLayer.capacity, requiredNodes)) : this.nodeLayer.capacity;
    const nextLinkCapacity = resizeLinks ? (compact ? compactLinkCapacity : nextCapacity(this.linkLayer.capacity, requiredLinks)) : this.linkLayer.capacity;
    let nextNodeGeometry: ThreeObject | undefined;
    let nextLinkGeometry: ThreeObject | undefined;
    let nextNodeMesh: ThreeObject | undefined;
    let nextLinkMesh: ThreeObject | undefined;
    let nextNodeAttributes: NodeAttributeSet | undefined;
    let nextLinkAttributes: LinkAttributeSet | undefined;
    let nextPositionAtlas: PositionAtlasResources | undefined;
    try {
      nextNodeGeometry = createNodeGeometry(this.THREE);
      nextNodeAttributes = this.transformPath === 'tsl'
        ? createNodeAttributes(this.THREE, nextNodeGeometry, nextNodeCapacity, this.linkFlowBinding !== undefined)
        : undefined;
      nextLinkGeometry = createLinkGeometry(this.THREE);
      nextLinkAttributes = this.transformPath === 'tsl'
        ? createLinkAttributes(this.THREE, nextLinkGeometry, nextLinkCapacity)
        : undefined;
      if (this.transformPath === 'tsl' && (!nextNodeAttributes || !nextLinkAttributes)) {
        throw new GraphError(
          'FG_RENDER_CAPABILITY_UNAVAILABLE',
          'The TSL graph attributes could not be recreated after renderer capacity growth.'
        );
      }
      if (this.transformPath === 'tsl') {
        nextPositionAtlas = createPositionAtlas(this.THREE, nextNodeCapacity, this.maxPositionAtlasHeight, this.positionAtlasWidth);
        if (!nextPositionAtlas) {
          throw new GraphError(
            'FG_RENDER_CAPABILITY_UNAVAILABLE',
            'The position atlas could not be recreated after renderer capacity growth.'
          );
        }
      }
      nextNodeMesh = createGraphLayerMesh(this.THREE, nextNodeGeometry, this.nodeMaterial.material, nextNodeCapacity, this.transformPath);
      nextLinkMesh = createGraphLayerMesh(this.THREE, nextLinkGeometry, this.linkMaterial.material, nextLinkCapacity, this.transformPath);
      return {
        node: { geometry: nextNodeGeometry, mesh: nextNodeMesh, attributes: nextNodeAttributes, capacity: nextNodeCapacity },
        link: { geometry: nextLinkGeometry, mesh: nextLinkMesh, attributes: nextLinkAttributes, capacity: nextLinkCapacity },
        positionAtlas: nextPositionAtlas ? { next: nextPositionAtlas, committed: false } : undefined,
        committed: false
      };
    } catch (error) {
      call(nextNodeMesh, 'dispose');
      call(nextLinkMesh, 'dispose');
      call(nextNodeGeometry, 'dispose');
      call(nextLinkGeometry, 'dispose');
      disposePositionAtlas(nextPositionAtlas);
      throw error;
    }
  }

  private commitCapacity(plan: CapacityPlan): void {
    const previousChildren = readChildren(this.object3D);
    const previousNode = this.nodeLayer.resources;
    const previousLink = this.linkLayer.resources;
    const previousPositionAtlas = this.positionAtlas;
    try {
      // Candidates are populated before this method is called. Attach all of
      // them while the live layers remain available, then perform one scene
      // transaction for the final link-then-node order.
      if (plan.link) call(this.object3D, 'add', plan.link.mesh);
      if (plan.node) call(this.object3D, 'add', plan.node.mesh);
      call(this.object3D, 'remove', previousLink.mesh);
      call(this.object3D, 'remove', previousNode.mesh);
      if (plan.link) call(this.object3D, 'remove', plan.link.mesh);
      if (plan.node) call(this.object3D, 'remove', plan.node.mesh);
      call(this.object3D, 'add', plan.link?.mesh ?? previousLink.mesh);
      call(this.object3D, 'add', plan.node?.mesh ?? previousNode.mesh);
    } catch (error) {
      restoreChildren(this.object3D, previousChildren);
      throw error;
    }

    if (plan.node) {
      this.nodeLayer.replace(plan.node);
    }
    if (plan.link) {
      this.linkLayer.replace(plan.link);
    }
    if (plan.positionAtlas) {
      this.positionAtlas = plan.positionAtlas.next;
      if (this.positionAtlasNode) {
        this.positionAtlasNode.value = plan.positionAtlas.next.texture;
      }
      plan.positionAtlas.committed = true;
    }
    plan.committed = true;
    if (plan.node) {
      disposeRenderLayerResources(previousNode);
    }
    if (plan.link) {
      disposeRenderLayerResources(previousLink);
    }
    if (plan.positionAtlas && previousPositionAtlas) {
      disposePositionAtlas(previousPositionAtlas);
    }
  }

  private disposeCapacityPlan(plan: CapacityPlan | undefined): void {
    if (!plan || plan.committed) {
      return;
    }
    disposeRenderLayerResources(plan.node);
    disposeRenderLayerResources(plan.link);
    if (plan.positionAtlas && !plan.positionAtlas.committed) {
      disposePositionAtlas(plan.positionAtlas.next);
    }
  }

  private captureWriteStats(): RendererWriteStats {
    return {
      nodeMatrixWrites: this.nodeMatrixWrites,
      linkMatrixWrites: this.linkMatrixWrites,
      nodeAttributeWrites: this.nodeAttributeWrites,
      linkAttributeWrites: this.linkAttributeWrites,
      topologyLogicalWriteBytes: this.topologyLogicalWriteBytes,
      positionAtlasLogicalWriteBytes: this.positionAtlasLogicalWriteBytes,
      positionAtlasUploadRequestedBytes: this.positionAtlasUploadRequestedBytes,
      styleLogicalWriteBytes: this.styleLogicalWriteBytes,
      partialUpdateRanges: this.partialUpdateRanges
    };
  }

  private restoreWriteStats(snapshot: RendererWriteStats): void {
    this.nodeMatrixWrites = snapshot.nodeMatrixWrites;
    this.linkMatrixWrites = snapshot.linkMatrixWrites;
    this.nodeAttributeWrites = snapshot.nodeAttributeWrites;
    this.linkAttributeWrites = snapshot.linkAttributeWrites;
    this.topologyLogicalWriteBytes = snapshot.topologyLogicalWriteBytes;
    this.positionAtlasLogicalWriteBytes = snapshot.positionAtlasLogicalWriteBytes;
    this.positionAtlasUploadRequestedBytes = snapshot.positionAtlasUploadRequestedBytes;
    this.styleLogicalWriteBytes = snapshot.styleLogicalWriteBytes;
    this.partialUpdateRanges = snapshot.partialUpdateRanges;
  }

  private writeNodeInstance(
    layer: NodeLayerResources,
    positionAtlas: PositionAtlasResources | undefined,
    instance: number,
    position: Vec3,
    radius: number,
    color: number,
    flags: number,
    channels: NodeWriteChannels = { position: true, radius: true, color: true, state: true }
  ): void {
    if (this.transformPath === 'tsl' && layer.attributes) {
      if (channels.position) {
        writePositionAtlas(positionAtlas, instance, position);
        this.positionAtlasLogicalWriteBytes += POSITION_ATLAS_ENTRY_BYTES;
      }
      if (channels.radius) {
        writeScalarAttribute(layer.attributes.radius, instance, radius);
        this.styleLogicalWriteBytes += Float32Array.BYTES_PER_ELEMENT;
      }
      if (channels.color) {
        writeColorAttribute(layer.attributes.color, instance, color);
        this.styleLogicalWriteBytes += 3 * Float32Array.BYTES_PER_ELEMENT;
      }
      if (channels.state) {
        writeScalarAttribute(layer.attributes.state, instance, flags);
        this.styleLogicalWriteBytes += Float32Array.BYTES_PER_ELEMENT;
      }
      if (channels.position || channels.radius || channels.color || channels.state) {
        this.nodeAttributeWrites += 1;
      }
      return;
    }
    const visual = resolveNodeVisual(radius, color, flags, this.stateTheme);
    if (channels.position || channels.radius) {
      writeNodeMatrix(this.nodeMatrix, position, visual.radius, this.cameraFrame);
      call(layer.mesh, 'setMatrixAt', instance, this.nodeMatrix);
      this.nodeMatrixWrites += 1;
    }
    if (channels.color) {
      this.setColor(layer.mesh, instance, visual.color);
    }
  }

  private writeLinkInstance(
    layer: LinkLayerResources,
    instance: number,
    source: Vec3,
    target: Vec3,
    sourceRadius: number,
    targetRadius: number,
    sourceInstance: number,
    targetInstance: number,
    width: number,
    color: number,
    sourceFlags: number,
    targetFlags: number,
    channels: LinkWriteChannels = { endpoints: true, radii: true, width: true, color: true }
  ): void {
    const sourceVisual = resolveNodeVisual(sourceRadius, 0, sourceFlags, this.stateTheme);
    const targetVisual = resolveNodeVisual(targetRadius, 0, targetFlags, this.stateTheme);
    const visual = resolveIncidentLinkVisual(
      width,
      color,
      sourceFlags,
      targetFlags,
      sourceVisual.visible,
      targetVisual.visible,
      this.stateTheme
    );
    if (this.transformPath === 'tsl' && layer.attributes) {
      if (channels.endpoints) {
        writeScalarAttribute(layer.attributes.sourceIndex, instance, sourceInstance);
        writeScalarAttribute(layer.attributes.targetIndex, instance, targetInstance);
        this.topologyLogicalWriteBytes += 2 * Float32Array.BYTES_PER_ELEMENT;
      }
      if (channels.radii) {
        writeScalarAttribute(layer.attributes.sourceRadius, instance, sourceVisual.radius);
        writeScalarAttribute(layer.attributes.targetRadius, instance, targetVisual.radius);
        this.styleLogicalWriteBytes += 2 * Float32Array.BYTES_PER_ELEMENT;
      }
      if (channels.width) {
        writeScalarAttribute(layer.attributes.width, instance, visual.width);
        this.styleLogicalWriteBytes += Float32Array.BYTES_PER_ELEMENT;
      }
      if (channels.color) {
        writeColorAttribute(layer.attributes.color, instance, visual.color);
        this.styleLogicalWriteBytes += 3 * Float32Array.BYTES_PER_ELEMENT;
      }
      if (channels.endpoints || channels.radii || channels.width || channels.color) {
        this.linkAttributeWrites += 1;
      }
      return;
    }
    if (channels.endpoints || channels.radii || channels.width) {
      writeLinkMatrix(this.linkMatrix, source, target, sourceVisual.radius, targetVisual.radius, visual.width, this.cameraFrame);
      call(layer.mesh, 'setMatrixAt', instance, this.linkMatrix);
      this.linkMatrixWrites += 1;
    }
    if (channels.color) {
      this.setColor(layer.mesh, instance, visual.color);
    }
  }

  private setColor(mesh: ThreeObject, instance: number, color: number): void {
    if (!this.colorScratch || typeof this.colorScratch.set !== 'function' || typeof mesh.setColorAt !== 'function') {
      return;
    }
    call(this.colorScratch, 'set', color);
    call(mesh, 'setColorAt', instance, this.colorScratch);
  }

  private setLayerCount(layer: { readonly geometry: ThreeObject; readonly mesh: ThreeObject }, count: number): void {
    setGraphLayerInstanceCount(layer.geometry, layer.mesh, count, this.transformPath);
  }

  private markMatricesDirty(includeColors = false): void {
    if (this.transformPath === 'tsl') {
      clearAttributeUpdateRanges(this.nodeLayer.resources.attributes?.radius);
      clearAttributeUpdateRanges(this.nodeLayer.resources.attributes?.color);
      clearAttributeUpdateRanges(this.nodeLayer.resources.attributes?.state);
      clearAttributeUpdateRanges(this.nodeLayer.resources.attributes?.flowRole);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.sourceIndex);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.targetIndex);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.sourceRadius);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.targetRadius);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.width);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.color);
      markAttributeNeedsUpdate(this.nodeLayer.resources.attributes?.radius, true);
      markAttributeNeedsUpdate(this.nodeLayer.resources.attributes?.state, true);
      markAttributeNeedsUpdate(this.nodeLayer.resources.attributes?.flowRole, true);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.sourceIndex, true);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.targetIndex, true);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.sourceRadius, true);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.targetRadius, true);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.width, true);
      if (includeColors) {
        markAttributeNeedsUpdate(this.nodeLayer.resources.attributes?.color, true);
        markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.color, true);
      }
      return;
    }
    const nodeMatrix = asOptionalRecord(this.nodeLayer.resources.mesh.instanceMatrix);
    const linkMatrix = asOptionalRecord(this.linkLayer.resources.mesh.instanceMatrix);
    clearAttributeUpdateRanges(nodeMatrix);
    clearAttributeUpdateRanges(linkMatrix);
    if (nodeMatrix) nodeMatrix.needsUpdate = true;
    if (linkMatrix) linkMatrix.needsUpdate = true;
    if (includeColors) {
      const nodeColor = asOptionalRecord(this.nodeLayer.resources.mesh.instanceColor);
      const linkColor = asOptionalRecord(this.linkLayer.resources.mesh.instanceColor);
      clearAttributeUpdateRanges(nodeColor);
      clearAttributeUpdateRanges(linkColor);
      if (nodeColor) nodeColor.needsUpdate = true;
      if (linkColor) linkColor.needsUpdate = true;
    }
  }

  private markColorInstancesDirty(
    nodeInstances: ReadonlySet<number>,
    linkInstances: ReadonlySet<number>
  ): void {
    if (nodeInstances.size === 0 && linkInstances.size === 0) {
      return;
    }
    if (this.transformPath === 'tsl') {
      if (nodeInstances.size > 0) {
        markAttributeNeedsUpdate(this.nodeLayer.resources.attributes?.color, true);
        markPartialUpdateRange(this.nodeLayer.resources.attributes?.color, nodeInstances);
      }
      if (linkInstances.size > 0) {
        markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.color, true);
        markPartialUpdateRange(this.linkLayer.resources.attributes?.color, linkInstances);
      }
    } else {
      const nodeColor = asOptionalRecord(this.nodeLayer.resources.mesh.instanceColor);
      const linkColor = asOptionalRecord(this.linkLayer.resources.mesh.instanceColor);
      if (nodeInstances.size > 0) {
        if (nodeColor) nodeColor.needsUpdate = true;
        markPartialUpdateRange(nodeColor, nodeInstances, 3);
      }
      if (linkInstances.size > 0) {
        if (linkColor) linkColor.needsUpdate = true;
        markPartialUpdateRange(linkColor, linkInstances, 3);
      }
    }
    this.partialUpdateRanges += 1;
  }

  private markNodeInstancesDirty(instances: ReadonlySet<number>): void {
    if (instances.size === 0) {
      return;
    }
    if (this.transformPath === 'tsl') {
      clearAttributeUpdateRanges(this.nodeLayer.resources.attributes?.radius);
      clearAttributeUpdateRanges(this.nodeLayer.resources.attributes?.color);
      clearAttributeUpdateRanges(this.nodeLayer.resources.attributes?.state);
      markAttributeNeedsUpdate(this.nodeLayer.resources.attributes?.radius, true);
      markAttributeNeedsUpdate(this.nodeLayer.resources.attributes?.color, true);
      markAttributeNeedsUpdate(this.nodeLayer.resources.attributes?.state, true);
      markPartialUpdateRange(this.nodeLayer.resources.attributes?.radius, instances);
      markPartialUpdateRange(this.nodeLayer.resources.attributes?.color, instances);
      markPartialUpdateRange(this.nodeLayer.resources.attributes?.state, instances);
      this.partialUpdateRanges += 1;
      return;
    }
    const matrix = asOptionalRecord(this.nodeLayer.resources.mesh.instanceMatrix);
    const color = asOptionalRecord(this.nodeLayer.resources.mesh.instanceColor);
    clearAttributeUpdateRanges(matrix);
    clearAttributeUpdateRanges(color);
    if (matrix) matrix.needsUpdate = true;
    if (color) color.needsUpdate = true;
    markPartialUpdateRange(matrix, instances, 16);
    markPartialUpdateRange(color, instances, 3);
    this.partialUpdateRanges += 1;
  }

  private markLinkInstancesDirty(instances: ReadonlySet<number>): void {
    if (instances.size === 0) {
      return;
    }
    if (this.transformPath === 'tsl') {
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.sourceRadius);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.targetRadius);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.width);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.color);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.sourceRadius, true);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.targetRadius, true);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.width, true);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.color, true);
      markPartialUpdateRange(this.linkLayer.resources.attributes?.sourceRadius, instances);
      markPartialUpdateRange(this.linkLayer.resources.attributes?.targetRadius, instances);
      markPartialUpdateRange(this.linkLayer.resources.attributes?.width, instances);
      markPartialUpdateRange(this.linkLayer.resources.attributes?.color, instances);
      this.partialUpdateRanges += 1;
      return;
    }
    const matrix = asOptionalRecord(this.linkLayer.resources.mesh.instanceMatrix);
    const color = asOptionalRecord(this.linkLayer.resources.mesh.instanceColor);
    clearAttributeUpdateRanges(matrix);
    clearAttributeUpdateRanges(color);
    if (matrix) matrix.needsUpdate = true;
    if (color) color.needsUpdate = true;
    markPartialUpdateRange(matrix, instances, 16);
    markPartialUpdateRange(color, instances, 3);
    this.partialUpdateRanges += 1;
  }

  private markLinkEndpointRadiiDirty(instances: ReadonlySet<number>): void {
    if (instances.size === 0) {
      return;
    }
    if (this.transformPath === 'tsl') {
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.sourceRadius);
      clearAttributeUpdateRanges(this.linkLayer.resources.attributes?.targetRadius);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.sourceRadius, true);
      markAttributeNeedsUpdate(this.linkLayer.resources.attributes?.targetRadius, true);
      markPartialUpdateRange(this.linkLayer.resources.attributes?.sourceRadius, instances);
      markPartialUpdateRange(this.linkLayer.resources.attributes?.targetRadius, instances);
      this.partialUpdateRanges += 1;
      return;
    }
    const matrix = asOptionalRecord(this.linkLayer.resources.mesh.instanceMatrix);
    clearAttributeUpdateRanges(matrix);
    if (matrix) matrix.needsUpdate = true;
    markPartialUpdateRange(matrix, instances, 16);
    this.partialUpdateRanges += 1;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new GraphError('FG_RESOURCE_ALREADY_DISPOSED', 'The Three graph renderer has already been disposed.');
    }
  }

  private markPositionAtlasDirty(atlas: PositionAtlasResources | undefined): void {
    if (!atlas) {
      return;
    }
    atlas.texture.needsUpdate = true;
    this.positionAtlasUploadRequestedBytes += atlas.data.byteLength;
  }
}

function createNodeMaterial(
  platform: ThreePlatform,
  opacity: number,
  transform: { readonly positionNode: ThreeObject; readonly colorNode: ThreeObject; readonly opacityNode?: ThreeObject } | undefined
): MaterialBinding {
  const three = platform.THREE;
  // Instanced mesh materials preserve our camera-facing instance transforms;
  // Sprite materials own their own billboard sizing and are only a fallback.
  const Material = asConstructor(three.MeshBasicNodeMaterial)
    ?? asConstructor(three.SpriteNodeMaterial)
    ?? asConstructor(three.MeshBasicMaterial);
  if (!Material) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'The injected Three module does not provide a TSL node material or MeshBasicMaterial fallback.');
  }
  const resolvedOpacity = normalizeOpacity(opacity);
  const hasDynamicOpacity = transform?.opacityNode !== undefined;
  const material = new Material({
    transparent: resolvedOpacity < 1 || hasDynamicOpacity,
    opacity: resolvedOpacity,
    depthWrite: resolvedOpacity >= 1 && !hasDynamicOpacity
  }) as ThreeObject;
  if (transform && 'positionNode' in material && 'colorNode' in material) {
    material.positionNode = transform.positionNode;
    material.colorNode = transform.colorNode;
  }
  const tslInputs = createTslMaterialInputs(platform.TSL, material, resolvedOpacity, transform?.colorNode, transform?.opacityNode);
  const setOpacity = (value: number | undefined): void => {
    const resolved = normalizeOpacity(value);
    material.opacity = resolved;
    material.transparent = resolved < 1 || hasDynamicOpacity;
    material.depthWrite = resolved >= 1 && !hasDynamicOpacity;
    if (tslInputs) {
      tslInputs.opacityInput.value = resolved;
    }
    material.needsUpdate = true;
  };
  return {
    material,
    usesTransform: transform !== undefined && material.positionNode === transform.positionNode,
    usesTslColor: tslInputs?.usesTslColor === true
      && (transform === undefined || material.colorNode === transform.colorNode),
    usesDynamicOpacity: transform?.opacityNode !== undefined && tslInputs?.usesDynamicOpacity === true,
    setOpacity
  };
}

function createTslMaterialInputs(
  tsl: ThreeObject,
  material: ThreeObject,
  opacity: number,
  colorNode: ThreeObject | undefined,
  opacityMultiplier: ThreeObject | undefined
): TslMaterialInputs | undefined {
  const createUniform = tsl.uniform;
  if (!hasProperty(material, 'colorNode') || !hasProperty(material, 'opacityNode')
    || !tsl.materialColor || typeof createUniform !== 'function') {
    return undefined;
  }
  const input = createUniform(opacity);
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const resolvedColorNode = colorNode ?? tsl.materialColor;
  const multipliedOpacity = opacityMultiplier === undefined
    ? undefined
    : call(input as ThreeObject, 'mul', opacityMultiplier);
  const resolvedOpacityNode = opacityMultiplier === undefined
    ? input as ThreeObject
    : asOptionalRecord(multipliedOpacity) ?? input as ThreeObject;
  material.colorNode = resolvedColorNode;
  material.opacityNode = resolvedOpacityNode;
  return {
    opacityInput: input as ThreeObject,
    usesTslColor: material.colorNode === resolvedColorNode,
    usesDynamicOpacity: opacityMultiplier !== undefined
      && multipliedOpacity !== undefined
      && material.opacityNode === multipliedOpacity
  };
}

function createMatrix(three: ThreeObject): ThreeObject {
  const Matrix4 = asConstructor(three.Matrix4);
  if (!Matrix4) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'The injected Three module does not provide Matrix4.');
  }
  return new Matrix4() as ThreeObject;
}

function readChildren(object3D: ThreeObject): readonly unknown[] | undefined {
  const children = object3D.children;
  return Array.isArray(children) ? children.slice() : undefined;
}

function restoreChildren(object3D: ThreeObject, snapshot: readonly unknown[] | undefined): void {
  const children = object3D.children;
  if (snapshot && Array.isArray(children)) {
    children.splice(0, children.length, ...snapshot);
  }
}

function createColor(three: ThreeObject): ThreeObject | undefined {
  const Color = asConstructor(three.Color);
  return Color ? new Color() as ThreeObject : undefined;
}

function writeNodeMatrix(matrix: ThreeObject, position: Vec3, radius: number, cameraFrame: CameraFrame): void {
  const diameter = radius > 0 ? Math.max(0.001, radius * 2) : 0;
  if (cameraFrame.valid) {
    writeBasisMatrix(
      matrix,
      cameraFrame.right,
      cameraFrame.up,
      cameraFrame.backward,
      diameter,
      diameter,
      1,
      position
    );
    return;
  }
  if (typeof matrix.makeScale === 'function') {
    call(matrix, 'makeScale', diameter, diameter, diameter);
    call(matrix, 'setPosition', position.x, position.y, position.z);
  } else {
    call(matrix, 'set', diameter, 0, 0, position.x, 0, diameter, 0, position.y, 0, 0, diameter, position.z, 0, 0, 0, 1);
  }
}

function writeLinkMatrix(
  matrix: ThreeObject,
  source: Vec3,
  target: Vec3,
  sourceRadius: number,
  targetRadius: number,
  width: number,
  cameraFrame: CameraFrame
): void {
  const clipped = clipLinkEndpoints(source, target, sourceRadius, targetRadius);
  const dx = clipped.target.x - clipped.source.x;
  const dy = clipped.target.y - clipped.source.y;
  const dz = clipped.target.z - clipped.source.z;
  const length = Math.max(0.0001, Math.hypot(dx, dy, dz));
  const xAxis = { x: dx / length, y: dy / length, z: dz / length };
  const midpoint = {
    x: (clipped.source.x + clipped.target.x) * 0.5,
    y: (clipped.source.y + clipped.target.y) * 0.5,
    z: (clipped.source.z + clipped.target.z) * 0.5
  };
  if (cameraFrame.valid) {
    const normal = normalizeOrUndefined({
      x: cameraFrame.position.x - midpoint.x,
      y: cameraFrame.position.y - midpoint.y,
      z: cameraFrame.position.z - midpoint.z
    }) ?? { ...cameraFrame.backward };
    let yAxis = normalizeOrUndefined(cross(normal, xAxis));
    if (!yAxis) {
      yAxis = normalizeOrUndefined(cross(cameraFrame.up, xAxis)) ?? { ...cameraFrame.up };
    }
    let zAxis = normalize(cross(xAxis, yAxis));
    if (dot(zAxis, normal) < 0) {
      yAxis = negate(yAxis);
      zAxis = negate(zAxis);
    }
    writeBasisMatrix(matrix, xAxis, yAxis, zAxis, clipped.visible ? length : 0, width > 0 ? Math.max(0.001, width) : 0, 1, midpoint);
    return;
  }
  const reference = Math.abs(xAxis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const normal = normalize(cross(xAxis, reference));
  const yAxis = normalize(cross(normal, xAxis));
  writeBasisMatrix(matrix, xAxis, yAxis, normal, clipped.visible ? length : 0, width > 0 ? Math.max(0.001, width) : 0, 1, midpoint);
}

/** Clips a straight link to the resolved visual radii of its endpoint nodes. */
export function clipLinkEndpoints(
  source: Vec3,
  target: Vec3,
  sourceRadius: number,
  targetRadius: number
): { source: Vec3; target: Vec3; visible: boolean } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const dz = target.z - source.z;
  const centerDistance = Math.hypot(dx, dy, dz);
  const midpoint = {
    x: (source.x + target.x) * 0.5,
    y: (source.y + target.y) * 0.5,
    z: (source.z + target.z) * 0.5
  };
  const sourceTrim = Math.max(0.001, sourceRadius);
  const targetTrim = Math.max(0.001, targetRadius);
  if (centerDistance <= sourceTrim + targetTrim || centerDistance <= 0.0001) {
    return { source: midpoint, target: midpoint, visible: false };
  }
  const inverseDistance = 1 / centerDistance;
  const direction = { x: dx * inverseDistance, y: dy * inverseDistance, z: dz * inverseDistance };
  return {
    source: {
      x: source.x + direction.x * sourceTrim,
      y: source.y + direction.y * sourceTrim,
      z: source.z + direction.z * sourceTrim
    },
    target: {
      x: target.x - direction.x * targetTrim,
      y: target.y - direction.y * targetTrim,
      z: target.z - direction.z * targetTrim
    },
    visible: true
  };
}

function createCameraFrame(): CameraFrame {
  return {
    valid: false,
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    backward: { x: 0, y: 0, z: 1 },
    position: { x: 0, y: 0, z: 0 },
    projection: undefined
  };
}

function readCameraFrame(frame: CameraFrame, camera: ThreeObject | undefined): boolean {
  const wasValid = frame.valid;
  const previous = {
    right: { ...frame.right },
    up: { ...frame.up },
    backward: { ...frame.backward },
    position: { ...frame.position },
    projection: frame.projection
  };
  const elements = asMatrixElements(asOptionalRecord(camera?.matrixWorld)?.elements);
  const projection = asMatrixElements(asOptionalRecord(camera?.projectionMatrix)?.elements);
  if (!elements) {
    frame.valid = false;
    const changed = wasValid || !sameMatrixElements(previous.projection, projection);
    frame.projection = projection;
    return changed;
  }
  const right = normalizeOrUndefined({ x: elements[0], y: elements[1], z: elements[2] });
  const up = normalizeOrUndefined({ x: elements[4], y: elements[5], z: elements[6] });
  const backward = normalizeOrUndefined({ x: elements[8], y: elements[9], z: elements[10] });
  if (!right || !up || !backward) {
    frame.valid = false;
    return wasValid;
  }
  Object.assign(frame.right, right);
  Object.assign(frame.up, up);
  Object.assign(frame.backward, backward);
  frame.position.x = elements[12];
  frame.position.y = elements[13];
  frame.position.z = elements[14];
  frame.valid = true;
  frame.projection = projection;
  return !wasValid
    || !sameVec3(previous.right, frame.right)
    || !sameVec3(previous.up, frame.up)
    || !sameVec3(previous.backward, frame.backward)
    || !sameVec3(previous.position, frame.position)
    || !sameMatrixElements(previous.projection, projection);
}

function sameMatrixElements(first: MatrixElements | undefined, second: MatrixElements | undefined): boolean {
  return first === second || (first !== undefined && second !== undefined && first.every((value, index) => value === second[index]));
}

function sameVec3(first: Vec3, second: Vec3): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function markPartialUpdateRange(
  value: NumericAttribute | ThreeObject | undefined,
  instances: ReadonlySet<number>,
  fallbackItemSize = 1
): void {
  if (!value || instances.size === 0) {
    return;
  }
  const numeric = 'attribute' in value && 'values' in value;
  const attribute: ThreeObject = numeric
    ? (value as NumericAttribute).attribute
    : value as ThreeObject;
  const itemSize: number = numeric
    ? (value as NumericAttribute).itemSize
    : fallbackItemSize;
  clearAttributeUpdateRanges(attribute);
  const sorted = [...instances].filter(Number.isInteger).sort((a, b) => a - b);
  let start = sorted[0];
  if (start === undefined) {
    return;
  }
  let previous = start;
  for (const instance of sorted.slice(1)) {
    if (instance === previous + 1) {
      previous = instance;
      continue;
    }
    addUpdateRange(attribute, start, previous, itemSize);
    start = instance;
    previous = instance;
  }
  addUpdateRange(attribute, start, previous, itemSize);
}

function addUpdateRange(attribute: ThreeObject, start: number, end: number, itemSize: number): void {
  const offset = start * itemSize;
  const count = (end - start + 1) * itemSize;
  if (typeof attribute.addUpdateRange === 'function') {
    call(attribute, 'addUpdateRange', offset, count);
    return;
  }
  const updateRange = asOptionalRecord(attribute.updateRange);
  if (updateRange) {
    updateRange.offset = offset;
    updateRange.count = count;
  }
}

function clearAttributeUpdateRanges(value: NumericAttribute | ThreeObject | undefined): void {
  if (!value) {
    return;
  }
  const attribute: ThreeObject = 'attribute' in value && 'values' in value
    ? (value as NumericAttribute).attribute
    : value as ThreeObject;
  if (typeof attribute.clearUpdateRanges === 'function') {
    call(attribute, 'clearUpdateRanges');
    return;
  }
  const updateRanges = attribute.updateRanges;
  if (Array.isArray(updateRanges)) {
    updateRanges.length = 0;
  }
  const updateRange = asOptionalRecord(attribute.updateRange);
  if (updateRange) {
    updateRange.offset = 0;
    updateRange.count = -1;
  }
}

function asMatrixElements(value: unknown): MatrixElements | undefined {
  if (!value || typeof value !== 'object' || !('length' in value)) {
    return undefined;
  }
  const values = value as ArrayLike<unknown>;
  if (values.length < 16) {
    return undefined;
  }
  const firstSixteen = Array.from({ length: 16 }, (_, index) => values[index]);
  return firstSixteen.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? firstSixteen as unknown as MatrixElements
    : undefined;
}

function writeBasisMatrix(
  matrix: ThreeObject,
  xAxis: Vec3,
  yAxis: Vec3,
  zAxis: Vec3,
  xScale: number,
  yScale: number,
  zScale: number,
  position: Vec3
): void {
  call(
    matrix,
    'set',
    xAxis.x * xScale, yAxis.x * yScale, zAxis.x * zScale, position.x,
    xAxis.y * xScale, yAxis.y * yScale, zAxis.y * zScale, position.y,
    xAxis.z * xScale, yAxis.z * yScale, zAxis.z * zScale, position.z,
    0, 0, 0, 1
  );
}

function construct(value: unknown, ...args: unknown[]): ThreeObject {
  const Constructor = asConstructor(value);
  if (!Constructor) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'The injected Three module is missing a required constructor.');
  }
  return new Constructor(...args) as ThreeObject;
}

function asConstructor(value: unknown): ThreeConstructor | undefined {
  return typeof value === 'function' ? value as ThreeConstructor : undefined;
}

function asRecord(value: unknown): ThreeObject {
  return value && typeof value === 'object' ? value as ThreeObject : {};
}

function asOptionalRecord(value: unknown): ThreeObject | undefined {
  return value && typeof value === 'object' ? value as ThreeObject : undefined;
}

function hasProperty(value: ThreeObject, key: string): boolean {
  return key in value;
}

function call(target: ThreeObject | undefined, method: string, ...args: unknown[]): unknown {
  if (!target) {
    return undefined;
  }
  const value = target[method];
  return typeof value === 'function' ? value.apply(target, args) : undefined;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeOpacity(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.55;
}

function nextCapacity(current: number, required: number): number {
  let capacity = Math.max(1, current);
  while (capacity < required) capacity *= 2;
  return capacity;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalize(value: Vec3): Vec3 {
  const length = Math.max(1e-6, Math.hypot(value.x, value.y, value.z));
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function normalizeOrUndefined(value: Vec3): Vec3 | undefined {
  const length = Math.hypot(value.x, value.y, value.z);
  return Number.isFinite(length) && length > 1e-6
    ? { x: value.x / length, y: value.y / length, z: value.z / length }
    : undefined;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function negate(value: Vec3): Vec3 {
  return { x: -value.x, y: -value.y, z: -value.z };
}
