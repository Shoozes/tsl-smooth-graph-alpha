import type { GraphId, Vec3 } from '../core/types.js';
import type { LinkAttributeSet, NodeAttributeSet, ThreeObject } from './TslGraphLayers.js';

export interface RenderLayerResources<TAttributes> {
  readonly geometry: ThreeObject;
  readonly mesh: ThreeObject;
  readonly attributes: TAttributes | undefined;
  readonly capacity: number;
}

export type NodeLayerResources = RenderLayerResources<NodeAttributeSet>;
export type LinkLayerResources = RenderLayerResources<LinkAttributeSet>;

/** Owns exactly one node or link layer and never reaches across layer boundaries. */
export class OwnedRenderLayer<TAttributes> {
  private current: RenderLayerResources<TAttributes>;

  constructor(initial: RenderLayerResources<TAttributes>) {
    this.current = initial;
  }

  get resources(): RenderLayerResources<TAttributes> {
    return this.current;
  }

  get capacity(): number {
    return this.current.capacity;
  }

  replace(next: RenderLayerResources<TAttributes>): RenderLayerResources<TAttributes> {
    const previous = this.current;
    this.current = next;
    return previous;
  }

  dispose(): void {
    disposeRenderLayerResources(this.current);
  }
}

export function disposeRenderLayerResources(resources: RenderLayerResources<unknown> | undefined): void {
  if (!resources) {
    return;
  }
  call(resources.mesh, 'dispose');
  call(resources.geometry, 'dispose');
}

/** Keeps renderer-only ID and raycast data outside node/link resource ownership. */
export class GraphPickingState {
  nodeInstanceIds: Array<GraphId | undefined> = [];
  nodePositions: Array<Vec3 | undefined> = [];
  nodeRadii: number[] = [];
  nodePickable: boolean[] = [];
  readonly nodeInstanceById = new Map<GraphId, number>();
  nodeInstancesByStoreIndex: Array<number | undefined> = [];
  linkInstancesByStoreIndex: Array<number | undefined> = [];

  /** Replaces every render-derived mapping only after a complete population succeeds. */
  replace(population: PickingPopulation): void {
    this.nodeInstanceIds = population.nodeInstanceIds;
    this.nodePositions = population.nodePositions;
    this.nodeRadii = population.nodeRadii;
    this.nodePickable = population.nodePickable;
    this.nodeInstancesByStoreIndex = population.nodeInstancesByStoreIndex;
    this.linkInstancesByStoreIndex = population.linkInstancesByStoreIndex;
    this.nodeInstanceById.clear();
    for (let instance = 0; instance < this.nodeInstanceIds.length; instance += 1) {
      const id = this.nodeInstanceIds[instance];
      if (id !== undefined) this.nodeInstanceById.set(id, instance);
    }
  }

  beginNodeRebuild(): void {
    this.nodeInstanceIds = [];
    this.nodePositions = [];
    this.nodeRadii = [];
    this.nodePickable = [];
    this.nodeInstanceById.clear();
    this.nodeInstancesByStoreIndex = [];
  }

  setNode(instance: number, storeIndex: number, id: GraphId, position: Vec3, radius: number, pickable: boolean): void {
    this.nodeInstanceIds[instance] = id;
    this.nodeInstancesByStoreIndex[storeIndex] = instance;
    this.nodeInstanceById.set(id, instance);
    this.nodePositions[instance] = { ...position };
    this.nodeRadii[instance] = radius;
    this.nodePickable[instance] = pickable;
  }

  resolveVisibleId(id: GraphId | undefined): GraphId | undefined {
    const instance = id === undefined ? undefined : this.nodeInstanceById.get(id);
    return instance !== undefined && this.nodePickable[instance] === true ? id : undefined;
  }

  clear(): void {
    this.nodeInstanceIds = [];
    this.nodePositions = [];
    this.nodeRadii = [];
    this.nodePickable = [];
    this.nodeInstanceById.clear();
    this.nodeInstancesByStoreIndex = [];
    this.linkInstancesByStoreIndex = [];
  }
}

export interface PickingPopulation {
  readonly nodeInstanceIds: Array<GraphId | undefined>;
  readonly nodePositions: Array<Vec3 | undefined>;
  readonly nodeRadii: number[];
  readonly nodePickable: boolean[];
  readonly nodeInstancesByStoreIndex: Array<number | undefined>;
  readonly linkInstancesByStoreIndex: Array<number | undefined>;
}

function call(target: ThreeObject, method: string, ...args: unknown[]): unknown {
  const value = target[method];
  return typeof value === 'function' ? value.apply(target, args) : undefined;
}
