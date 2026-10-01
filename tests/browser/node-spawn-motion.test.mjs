import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createNodeSpawnMotion,
  parentRelativePosition
} from '../../examples/showcase/examples/runtime/node-spawn-motion.js';

test('parent-relative spawn positions are deterministic, bounded, and dimension aware', () => {
  const parent = { x: 4, y: -2, z: 8 };
  const first = parentRelativePosition(parent, 'parent', 'child', { distance: 2.4, seed: 17 });
  const second = parentRelativePosition(parent, 'parent', 'child', { distance: 2.4, seed: 17 });
  const planar = parentRelativePosition(parent, 'parent', 'child', { distance: 3, dimensions: 2, seed: 17 });

  assert.deepEqual(first, second);
  assert.ok(Math.abs(Math.hypot(first.x - parent.x, first.y - parent.y, first.z - parent.z) - 2.4) < 1e-9);
  assert.ok(Math.abs(Math.hypot(planar.x - parent.x, planar.y - parent.y) - 3) < 1e-9);
  assert.equal(planar.z, 0);
});

test('spawn motion shares one frame scheduler and batches style refreshes', () => {
  let now = 100;
  let nextFrame = 0;
  const frames = new Map();
  const refreshes = [];
  const motion = createNodeSpawnMotion({
    now: () => now,
    requestFrame: (callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    refreshNodeStyles: (ids) => refreshes.push([...ids])
  });

  motion.animate('a');
  motion.animate('b', { delayMs: 40 });
  assert.equal(frames.size, 1);
  assert.equal(motion.activeCount, 2);
  refreshes.length = 0;

  now = 330;
  const frame = [...frames.values()][0];
  frames.clear();
  frame(now);
  assert.equal(refreshes.length, 1);
  assert.deepEqual(new Set(refreshes[0]), new Set(['a', 'b']));
  assert.equal(frames.size, 1);

  now = 700;
  const finalFrame = [...frames.values()][0];
  frames.clear();
  finalFrame(now);
  assert.equal(motion.scale('a'), 1);
  assert.equal(motion.scale('b'), 1);
  assert.equal(motion.activeCount, 0);
  assert.equal(frames.size, 0);
  motion.dispose();
});

test('reduced motion settles immediately without scheduling a frame', () => {
  let scheduled = false;
  const refreshed = [];
  const motion = createNodeSpawnMotion({
    reducedMotion: () => true,
    requestFrame: () => {
      scheduled = true;
      return 1;
    },
    cancelFrame: () => undefined,
    refreshNodeStyles: (ids) => refreshed.push([...ids])
  });

  assert.equal(motion.animate('instant'), false);
  assert.equal(motion.scale('instant'), 1);
  assert.equal(motion.activeCount, 0);
  assert.equal(scheduled, false);
  assert.deepEqual(refreshed, [['instant']]);
  motion.dispose();
});
