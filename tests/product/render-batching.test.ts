import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ThreePlatform } from '../../source/platform/three/createThreePlatform.js';
import { NodeFlags } from '../../source/core/types.js';
import { GraphStore } from '../../source/data/GraphStore.js';
import {
  GraphPickingState,
  OwnedRenderLayer,
  disposeRenderLayerResources,
  type RenderLayerResources
} from '../../source/render/RenderLayerResources.js';
import { clipLinkEndpoints, ThreeGraphRenderer } from '../../source/render/ThreeGraphRenderer.js';

const fakeLifecycle = {
  geometryDisposals: 0,
  materialDisposals: 0,
  failMeshCapacity: undefined as number | undefined,
  failPopulateCapacity: undefined as number | undefined,
  failAddAfter: undefined as number | undefined,
  failRemoveAfter: undefined as number | undefined,
  addCalls: 0,
  removeCalls: 0
};

class FakeObject3D {
  readonly children: unknown[] = [];

  add(child: unknown): void {
    fakeLifecycle.addCalls += 1;
    if (fakeLifecycle.failAddAfter !== undefined && fakeLifecycle.addCalls >= fakeLifecycle.failAddAfter) {
      fakeLifecycle.failAddAfter = undefined;
      throw new Error('injected scene add failure');
    }
    this.children.push(child);
  }

  remove(child: unknown): void {
    fakeLifecycle.removeCalls += 1;
    if (fakeLifecycle.failRemoveAfter !== undefined && fakeLifecycle.removeCalls >= fakeLifecycle.failRemoveAfter) {
      fakeLifecycle.failRemoveAfter = undefined;
      throw new Error('injected scene remove failure');
    }
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
  }
}

class FakeGeometry {
  disposed = false;

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      fakeLifecycle.geometryDisposals += 1;
    }
  }
}

class FakeCircleGeometry extends FakeGeometry {}

class FakeMaterial {
  opacity = 1;
  transparent = false;
  depthWrite = true;
  needsUpdate = false;
  colorNode: unknown = null;
  opacityNode: unknown = null;

  constructor(options: Record<string, unknown>) {
    Object.assign(this, options);
  }

  disposed = false;

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      fakeLifecycle.materialDisposals += 1;
    }
  }
}

class FakeMeshBasicNodeMaterial extends FakeMaterial {}

class FakeSpriteNodeMaterial extends FakeMaterial {}

class FakeUniform {
  constructor(public value: number) {}
}

const fakeMaterialColor = { kind: 'material-color' };

class FakeMatrix4 {
  static constructions = 0;

  constructor() {
    FakeMatrix4.constructions += 1;
  }

  values: number[] = [];

  makeScale(...values: number[]): this {
    this.values = values;
    return this;
  }

  setPosition(...values: number[]): this {
    this.values.push(...values);
    return this;
  }

  set(...values: number[]): this {
    this.values = values;
    return this;
  }
}

class FakeColor {
  static constructions = 0;

  constructor() {
    FakeColor.constructions += 1;
  }

  value = 0;

  set(value: number): this {
    this.value = value;
    return this;
  }
}

class FakeInstancedMesh extends FakeObject3D {
  count = 0;
  setMatrixAtCalls = 0;
  setColorAtCalls = 0;
  readonly instanceMatrix = {
    needsUpdate: false,
    setUsage: () => undefined
  };
  instanceColor: { needsUpdate: boolean } | undefined;
  readonly matrices = new Map<number, number[]>();
  readonly colors = new Map<number, number>();
  disposed = false;

  constructor(
    readonly geometry: FakeGeometry,
    readonly material: FakeMaterial,
    readonly capacity: number
  ) {
    super();
    if (fakeLifecycle.failMeshCapacity === capacity) {
      fakeLifecycle.failMeshCapacity = undefined;
      throw new Error(`injected mesh allocation failure at capacity ${capacity}`);
    }
  }

  setMatrixAt(instance: number, matrix: FakeMatrix4): void {
    if (fakeLifecycle.failPopulateCapacity === this.capacity) {
      fakeLifecycle.failPopulateCapacity = undefined;
      throw new Error(`injected population failure at capacity ${this.capacity}`);
    }
    this.setMatrixAtCalls += 1;
    this.matrices.set(instance, [...matrix.values]);
  }

  setColorAt(instance: number, color: FakeColor): void {
    this.setColorAtCalls += 1;
    this.colors.set(instance, color.value);
    this.instanceColor ??= { needsUpdate: false };
  }

  dispose(): void {
    this.disposed = true;
  }
}

function fakePlatform(): ThreePlatform {
  return {
    THREE: {
      Group: FakeObject3D,
      PlaneGeometry: FakeGeometry,
      CircleGeometry: FakeCircleGeometry,
      MeshBasicNodeMaterial: FakeMeshBasicNodeMaterial,
      SpriteNodeMaterial: FakeSpriteNodeMaterial,
      InstancedMesh: FakeInstancedMesh,
      Matrix4: FakeMatrix4,
      Color: FakeColor,
      DynamicDrawUsage: 1
    },
    TSL: {
      materialColor: fakeMaterialColor,
      uniform: (value: number) => new FakeUniform(value)
    },
    capabilities: { webgpuRenderer: false, nodeMaterials: true, raycasting: false }
  };
}

function resetFakeLifecycle(): void {
  fakeLifecycle.geometryDisposals = 0;
  fakeLifecycle.materialDisposals = 0;
  fakeLifecycle.failMeshCapacity = undefined;
  fakeLifecycle.failPopulateCapacity = undefined;
  fakeLifecycle.failAddAfter = undefined;
  fakeLifecycle.failRemoveAfter = undefined;
  fakeLifecycle.addCalls = 0;
  fakeLifecycle.removeCalls = 0;
}

test('link clipping terminates at dynamic endpoint radii and suppresses fully occluded segments', () => {
  const clipped = clipLinkEndpoints(
    { x: 0, y: 0, z: 0 },
    { x: 20, y: 0, z: 0 },
    4,
    3
  );
  assert.deepEqual(clipped, {
    source: { x: 4, y: 0, z: 0 },
    target: { x: 17, y: 0, z: 0 },
    visible: true
  });

  const occluded = clipLinkEndpoints(
    { x: 0, y: 0, z: 0 },
    { x: 6, y: 0, z: 0 },
    4,
    3
  );
  assert.deepEqual(occluded, {
    source: { x: 3, y: 0, z: 0 },
    target: { x: 3, y: 0, z: 0 },
    visible: false
  });
});

test('render-layer ownership isolates node capacity, link capacity, and picking state', () => {
  const nodeInitialMesh = new FakeInstancedMesh(new FakeGeometry(), new FakeMaterial({}), 1);
  const nodeNextMesh = new FakeInstancedMesh(new FakeGeometry(), new FakeMaterial({}), 2);
  const linkInitialMesh = new FakeInstancedMesh(new FakeGeometry(), new FakeMaterial({}), 3);
  const nodeInitial = { geometry: new FakeGeometry(), mesh: nodeInitialMesh, attributes: undefined, capacity: 1 } as unknown as RenderLayerResources<never>;
  const nodeNext = { geometry: new FakeGeometry(), mesh: nodeNextMesh, attributes: undefined, capacity: 2 } as unknown as RenderLayerResources<never>;
  const linkInitial = { geometry: new FakeGeometry(), mesh: linkInitialMesh, attributes: undefined, capacity: 3 } as unknown as RenderLayerResources<never>;
  const nodeLayer = new OwnedRenderLayer(nodeInitial);
  const linkLayer = new OwnedRenderLayer(linkInitial);
  const picking = new GraphPickingState();
  picking.nodeInstanceIds = ['node'];
  picking.nodePositions = [{ x: 1, y: 2, z: 3 }];
  picking.nodeRadii = [4];

  const previousNode = nodeLayer.replace(nodeNext);
  disposeRenderLayerResources(previousNode);

  assert.equal(nodeLayer.capacity, 2);
  assert.equal(linkLayer.capacity, 3);
  assert.equal(linkLayer.resources, linkInitial);
  assert.deepEqual(picking.nodeInstanceIds, ['node']);
  assert.deepEqual(picking.nodePositions, [{ x: 1, y: 2, z: 3 }]);
  assert.deepEqual(picking.nodeRadii, [4]);
  assert.equal(linkInitialMesh.disposed, false);
  nodeLayer.dispose();
  assert.equal(nodeNextMesh.disposed, true);
  assert.equal(linkInitialMesh.disposed, false);
  linkLayer.dispose();
});

test('renderer construction releases candidates when capability validation fails', () => {
  resetFakeLifecycle();
  assert.throws(
    () => new ThreeGraphRenderer(fakePlatform(), 0.55, 'pixel'),
    (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === 'FG_RENDER_CAPABILITY_UNAVAILABLE'
  );
  assert.equal(fakeLifecycle.geometryDisposals, 2);
  assert.equal(fakeLifecycle.materialDisposals, 2);
});

test('CPU fallback reports the device limit without claiming an active position atlas', () => {
  const renderer = new ThreeGraphRenderer(fakePlatform(), 0.55, 'world', 128, {}, undefined, undefined, 64);
  const stats = renderer.getStats();
  assert.equal(stats.deviceMaxTextureSize, 64);
  assert.equal(stats.positionAtlasWidth, 0);
  assert.equal(stats.positionAtlasMaxHeight, 0);
  assert.equal(stats.positionAtlasMaxNodeCapacity, 0);
  renderer.dispose();
});

test('renderer capacity growth keeps the old layers usable until replacement succeeds', () => {
  resetFakeLifecycle();
  const renderer = new ThreeGraphRenderer(fakePlatform());
  const first = new GraphStore();
  first.setData({ nodes: [{ id: 'a' }], links: [] });
  renderer.syncData(first);
  const group = renderer.object3D as unknown as FakeObject3D;
  const oldNode = group.children[1] as FakeInstancedMesh;
  const disposalsBeforeFailure = fakeLifecycle.geometryDisposals;
  const expanded = new GraphStore();
  expanded.setData({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });

  fakeLifecycle.failMeshCapacity = 2;
  assert.throws(() => renderer.syncData(expanded), /injected mesh allocation failure/);
  assert.equal(oldNode.disposed, false);
  assert.equal(group.children.includes(oldNode), true);
  assert.equal(fakeLifecycle.geometryDisposals, disposalsBeforeFailure + 2);

  renderer.syncData(expanded);
  assert.equal(oldNode.disposed, true);
  assert.equal((group.children[1] as FakeInstancedMesh).capacity, 2);
  renderer.dispose();
});

test('renderer compaction replaces only oversized layers after a temporary peak', () => {
  resetFakeLifecycle();
  const renderer = new ThreeGraphRenderer(fakePlatform());
  const peak = new GraphStore();
  peak.setData({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    links: [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }, { id: 'cd', source: 'c', target: 'd' }]
  });
  renderer.syncData(peak);
  const group = renderer.object3D as unknown as FakeObject3D;
  const peakLink = group.children[0] as FakeInstancedMesh;
  const peakNode = group.children[1] as FakeInstancedMesh;
  const reduced = new GraphStore();
  reduced.setData({ nodes: [{ id: 'a' }], links: [] });

  assert.equal(renderer.compact(reduced), true);
  assert.equal(peakLink.disposed, true);
  assert.equal(peakNode.disposed, true);
  assert.equal((group.children[0] as FakeInstancedMesh).capacity, 1);
  assert.equal((group.children[1] as FakeInstancedMesh).capacity, 1);
  assert.equal(renderer.compact(reduced), false);
  renderer.dispose();
});

test('renderer link-only growth atomically replaces both populated layers', () => {
  resetFakeLifecycle();
  const renderer = new ThreeGraphRenderer(fakePlatform());
  const initial = new GraphStore();
  initial.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [{ id: 'ab', source: 'a', target: 'b' }]
  });
  renderer.syncData(initial);
  const group = renderer.object3D as unknown as FakeObject3D;
  const oldLink = group.children[0] as FakeInstancedMesh;
  const oldNode = group.children[1] as FakeInstancedMesh;
  const expanded = new GraphStore();
  expanded.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [{ id: 'ab', source: 'a', target: 'b' }, { id: 'ba', source: 'b', target: 'a' }]
  });

  fakeLifecycle.failMeshCapacity = 2;
  assert.throws(() => renderer.syncData(expanded), /injected mesh allocation failure/);
  assert.equal(oldNode.disposed, false);
  assert.equal(group.children.length, 2);
  assert.equal(group.children[0], oldLink);
  assert.equal(group.children[1], oldNode);

  renderer.syncData(expanded);
  assert.equal(oldNode.disposed, true);
  assert.equal((group.children[0] as FakeInstancedMesh).capacity, 2);
  assert.notEqual(group.children[1], oldNode);
  renderer.dispose();
});

test('renderer full sync failure without capacity growth preserves live state and diagnostics', () => {
  resetFakeLifecycle();
  const renderer = new ThreeGraphRenderer(fakePlatform());
  const initial = new GraphStore();
  initial.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [{ id: 'ab', source: 'a', target: 'b' }]
  });
  renderer.syncData(initial);
  const group = renderer.object3D as unknown as FakeObject3D;
  const oldLink = group.children[0] as FakeInstancedMesh;
  const oldNode = group.children[1] as FakeInstancedMesh;
  const before = renderer.getStats();
  const replacement = new GraphStore();
  replacement.setData({
    nodes: [{ id: 'x' }, { id: 'y' }],
    links: [{ id: 'xy', source: 'x', target: 'y' }]
  });

  fakeLifecycle.failPopulateCapacity = 2;
  assert.throws(() => renderer.syncData(replacement), /injected population failure/);
  assert.equal(group.children[0], oldLink);
  assert.equal(group.children[1], oldNode);
  assert.equal(oldLink.disposed, false);
  assert.equal(oldNode.disposed, false);
  assert.deepEqual(renderer.getStats(), before);
  renderer.dispose();
});

test('renderer grows both layers from populated owned candidates before swapping', () => {
  resetFakeLifecycle();
  const renderer = new ThreeGraphRenderer(fakePlatform());
  const initial = new GraphStore();
  initial.setData({ nodes: [{ id: 'a' }], links: [] });
  renderer.syncData(initial);
  const group = renderer.object3D as unknown as FakeObject3D;
  const oldLink = group.children[0] as FakeInstancedMesh;
  const oldNode = group.children[1] as FakeInstancedMesh;
  const disposalsBeforeFailure = fakeLifecycle.geometryDisposals;
  const expanded = new GraphStore();
  expanded.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'ba', source: 'b', target: 'a' }
    ]
  });

  fakeLifecycle.failPopulateCapacity = 2;
  assert.throws(() => renderer.syncData(expanded), /injected population failure/);
  assert.equal(oldLink.disposed, false);
  assert.equal(oldNode.disposed, false);
  assert.equal(group.children[0], oldLink);
  assert.equal(group.children[1], oldNode);
  assert.equal(fakeLifecycle.geometryDisposals, disposalsBeforeFailure + 2);

  renderer.syncData(expanded);
  assert.equal(oldLink.disposed, true);
  assert.equal(oldNode.disposed, true);
  assert.equal((group.children[0] as FakeInstancedMesh).capacity, 2);
  assert.equal((group.children[1] as FakeInstancedMesh).capacity, 2);
  renderer.dispose();
});

test('renderer disposes only owned candidates when population or scene attachment fails', () => {
  resetFakeLifecycle();
  const renderer = new ThreeGraphRenderer(fakePlatform());
  const initial = new GraphStore();
  initial.setData({ nodes: [{ id: 'a' }], links: [] });
  renderer.syncData(initial);
  const group = renderer.object3D as unknown as FakeObject3D;
  const oldNode = group.children[1] as FakeInstancedMesh;
  const disposalsBeforeFailure = fakeLifecycle.geometryDisposals;
  const expanded = new GraphStore();
  expanded.setData({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });

  fakeLifecycle.failPopulateCapacity = 2;
  assert.throws(() => renderer.syncData(expanded), /injected population failure/);
  assert.equal(oldNode.disposed, false);
  assert.equal(group.children[1], oldNode);
  assert.equal(fakeLifecycle.geometryDisposals, disposalsBeforeFailure + 2);

  fakeLifecycle.failAddAfter = fakeLifecycle.addCalls + 1;
  assert.throws(() => renderer.syncData(expanded), /injected scene add failure/);
  assert.equal(oldNode.disposed, false);
  assert.equal(group.children[1], oldNode);
  assert.equal(fakeLifecycle.geometryDisposals, disposalsBeforeFailure + 4);

  fakeLifecycle.failRemoveAfter = fakeLifecycle.removeCalls + 3;
  assert.throws(() => renderer.syncData(expanded), /injected scene remove failure/);
  assert.equal(oldNode.disposed, false);
  assert.equal(group.children[1], oldNode);
  assert.equal(fakeLifecycle.geometryDisposals, disposalsBeforeFailure + 6);

  renderer.syncData(expanded);
  assert.equal(oldNode.disposed, true);
  renderer.dispose();
});

test('ThreeGraphRenderer reuses matrix and color scratch objects across batched syncs', () => {
  FakeMatrix4.constructions = 0;
  FakeColor.constructions = 0;
  const store = new GraphStore();
  store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [{ id: 'edge', source: 'a', target: 'b' }]
  });
  const renderer = new ThreeGraphRenderer(fakePlatform());

  renderer.syncData(store);
  renderer.syncPositions(store);
  renderer.syncPositions(store);
  renderer.setLinkOpacity(2);

  assert.equal(FakeMatrix4.constructions, 2);
  assert.equal(FakeColor.constructions, 1);
  const group = renderer.object3D as unknown as FakeObject3D;
  const linkMesh = group.children[0] as FakeInstancedMesh;
  const nodeMesh = group.children[1] as FakeInstancedMesh;
  assert.equal(linkMesh.material.opacity, 1);
  assert.equal(linkMesh.material.transparent, false);
  assert.ok(nodeMesh.material instanceof FakeMeshBasicNodeMaterial);
  assert.ok(linkMesh.material instanceof FakeMeshBasicNodeMaterial);
  assert.equal(nodeMesh.material.colorNode, fakeMaterialColor);
  assert.equal(linkMesh.material.colorNode, fakeMaterialColor);
  assert.equal((linkMesh.material.opacityNode as FakeUniform).value, 1);
  assert.equal(renderer.getStats().materialPath, 'tsl');
  renderer.dispose();
  assert.equal(linkMesh.disposed, true);
});

test('ThreeGraphRenderer turns batched nodes and links toward the supplied camera frame', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [
      { id: 'a', initialPosition: { x: 0, y: 0, z: 0 } },
      { id: 'b', initialPosition: { x: 0, y: 4, z: 0 } }
    ],
    links: [{ id: 'edge', source: 'a', target: 'b' }]
  });
  const renderer = new ThreeGraphRenderer(fakePlatform());
  const camera = {
    matrixWorld: {
      elements: [
        0, 0, -1, 0,
        0, 1, 0, 0,
        1, 0, 0, 0,
        10, 0, 0, 1
      ]
    }
  };

  renderer.syncData(store, camera);

  const group = renderer.object3D as unknown as FakeObject3D;
  const linkMesh = group.children[0] as FakeInstancedMesh;
  const nodeMesh = group.children[1] as FakeInstancedMesh;
  assert.ok(nodeMesh.geometry instanceof FakeCircleGeometry);
  const nodeMatrix = nodeMesh.matrices.get(0);
  assert.ok(nodeMatrix);
  assert.deepEqual(nodeMatrix.slice(0, 12), [0, 0, 1, 0, 0, 2, 0, 0, -2, 0, 0, 0]);

  const linkMatrix = linkMesh.matrices.get(0);
  assert.ok(linkMatrix);
  const linkNormal = { x: linkMatrix[2]!, y: linkMatrix[6]!, z: linkMatrix[10]! };
  const midpointToCamera = { x: 10, y: -2, z: 0 };
  assert.ok(
    linkNormal.x * midpointToCamera.x
      + linkNormal.y * midpointToCamera.y
      + linkNormal.z * midpointToCamera.z > 0
  );
  renderer.dispose();
});

test('ThreeGraphRenderer applies graph interaction flags through instance state without replacing materials', () => {
  const store = new GraphStore();
  store.setData({ nodes: [{ id: 'node' }], links: [] });
  const renderer = new ThreeGraphRenderer(fakePlatform());
  renderer.syncData(store);
  const nodeMesh = (renderer.object3D as unknown as FakeObject3D).children[1] as FakeInstancedMesh;
  const initialColor = nodeMesh.colors.get(0);
  const initialScale = nodeMesh.matrices.get(0)?.[0];

  assert.equal(store.setNodeFlags('node', NodeFlags.Selected | NodeFlags.Hovered), true);
  renderer.syncNodeStates(store, ['node']);

  assert.notEqual(nodeMesh.colors.get(0), initialColor);
  assert.ok((nodeMesh.matrices.get(0)?.[0] ?? 0) > (initialScale ?? 0));
  assert.ok(nodeMesh.material instanceof FakeMeshBasicNodeMaterial);
  assert.equal(nodeMesh.instanceColor?.needsUpdate, true);
  renderer.dispose();
});

test('ThreeGraphRenderer applies a custom state theme and collapses hidden geometry', () => {
  const store = new GraphStore();
  store.setData({ nodes: [{ id: 'node' }], links: [] });
  const renderer = new ThreeGraphRenderer(fakePlatform(), 0.55, 'world', undefined, {}, {
    selected: { scale: 2, color: 0xff0000, colorMix: 1 },
    hidden: { visible: false }
  });
  renderer.syncData(store);
  const nodeMesh = (renderer.object3D as unknown as FakeObject3D).children[1] as FakeInstancedMesh;

  assert.equal(store.setNodeFlags('node', NodeFlags.Selected), true);
  renderer.syncNodeStates(store, ['node']);
  assert.equal(nodeMesh.colors.get(0), 0xff0000);
  assert.equal(nodeMesh.matrices.get(0)?.[0], 4);

  assert.equal(store.setNodeFlags('node', NodeFlags.Hidden), true);
  renderer.syncNodeStates(store, ['node']);
  assert.equal(nodeMesh.matrices.get(0)?.[0], 0);
  renderer.dispose();
});

test('theme-derived refresh keeps picking and incident-link visibility on one resolver', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [
      { id: 'a', initialPosition: { x: -4, y: 0, z: 0 } },
      { id: 'b', initialPosition: { x: 4, y: 0, z: 0 } }
    ],
    links: [{ id: 'a-b', source: 'a', target: 'b' }]
  });
  const renderer = new ThreeGraphRenderer(fakePlatform());
  renderer.syncData(store);
  const picking = (renderer as unknown as { picking: GraphPickingState }).picking;
  const group = renderer.object3D as unknown as FakeObject3D;
  const linkMesh = group.children[0] as FakeInstancedMesh;

  assert.equal(store.setNodeFlags('a', NodeFlags.Selected), true);
  renderer.setStateTheme({ selected: { scale: 3 } });
  renderer.syncFrame(store, undefined, { themeDerived: true });
  assert.equal(picking.nodeRadii[0], 3);
  assert.equal(picking.nodePickable[0], true);

  renderer.setStateTheme({ selected: { visible: false } });
  renderer.syncFrame(store, undefined, { themeDerived: true });
  assert.equal(picking.nodeRadii[0], 0);
  assert.equal(picking.nodePickable[0], false);
  assert.equal(linkMesh.matrices.get(0)?.[5], 0);

  assert.equal(store.setNodeFlags('a', NodeFlags.Hidden, NodeFlags.Selected), true);
  renderer.setStateTheme({ hidden: { visible: true } });
  renderer.syncFrame(store, undefined, { nodeStateIds: ['a'], themeDerived: true });
  assert.equal(picking.nodePickable[0], true);
  assert.ok((linkMesh.matrices.get(0)?.[5] ?? 0) > 0);

  assert.equal(store.setNodeFlags('a', NodeFlags.Dimmed, NodeFlags.Hidden), true);
  renderer.setStateTheme({ dimmed: { visible: false } });
  renderer.syncFrame(store, undefined, { nodeStateIds: ['a'], themeDerived: true });
  assert.equal(picking.nodePickable[0], false);
  assert.equal(linkMesh.matrices.get(0)?.[5], 0);
  renderer.dispose();
});

test('ThreeGraphRenderer rejects stale and invisible GPU-ID results with monotonic picking revisions', async () => {
  const store = new GraphStore();
  store.setData({ nodes: [{ id: 'node' }], links: [] });
  const requests: Array<{
    request: { readonly topologyRevision: number; readonly pickingRevision: number };
    resolve: (nodeId: string | undefined) => void;
  }> = [];
  const renderer = new ThreeGraphRenderer(fakePlatform(), 0.55, 'world', undefined, {
    mode: 'gpu-id',
    gpuIdThreshold: 1,
    gpuIdPicker: (request) => new Promise((resolve) => requests.push({ request, resolve }))
  });
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 })
  } as unknown as HTMLCanvasElement;
  const event = { clientX: 10, clientY: 10 } as PointerEvent;
  renderer.syncData(store);

  const stale = renderer.pickNodeAsync(event, {} as Record<string, unknown>, canvas);
  assert.ok(requests[0]!.request.pickingRevision > 0);
  renderer.setStateTheme({ hidden: { visible: false } });
  renderer.syncFrame(store, undefined, { themeDerived: true });
  requests[0]!.resolve('node');
  assert.equal(await stale, undefined);

  const current = renderer.pickNodeAsync(event, {} as Record<string, unknown>, canvas);
  requests[1]!.resolve('node');
  assert.equal(await current, 'node');

  assert.equal(store.setNodeFlags('node', NodeFlags.Hidden), true);
  renderer.syncNodeStates(store, ['node']);
  const hidden = renderer.pickNodeAsync(event, {} as Record<string, unknown>, canvas);
  requests[2]!.resolve('node');
  assert.equal(await hidden, undefined);
  renderer.dispose();
});

test('ThreeGraphRenderer dims and hides links incident to application-managed node flags', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [
      { id: 'a', initialPosition: { x: -2, y: 0, z: 0 } },
      { id: 'b', initialPosition: { x: 2, y: 0, z: 0 } }
    ],
    links: [{ id: 'a-b', source: 'a', target: 'b' }]
  });
  const renderer = new ThreeGraphRenderer(fakePlatform(), 0.55, 'world', undefined, {}, {
    incidentLinks: {
      dimmed: { scale: 0.25, color: 0xff0000, colorMix: 1 },
      hidden: { scale: 0.125, color: 0x00ff00, colorMix: 1 }
    }
  });
  renderer.syncData(store);
  const linkMesh = (renderer.object3D as unknown as FakeObject3D).children[0] as FakeInstancedMesh;
  const initialMatrix = linkMesh.matrices.get(0);
  const initialColor = linkMesh.colors.get(0);

  assert.equal(store.setNodeFlags('a', NodeFlags.Dimmed), true);
  renderer.syncFrame(store, undefined, { nodeStateIds: ['a'], linkStyleIds: ['a-b'] });
  assert.notDeepEqual(linkMesh.matrices.get(0), initialMatrix);
  assert.equal(linkMesh.colors.get(0), 0xff0000);

  assert.equal(store.setNodeFlags('b', NodeFlags.Hidden), true);
  renderer.syncFrame(store, undefined, { nodeStateIds: ['b'], linkStyleIds: ['a-b'] });
  assert.equal(linkMesh.colors.get(0), 0x00ff00);
  assert.equal(linkMesh.matrices.get(0)?.[5], 0);
  renderer.dispose();
});

test('ThreeGraphRenderer updates only the explicitly changed node instances', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    links: [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }]
  });
  const renderer = new ThreeGraphRenderer(fakePlatform());
  renderer.syncData(store);
  const group = renderer.object3D as unknown as FakeObject3D;
  const nodeMesh = group.children[1] as FakeInstancedMesh;
  const linkMesh = group.children[0] as FakeInstancedMesh;
  nodeMesh.setMatrixAtCalls = 0;
  nodeMesh.setColorAtCalls = 0;
  linkMesh.setMatrixAtCalls = 0;
  linkMesh.setColorAtCalls = 0;

  store.setNodeFlags('b', NodeFlags.Hovered);
  renderer.syncNodeStates(store, ['b']);

  assert.equal(nodeMesh.setMatrixAtCalls, 1);
  assert.equal(nodeMesh.setColorAtCalls, 1);
  assert.equal(linkMesh.setMatrixAtCalls, 0);
  assert.equal(linkMesh.setColorAtCalls, 0);
  renderer.dispose();
});

test('ThreeGraphRenderer updates only the explicitly changed link style instances', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    links: [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }]
  });
  const renderer = new ThreeGraphRenderer(fakePlatform());
  renderer.syncData(store);
  const group = renderer.object3D as unknown as FakeObject3D;
  const nodeMesh = group.children[1] as FakeInstancedMesh;
  const linkMesh = group.children[0] as FakeInstancedMesh;
  nodeMesh.setMatrixAtCalls = 0;
  nodeMesh.setColorAtCalls = 0;
  linkMesh.setMatrixAtCalls = 0;
  linkMesh.setColorAtCalls = 0;

  const link = store.getLinkRenderStateById('bc');
  assert.ok(link);
  assert.equal(store.setLinkRenderStyle(link.index, 3, 0xff00aa), true);
  renderer.syncLinkStyles(store, ['bc', 'bc']);

  assert.equal(nodeMesh.setMatrixAtCalls, 0);
  assert.equal(nodeMesh.setColorAtCalls, 0);
  assert.equal(linkMesh.setMatrixAtCalls, 1);
  assert.equal(linkMesh.setColorAtCalls, 1);
  renderer.dispose();
});

test('ThreeGraphRenderer consumes state colors during a complete CPU position pass', () => {
  const store = new GraphStore();
  store.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [{ id: 'edge', source: 'a', target: 'b' }]
  });
  const renderer = new ThreeGraphRenderer(fakePlatform());
  renderer.syncData(store);
  const group = renderer.object3D as unknown as FakeObject3D;
  const nodeMesh = group.children[1] as FakeInstancedMesh;
  const linkMesh = group.children[0] as FakeInstancedMesh;
  nodeMesh.setColorAtCalls = 0;
  linkMesh.setColorAtCalls = 0;
  if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = false;
  if (linkMesh.instanceColor) linkMesh.instanceColor.needsUpdate = false;
  store.setNodeFlags('b', NodeFlags.Selected);
  assert.equal(store.setLinkRenderStyle(0, 3, 0xff00aa), true);

  renderer.syncFrame(store, undefined, {
    positions: true,
    nodeStateIds: ['b'],
    linkStyleIds: ['edge']
  });

  assert.equal(nodeMesh.setColorAtCalls, 1);
  assert.equal(linkMesh.setColorAtCalls, 1);
  assert.equal(nodeMesh.instanceColor?.needsUpdate, true);
  assert.equal(linkMesh.instanceColor?.needsUpdate, true);
  renderer.dispose();
});
