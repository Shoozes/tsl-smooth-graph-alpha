import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InteractionController } from '../../source/interaction/InteractionController.js';

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event } as unknown as Event);
  }
}

class FakeCanvas {
  private readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  captured: number[] = [];
  released: number[] = [];
  readonly fallbackTarget = new FakeEventTarget();
  readonly ownerDocument = { defaultView: this.fallbackTarget };

  addEventListener(type: string, listener: (event: PointerEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: PointerEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: PointerEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.released.push(pointerId);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as unknown as PointerEvent);
    }
  }
}

test('InteractionController finishes outside-canvas input when pointer capture is rejected', () => {
  const canvas = new FakeCanvas();
  canvas.setPointerCapture = () => { throw new Error('capture rejected'); };
  let controlsEnabled = true;
  let clicks = 0;
  const controller = new InteractionController(canvas as unknown as HTMLCanvasElement, {}, {
    pickNode: () => 'node',
    projectDrag: () => ({ x: 1, y: 2, z: 3 }),
    hover: () => undefined,
    click: () => { clicks += 1; },
    beginDrag: () => undefined,
    moveDrag: () => undefined,
    endDrag: () => undefined,
    getNavigationEnabled: () => controlsEnabled,
    setNavigationEnabled: (enabled) => { controlsEnabled = enabled; }
  });

  canvas.dispatch('pointerdown', { pointerId: 7, clientX: 0, clientY: 0, button: 0, isPrimary: true });
  assert.equal(controlsEnabled, false);
  canvas.fallbackTarget.dispatch('pointerup', { pointerId: 7, clientX: 0, clientY: 0 });
  assert.equal(controller.activeNodeId, undefined);
  assert.equal(controlsEnabled, true);
  assert.equal(clicks, 1);
  controller.dispose();
});

test('InteractionController preserves disabled navigation and finishes a lost capture drag at its last valid position', () => {
  const canvas = new FakeCanvas();
  const navigation: boolean[] = [];
  const dragEnds: Array<{ x: number; y: number; z: number }> = [];
  const controller = new InteractionController(canvas as unknown as HTMLCanvasElement, {
    navigation: false,
    dragNodes: true
  }, {
    pickNode: () => 'node',
    projectDrag: (event) => event.type === 'lostpointercapture' ? undefined : { x: 4, y: 5, z: 6 },
    hover: () => undefined,
    click: () => undefined,
    beginDrag: () => undefined,
    moveDrag: () => undefined,
    endDrag: (_nodeId, position) => dragEnds.push(position),
    setNavigationEnabled: (enabled) => navigation.push(enabled)
  });

  canvas.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, type: 'pointerdown' });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: 5, clientY: 0, type: 'pointermove' });
  canvas.dispatch('lostpointercapture', { pointerId: 1, clientX: 5, clientY: 0, type: 'lostpointercapture' });
  controller.dispose();

  assert.deepEqual(dragEnds, [{ x: 4, y: 5, z: 6 }]);
  assert.ok(navigation.length >= 3);
  assert.equal(navigation.every((enabled) => enabled === false), true);
});

test('InteractionController restores borrowed controls, claims valid primary pointers, and rejects competing input', () => {
  const canvas = new FakeCanvas();
  let controlsEnabled = true;
  let picks = 0;
  let clicks = 0;
  let claimed = 0;
  const controller = new InteractionController(canvas as unknown as HTMLCanvasElement, {
    dragNodes: true
  }, {
    pickNode: () => {
      picks += 1;
      return 'node';
    },
    projectDrag: () => ({ x: 1, y: 2, z: 3 }),
    hover: () => undefined,
    click: () => { clicks += 1; },
    beginDrag: () => undefined,
    moveDrag: () => undefined,
    endDrag: () => undefined,
    getNavigationEnabled: () => controlsEnabled,
    setNavigationEnabled: (enabled) => { controlsEnabled = enabled; }
  });

  canvas.dispatch('pointerdown', {
    pointerId: 2,
    clientX: 0,
    clientY: 0,
    button: 2,
    isPrimary: true,
    stopPropagation: () => { claimed += 1; },
    preventDefault: () => { claimed += 1; }
  });
  canvas.dispatch('pointerdown', {
    pointerId: 3,
    clientX: 0,
    clientY: 0,
    button: 0,
    isPrimary: false,
    stopPropagation: () => { claimed += 1; },
    preventDefault: () => { claimed += 1; }
  });
  assert.equal(picks, 0);
  assert.equal(controlsEnabled, true);

  canvas.dispatch('pointerdown', {
    pointerId: 4,
    clientX: 0,
    clientY: 0,
    button: 0,
    isPrimary: true,
    stopPropagation: () => { claimed += 1; },
    preventDefault: () => { claimed += 1; }
  });
  canvas.dispatch('pointerdown', { pointerId: 5, clientX: 0, clientY: 0, button: 0, isPrimary: true });
  assert.equal(picks, 1);
  assert.equal(claimed, 2);
  assert.equal(controlsEnabled, false);
  assert.deepEqual(canvas.captured, [4]);

  canvas.dispatch('pointerup', { pointerId: 4, clientX: 0, clientY: 0, button: 0, isPrimary: true });
  assert.equal(clicks, 1);
  assert.equal(controlsEnabled, true);
  assert.deepEqual(canvas.released, [4]);
  controller.dispose();
  assert.equal(controlsEnabled, true);
});

test('InteractionController cancels an active drag at its last valid position and restores the original control state', () => {
  const canvas = new FakeCanvas();
  let controlsEnabled = false;
  const ends: Array<{ x: number; y: number; z: number }> = [];
  const controller = new InteractionController(canvas as unknown as HTMLCanvasElement, {
    navigation: true,
    dragNodes: true
  }, {
    pickNode: () => 'node',
    projectDrag: () => ({ x: 7, y: 8, z: 9 }),
    hover: () => undefined,
    click: () => undefined,
    beginDrag: () => undefined,
    moveDrag: () => undefined,
    endDrag: (_nodeId, position) => ends.push(position),
    getNavigationEnabled: () => controlsEnabled,
    setNavigationEnabled: (enabled) => { controlsEnabled = enabled; }
  });

  canvas.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0, isPrimary: true });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: 5, clientY: 0, button: -1, isPrimary: true });
  controller.cancelActiveInteraction();

  assert.deepEqual(ends, [{ x: 7, y: 8, z: 9 }]);
  assert.equal(controlsEnabled, false);
  assert.equal(controller.activeNodeId, undefined);
  controller.dispose();
  assert.equal(controlsEnabled, false);
});

test('InteractionController cancels a queued hover before reporting pointer leave', () => {
  const canvas = new FakeCanvas();
  const hovers: Array<string | undefined> = [];
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let queued: FrameRequestCallback | undefined;
  globalThis.requestAnimationFrame = (callback): number => {
    queued = callback;
    return 1;
  };
  globalThis.cancelAnimationFrame = (): void => {
    queued = undefined;
  };
  try {
    const controller = new InteractionController(canvas as unknown as HTMLCanvasElement, {}, {
      pickNode: () => 'node',
      projectDrag: () => undefined,
      hover: (nodeId) => hovers.push(nodeId as string | undefined),
      click: () => undefined,
      beginDrag: () => undefined,
      moveDrag: () => undefined,
      endDrag: () => undefined,
      setNavigationEnabled: () => undefined
    });
    canvas.dispatch('pointermove', { pointerId: 1, clientX: 1, clientY: 1, button: -1, isPrimary: true });
    canvas.dispatch('pointerleave', { pointerId: 1, clientX: 1, clientY: 1, button: -1, isPrimary: true });
    queued?.(0);
    assert.deepEqual(hovers, [undefined]);
    controller.dispose();
  } finally {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('InteractionController ignores a stale asynchronous hover pick', async () => {
  const canvas = new FakeCanvas();
  const hovers: Array<string | undefined> = [];
  const requests: Array<{ resolve: (nodeId: string | undefined) => void }> = [];
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (callback): number => {
    frames.push(callback);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = (): void => undefined;
  try {
    const controller = new InteractionController(canvas as unknown as HTMLCanvasElement, {}, {
      pickNode: () => undefined,
      pickNodeAsync: () => new Promise((resolve) => requests.push({ resolve })),
      projectDrag: () => undefined,
      hover: (nodeId) => hovers.push(nodeId as string | undefined),
      click: () => undefined,
      beginDrag: () => undefined,
      moveDrag: () => undefined,
      endDrag: () => undefined,
      setNavigationEnabled: () => undefined
    });
    canvas.dispatch('pointermove', { pointerId: 1, clientX: 1, clientY: 1, button: -1, isPrimary: true });
    frames.shift()?.(0);
    canvas.dispatch('pointermove', { pointerId: 1, clientX: 2, clientY: 1, button: -1, isPrimary: true });
    frames.shift()?.(0);
    requests[0]!.resolve('stale');
    await Promise.resolve();
    requests[1]!.resolve('current');
    await Promise.resolve();

    assert.deepEqual(hovers, ['current']);
    controller.dispose();
  } finally {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('InteractionController invalidates a pending hover before pointer-down ownership begins', async () => {
  const canvas = new FakeCanvas();
  const hovers: Array<string | undefined> = [];
  const requests: Array<{ resolve: (nodeId: string | undefined) => void }> = [];
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (callback): number => {
    frames.push(callback);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = (): void => undefined;
  try {
    const controller = new InteractionController(canvas as unknown as HTMLCanvasElement, {}, {
      pickNode: () => 'node',
      pickNodeAsync: () => new Promise((resolve) => requests.push({ resolve })),
      projectDrag: () => undefined,
      hover: (nodeId) => hovers.push(nodeId as string | undefined),
      click: () => undefined,
      beginDrag: () => undefined,
      moveDrag: () => undefined,
      endDrag: () => undefined,
      setNavigationEnabled: () => undefined
    });
    canvas.dispatch('pointermove', { pointerId: 1, clientX: 1, clientY: 1, button: -1, isPrimary: true });
    frames.shift()?.(0);
    canvas.dispatch('pointerdown', { pointerId: 1, clientX: 1, clientY: 1, button: 0, isPrimary: true });
    canvas.dispatch('pointerup', { pointerId: 1, clientX: 1, clientY: 1, button: 0, isPrimary: true });
    requests[0]!.resolve('stale');
    await Promise.resolve();

    assert.deepEqual(hovers, []);
    controller.dispose();
  } finally {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});
