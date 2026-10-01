import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ThreePlatform } from '../../source/platform/three/createThreePlatform.js';
import { createThreeHost } from '../../source/platform/three/ThreeHost.js';

class FakeRenderer {
  static instances: FakeRenderer[] = [];
  static failInitialization = false;

  readonly config: Record<string, unknown>;
  pixelRatio = 0;
  disposed = false;
  backend = { isWebGLBackend: false, device: { limits: { maxTextureDimension2D: 2048 } } };
  readonly deviceLossSignals: unknown[] = [];
  onDeviceLost = (signal: unknown): void => {
    this.deviceLossSignals.push(signal);
  };

  constructor(config: Record<string, unknown>) {
    this.config = config;
    FakeRenderer.instances.push(this);
  }

  setPixelRatio(value: number): void {
    this.pixelRatio = value;
  }

  setSize(): void {}

  async init(): Promise<void> {
    if (FakeRenderer.failInitialization) {
      throw new Error('init failed');
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeScene {}

class FakeCamera {
  aspect = 1;
  readonly position: { x?: number; y?: number; z?: number; set?: (x: number, y: number, z: number) => void } = {
    set: (x, y, z) => {
      this.position.x = x;
      this.position.y = y;
      this.position.z = z;
    }
  };
  lookAtTarget: [number, number, number] | undefined;
  updateMatrixWorldCalls = 0;

  updateProjectionMatrix(): void {}

  lookAt(x: number, y: number, z: number): void {
    this.lookAtTarget = [x, y, z];
  }

  updateMatrixWorld(): void {
    this.updateMatrixWorldCalls += 1;
  }
}

function platform(): ThreePlatform {
  return {
    THREE: {
      WebGPURenderer: FakeRenderer,
      Scene: FakeScene,
      PerspectiveCamera: FakeCamera
    },
    TSL: {},
    capabilities: { webgpuRenderer: true, nodeMaterials: false, raycasting: false }
  };
}

const canvas = {
  clientWidth: 320,
  clientHeight: 200,
  width: 320,
  height: 200
} as unknown as HTMLCanvasElement;

test('managed Three host clamps pixel ratio and disposes a renderer whose initialization fails', async () => {
  FakeRenderer.instances = [];
  FakeRenderer.failInitialization = false;
  const host = await createThreeHost(platform(), { mode: 'managed', canvas }, {
    pixelRatio: { minimum: 1.5, maximum: 2 }
  });
  const successfulRenderer = FakeRenderer.instances[0];
  assert.ok(successfulRenderer);
  assert.equal(successfulRenderer.pixelRatio, 1.5);
  assert.equal(host.deviceMaxTextureSize, 2048);
  host.dispose();
  assert.equal(successfulRenderer.disposed, true);

  FakeRenderer.failInitialization = true;
  await assert.rejects(() => createThreeHost(platform(), { mode: 'managed', canvas }));
  const failedRenderer = FakeRenderer.instances.at(-1);
  assert.ok(failedRenderer);
  assert.equal(failedRenderer.disposed, true);
});

test('managed Three host forwards supported device-loss signals once and cleans its listener on disposal', async () => {
  FakeRenderer.instances = [];
  FakeRenderer.failInitialization = false;
  const host = await createThreeHost(platform(), { mode: 'managed', canvas });
  const renderer = FakeRenderer.instances[0];
  assert.ok(renderer);
  const received: Array<{ api: string; message: string; reason: string | null }> = [];
  const unsubscribe = host.onDeviceLost((signal) => received.push(signal));
  const firstSignal = { api: 'WebGPU', message: 'adapter reset', reason: 'unknown' };
  renderer.onDeviceLost(firstSignal);
  assert.deepEqual(renderer.deviceLossSignals, [firstSignal]);
  assert.deepEqual(received, [firstSignal]);

  unsubscribe();
  renderer.onDeviceLost({ api: 'WebGPU', message: 'ignored subscriber', reason: null });
  assert.equal(received.length, 1);

  host.dispose();
  renderer.onDeviceLost({ api: 'WebGPU', message: 'after disposal', reason: null });
  assert.equal(received.length, 1);
  assert.equal(renderer.deviceLossSignals.length, 3);
});

test('managed Three host applies a validated camera pose without taking embedded camera ownership', async () => {
  FakeRenderer.instances = [];
  const host = await createThreeHost(platform(), { mode: 'managed', canvas }, {
    cameraPose: {
      position: { x: 100, y: 42, z: 90 },
      target: { x: 0, y: 0, z: 0 }
    }
  });
  const camera = host.camera as unknown as FakeCamera;
  assert.deepEqual(camera.position.x === undefined ? undefined : [camera.position.x, camera.position.y, camera.position.z], [100, 42, 90]);
  assert.deepEqual(camera.lookAtTarget, [0, 0, 0]);
  assert.equal(camera.updateMatrixWorldCalls, 1);
  host.dispose();
});

test('managed Three host refreshes and removes its device-pixel-ratio listener', async () => {
  FakeRenderer.instances = [];
  FakeRenderer.failInitialization = false;
  const previousRatio = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  const previousAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const previousRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  let resizeListener: (() => void) | undefined;
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 2.5 });
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: (name: string, listener: () => void) => {
    if (name === 'resize') resizeListener = listener;
  }});
  Object.defineProperty(globalThis, 'removeEventListener', { configurable: true, value: (name: string, listener: () => void) => {
    if (name === 'resize' && resizeListener === listener) resizeListener = undefined;
  }});
  try {
    const host = await createThreeHost(platform(), { mode: 'managed', canvas }, {
      pixelRatio: { minimum: 1, maximum: 2 }
    });
    const renderer = FakeRenderer.instances[0];
    assert.ok(renderer);
    assert.equal(renderer.pixelRatio, 2);
    Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 1.25 });
    resizeListener?.();
    assert.equal(renderer.pixelRatio, 1.25);
    host.dispose();
    Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 3 });
    resizeListener?.();
    assert.equal(renderer.pixelRatio, 1.25);
    assert.equal(resizeListener, undefined);
  } finally {
    if (previousRatio) Object.defineProperty(globalThis, 'devicePixelRatio', previousRatio);
    else delete (globalThis as Record<string, unknown>).devicePixelRatio;
    if (previousAdd) Object.defineProperty(globalThis, 'addEventListener', previousAdd);
    else delete (globalThis as Record<string, unknown>).addEventListener;
    if (previousRemove) Object.defineProperty(globalThis, 'removeEventListener', previousRemove);
    else delete (globalThis as Record<string, unknown>).removeEventListener;
  }
});

test('managed Three host rebinds resolution media queries and deduplicates effective DPR changes', async () => {
  FakeRenderer.instances = [];
  FakeRenderer.failInitialization = false;
  const previousRatio = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  let mediaQueries: Array<{ query: string; listener: (() => void) | undefined; removed: number }> = [];
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 1 });
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: (query: string) => {
    const entry = { query, listener: undefined as (() => void) | undefined, removed: 0 };
    mediaQueries.push(entry);
    return {
      matches: false,
      media: query,
      addEventListener: (_name: string, listener: () => void) => { entry.listener = listener; },
      removeEventListener: (_name: string, listener: () => void) => {
        if (entry.listener === listener) entry.removed += 1;
      }
    } as unknown as MediaQueryList;
  }});
  try {
    const host = await createThreeHost(platform(), { mode: 'managed', canvas }, {
      pixelRatio: { minimum: 1, maximum: 2 }
    });
    const renderer = FakeRenderer.instances[0];
    assert.ok(renderer);
    let changes = 0;
    const unsubscribe = host.onPixelRatioChanged(() => { changes += 1; });
    assert.equal(mediaQueries.length, 1);
    assert.match(mediaQueries[0]!.query, /1dppx/);

    Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 1 });
    mediaQueries[0]!.listener?.();
    assert.equal(changes, 0);
    assert.equal(renderer.pixelRatio, 1);
    assert.equal(mediaQueries.length, 2);

    Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 3 });
    mediaQueries[1]!.listener?.();
    assert.equal(changes, 1);
    assert.equal(renderer.pixelRatio, 2);
    assert.equal(mediaQueries.length, 3);

    unsubscribe();
    host.dispose();
    assert.equal(mediaQueries[2]!.removed, 1);
    assert.equal(mediaQueries[0]!.removed, 1);
    assert.equal(mediaQueries[1]!.removed, 1);
  } finally {
    if (previousRatio) Object.defineProperty(globalThis, 'devicePixelRatio', previousRatio);
    else delete (globalThis as Record<string, unknown>).devicePixelRatio;
    if (previousMatchMedia) Object.defineProperty(globalThis, 'matchMedia', previousMatchMedia);
    else delete (globalThis as Record<string, unknown>).matchMedia;
  }
});
