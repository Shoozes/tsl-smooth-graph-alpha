import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { sampleCameraPoseTween } from '../../dist/camera/index.js';

const sourceRoot = new URL('../../', import.meta.url);
const showcaseSource = await readFile(new URL('examples/showcase/showcase.js', sourceRoot), 'utf8');
const exampleSource = await readFile(new URL('examples/showcase/examples/example.js', sourceRoot), 'utf8');

function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'Expected the real example camera entry point.');
  return source.slice(first, last);
}

// Browser entry points require a renderer and DOM. Exercise their actual camera
// functions with a controlled frame scheduler and the built public tween math.
const animationSource = section(showcaseSource, 'function animateCamera(frame) {', '/** Browser proof settles');
const exerciseSource = section(exampleSource, "  let cinematicTweenOptionsExercised = kind !== 'cinematic';", "  await waitForAnimationFrames(kind === 'flow'");

const pose = (x) => ({ position: { x, y: 0, z: 100 }, target: { x, y: 0, z: 0 } });

function animationHarness() {
  let current = pose(0);
  let writes = 0;
  let metricsUpdates = 0;
  let nextFrame = 1;
  const frames = new Map();
  const context = {
    graph: {
      isDisposed: false,
      getCameraPose: () => current,
      setCameraPose: (value) => { current = value; writes += 1; }
    },
    performance: { now: () => 1_234 },
    cameraMotion: { durationMs: 600, easing: 'smoothstep' },
    sampleCameraPoseTween,
    requestAnimationFrame: (callback) => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    updateMetrics: () => { metricsUpdates += 1; }
  };
  vm.runInNewContext(`
    let cameraTweenFrame;
    let cameraTweenToken = 0;
    let cameraTweenDestination;
    ${animationSource}
    globalThis.camera = { animateCamera, cancelCameraTween,
      state: () => ({ frame: cameraTweenFrame, destination: cameraTweenDestination }) };
  `, context);
  const step = (timestamp) => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(timestamp);
  };
  return { camera: context.camera, frames, step, current: () => current, writes: () => writes, metricsUpdates: () => metricsUpdates };
}

test('showcase starts its elapsed clock from the first animation frame', () => {
  const h = animationHarness();
  h.camera.animateCamera(pose(20));
  // The frame timestamp may precede performance.now() at the click handler.
  assert.doesNotThrow(() => h.step(1_000));
  assert.equal(h.current().progress, 0);
  h.step(1_300);
  assert.equal(h.current().progress, 0.5);
  h.step(1_600);
  assert.equal(h.current().complete, true);
  assert.deepEqual(h.current().position, pose(20).position);
  assert.equal(h.frames.size, 0);
  assert.equal(h.camera.state().destination, undefined);
  assert.equal(h.metricsUpdates(), 1);
});

test('cancelled showcase flights ignore a callback already taken from the frame queue', () => {
  const h = animationHarness();
  h.camera.animateCamera(pose(20));
  const staleCallback = [...h.frames.values()][0];
  h.camera.cancelCameraTween();
  staleCallback(1_000);
  assert.equal(h.writes(), 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.camera.state().frame, undefined);
});

test('a repeated showcase flight ignores the old callback and completes the new destination', () => {
  const h = animationHarness();
  h.camera.animateCamera(pose(20));
  const staleCallback = [...h.frames.values()][0];
  h.camera.animateCamera(pose(40));
  staleCallback(1_000);
  assert.equal(h.writes(), 0);
  h.step(1_020);
  h.step(1_620);
  assert.equal(h.current().complete, true);
  assert.deepEqual(h.current().position, pose(40).position);
  assert.equal(h.frames.size, 0);
});

async function exerciseHarness({ started = true, completed = false, moved = true } = {}) {
  let current = pose(0);
  let now = 1_000;
  const canvas = { dataset: {} };
  const context = {
    kind: 'cinematic', reducedMotion: false, cameraFlight: {}, nodeIds: ['a', 'b', 'c'],
    document: { querySelector: () => null }, HTMLInputElement: class {},
    graph: { getCameraPose: () => current }, canvas,
    performance: { now: () => now }, status: { textContent: 'Flying' },
    focusNode: () => { if (started) canvas.dataset.cameraFlight = 'cinematic'; },
    waitForAnimationFrames: async () => {
      current = pose(moved ? 20 : 0);
      now += completed ? 850 : 80;
      if (completed) { delete canvas.dataset.cameraFlight; context.status.textContent = 'Arrived'; }
    },
    length: (v) => Math.hypot(v.x, v.y, v.z),
    subtract: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
    cancelCameraTween: () => { delete canvas.dataset.cameraFlight; },
    showOverview: () => {}
  };
  return vm.runInNewContext(`(async () => {
    ${exerciseSource}
    return { passed: cinematicTweenOptionsExercised, evidence: cinematicTweenEvidence };
  })()`, context);
}

test('cinematic helper accepts a started and moving flight still active at observation', async () => {
  const result = await exerciseHarness();
  assert.equal(result.passed, true);
  assert.equal(result.evidence.started, true);
  assert.equal(result.evidence.flightAtObservation, 'cinematic');
  assert.equal(result.evidence.observationElapsedMs, 80);
});

test('cinematic helper accepts a flight completed before its eight-frame observation', async () => {
  const result = await exerciseHarness({ completed: true });
  assert.equal(result.passed, true);
  assert.equal(result.evidence.started, true);
  assert.equal(result.evidence.positionDelta, 20);
  assert.equal(result.evidence.flightAtObservation, null);
  assert.equal(result.evidence.statusAtObservation, 'Arrived');
  assert.equal(result.evidence.observationElapsedMs, 850);
});

test('cinematic helper rejects movement without evidence that animation started', async () => {
  assert.equal((await exerciseHarness({ started: false })).passed, false);
});

test('cinematic helper rejects an animation that never moves the camera', async () => {
  assert.equal((await exerciseHarness({ moved: false })).passed, false);
});
