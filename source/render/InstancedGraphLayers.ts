export type LayerThreeObject = Record<string, unknown>;

/** Creates the owned reusable geometry and mesh surfaces for graph layers. */
export function createNodeGeometry(three: LayerThreeObject): LayerThreeObject {
  return typeof three.CircleGeometry === 'function'
    ? construct(three.CircleGeometry, 0.5, 16)
    : construct(three.PlaneGeometry, 1, 1);
}

export function createLinkGeometry(three: LayerThreeObject): LayerThreeObject {
  return construct(three.PlaneGeometry, 1, 1);
}

export function createGraphLayerMesh(
  three: LayerThreeObject,
  geometry: LayerThreeObject,
  material: LayerThreeObject,
  capacity: number,
  transformPath: 'tsl' | 'cpu'
): LayerThreeObject {
  if (transformPath === 'tsl') {
    geometry.isInstancedBufferGeometry = true;
    geometry.instanceCount = capacity;
    const mesh = construct(three.Mesh, geometry, material);
    mesh.frustumCulled = false;
    return mesh;
  }
  const mesh = construct(three.InstancedMesh, geometry, material, capacity);
  mesh.frustumCulled = false;
  const matrix = asRecord(mesh.instanceMatrix);
  if (matrix && three.DynamicDrawUsage !== undefined) call(matrix, 'setUsage', three.DynamicDrawUsage);
  return mesh;
}

export function setGraphLayerInstanceCount(
  geometry: LayerThreeObject,
  mesh: LayerThreeObject,
  count: number,
  transformPath: 'tsl' | 'cpu'
): void {
  if (transformPath === 'tsl') {
    geometry.instanceCount = count;
    return;
  }
  mesh.count = count;
}

export function clearGraphAttributes(nodeGeometry: LayerThreeObject, linkGeometry: LayerThreeObject): void {
  for (const name of ['graphRadius', 'graphColor', 'graphState', 'graphFlowRole']) call(nodeGeometry, 'deleteAttribute', name);
  for (const name of ['graphSourceIndex', 'graphTargetIndex', 'graphSourceRadius', 'graphTargetRadius', 'graphWidth', 'graphLinkColor']) call(linkGeometry, 'deleteAttribute', name);
}

function construct(value: unknown, ...args: unknown[]): LayerThreeObject {
  if (typeof value !== 'function') throw new Error('The injected Three platform is missing a required constructor.');
  return new (value as new (...parameters: unknown[]) => object)(...args) as LayerThreeObject;
}

function asRecord(value: unknown): LayerThreeObject | undefined {
  return value !== null && typeof value === 'object' ? value as LayerThreeObject : undefined;
}

function call(target: LayerThreeObject, method: string, ...args: unknown[]): unknown {
  const value = target[method];
  return typeof value === 'function' ? value.apply(target, args) : undefined;
}
