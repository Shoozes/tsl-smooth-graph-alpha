import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchScanFixture } from '../../examples/showcase/examples/search-scan/search-scan-model.js';
import { createSearchScanTimeline } from '../../examples/showcase/examples/search-scan/search-scan-timeline.js';

const smallFixture = () => buildSearchScanFixture({ pointsPerGroup: 60 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('search scan fixture is seeded, bounded, and independent between calls', () => {
  const first = smallFixture();
  const second = smallFixture();
  assert.deepEqual(first, second);
  assert.notStrictEqual(first.nodes[0], second.nodes[0]);
  assert.notDeepEqual(first.nodes[0].initialPosition, buildSearchScanFixture({ pointsPerGroup: 60, seed: 12 }).nodes[0].initialPosition);
  assert.equal(first.groups.length, 7);
  assert.equal(first.nodes.length, 7 * 80);
  for (const node of first.nodes) {
    assert.deepEqual(node.fixed, node.initialPosition);
    assert.ok(Object.values(node.initialPosition).every(Number.isFinite));
    assert.ok(Number.isFinite(node.data.radius) && node.data.radius > 0);
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(node.initialPosition[axis] - node.data.radius >= first.bounds.min[axis]);
      assert.ok(node.initialPosition[axis] + node.data.radius <= first.bounds.max[axis]);
    }
    assert.ok(distance(node.initialPosition, first.bounds.center) + node.data.radius <= first.bounds.radius + 1e-10);
  }
  assert.ok(first.bounds.size.z < first.bounds.size.x / 5, 'clusters retain shallow depth');
  assert.throws(() => { first.nodes[0].fixed.x = 0; }, TypeError);
});

test('search scan links connect distinct nearby members with valid unique references', () => {
  const fixture = buildSearchScanFixture();
  const byId = new Map(fixture.nodes.map(node => [node.id, node]));
  const byGroup = new Map(fixture.groups.map(group => [group.id, group]));
  assert.equal(byId.size, fixture.nodes.length);
  const pairs = new Set();
  const linkIds = new Set();
  for (const link of fixture.links) {
    assert.ok(byId.has(link.source) && byId.has(link.target));
    assert.notEqual(link.source, link.target);
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    assert.equal(source.data.groupId, target.data.groupId);
    assert.ok(distance(source.initialPosition, target.initialPosition) <= byGroup.get(source.data.groupId).radius * 0.55 + 1e-10);
    const pair = [link.source, link.target].sort().join('|');
    assert.ok(!pairs.has(pair), 'undirected links are unique');
    assert.ok(!linkIds.has(link.id));
    pairs.add(pair);
    linkIds.add(link.id);
  }
  assert.ok(fixture.links.length >= fixture.nodes.length * 2);
  assert.ok(fixture.links.length <= fixture.nodes.length * 3);
  for (const group of fixture.groups) {
    assert.equal(group.nodeIds.length, 20);
    for (const id of group.nodeIds) {
      assert.equal(byId.get(id).data.kind, 'word');
      assert.equal(byId.get(id).data.groupId, group.id);
      assert.equal(typeof byId.get(id).data.label, 'string');
    }
  }
});

test('fixture result IDs retain the supplied scan order and identify synthetic matches', () => {
  const fixture = smallFixture();
  const byId = new Map(fixture.nodes.map(node => [node.id, node]));
  assert.deepEqual(fixture.steps.map(step => step.groupId), ['roles', 'rules', 'review', 'start']);
  assert.deepEqual(fixture.resultNodeIds, [
    'roles-word-4', 'roles-word-16', 'rules-word-4', 'rules-word-16',
    'review-word-4', 'review-word-16', 'start-word-4', 'start-word-16'
  ]);
  assert.ok(fixture.resultNodeIds.every(id => byId.get(id).data.annotation === 'match'));
  assert.ok(buildSearchScanFixture({ pointsPerGroup: 0 }).nodes.every(node => node.data.kind === 'word'));
});

test('fixture rejects nonfinite, fractional, negative, and excessive input', () => {
  for (const seed of [-1, 0.1, NaN, Infinity, 2 ** 32, '1', null]) {
    assert.throws(() => buildSearchScanFixture({ seed }), /seed/);
  }
  for (const pointsPerGroup of [-1, 0.5, NaN, Infinity, 4_097, '4', null]) {
    assert.throws(() => buildSearchScanFixture({ pointsPerGroup }), /pointsPerGroup/);
  }
  assert.doesNotThrow(() => buildSearchScanFixture({ seed: 0, pointsPerGroup: 0 }));
  assert.throws(() => buildSearchScanFixture(null), /options/);
  assert.throws(() => buildSearchScanFixture([]), /options/);
});

test('timeline has exact scan, travel, overview, and complete boundaries', () => {
  const fixture = smallFixture();
  const timeline = createSearchScanTimeline(fixture);
  assert.equal(timeline.durationMs, 11_100);
  const expected = [
    [0, 'scan', 'roles'], [899.999, 'scan', 'roles'], [900, 'travel', 'rules'],
    [1_200, 'scan', 'rules'], [3_800, 'travel', 'review'], [4_100, 'scan', 'review'],
    [6_700, 'travel', 'start'], [7_000, 'scan', 'start'], [9_600, 'overview', 'start'],
    [11_100, 'complete', 'start'], [20_000, 'complete', 'start']
  ];
  for (const [time, phase, groupId] of expected) {
    const state = timeline.sample(time);
    assert.equal(state.phase, phase, `phase at ${time}`);
    assert.equal(state.groupId, groupId, `group at ${time}`);
    assert.ok(state.phaseProgress >= 0 && state.phaseProgress <= 1);
  }
  assert.equal(timeline.sample(0).activeNodeId, 'roles-word-0');
  assert.deepEqual(timeline.sample(900).completedGroupIds, ['roles']);
  assert.equal(timeline.sample(900).previousGroupId, 'roles');
  assert.equal(timeline.sample(10_350).overviewProgress, 0.5);
  const completed = timeline.sample(timeline.durationMs);
  assert.deepEqual(completed.completedGroupIds, ['roles', 'rules', 'review', 'start']);
  assert.equal(completed.visibleNodeIds.length, 140);
  assert.equal(completed.progress, 1);
  assert.equal(completed.activeNodeId, 'start-word-19');
});

test('absolute-time sampling supports backward seek without leaking completed state', () => {
  const timeline = createSearchScanTimeline(smallFixture());
  const before = timeline.sample(470);
  timeline.sample(11_100);
  assert.deepEqual(timeline.sample(470), before);
  assert.deepEqual(timeline.sample(-1), timeline.sample(0));
  assert.deepEqual(timeline.sample(50_000), timeline.sample(11_100));
  assert.throws(() => { before.visibleNodeIds.push('unowned'); }, TypeError);
  for (const time of [NaN, Infinity, -Infinity, '500', null]) assert.throws(() => timeline.sample(time), /elapsedMs/);
});

test('cursor interpolation stays continuous across tokens, travel, and overview', () => {
  const fixture = smallFixture();
  const timeline = createSearchScanTimeline(fixture);
  const byId = new Map(fixture.nodes.map(node => [node.id, node.initialPosition]));
  const positionAt = time => {
    const state = timeline.sample(time);
    const a = byId.get(state.fromNodeId);
    const b = byId.get(state.toNodeId);
    return { x: a.x + (b.x - a.x) * state.nodeProgress, y: a.y + (b.y - a.y) * state.nodeProgress, z: a.z + (b.z - a.z) * state.nodeProgress };
  };
  const boundaries = [900, 1_200, 3_800, 4_100, 6_700, 7_000, 9_600, 11_100];
  for (let index = 1; index < 20; index += 1) boundaries.push(900 * index / 20);
  for (const time of boundaries) {
    assert.ok(distance(positionAt(time - 0.0001), positionAt(time)) < 1e-5, `arrival continuity at ${time}`);
    assert.ok(distance(positionAt(time), positionAt(time + 0.0001)) < 1e-5, `departure continuity at ${time}`);
  }
  assert.ok(distance(positionAt(900), positionAt(1_200)) > 20, 'travel actually reaches another group');
  assert.equal(timeline.sample(1_050).nodeProgress, 0.5);
});

test('timeline preserves caller group and node sequence, and copies caller input', () => {
  const groups = [{ id: 'a', nodeIds: ['a1', 'a2'] }, { id: 'b', nodeIds: ['b1', 'b2', 'b3'] }];
  const steps = [{ groupId: 'b', nodeIds: ['b3', 'b1', 'b2'], durationMs: 300 }, { groupId: 'a', nodeIds: ['a2', 'a1'], durationMs: 200 }];
  const timeline = createSearchScanTimeline({ groups, steps, travelMs: 100, overviewMs: 100 });
  const expected = timeline.sample(650);
  groups[0].nodeIds[0] = 'changed';
  steps[0].nodeIds.reverse();
  steps[0].durationMs = 5;
  steps.reverse();
  assert.equal(timeline.sample(0).groupId, 'b');
  assert.equal(timeline.sample(0).activeNodeId, 'b3');
  assert.equal(timeline.sample(100).activeNodeId, 'b1');
  assert.equal(timeline.sample(200).activeNodeId, 'b2');
  assert.equal(timeline.sample(400).activeNodeId, 'a2');
  assert.deepEqual(timeline.sample(650), expected);
  assert.deepEqual(expected.visibleNodeIds, ['b3', 'b1', 'b2', 'a2', 'a1']);
  assert.deepEqual(expected.completedGroupIds, ['b', 'a']);
});

test('a revisited group completes only after its last scan while result order stays stable', () => {
  const timeline = createSearchScanTimeline({
    groups: [{ id: 'a', nodeIds: ['a1', 'a2'] }, { id: 'b', nodeIds: ['b1'] }],
    steps: [
      { groupId: 'a', nodeIds: ['a1'], durationMs: 100 },
      { groupId: 'b', nodeIds: ['b1'], durationMs: 100 },
      { groupId: 'a', nodeIds: ['a2'], durationMs: 100 }
    ],
    travelMs: 0, overviewMs: 0
  });
  assert.deepEqual(timeline.sample(100).completedGroupIds, []);
  assert.deepEqual(timeline.sample(100).visibleNodeIds, ['a1', 'b1']);
  const revisiting = timeline.sample(250);
  assert.equal(revisiting.phase, 'scan');
  assert.equal(revisiting.groupId, 'a');
  assert.equal(revisiting.activeNodeId, 'a2');
  assert.deepEqual(revisiting.completedGroupIds, ['b']);
  assert.deepEqual(revisiting.visibleNodeIds, ['a1', 'b1', 'a2']);
  assert.deepEqual(timeline.sample(299.999).completedGroupIds, ['b']);
  const complete = timeline.sample(300);
  assert.deepEqual(complete.completedGroupIds, ['a', 'b'], 'completed groups retain first scheduled order');
  assert.deepEqual(complete.visibleNodeIds, ['a1', 'b1', 'a2'], 'results retain scan order across group revisits');
  assert.deepEqual(timeline.sample(250), revisiting, 'backward seek removes final completion again');
});

test('empty input and zero-duration steps have finite completed states', () => {
  const empty = createSearchScanTimeline();
  assert.equal(empty.durationMs, 0);
  assert.equal(empty.sample(0).phase, 'complete');
  assert.equal(empty.sample(0).groupId, null);
  assert.equal(empty.sample(0).fromNodeId, null);
  assert.deepEqual(empty.sample(0).visibleNodeIds, []);
  const groups = [{ id: 'a', nodeIds: ['a1'] }, { id: 'b', nodeIds: [] }];
  const steps = [{ groupId: 'a', nodeIds: ['a1'], durationMs: 0 }, { groupId: 'b', nodeIds: [], durationMs: 0 }];
  const instant = createSearchScanTimeline({ groups, steps, travelMs: 0, overviewMs: 0 });
  assert.equal(instant.durationMs, 0);
  assert.deepEqual(instant.sample(0).completedGroupIds, ['a', 'b']);
  assert.deepEqual(instant.sample(0).visibleNodeIds, ['a1']);
  const dwell = createSearchScanTimeline({ groups, steps: [{ groupId: 'b', nodeIds: [], durationMs: 100 }], overviewMs: 0 });
  assert.equal(dwell.sample(50).phase, 'scan');
  assert.equal(dwell.sample(50).activeNodeId, null);
  assert.equal(dwell.sample(100).phase, 'complete');
});

test('timeline rejects malformed references, duplicates, unbounded counts, and durations', () => {
  const groups = [{ id: 'a', nodeIds: ['a1', 'a2'] }, { id: 'b', nodeIds: ['b1'] }];
  const step = { groupId: 'a', nodeIds: ['a1'], durationMs: 100 };
  const invalid = [
    null, [], { groups: null }, { steps: {} }, { groups: [...groups, groups[0]] },
    { groups: [{ id: 'a', nodeIds: ['a1', 'a1'] }] },
    { groups: [{ id: 'a', nodeIds: ['a1'] }, { id: 'b', nodeIds: ['a1'] }] },
    { groups: [{ id: '', nodeIds: [] }] }, { groups: [{ id: 'a', nodeIds: [null] }] },
    { groups, steps: [{ ...step, groupId: 'missing' }] },
    { groups, steps: [{ ...step, nodeIds: ['b1'] }] },
    { groups, steps: [{ ...step, nodeIds: ['missing'] }] },
    { groups, steps: [{ ...step, durationMs: -1 }] },
    { groups, steps: [{ ...step, durationMs: NaN }] },
    { groups, steps: [{ ...step, durationMs: '100' }] },
    { groups, steps: [{ ...step, durationMs: 3_600_001 }] },
    { groups, steps: [null] }, { groups, steps: [{ ...step, nodeIds: null }] },
    { groups, travelMs: -1 }, { groups, overviewMs: Infinity },
    { groups, steps: [{ ...step, durationMs: 3_600_000 }], overviewMs: 1 },
    { groups: Array.from({ length: 129 }, (_, i) => ({ id: `g${i}`, nodeIds: [] })) },
    { groups, steps: Array.from({ length: 257 }, () => step) }
  ];
  for (const options of invalid) assert.throws(() => createSearchScanTimeline(options), /Search scan timeline/);
});
