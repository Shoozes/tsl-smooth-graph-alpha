import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createSearchScanPrefab } from '../../examples/showcase/examples/search-scan/search-scan-prefab.js';
import { buildSearchScanFixture } from '../../examples/showcase/examples/search-scan/search-scan-model.js';

test('prefab preflight rejects malformed references and nonfinite geometry before acquiring resources', () => {
  const cases = [
    ['duplicate node', (h) => h.model.nodes.push(h.model.nodes[0]), /Duplicate.*node/],
    ['missing node data', (h) => { h.model.nodes[0].data = null; }, /requires data/],
    ['unknown group', (h) => { h.model.nodes[0].data.groupId = 'missing'; }, /unknown group/],
    ['ghost group member', (h) => { h.model.groups[0].nodeIds[0] = 'ghost'; h.model.steps[0].nodeIds[0] = 'ghost'; }, /unknown node ghost/],
    ['wrong group membership', (h) => { h.model.groups[1].nodeIds.push('a1'); }, /wrong group/],
    ['unlisted label', (h) => { h.model.groups[0].nodeIds.pop(); }, /missing from its group/],
    ['invalid label', (h) => { h.model.nodes[0].data.label = null; }, /label must be a string/],
    ['invalid color', (h) => { h.model.nodes[0].data.color = '#ffffff'; }, /RGB integer/],
    ['invalid center', (h) => { h.model.groups[0].center.x = NaN; }, /finite float32/],
    ['invalid radius', (h) => { h.model.groups[0].radius = Infinity; }, /radius must be/],
    ['unknown edge', (h) => { h.model.links[0].target = 'ghost'; }, /link refers to an unknown node/],
    ['unknown initial result', (h) => { h.model.resultNodeIds = ['ghost']; }, /Unknown.*result label/],
    ['invalid result collection', (h) => { h.model.resultNodeIds = 'a1'; }, /must be an array/],
    ['missing graph node', (h) => h.positions.delete('a1'), /a1 is missing from the graph/],
    ['invalid graph position', (h) => { h.positions.get('a1').z = Infinity; }, /finite float32/],
    ['invalid graph bounds', (h) => { h.bounds.min.x = NaN; }, /finite float32/],
    ['invalid step', (h) => { h.model.steps[0].nodeIds = ['b1']; }, /outside a/],
    ['invalid duration', (h) => { h.model.steps[0].durationMs = -1; }, /duration/]
  ];
  for (const [label, corrupt, expected] of cases) {
    const host = makeHost();
    corrupt(host);
    assert.throws(() => host.create(), expected, label);
    assert.equal(host.resources.length, 0, `${label}: no GPU resources acquired`);
    assert.deepEqual(host.scene.children, [host.borrowedObject], `${label}: borrowed scene unchanged`);
    assert.equal(host.labelLayer.children.length, 0, `${label}: no DOM attached`);
  }
});

test('prefab uses string IDs without collisions or coercing numeric graph IDs', () => {
  const host = makeHost();
  renameNode(host, 'a1', 'group:a');
  const prefab = host.create();
  prefab.resize(900, 600);
  prefab.render(20);
  const owned = host.labelLayer.children[0];
  assert.equal(owned.children.length, 5);
  assert.equal(prefab.inspect().labelCapacity, 5);
  const heading = owned.children.find((element) => element.className === 'scan-group-label' && element.children[0].textContent === 'A');
  assert.match(heading.children[1].textContent, /revealing/);
  assert.equal(owned.children.filter((element) => element.className === 'scan-word-label').length, 3);
  prefab.dispose();

  const numeric = makeHost();
  renameNode(numeric, 'a1', 0);
  assert.throws(() => numeric.create(), /string ID.*numeric IDs are not converted/);
  assert.equal(numeric.resources.length, 0);

  const distinct = makeHost();
  renameNode(distinct, 'a1', '0');
  const position = distinct.positions.get('0');
  distinct.positions.delete('0');
  distinct.positions.set(0, position);
  assert.throws(() => distinct.create(), /node 0 is missing from the graph/);
});

test('construction rolls back resources when a Three allocation or scene attachment fails', () => {
  for (const failure of ['geometry', 'attachment', 'DOM']) {
    const host = makeHost();
    if (failure === 'geometry') {
      host.THREE.RingGeometry = class { constructor() { throw new Error('Injected geometry failure'); } };
    } else if (failure === 'attachment') {
      const add = host.scene.add.bind(host.scene);
      let additions = 0;
      host.scene.add = (...objects) => {
        add(...objects);
        if (++additions === 2) throw new Error('Injected attachment failure');
        return host.scene;
      };
    } else {
      const create = host.document.createElement;
      host.document.createElement = (tag) => {
        if (tag === 'strong') throw new Error('Injected DOM failure');
        return create(tag);
      };
    }
    assert.throws(() => host.create(), /Injected/, failure);
    assert.ok(host.resources.length > 0, `${failure}: failure happened after allocation`);
    assert.ok(host.resources.every(({ disposals }) => disposals === 1), `${failure}: each resource released once`);
    assert.deepEqual(host.scene.children, [host.borrowedObject], `${failure}: only borrowed content remains`);
    assert.equal(host.labelLayer.children.length, 0, `${failure}: owned label root removed`);
    assert.equal(host.graphDisposals, 0, `${failure}: borrowed graph preserved`);
  }
});

test('invalid replacement leaves the current timeline and results intact', () => {
  const host = makeHost();
  const prefab = host.create();
  prefab.resize(900, 600);
  const before = prefab.render(75);
  const duration = prefab.durationMs;
  const resourceCount = host.resources.length;
  assert.throws(() => prefab.setSequence(host.model.steps, { resultNodeIds: ['missing'] }), /Unknown.*result label/);
  assert.equal(prefab.durationMs, duration);
  assert.deepEqual(prefab.render(75), before);
  assert.throws(() => prefab.setSequence([{ groupId: 'a', nodeIds: ['b1'], durationMs: 100 }]), /outside a/);
  assert.throws(() => prefab.setSequence(undefined), /steps must be an array/);
  host.positions.delete('a1');
  assert.throws(() => prefab.setSequence(host.model.steps), /missing from the graph/);
  assert.equal(prefab.durationMs, duration);
  assert.equal(host.resources.length, resourceCount);
  prefab.dispose();
});

test('seeking, empty results, restoring, and reduced motion preserve graph ownership and finite cameras', () => {
  const fixture = buildSearchScanFixture({ pointsPerGroup: 2 });
  const host = makeHost(structuredClone(fixture));
  const beforeModel = structuredClone(host.model);
  const beforePositions = [...host.positions];
  const prefab = host.create();
  prefab.resize(598, 512);
  host.camera.aspect = 598 / 512;
  host.camera.updateProjectionMatrix();
  const sample = prefab.render(4300);
  const pose = structuredClone(host.lastPose);
  prefab.render(prefab.durationMs);
  assert.deepEqual(prefab.render(4300), sample);
  assert.deepEqual(host.lastPose, pose);
  assert.ok([...Object.values(pose.position), ...Object.values(pose.target)].every(Number.isFinite));

  prefab.setSequence([], { resultNodeIds: [] });
  assert.equal(prefab.durationMs, 0);
  assert.deepEqual(prefab.render(0).visibleNodeIds, []);
  assert.equal(host.scene.getObjectByName('search-scan-marker').visible, false);
  prefab.setSequence(fixture.steps, { resultNodeIds: fixture.resultNodeIds });
  prefab.render(prefab.durationMs, { reducedMotion: true });
  const stationaryPose = structuredClone(host.lastPose);
  prefab.render(100, { reducedMotion: true });
  assert.deepEqual(host.lastPose, stationaryPose);
  assert.deepEqual(host.model, beforeModel);
  assert.deepEqual([...host.positions], beforePositions);

  assert.throws(() => prefab.resize(1, Number.MIN_VALUE), /aspect.*finite/);
  prefab.dispose();
  prefab.dispose();
  assert.equal(prefab.inspect().disposed, true);
  assert.equal(prefab.inspect().labelCapacity, 0);
  assert.equal(prefab.render(0), null);
  assert.throws(() => prefab.setSequence([]), /disposed/);
  assert.equal(host.labelLayer.children.length, 0);
  assert.deepEqual(host.scene.children, [host.borrowedObject]);
  assert.ok(host.resources.every(({ disposals }) => disposals === 1));
  assert.equal(host.graphDisposals, 0);
});

test('revisited active groups show revealing and snapshot caller presentation metadata', () => {
  const host = makeHost();
  const prefab = host.create();
  prefab.resize(900, 600);
  prefab.setSequence([
    { groupId: 'a', nodeIds: ['a1'], durationMs: 100 },
    { groupId: 'b', nodeIds: ['b1'], durationMs: 100 },
    { groupId: 'a', nodeIds: ['a2'], durationMs: 100 }
  ]);
  host.model.groups[0].center.x = NaN;
  host.model.nodes[0].data.label = 'caller changed this';
  prefab.render(850);
  const heading = host.labelLayer.children[0].children.find((element) => element.className === 'scan-group-label' && element.children[0].textContent === 'A');
  assert.match(heading.children[1].textContent, /revealing/);
  assert.ok(Object.values(host.lastPose.position).every(Number.isFinite));
  assert.equal(host.labelLayer.children[0].children.some((element) => element.textContent === 'caller changed this'), false);
  prefab.dispose();
});

test('scanner lines, hands and contact lights meet live nodes under camera rotation, translation and scale', () => {
  const host = makeHost(contactModel());
  const beforeModel = structuredClone(host.model);
  const prefab = host.create();
  prefab.resize(900, 600);
  host.camera.position.set(80, 55, 120);
  host.camera.lookAt(17, -9, 4);
  prefab.render(104, { followCamera: false });
  const marker = host.scene.getObjectByName('search-scan-marker');
  const lines = host.scene.getObjectByName('search-scan-legs');
  assert.equal(marker.scale.x, 1.4);
  const approach = prefab.inspect().scanner.legs[0];
  assert.equal(approach.phase, 'reach');
  assert.ok(new THREE.Vector3(approach.worldTip.x, approach.worldTip.y, approach.worldTip.z)
    .distanceTo(new THREE.Vector3().copy(approach.targetPosition)) > 0.1);
  assert.equal(host.scene.getObjectByName('search-scan-contact-0').visible, false);

  prefab.render(260, { followCamera: false });
  const firstContact = prefab.inspect().scanner;
  const firstMarkerZ = marker.position.z;
  assert.ok(firstContact.contactCount > 0);
  assert.equal(firstContact.legCount, 24);
  assertWorldContacts();
  const targetId = firstContact.legs[0].targetNodeId;
  const target = host.positions.get(targetId);
  target.x += 0.8; target.y -= 0.3; target.z += 0.5;
  host.positions.get('anchor').x += 1;
  host.camera.position.set(-60, 40, 75);
  host.camera.lookAt(18, -9, 4);
  prefab.render(260, { followCamera: false });
  assert.equal(prefab.inspect().scanner.legs[0].targetNodeId, targetId);
  assert.equal(marker.position.x, 18);
  assert.equal(marker.position.z, firstMarkerZ, 'The existing scan bend is unchanged at the same timestamp.');
  assertWorldContacts();

  prefab.render(416, { followCamera: false });
  const retracted = prefab.inspect().scanner.legs[0];
  assert.equal(retracted.phase, 'retract');
  assert.ok(new THREE.Vector3().copy(retracted.worldTip).distanceTo(new THREE.Vector3().copy(target)) > 0.1);
  const fadingLight = host.scene.getObjectByName('search-scan-contact-0');
  assert.equal(fadingLight.visible, true);
  assert.ok(fadingLight.material.opacity > 0 && fadingLight.material.opacity < 1);
  assert.ok(fadingLight.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().copy(target)) < 1e-9);
  assert.deepEqual(host.model, beforeModel, 'Presentation contacts do not change the input graph data.');
  prefab.dispose();

  function assertWorldContacts() {
    host.scene.updateMatrixWorld(true);
    const scanner = prefab.inspect().scanner;
    const touching = scanner.legs.filter(leg => leg.touching);
    assert.ok(touching.length > 0);
    assert.equal(scanner.contactCount, touching.length);
    for (const leg of touching) {
      const target = new THREE.Vector3().copy(host.positions.get(leg.targetNodeId));
      const renderedEndpoint = new THREE.Vector3()
        .fromBufferAttribute(lines.geometry.getAttribute('position'), leg.legId * 28 + 27)
        .applyMatrix4(lines.matrixWorld);
      assert.ok(renderedEndpoint.distanceTo(target) < 1e-5, `Float32 leg ${leg.legId} endpoint contacts its node.`);
      assert.ok(new THREE.Vector3().copy(leg.worldTip).distanceTo(target) < 1e-9);
      const hand = host.scene.getObjectByName(`search-scan-hand-${leg.legId}`);
      const light = host.scene.getObjectByName(`search-scan-contact-${leg.legId}`);
      assert.ok(hand.getWorldPosition(new THREE.Vector3()).distanceTo(target) < 1e-9);
      assert.equal(light.visible, true);
      assert.ok(light.getWorldPosition(new THREE.Vector3()).distanceTo(target) < 1e-9);
      assert.equal(light.material.opacity, leg.contactStrength);
    }
  }
});

test('scanner contacts seek deterministically and clear through overview, reduction, replacement and disposal', () => {
  const host = makeHost(contactModel());
  const prefab = host.create();
  prefab.resize(900, 600);
  prefab.render(260);
  const contact = prefab.inspect().scanner;
  assert.ok(contact.contactCount > 0);
  prefab.render(1_400);
  prefab.render(260);
  assert.deepEqual(prefab.inspect().scanner, contact);
  for (const options of [{ overview: true }, { reducedMotion: true }]) {
    prefab.render(260, options);
    assertNoContactLights();
    prefab.render(260);
    assert.deepEqual(prefab.inspect().scanner, contact);
  }
  prefab.setSequence([], { resultNodeIds: [] });
  prefab.render(0);
  assertNoContactLights();
  assert.equal(host.scene.getObjectByName('search-scan-marker').visible, false);
  prefab.setSequence(host.model.steps, { resultNodeIds: host.model.resultNodeIds });
  prefab.render(260);
  assert.deepEqual(prefab.inspect().scanner, contact);
  prefab.dispose();
  assert.equal(prefab.inspect().scanner.contactCount, 0);
  assert.deepEqual(host.scene.children, [host.borrowedObject]);
  assert.ok(host.resources.every(resource => resource.disposals === 1), 'Shared contact resources are released exactly once.');
  assert.equal(host.graphDisposals, 0);

  function assertNoContactLights() {
    const scanner = prefab.inspect().scanner;
    assert.equal(scanner.contactCount, 0);
    assert.ok(scanner.legs.every(leg => !leg.touching && leg.contactStrength === 0 && leg.targetNodeId === null));
    for (let index = 0; index < scanner.legCount; index += 1) {
      assert.equal(host.scene.getObjectByName(`search-scan-contact-${index}`).visible, false);
    }
  }
});

test('actual fixture scan boundaries begin with retracted hands instead of partial-cycle extensions', (t) => {
  const fixture = buildSearchScanFixture({ pointsPerGroup: 900 });
  const host = makeHost(fixture);
  const prefab = host.create();
  t.after(() => prefab.dispose());
  prefab.resize(900, 600);
  let time = 0;
  for (const step of fixture.steps) {
    prefab.render(time);
    const scanner = prefab.inspect().scanner;
    assert.equal(scanner.contactCount, 0, `${step.groupId} starts without a planted hand.`);
    for (const leg of scanner.legs) {
      assert.equal(leg.reach, 0, `${step.groupId} leg ${leg.legId} cannot enter with an already extended hand.`);
      assert.ok(leg.phase === 'idle' || leg.phase === 'reach');
    }
    time += step.durationMs + 300;
  }
});

test('fast actual-fixture scans keep touching hands planted throughout each feasible hold', (t) => {
  const fixture = buildSearchScanFixture({ pointsPerGroup: 900 });
  const host = makeHost(fixture);
  const prefab = host.create();
  t.after(() => prefab.dispose());
  prefab.resize(900, 600);
  const planted = new Map();
  const observed = new Set();
  for (let time = 0; time < fixture.steps[0].durationMs; time += 2) {
    prefab.render(time);
    const scanner = prefab.inspect().scanner;
    for (const leg of scanner.legs) {
      const hold = planted.get(leg.legId);
      if (hold && time < hold.endMs - 1e-6) {
        assert.equal(leg.touching, true, `Leg ${leg.legId} must not drop its planted contact at ${time}ms.`);
        assert.equal(leg.targetNodeId, hold.targetNodeId);
      } else planted.delete(leg.legId);
      if (leg.touching && leg.contactProgress > 0) {
        const endMs = leg.contactStartMs + (time - leg.contactStartMs) / leg.contactProgress;
        assert.ok(Number.isFinite(endMs) && endMs >= time - 1e-6);
        planted.set(leg.legId, { endMs, targetNodeId: leg.targetNodeId });
        observed.add(`${leg.legId}:${leg.contactStartMs}`);
        assert.ok(new THREE.Vector3().copy(leg.worldTip)
          .distanceTo(new THREE.Vector3().copy(host.positions.get(leg.targetNodeId))) < 1e-5);
      }
    }
  }
  assert.ok(observed.size > 0, 'The real fixture must produce contacts; all-idle motion is not a valid repair.');
});

function contactModel() {
  const center = { x: 17, y: -9, z: 4 };
  const color = 0x67d9c1;
  const nodes = [{ id: 'anchor', initialPosition: { ...center }, data: { groupId: 'a', color, radius: 0.4, label: 'anchor', kind: 'word' } }];
  for (let index = 0; index < 24; index += 1) {
    const angle = index / 24 * Math.PI * 2;
    nodes.push({
      id: `point-${index}`,
      initialPosition: { x: center.x + Math.cos(angle) * 12, y: center.y + Math.sin(angle) * 12, z: center.z + Math.sin(angle) },
      data: { groupId: 'a', color, radius: 0.25, kind: 'point' }
    });
  }
  return {
    nodes, links: [], groups: [{ id: 'a', label: 'A', color, center, radius: 35, nodeIds: ['anchor'] }],
    steps: [{ groupId: 'a', nodeIds: ['anchor'], durationMs: 1_600 }], resultNodeIds: [],
    bounds: { min: { x: -20, y: -45, z: -5 }, max: { x: 55, y: 30, z: 15 } }
  };
}

function makeHost(model = simpleModel()) {
  const resources = [];
  const injected = { ...THREE };
  for (const name of ['PlaneGeometry', 'CircleGeometry', 'RingGeometry', 'BufferGeometry', 'MeshBasicMaterial', 'MeshBasicNodeMaterial', 'LineBasicMaterial']) {
    injected[name] = class extends THREE[name] {
      constructor(...args) {
        super(...args);
        const record = { resource: this, disposals: 0 };
        this.addEventListener('dispose', () => { record.disposals += 1; });
        resources.push(record);
      }
    };
  }
  const document = { createElement: (tag) => new Element(tag, document) };
  const labelLayer = document.createElement('div');
  const scene = new THREE.Scene();
  const borrowedObject = new THREE.Group();
  scene.add(borrowedObject);
  const camera = new THREE.PerspectiveCamera(42, 1.5, 0.1, 4000);
  camera.position.set(0, 0, 200);
  camera.updateMatrixWorld();
  const positions = new Map(model.nodes.map((node) => [node.id, { ...node.initialPosition }]));
  const host = { THREE: injected, TSL, model, document, labelLayer, scene, borrowedObject, camera, positions, resources, bounds: structuredClone(model.bounds), graphDisposals: 0, lastPose: null };
  host.graph = {
    getNodePosition: (id) => positions.get(id),
    getGraphBounds: () => host.bounds,
    setCameraPose: (pose) => {
      assert.ok([...Object.values(pose.position), ...Object.values(pose.target)].every(Number.isFinite));
      host.lastPose = pose;
      camera.position.set(pose.position.x, pose.position.y, pose.position.z);
      camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
    },
    dispose: () => { host.graphDisposals += 1; }
  };
  host.create = () => createSearchScanPrefab(host);
  return host;
}

function simpleModel() {
  const nodes = [
    { id: 'a1', initialPosition: { x: -4, y: 0, z: 0 }, data: { groupId: 'a', color: 0x67d9c1, label: 'first' } },
    { id: 'a2', initialPosition: { x: 4, y: 1, z: 0 }, data: { groupId: 'a', color: 0x67d9c1, label: 'second' } },
    { id: 'b1', initialPosition: { x: 50, y: 0, z: 0 }, data: { groupId: 'b', color: 0xed4d91, label: 'third' } }
  ];
  return {
    groups: [
      { id: 'a', label: 'A', color: 0x67d9c1, center: { x: 0, y: 0, z: 0 }, radius: 10, nodeIds: ['a1', 'a2'] },
      { id: 'b', label: 'B', color: 0xed4d91, center: { x: 50, y: 0, z: 0 }, radius: 10, nodeIds: ['b1'] }
    ],
    nodes, links: [{ source: 'a1', target: 'b1' }],
    steps: [{ groupId: 'a', nodeIds: ['a1', 'a2'], durationMs: 200 }, { groupId: 'b', nodeIds: ['b1'], durationMs: 100 }],
    resultNodeIds: ['a2'], bounds: { min: { x: -15, y: -15, z: -1 }, max: { x: 65, y: 15, z: 1 } }
  };
}

function renameNode(host, before, after) {
  const node = host.model.nodes.find((item) => item.id === before);
  node.id = after;
  for (const group of host.model.groups) group.nodeIds = group.nodeIds.map((id) => id === before ? after : id);
  for (const step of host.model.steps) step.nodeIds = step.nodeIds.map((id) => id === before ? after : id);
  for (const link of host.model.links) {
    if (link.source === before) link.source = after;
    if (link.target === before) link.target = after;
  }
  host.model.resultNodeIds = host.model.resultNodeIds.map((id) => id === before ? after : id);
  const point = host.positions.get(before);
  host.positions.delete(before);
  host.positions.set(after, point);
}

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.dataset = {};
    this.style = { setProperty() {} };
    this.hidden = false;
  }
  setAttribute() {}
  append(...elements) {
    for (const element of elements) {
      element.remove();
      element.parentNode = this;
      this.children.push(element);
    }
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((element) => element !== this);
    this.parentNode = null;
  }
}
