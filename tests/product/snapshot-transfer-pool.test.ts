import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SnapshotTransferPool } from '../../source/layout/SnapshotTransferPool.js';

test('SnapshotTransferPool bounds in-flight ownership and reuses a reclaimed slot', () => {
  const pool = new SnapshotTransferPool(3);
  const first = pool.acquire(2);
  const second = pool.acquire(2);
  const third = pool.acquire(2);

  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  assert.equal(pool.slotCount, 3);
  assert.equal(pool.inFlightCount, 3);
  assert.equal(pool.acquire(2), undefined);

  first.buffers.positions.set([1, 2, 3, 4, 5, 6]);
  assert.equal(pool.reclaim(first), true);
  assert.equal(pool.inFlightCount, 2);

  const reused = pool.acquire(2);
  assert.ok(reused);
  assert.equal(reused.poolId, first.poolId);
  assert.deepEqual([...reused.buffers.positions], [1, 2, 3, 4, 5, 6]);
  assert.equal(pool.reclaim(reused), true);
  assert.equal(pool.reclaim(reused), false);
});

test('SnapshotTransferPool reallocates only an available slot when graph dimensions change', () => {
  const pool = new SnapshotTransferPool(1);
  const first = pool.acquire(1);
  assert.ok(first);
  assert.equal(pool.reclaim(first), true);

  const resized = pool.acquire(4);
  assert.ok(resized);
  assert.equal(resized.poolId, first.poolId);
  assert.equal(resized.buffers.nodeIndices.length, 4);
  assert.equal(resized.buffers.positions.length, 12);
  assert.equal(resized.buffers.velocities.length, 12);
});
