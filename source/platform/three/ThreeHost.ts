import { GraphError } from '../../core/errors.js';
import type { CameraPose, EmbeddedHostOptions, ManagedHostOptions, RendererOptions } from '../../core/types.js';
import type { ThreePlatform } from './createThreePlatform.js';

export interface HostDeviceLossSignal {
  readonly api: string;
  readonly message: string;
  readonly reason: string | null;
}

type DeviceLossListener = (signal: HostDeviceLossSignal) => void;

export interface ResolvedThreeHost {
  readonly mode: 'managed' | 'embedded';
  readonly renderer: Record<string, unknown>;
  readonly scene: Record<string, unknown>;
  readonly camera: Record<string, unknown>;
  readonly canvas: HTMLCanvasElement | undefined;
  readonly controls: { enabled: boolean } | undefined;
  readonly ownsRenderer: boolean;
  readonly ownsScene: boolean;
  readonly ownsCamera: boolean;
  readonly backend: 'webgpu' | 'webgl2';
  /** Device-reported maximum 2D texture dimension when the renderer exposes it. */
  readonly deviceMaxTextureSize: number | undefined;
  onDeviceLost(listener: DeviceLossListener): () => void;
  onPixelRatioChanged(listener: () => void): () => void;
  dispose(): void;
}

export async function createThreeHost(
  platform: ThreePlatform,
  hostOptions: ManagedHostOptions | EmbeddedHostOptions,
  rendererOptions: RendererOptions = {}
): Promise<ResolvedThreeHost> {
  if (hostOptions.mode === 'embedded') {
    return createEmbeddedHost(platform, hostOptions, rendererOptions);
  }
  return createManagedHost(platform, hostOptions, rendererOptions);
}

function createEmbeddedHost(platform: ThreePlatform, options: EmbeddedHostOptions, rendererOptions: RendererOptions): ResolvedThreeHost {
  const renderer = asRecord(options.renderer, 'Embedded host renderer');
  const scene = asRecord(options.scene, 'Embedded host scene');
  const camera = asRecord(options.camera, 'Embedded host camera');
  validateEmbeddedThreeIdentity(platform, scene, camera);
  return {
    mode: 'embedded',
    renderer,
    scene,
    camera,
    canvas: options.canvas,
    controls: options.controls,
    ownsRenderer: false,
    ownsScene: false,
    ownsCamera: false,
    backend: rendererOptions.backend === 'webgl2' ? 'webgl2' : detectBackend(renderer, 'webgpu'),
    deviceMaxTextureSize: readDeviceMaxTextureSize(renderer),
    onDeviceLost: () => () => undefined,
    onPixelRatioChanged: () => () => undefined,
    dispose: () => undefined
  };
}

function validateEmbeddedThreeIdentity(
  platform: ThreePlatform,
  scene: Record<string, unknown>,
  camera: Record<string, unknown>
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

async function createManagedHost(
  platform: ThreePlatform,
  options: ManagedHostOptions,
  rendererOptions: RendererOptions
): Promise<ResolvedThreeHost> {
  const WebGPURenderer = asConstructor(platform.THREE.WebGPURenderer);
  const Scene = asConstructor(platform.THREE.Scene);
  const PerspectiveCamera = asConstructor(platform.THREE.PerspectiveCamera);
  if (!WebGPURenderer || !Scene || !PerspectiveCamera) {
    throw new GraphError(
      'FG_RENDER_BACKEND_UNAVAILABLE',
      'Managed rendering requires WebGPURenderer, Scene, and PerspectiveCamera from the injected Three module.'
    );
  }
  const rendererConfig: Record<string, unknown> = {
    canvas: options.canvas,
    antialias: rendererOptions.antialias ?? true,
    alpha: rendererOptions.alpha ?? true
  };
  if (rendererOptions.backend === 'webgl2') {
    rendererConfig.forceWebGL = true;
  }
  const renderer = new WebGPURenderer(rendererConfig) as Record<string, unknown>;
  const deviceLossBridge = createDeviceLossBridge(renderer);
  let pixelRatioMonitor: { subscribe(listener: () => void): () => void; dispose(): void } = {
    subscribe: () => () => undefined,
    dispose: () => undefined
  };
  try {
    const scene = new Scene() as Record<string, unknown>;
    const camera = new PerspectiveCamera(50, 1, 0.1, 100_000) as Record<string, unknown>;
    const position = asOptionalRecord(camera.position);
    if (position) {
      position.z = 120;
    }
    applyCameraPose(camera, rendererOptions.cameraPose);
    const minimumPixelRatio = positivePixelRatio(rendererOptions.pixelRatio?.minimum, 1);
    const maximumPixelRatio = Math.max(minimumPixelRatio, positivePixelRatio(rendererOptions.pixelRatio?.maximum, 2));
    pixelRatioMonitor = createPixelRatioMonitor(renderer, minimumPixelRatio, maximumPixelRatio);
    resizeManagedHost(renderer, camera, options.canvas);
    const initialize = renderer.init;
    if (typeof initialize === 'function') {
      await Promise.resolve(initialize.call(renderer));
    }
    const backend = detectBackend(renderer, rendererOptions.backend === 'webgl2' ? 'webgl2' : 'webgpu');
    return {
      mode: 'managed',
      renderer,
      scene,
      camera,
      canvas: options.canvas,
      controls: undefined,
      ownsRenderer: true,
      ownsScene: true,
      ownsCamera: true,
      backend,
      deviceMaxTextureSize: readDeviceMaxTextureSize(renderer),
      onDeviceLost: deviceLossBridge.subscribe,
      onPixelRatioChanged: pixelRatioMonitor.subscribe,
      dispose: () => {
        pixelRatioMonitor.dispose();
        deviceLossBridge.dispose();
        call(renderer, 'dispose');
      }
    };
  } catch (error) {
    pixelRatioMonitor.dispose();
    deviceLossBridge.dispose();
    call(renderer, 'dispose');
    throw error;
  }
}

function readDeviceMaxTextureSize(renderer: Record<string, unknown>): number | undefined {
  const webgl = asOptionalRecord(renderer.capabilities)?.maxTextureSize;
  const backend = asOptionalRecord(renderer.backend);
  const device = asOptionalRecord(backend?.device);
  const limits = asOptionalRecord(device?.limits);
  const value = webgl ?? limits?.maxTextureDimension2D;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Applies an already validated pose to a graph host camera. */
export function applyCameraPose(camera: Record<string, unknown>, pose: CameraPose | undefined): void {
  if (pose === undefined) {
    return;
  }
  const position = asOptionalRecord(camera.position);
  if (position && typeof position.set === 'function') {
    position.set(pose.position.x, pose.position.y, pose.position.z);
  } else if (position) {
    position.x = pose.position.x;
    position.y = pose.position.y;
    position.z = pose.position.z;
  }
  const lookAt = camera.lookAt;
  if (typeof lookAt === 'function') {
    lookAt.call(camera, pose.target.x, pose.target.y, pose.target.z);
  }
  call(camera, 'updateMatrixWorld');
}

export function resizeManagedHost(
  renderer: Record<string, unknown>,
  camera: Record<string, unknown>,
  canvas: HTMLCanvasElement
): void {
  const width = Math.max(1, canvas.clientWidth || canvas.width || 1);
  const height = Math.max(1, canvas.clientHeight || canvas.height || 1);
  call(renderer, 'setSize', width, height, false);
  if (typeof camera.aspect === 'number') {
    camera.aspect = width / height;
    call(camera, 'updateProjectionMatrix');
  }
}

function detectBackend(renderer: Record<string, unknown>, fallback: 'webgpu' | 'webgl2'): 'webgpu' | 'webgl2' {
  const backend = asOptionalRecord(renderer.backend);
  return backend?.isWebGLBackend === true || renderer.isWebGLRenderer === true ? 'webgl2' : fallback;
}

function asConstructor(value: unknown): (new (...args: unknown[]) => object) | undefined {
  return typeof value === 'function' ? value as new (...args: unknown[]) => object : undefined;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', `${label} must be an object from the injected Three module.`);
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function createDeviceLossBridge(renderer: Record<string, unknown>): {
  subscribe(listener: DeviceLossListener): () => void;
  dispose(): void;
} {
  const original = renderer.onDeviceLost;
  if (typeof original !== 'function') {
    return {
      subscribe: () => () => undefined,
      dispose: () => undefined
    };
  }
  const listeners = new Set<DeviceLossListener>();
  let active = true;
  let lastSignal: HostDeviceLossSignal | undefined;
  const handler = (rawSignal: unknown) => {
    try {
      original.call(renderer, rawSignal);
    } finally {
      if (active) {
        lastSignal = normalizeDeviceLossSignal(rawSignal);
        for (const listener of [...listeners]) {
          listener(lastSignal);
        }
      }
    }
  };
  renderer.onDeviceLost = handler;
  return {
    subscribe(listener: DeviceLossListener): () => void {
      if (!active) {
        return () => undefined;
      }
      listeners.add(listener);
      if (lastSignal) {
        listener(lastSignal);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (!active) {
        return;
      }
      active = false;
      listeners.clear();
      if (renderer.onDeviceLost === handler) {
        renderer.onDeviceLost = original;
      }
    }
  };
}

function normalizeDeviceLossSignal(value: unknown): HostDeviceLossSignal {
  const signal = asOptionalRecord(value);
  return {
    api: typeof signal?.api === 'string' ? signal.api : 'Unknown',
    message: typeof signal?.message === 'string' && signal.message.length > 0 ? signal.message : 'Unknown reason',
    reason: typeof signal?.reason === 'string' ? signal.reason : null
  };
}

function call(target: Record<string, unknown>, name: string, ...args: unknown[]): unknown {
  const method = target[name];
  return typeof method === 'function' ? method.apply(target, args) : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function devicePixelRatio(): number {
  const value = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function createPixelRatioMonitor(
  renderer: Record<string, unknown>,
  minimum: number,
  maximum: number
): { subscribe(listener: () => void): () => void; dispose(): void } {
  let lastRatio = Number.NaN;
  const subscribers = new Set<() => void>();
  const refresh = () => {
    const ratio = clamp(devicePixelRatio(), minimum, maximum);
    if (ratio === lastRatio) return;
    lastRatio = ratio;
    call(renderer, 'setPixelRatio', ratio);
    for (const subscriber of [...subscribers]) subscriber();
  };
  refresh();
  const global = globalThis as typeof globalThis & {
    addEventListener?: (name: string, listener: () => void) => void;
    removeEventListener?: (name: string, listener: () => void) => void;
    matchMedia?: (query: string) => MediaQueryList;
  };
  const listeners: Array<() => void> = [];
  const onEnvironmentChange = refresh;
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('resize', onEnvironmentChange);
    listeners.push(() => global.removeEventListener?.('resize', onEnvironmentChange));
  }
  let mediaQuery: MediaQueryList | undefined;
  if (typeof global.matchMedia === 'function') {
    const watch = () => {
      mediaQuery = global.matchMedia?.(`(resolution: ${devicePixelRatio()}dppx)`);
      mediaQuery?.addEventListener?.('change', onMediaChange);
    };
    const onMediaChange = () => {
      mediaQuery?.removeEventListener?.('change', onMediaChange);
      onEnvironmentChange();
      watch();
    };
    watch();
    listeners.push(() => mediaQuery?.removeEventListener?.('change', onMediaChange));
  }
  return {
    subscribe(listener: () => void): () => void {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    dispose(): void {
      for (const dispose of listeners.splice(0)) dispose();
      subscribers.clear();
    }
  };
}

function positivePixelRatio(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
