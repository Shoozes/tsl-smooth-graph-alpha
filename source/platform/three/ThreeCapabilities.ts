import type { RendererOptions } from '../../core/types.js';

export type ThreeCapabilityObject = Record<string, unknown>;

export interface TslFeatureRequirements {
  readonly transform: boolean;
  readonly nodeSurface: boolean;
  readonly linkFlow: boolean;
  readonly pixelWidths: boolean;
}

/** Resolves the exact renderer features that cannot use the CPU/world fallback. */
export function resolveTslFeatureRequirements(renderer: RendererOptions | undefined): TslFeatureRequirements {
  const pixelWidths = renderer?.linkWidthUnit === 'pixel';
  const nodeSurface = renderer?.nodeSurface?.profile === 'metallic'
    || renderer?.nodeSurface?.selectionEffect !== undefined;
  const linkFlow = renderer?.linkFlow !== undefined;
  return Object.freeze({
    transform: pixelWidths || nodeSurface || linkFlow,
    nodeSurface,
    linkFlow,
    pixelWidths
  });
}

/** Pure capability check for the shared node/link TSL transform. */
export function supportsTslGraphTransform(
  tsl: ThreeCapabilityObject,
  linkWidthUnit: 'world' | 'pixel'
): boolean {
  const requiredNodes = ['positionLocal', 'cameraWorldMatrix', 'cameraPosition', 'instanceIndex'];
  const requiredFunctions = [
    'attribute', 'normalize', 'cross', 'length', 'max', 'select', 'uniform',
    'floor', 'mix', 'vec3', 'round', 'texture', 'textureLoad', 'ivec2', 'int'
  ];
  if (requiredNodes.some((name) => !tsl[name])
    || requiredFunctions.some((name) => typeof tsl[name] !== 'function')) {
    return false;
  }
  return linkWidthUnit !== 'pixel'
    || (!!tsl.cameraViewMatrix
      && !!tsl.cameraProjectionMatrix
      && !!tsl.cameraViewport
      && typeof tsl.vec4 === 'function');
}

/** Pure capability check for the shared metallic/selection node surface. */
export function supportsTslNodeSurface(tsl: ThreeCapabilityObject): boolean {
  return ['dot', 'sqrt', 'pow', 'sin', 'uv'].every((name) => typeof tsl[name] === 'function');
}

/** Pure capability check for shared directional link-flow uniforms. */
export function supportsTslLinkFlow(tsl: ThreeCapabilityObject): boolean {
  return ['sin', 'pow', 'uv'].every((name) => typeof tsl[name] === 'function');
}

/** Lists the structurally provable Three requirements for the shared TSL path. */
export function missingThreeTslGraphResources(three: ThreeCapabilityObject): readonly string[] {
  const missing: string[] = [];
  for (const name of ['DataTexture', 'InstancedBufferAttribute', 'Mesh']) {
    if (typeof three[name] !== 'function') missing.push(name);
  }
  for (const name of ['RGBAFormat', 'FloatType', 'NearestFilter']) {
    if (three[name] === undefined) missing.push(name);
  }
  if (typeof three.MeshBasicNodeMaterial !== 'function' && typeof three.SpriteNodeMaterial !== 'function') {
    missing.push('MeshBasicNodeMaterial or SpriteNodeMaterial');
  }
  const nodeGeometry = typeof three.CircleGeometry === 'function' ? three.CircleGeometry : three.PlaneGeometry;
  if (!constructorHasMethod(nodeGeometry, 'setAttribute')) missing.push('node geometry setAttribute');
  if (!constructorHasMethod(three.PlaneGeometry, 'setAttribute')) missing.push('link geometry setAttribute');
  return Object.freeze(missing);
}

/** Shared position-atlas resource predicate used by preflight and allocation. */
export function supportsThreePositionAtlas(three: ThreeCapabilityObject): boolean {
  return typeof three.DataTexture === 'function'
    && three.RGBAFormat !== undefined
    && three.FloatType !== undefined
    && three.NearestFilter !== undefined;
}

/** Shared runtime attribute-attachment predicate used by the TSL layer builder. */
export function supportsThreeAttributeAttachment(
  three: ThreeCapabilityObject,
  geometry: ThreeCapabilityObject
): boolean {
  return typeof three.InstancedBufferAttribute === 'function'
    && typeof geometry.setAttribute === 'function';
}

function constructorHasMethod(value: unknown, method: string): boolean {
  if (typeof value !== 'function') return false;
  const prototype = (value as { prototype?: Record<string, unknown> }).prototype;
  return !!prototype && typeof prototype[method] === 'function';
}
