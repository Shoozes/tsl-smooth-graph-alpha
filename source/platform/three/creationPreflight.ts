import { GraphError } from '../../core/errors.js';
import type { ForceGraphOptions, GraphHostOptions, RendererOptions } from '../../core/types.js';
import type { ThreePlatform } from './createThreePlatform.js';
import {
  missingThreeTslGraphResources,
  resolveTslFeatureRequirements,
  supportsTslGraphTransform,
  supportsTslLinkFlow,
  supportsTslNodeSurface
} from './ThreeCapabilities.js';

type RuntimeObject = Record<string, unknown>;

/**
 * Validates the non-headless creation contract before a worker, renderer,
 * listener, observer, or other runtime resource can be acquired.
 */
export function preflightThreeCreation<TNode, TLink>(options: Readonly<ForceGraphOptions<TNode, TLink>>): void {
  const host = options.host ?? { mode: 'headless' as const };
  if (host.mode === 'headless') {
    validateHeadlessRendererOptions(options.renderer);
    return;
  }
  const platform = validatePlatform(options.platform);
  validateThreeRenderPrimitives(platform.THREE);
  if (host.mode === 'managed') {
    validateManagedHost(platform, host);
  } else {
    validateEmbeddedHost(platform, host, options.renderer);
  }
  validateRequestedRenderCapabilities(platform, host, options.renderer);
}

function validateHeadlessRendererOptions(renderer: RendererOptions | undefined): void {
  if (!renderer) {
    return;
  }
  const meaningfulStartupFacts = new Set<keyof RendererOptions>(['backend', 'linkWidthUnit']);
  const ignored = Object.keys(renderer).find((name) => !meaningfulStartupFacts.has(name as keyof RendererOptions));
  if (ignored !== undefined) {
    throw invalid(`Headless hosts cannot use renderer option ${ignored}.`);
  }
}

function validatePlatform(value: unknown): ThreePlatform {
  const platform = asRecord(value, 'Managed and embedded hosts require createThreePlatform({ THREE, TSL }).');
  const three = asRecord(platform.THREE, 'The injected platform THREE value must be a module object.');
  asRecord(platform.TSL, 'The injected platform TSL value must be a module object.');
  const capabilities = asRecord(platform.capabilities, 'The injected platform capabilities value must be an object.');
  for (const name of ['webgpuRenderer', 'nodeMaterials', 'raycasting']) {
    if (typeof capabilities[name] !== 'boolean') {
      throw invalid(`The injected platform capability ${name} must be a boolean.`);
    }
  }
  requireConstructors(three, ['Group', 'Object3D'], 'The injected THREE module');
  return value as ThreePlatform;
}

function validateThreeRenderPrimitives(three: RuntimeObject): void {
  requireConstructors(three, ['PlaneGeometry', 'InstancedMesh', 'Matrix4'], 'The injected THREE module');
  if (typeof three.MeshBasicNodeMaterial !== 'function'
    && typeof three.SpriteNodeMaterial !== 'function'
    && typeof three.MeshBasicMaterial !== 'function') {
    throw invalid('The injected THREE module must provide a node material or MeshBasicMaterial fallback.');
  }
}

function validateManagedHost(platform: ThreePlatform, host: Extract<GraphHostOptions, { mode: 'managed' }>): void {
  validateCanvas(host.canvas, 'Managed host canvas');
  requireConstructors(
    platform.THREE,
    ['WebGPURenderer', 'Scene', 'PerspectiveCamera'],
    'Managed rendering'
  );
}

function validateEmbeddedHost(
  platform: ThreePlatform,
  host: Extract<GraphHostOptions, { mode: 'embedded' }>,
  rendererOptions: RendererOptions | undefined
): void {
  const renderer = asRecord(host.renderer, 'Embedded host renderer must be an object from the injected Three module.');
  const scene = asRecord(host.scene, 'Embedded host scene must be an object from the injected Three module.');
  const camera = asRecord(host.camera, 'Embedded host camera must be an object from the injected Three module.');
  requireMethods(renderer, ['render'], 'Embedded host renderer');
  requireMethods(scene, ['add', 'remove'], 'Embedded host scene');
  asRecord(camera.position, 'Embedded host camera position must be an object.');
  if (host.canvas !== undefined) {
    validateCanvas(host.canvas, 'Embedded host canvas');
  }
  if (host.controls !== undefined) {
    const controls = asRecord(host.controls, 'Embedded host controls must be an object.');
    if (typeof controls.enabled !== 'boolean') {
      throw invalid('Embedded host controls enabled must be a boolean.');
    }
  }
  validateEmbeddedThreeIdentity(platform, scene, camera);
  const backend = asOptionalRecord(renderer.backend);
  const knownWebGpu = renderer.isWebGPURenderer === true || backend?.isWebGPUBackend === true;
  const knownWebGl = renderer.isWebGLRenderer === true || backend?.isWebGLBackend === true;
  if (rendererOptions?.backend === 'webgl2' && knownWebGpu && !knownWebGl) {
    throw new GraphError(
      'FG_RENDER_BACKEND_UNAVAILABLE',
      'The embedded renderer is WebGPU-backed and cannot satisfy an explicit WebGL2 renderer policy.'
    );
  }
}

function validateRequestedRenderCapabilities(
  platform: ThreePlatform,
  host: Exclude<GraphHostOptions, { mode: 'headless' }>,
  renderer: RendererOptions | undefined
): void {
  const widthUnit = renderer?.linkWidthUnit ?? 'world';
  const requirements = resolveTslFeatureRequirements(renderer);
  if (!requirements.transform) {
    return;
  }
  const missingThree = [...missingThreeTslGraphResources(platform.THREE)];
  if (platform.capabilities.nodeMaterials !== true
    && !missingThree.includes('MeshBasicNodeMaterial or SpriteNodeMaterial')) {
    missingThree.push('nodeMaterials capability');
  }
  if (missingThree.length > 0) {
    throw new GraphError(
      'FG_RENDER_CAPABILITY_UNAVAILABLE',
      `The requested TSL renderer path is missing ${missingThree.join(', ')}.`
    );
  }
  if (!supportsTslGraphTransform(platform.TSL, widthUnit)) {
    const feature = requirements.linkFlow
      ? 'Directional link flow'
      : requirements.nodeSurface
        ? 'The requested node surface'
        : 'Pixel link widths';
    throw new GraphError(
      'FG_RENDER_CAPABILITY_UNAVAILABLE',
      `${feature} requires a complete injected TSL graph-transform surface.`
    );
  }
  if (requirements.nodeSurface && !supportsTslNodeSurface(platform.TSL)) {
    throw new GraphError(
      'FG_RENDER_CAPABILITY_UNAVAILABLE',
      'The requested node surface requires the injected TSL surface-math functions.'
    );
  }
  if (requirements.linkFlow && !supportsTslLinkFlow(platform.TSL)) {
    throw new GraphError(
      'FG_RENDER_CAPABILITY_UNAVAILABLE',
      'Directional link flow requires the injected TSL flow-math functions.'
    );
  }
  if (requirements.pixelWidths && cameraProjectionFor(host.mode === 'embedded' ? host.camera : undefined) === 'orthographic') {
    throw new GraphError(
      'FG_RENDER_CAPABILITY_UNAVAILABLE',
      'Pixel link widths are not available for orthographic cameras in this renderer path.'
    );
  }
}

function validateCanvas(value: unknown, label: string): void {
  const canvas = asRecord(value, `${label} must be a canvas-like object.`);
  requireMethods(canvas, ['getContext', 'addEventListener', 'removeEventListener'], label);
  for (const name of ['width', 'height', 'clientWidth', 'clientHeight']) {
    const size = canvas[name];
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      throw invalid(`${label} ${name} must be a finite non-negative number.`);
    }
  }
}

function validateEmbeddedThreeIdentity(
  platform: ThreePlatform,
  scene: RuntimeObject,
  camera: RuntimeObject
): void {
  const Object3D = asConstructor(platform.THREE.Object3D);
  if (Object3D && scene.isObject3D === true && !(scene instanceof Object3D)) {
    throw new GraphError(
      'FG_RENDER_CAPABILITY_UNAVAILABLE',
      'The embedded scene was created by a different Three module instance than the supplied platform.'
    );
  }
  const Camera = asConstructor(platform.THREE.Camera);
  if (Camera && camera.isCamera === true && !(camera instanceof Camera)) {
    throw new GraphError(
      'FG_RENDER_CAPABILITY_UNAVAILABLE',
      'The embedded camera was created by a different Three module instance than the supplied platform.'
    );
  }
}

function requireConstructors(target: RuntimeObject, names: readonly string[], label: string): void {
  const missing = names.filter((name) => typeof target[name] !== 'function');
  if (missing.length > 0) {
    throw invalid(`${label} must provide ${missing.join(', ')} constructor${missing.length === 1 ? '' : 's'}.`);
  }
}

function requireMethods(target: RuntimeObject, names: readonly string[], label: string): void {
  const missing = names.filter((name) => typeof target[name] !== 'function');
  if (missing.length > 0) {
    throw invalid(`${label} must provide ${missing.join(', ')}().`);
  }
}

function cameraProjectionFor(value: unknown): 'perspective' | 'orthographic' | 'unknown' {
  const camera = asOptionalRecord(value);
  if (camera?.isOrthographicCamera === true) return 'orthographic';
  if (camera?.isPerspectiveCamera === true) return 'perspective';
  return 'unknown';
}

function asConstructor(value: unknown): (new (...args: unknown[]) => object) | undefined {
  return typeof value === 'function' ? value as new (...args: unknown[]) => object : undefined;
}

function asRecord(value: unknown, message: string): RuntimeObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(message);
  }
  return value as RuntimeObject;
}

function asOptionalRecord(value: unknown): RuntimeObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RuntimeObject : undefined;
}

function invalid(message: string): GraphError {
  return new GraphError('FG_RENDER_PLATFORM_INVALID', message);
}
