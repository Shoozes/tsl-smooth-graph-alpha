import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GraphError } from '../../source/core/errors.js';
import { planLabelVisibility, type LabelCandidate } from '../../source/labels/index.js';

test('label visibility is deterministic across input order and suppresses lower-ranked overlaps', () => {
  const candidates: LabelCandidate[] = [
    { id: 'beta', priority: 10, bounds: { x: 0, y: 0, width: 20, height: 10 } },
    { id: 'alpha', priority: 10, bounds: { x: 1, y: 0, width: 20, height: 10 } },
    { id: 'separate', priority: 1, bounds: { x: 40, y: 0, width: 20, height: 10 } }
  ];

  const forward = planLabelVisibility(candidates);
  const reversed = planLabelVisibility([...candidates].reverse());
  const decisions = (plan: readonly { id: string | number; visible: boolean; reason: string }[]) =>
    Object.fromEntries(plan.map((entry) => [String(entry.id), { visible: entry.visible, reason: entry.reason }]));

  assert.deepEqual(decisions(forward), decisions(reversed));
  assert.deepEqual(decisions(forward), {
    beta: { visible: false, reason: 'collision' },
    alpha: { visible: true, reason: 'visible' },
    separate: { visible: true, reason: 'visible' }
  });
});

test('label visibility applies viewport, size, padding, and capacity policy in screen space', () => {
  const plan = planLabelVisibility([
    { id: 'small', priority: 100, bounds: { x: 0, y: 0, width: 20, height: 2 } },
    { id: 'outside', priority: 100, bounds: { x: 200, y: 0, width: 20, height: 10 } },
    { id: 'first', priority: 5, bounds: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'padded-collision', priority: 4, bounds: { x: 11, y: 0, width: 10, height: 10 } },
    { id: 'capacity', priority: 3, bounds: { x: 40, y: 0, width: 10, height: 10 } }
  ], {
    viewport: { x: 0, y: 0, width: 100, height: 100 },
    minimumPixelHeight: 5,
    collisionPadding: 2,
    maximumVisible: 1
  });

  assert.deepEqual(plan.map(({ id, reason }) => ({ id, reason })), [
    { id: 'small', reason: 'below-minimum-size' },
    { id: 'outside', reason: 'outside-viewport' },
    { id: 'first', reason: 'visible' },
    { id: 'padded-collision', reason: 'collision' },
    { id: 'capacity', reason: 'maximum-visible' }
  ]);
});

test('label visibility copies inputs and rejects malformed candidates and options', () => {
  const bounds = { x: 0, y: 0, width: 12, height: 8 };
  const candidates: LabelCandidate[] = [{ id: 1, bounds, priority: 2 }];
  const plan = planLabelVisibility(candidates);

  assert.deepEqual(candidates, [{ id: 1, bounds, priority: 2 }]);
  assert.notEqual(plan[0]?.bounds, bounds);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan[0]));
  assert.ok(Object.isFrozen(plan[0]?.bounds));

  assert.throws(
    () => planLabelVisibility([
      { id: 'same', bounds },
      { id: 'same', bounds: { x: 20, y: 0, width: 12, height: 8 } }
    ]),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LABEL_DUPLICATE_ID'
  );
  assert.throws(
    () => planLabelVisibility([{ id: 'bad', bounds: { x: 0, y: 0, width: 0, height: 1 } }]),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LABEL_INVALID_CANDIDATE'
  );
  assert.throws(
    () => planLabelVisibility([{ id: 'ok', bounds }], { collisionPadding: -1 }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LABEL_INVALID_OPTIONS'
  );
});

test('label visibility scales ordinary non-overlapping candidates through bounded collision buckets', () => {
  const candidates = Array.from({ length: 4_096 }, (_, index): LabelCandidate => ({
    id: index,
    bounds: {
      x: (index % 128) * 80,
      y: Math.floor(index / 128) * 40,
      width: 24,
      height: 12
    }
  }));

  const plan = planLabelVisibility(candidates);

  assert.equal(plan.length, candidates.length);
  assert.equal(plan.every((decision) => decision.visible && decision.reason === 'visible'), true);
});

test('label visibility keeps exact collision semantics for oversized and padded candidates', () => {
  const plan = planLabelVisibility([
    { id: 'oversized', priority: 3, bounds: { x: -1000, y: -1000, width: 4000, height: 4000 } },
    { id: 'inside', priority: 2, bounds: { x: 10, y: 10, width: 20, height: 10 } },
    { id: 'separate', priority: 1, bounds: { x: 5000, y: 0, width: 20, height: 10 } },
    { id: 'padded', priority: 0, bounds: { x: 5021, y: 0, width: 20, height: 10 } }
  ], { collisionPadding: 2 });

  assert.deepEqual(plan.map(({ id, reason }) => ({ id, reason })), [
    { id: 'oversized', reason: 'visible' },
    { id: 'inside', reason: 'collision' },
    { id: 'separate', reason: 'visible' },
    { id: 'padded', reason: 'collision' }
  ]);
});

test('label visibility distributes thousands of oversized non-overlapping candidates across coarse cells', () => {
  const candidates = Array.from({ length: 4_096 }, (_, index): LabelCandidate => ({
    id: index,
    bounds: {
      x: index * 6_000,
      y: 0,
      width: 5_000,
      height: 12
    }
  }));

  const plan = planLabelVisibility(candidates);

  assert.equal(plan.length, candidates.length);
  assert.equal(plan.every((decision) => decision.visible && decision.reason === 'visible'), true);
});

test('label visibility preserves collisions between ordinary and coarse hierarchy levels', () => {
  const plan = planLabelVisibility([
    { id: 'ordinary-first', priority: 4, bounds: { x: 8_000, y: 8, width: 24, height: 12 } },
    { id: 'coarse-overlap', priority: 3, bounds: { x: 4_000, y: 0, width: 5_000, height: 40 } },
    { id: 'coarse-first', priority: 2, bounds: { x: 20_000, y: 0, width: 5_000, height: 40 } },
    { id: 'ordinary-overlap', priority: 1, bounds: { x: 21_000, y: 8, width: 24, height: 12 } }
  ]);

  assert.deepEqual(plan.map(({ id, reason }) => ({ id, reason })), [
    { id: 'ordinary-first', reason: 'visible' },
    { id: 'coarse-overlap', reason: 'collision' },
    { id: 'coarse-first', reason: 'visible' },
    { id: 'ordinary-overlap', reason: 'collision' }
  ]);
});
