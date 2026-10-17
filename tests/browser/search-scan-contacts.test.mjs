import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchScanContacts, SEARCH_SCAN_LEG_COUNT } from '../../examples/showcase/examples/search-scan/search-scan-contacts.js';

test('legs choose the nearest reachable forward node, including unlabelled points', () => {
  const nodes = [
    node('label', 14, 0, 0, { label: 'labelled farther node' }),
    node('point', 9),
    node('other-group', 9.5, 0, 0, { groupId: 'b' }),
    node('inside-body', 0.5),
    node('behind', -9.5),
    node('too-far', 25)
  ];
  const before = structuredClone(nodes);
  const h = harness(nodes);
  const legs = h.contacts.sample(scan(260));
  assert.equal(legs.length, SEARCH_SCAN_LEG_COUNT);
  assert.equal(SEARCH_SCAN_LEG_COUNT, 24);
  assert.deepEqual(legs.map(leg => leg.legId), Array.from({ length: 24 }, (_, id) => id));
  assert.equal(legs[0].targetNodeId, 'point');
  assert.equal(legs[0].phase, 'touch');
  assert.equal(legs[0].touching, true);
  assert.deepEqual(legs[0].targetPosition, { x: 9, y: 0, z: 0 });
  assert.deepEqual(nodes, before, 'Sampling does not modify graph records.');
});

test('equal-distance targets use stable IDs independently of input order', () => {
  const nodes = [node('z-target', 9), node('a-target', 9)];
  const first = harness(nodes).contacts.sample(scan(260));
  const reordered = harness([...nodes].reverse()).contacts.sample(scan(260));
  assert.equal(first[0].targetNodeId, 'a-target');
  assert.deepEqual(reordered, first);
});

test('reach, actual contact and afterglow are sampled from time without observed contact events', () => {
  const h = harness([node('target', 9)]);
  const reach = h.contacts.sample(scan(104))[0];
  assert.equal(reach.phase, 'reach');
  assert.ok(reach.reach > 0 && reach.reach < 1);
  assert.equal(reach.contactStrength, 0, 'Approaching a node must not light it before contact.');
  assert.equal(reach.touching, false);
  const touch = h.contacts.sample(scan(260))[0];
  assert.equal(touch.phase, 'touch');
  assert.equal(touch.reach, 1);
  assert.equal(touch.contactStartMs, 208);
  assert.ok(touch.contactStrength > 0.8 && touch.contactStrength <= 1);
  const retract = h.contacts.sample(scan(416))[0];
  assert.equal(retract.phase, 'retract');
  assert.ok(retract.reach > 0 && retract.reach < 1);
  assert.ok(retract.contactStrength > 0 && retract.contactStrength < touch.contactStrength);
  assert.equal(retract.touching, false);
  assert.deepEqual(harness([node('target', 9)]).contacts.sample(scan(416))[0], retract,
    'A sparse first frame after contact still produces its correct afterglow.');
  const nextCycle = h.contacts.sample(scan(520))[0];
  assert.equal(nextCycle.contactStrength, 0, 'The completed cycle does not leak its light into the next reach.');
  assert.equal(nextCycle.touching, false);
});

test('cycle targets stay locked while endpoint positions are read live and copied', () => {
  const h = harness([node('target', 9), node('alternate', 12)]);
  const before = h.contacts.sample(scan(104))[0];
  h.positions.set('target', { x: 10, y: 1, z: 0.5 });
  h.positions.set('alternate', { x: 9, y: 0, z: 0 });
  const contact = h.contacts.sample(scan(260))[0];
  assert.equal(contact.targetNodeId, before.targetNodeId);
  assert.equal(contact.touching, true);
  assert.deepEqual(contact.targetPosition, h.positions.get('target'));
  contact.targetPosition.x = 100;
  assert.equal(h.positions.get('target').x, 10, 'Inspection cannot mutate a graph position.');
  h.positions.set('target', { x: 40, y: 0, z: 0 });
  const unreachable = h.contacts.sample(scan(270))[0];
  assert.equal(unreachable.phase, 'idle');
  assert.equal(unreachable.targetNodeId, null);
  assert.equal(unreachable.touching, false);
  assert.equal(unreachable.contactStrength, 0, 'An externally moved target cannot report contact out of reach.');
});

test('seek, reset and inactive phases cannot retain stale targets or contact lights', () => {
  const nodes = Array.from({ length: 24 }, (_, index) => node(`target-${index}`,
    Math.cos(index / 24 * Math.PI * 2) * 9, Math.sin(index / 24 * Math.PI * 2) * 9));
  const h = harness(nodes);
  const contact = h.contacts.sample(scan(260));
  assert.ok(contact.some(leg => leg.touching));
  h.contacts.sample(scan(1_900));
  assert.deepEqual(h.contacts.sample(scan(260)), contact, 'Backward seeking rebuilds the same plans.');
  for (const [sample, options] of [
    [scan(260, { phase: 'travel' }), {}],
    [scan(260, { phase: 'overview' }), {}],
    [scan(260, { phase: 'complete' }), {}],
    [scan(260), { reducedMotion: true }],
    [scan(260), { overview: true }]
  ]) {
    assertIdle(h.contacts.sample(sample, options));
    assert.deepEqual(h.contacts.sample(scan(260)), contact);
  }
  h.contacts.reset();
  assert.deepEqual(h.contacts.sample(scan(260)), contact, 'Reset does not alter the deterministic plan.');
  assertIdle(h.contacts.sample(scan(50, { groupScanEndMs: 100 })));
  assertIdle(harness([]).contacts.sample(scan(260)));
});

test('target planning considers the contact interval and reset invalidates anchor-dependent plans', () => {
  const h = harness([node('near-first-anchor', 9), node('near-second-anchor', 39)]);
  assert.equal(h.contacts.sample(scan(260))[0].targetNodeId, 'near-first-anchor');
  h.center.x = 30;
  assert.equal(h.contacts.sample(scan(260))[0].targetNodeId, null, 'The old locked target is now outside reach.');
  h.contacts.reset();
  assert.equal(h.contacts.sample(scan(260))[0].targetNodeId, 'near-second-anchor');

  const moving = createSearchScanContacts({
    nodes: [node('unreachable-later', 9)],
    sampleAnchor: time => ({ center: { x: time < 250 ? 0 : 50, y: 0, z: 2 }, scale: 1, groupId: 'a', phase: 'scan' }),
    getNodePosition: () => ({ x: 9, y: 0, z: 0 })
  });
  const leg = moving.sample(scan(210))[0];
  assert.equal(leg.phase, 'idle');
  assert.equal(leg.targetNodeId, null, 'A candidate reachable only at contact onset must not be planted for the full hold.');
});

function scan(timeMs, overrides = {}) {
  return { phase: 'scan', timeMs, groupId: 'a', stepIndex: 0, groupScanStartMs: 0, groupScanEndMs: 2_600, ...overrides };
}

function node(id, x, y = 0, z = 0, data = {}) {
  return { id, initialPosition: { x, y, z }, data: { groupId: 'a', radius: 0.2, kind: 'point', ...data } };
}

function harness(nodes) {
  const center = { x: 0, y: 0, z: 2 };
  const positions = new Map(nodes.map(item => [item.id, { ...item.initialPosition }]));
  const contacts = createSearchScanContacts({
    nodes,
    sampleAnchor: () => ({ center: { ...center }, scale: 1, groupId: 'a', phase: 'scan' }),
    getNodePosition: id => positions.get(id)
  });
  return { center, positions, contacts };
}

function assertIdle(legs) {
  assert.equal(legs.length, SEARCH_SCAN_LEG_COUNT);
  for (const leg of legs) {
    assert.equal(leg.phase, 'idle');
    assert.equal(leg.targetNodeId, null);
    assert.equal(leg.targetPosition, null);
    assert.equal(leg.contactStartMs, null);
    assert.equal(leg.touching, false);
    assert.equal(leg.contactStrength, 0);
    assert.equal(leg.reach, 0);
  }
}
