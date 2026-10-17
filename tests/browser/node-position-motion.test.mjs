import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createNodePositionMotion } from '../../examples/corpus/node-position-motion.js';
import { metallicNodeSurface } from '../../examples/showcase/showcase-model.js';

const point = x => ({ x, y: 0, z: 0 });

function harness() {
  let now = 0, reduced = false, nextFrame = 0;
  const frames = new Map(), writes = [];
  const motion = createNodePositionMotion({
    now: () => now,
    reducedMotion: () => reduced,
    requestFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id),
    setPosition: (id, position) => writes.push({ id, position: { ...position } })
  });
  const take = () => { const pending = [...frames.values()]; frames.clear(); return pending; };
  return {
    motion, frames, writes, take,
    setReduced: value => { reduced = value; },
    step(time) { now = time; for (const callback of take()) callback(time); }
  };
}

test('position motion shares one scheduler and settles copied endpoints', () => {
  const h = harness(), destination = point(10);
  h.motion.animate('a', point(0), destination, { durationMs: 100 });
  h.motion.animate('b', point(1), point(20), { durationMs: 100, delayMs: 10 });
  destination.x = 99;
  assert.equal(h.frames.size, 1);
  h.step(110);
  assert.deepEqual(h.writes.slice(-2), [{ id: 'a', position: point(10) }, { id: 'b', position: point(20) }]);
  assert.equal(h.motion.activeCount, 0);
  assert.equal(h.frames.size, 0);
  h.motion.dispose();
});

test('a reduced-motion replacement cannot be overwritten by an already dequeued frame', () => {
  const h = harness();
  h.motion.animate('a', point(0), point(10), { durationMs: 100 });
  const [stale] = h.take();
  h.setReduced(true);
  assert.equal(h.motion.animate('a', point(0), point(20)), false);
  const before = h.writes.length;
  stale(1000);
  assert.deepEqual(h.writes.at(-1), { id: 'a', position: point(20) });
  assert.equal(h.writes.length, before);
  assert.equal(h.motion.activeCount, 0);
  assert.equal(h.frames.size, 0);
  h.motion.dispose();
});

test('reduced motion settles other active nodes and cancels their pending frame', () => {
  const h = harness();
  h.motion.animate('a', point(0), point(10));
  h.motion.animate('b', point(0), point(20), { delayMs: 1000 });
  h.setReduced(true);
  assert.equal(h.motion.animate('c', point(0), point(30)), false);
  assert.deepEqual(h.writes.slice(-3), [
    { id: 'a', position: point(10) }, { id: 'b', position: point(20) }, { id: 'c', position: point(30) }
  ]);
  assert.equal(h.motion.activeCount, 0);
  assert.equal(h.frames.size, 0);
  h.motion.dispose();
});

test('a changed motion preference settles even delayed motion on the next frame', () => {
  const h = harness();
  h.motion.animate('a', point(0), point(10), { delayMs: 1000 });
  h.setReduced(true);
  h.step(10);
  assert.deepEqual(h.writes.at(-1), { id: 'a', position: point(10) });
  assert.equal(h.motion.activeCount, 0);
  assert.equal(h.frames.size, 0);
  h.motion.dispose();
});

test('cancelled position callbacks cannot advance or unschedule a replacement run', () => {
  const h = harness();
  h.motion.animate('a', point(0), point(10), { durationMs: 100 });
  const [stale] = h.take();
  h.motion.cancelAll(false);
  h.motion.animate('b', point(0), point(20), { durationMs: 100 });
  const before = h.writes.length;
  stale(50);
  assert.equal(h.writes.length, before);
  assert.equal(h.frames.size, 1);
  h.step(100);
  assert.deepEqual(h.writes.at(-1), { id: 'b', position: point(20) });
  assert.equal(h.frames.size, 0);
  h.motion.dispose();
});

test('settling and disposal leave no active motion or stale writes', () => {
  const h = harness();
  h.motion.animate('a', point(0), point(10));
  const [stale] = h.take();
  h.motion.cancelAll(true);
  assert.deepEqual(h.writes.at(-1), { id: 'a', position: point(10) });
  h.motion.dispose(); h.motion.dispose();
  const before = h.writes.length;
  stale(1000);
  assert.equal(h.writes.length, before);
  assert.equal(h.motion.activeCount, 0);
  assert.equal(h.frames.size, 0);
  assert.throws(() => h.motion.animate('a', point(0), point(1)), /disposed/);
});

const corpusSource = await readFile(new URL('../../examples/corpus/corpus.js', import.meta.url), 'utf8');
const start = corpusSource.indexOf('function toggleMotion(manual=true)');
const end = corpusSource.indexOf('\nfunction ', start + 1);
assert.ok(start >= 0 && end > start, 'Exercise the actual Corpus motion toggle.');
const toggleSource = corpusSource.slice(start, end);
const cancelStart = corpusSource.indexOf('function cancelSearchMotion(settle=true)');
const cancelEnd = corpusSource.indexOf('\nfunction ', cancelStart + 1);
assert.ok(cancelStart >= 0 && cancelEnd > cancelStart, 'Exercise the actual search-motion cancellation.');
const cancelSource = corpusSource.slice(cancelStart, cancelEnd);

function toggleHarness(fullMotion) {
  const calls = [], elements = { motion: { dataset: {} }, status: {}, search: { value: '' }, canvas: { dataset: {} } };
  const context = {
    fullMotion, motionOverridden: false, autoFrame: false, searchMotionToken: 0, elements, metallicNodeSurface,
    cameraAnimator: { cancel: () => calls.push('camera') },
    nodeMotion: { cancelAll: settle => calls.push(['scale', settle]) },
    positionMotion: { cancelAll: settle => calls.push(['position', settle]) },
    graph: { setLinkFlow: flow => calls.push(['flow', flow.enabled]),
      setNodeSurface: surface => calls.push(['breath', surface.selectionEffect.breathAmount]) },
    clearTransientEffects: () => calls.push('transients')
  };
  vm.createContext(context);
  vm.runInContext(`${cancelSource}\n${toggleSource}\nglobalThis.runToggle = toggleMotion;`, context);
  return { context, calls };
}

test('the actual Corpus reduced-motion toggle settles positions, scales and directional flow', () => {
  const h = toggleHarness(true);
  h.context.runToggle();
  assert.equal(h.context.fullMotion, false);
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'position' && call[1] === true));
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'scale' && call[1] === true));
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'scale').length, 1);
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'flow' && call[1] === false));
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'breath' && call[1] === 0));
  assert.equal(h.context.elements.motion.textContent, 'Motion: reduced');
});

test('turning full motion back on does not settle positions or disable flow again', () => {
  const h = toggleHarness(false);
  h.context.runToggle();
  assert.equal(h.context.fullMotion, true);
  assert.equal(h.calls.some(call => Array.isArray(call) && ['position', 'flow'].includes(call[0])), false);
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'breath' && call[1] === metallicNodeSurface.selectionEffect.breathAmount));
  assert.equal(h.context.elements.motion.textContent, 'Motion: full');
});
