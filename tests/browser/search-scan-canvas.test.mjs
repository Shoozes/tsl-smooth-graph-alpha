import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { createSearchScanCanvasHost } from '../../examples/showcase/examples/search-scan/search-scan-canvas.js';

test('contact halo uses its explicit color and strength with one material opacity envelope', (t) => {
  const h = harness(t);
  const descriptor = Object.freeze({ color: 0xed4d91, strength: 0.6 });
  h.material.userData.searchScanHalo = descriptor;
  h.material.opacity = 0.25;
  h.draw();
  const [first] = h.context.gradients;
  assert.deepEqual(rgba(first.stops[0][1]), [237, 77, 145, 0.6]);
  assert.equal(rgba(first.stops.at(-1)[1])[3], 0);
  const alphas = first.stops.map(([, value]) => rgba(value)[3]);
  assert.ok(alphas.every((value, index) => index === 0 || value <= alphas[index - 1]));
  // Mid-radius corresponds to UV radius .25 in the documented TSL smoothstep.
  const middle = first.stops.find(([radius]) => radius === 0.5);
  const blend = 21 / 46;
  assert.ok(Math.abs(rgba(middle[1])[3] - 0.6 * (1 - blend * blend * (3 - 2 * blend)) ** 2) < 0.000001);
  assert.equal(h.haloPaints()[0].alpha, 0.25, 'The material envelope is applied separately, exactly once.');
  assert.equal(h.haloPaints()[0].composite, 'lighter');
  assert.equal(h.material.userData.searchScanHalo, descriptor, 'Canvas never mutates the shared material descriptor.');
  assert.equal(h.renderer.info.render.canvasPaintCalls, h.context.paints.length);
  assert.equal(h.graph.getDiagnostics().drawCalls, 0, 'Canvas painting is not reported as a GPU draw.');

  h.material.userData.searchScanHalo = { color: 0x72ffb2, strength: 0.3 };
  h.material.opacity = 0.8;
  h.draw();
  assert.deepEqual(rgba(h.context.gradients[0].stops[0][1]), [114, 255, 178, 0.3]);
  assert.equal(h.haloPaints()[0].alpha, 0.8);
  h.material.opacity = 0;
  h.draw();
  assert.equal(h.context.gradients.length, 0, 'A target stays dark before the contact envelope begins.');
});

test('halo follows actual scene transforms and camera projection at the accepted node position', (t) => {
  const h = harness(t);
  h.material.userData.searchScanHalo = { color: 0xffffff, strength: 1 };
  const target = h.graph.getNodePosition('target');
  h.halo.position.set(target.x, target.y, target.z);
  h.draw();
  assertCenter(h.context.gradients[0], new THREE.Vector3(target.x, target.y, target.z), h.camera);

  const parent = new THREE.Group();
  parent.position.set(-3, 4, 1);
  parent.scale.setScalar(1.5);
  h.scene.add(parent);
  parent.add(h.halo);
  h.graph.setCameraPose({ position: { x: 4, y: 3, z: 20 }, target: { x: 0, y: 0, z: 0 } });
  h.halo.quaternion.copy(h.camera.quaternion);
  h.draw();
  const world = h.halo.getWorldPosition(new THREE.Vector3());
  assertCenter(h.context.gradients[0], world, h.camera);
  assert.deepEqual(h.graph.getNodePosition('target'), target, 'Presentation transforms never move the graph node.');
});

test('untagged marker halos retain their original gradient and material opacity', (t) => {
  const h = harness(t);
  h.material.opacity = 0.42;
  h.draw();
  assert.deepEqual(h.context.gradients[0].stops, [
    [0, 'rgba(103,217,193,.19)'], [0.35, 'rgba(103,217,193,.09)'], [1, 'rgba(103,217,193,0)']
  ]);
  assert.equal(h.haloPaints()[0].alpha, 0.42);
});

test('invalid halo metadata fails before saving Canvas state and a corrected material can render', (t) => {
  const h = harness(t);
  for (const invalid of [
    null, [], {}, { color: '#ffffff', strength: 0.5 }, { color: -1, strength: 0.5 },
    { color: 0x1000000, strength: 0.5 }, { color: 1.5, strength: 0.5 },
    { color: 0xffffff, strength: -0.1 }, { color: 0xffffff, strength: 1.1 },
    { color: 0xffffff, strength: NaN }, { color: 0xffffff, strength: Infinity }
  ]) {
    h.material.userData.searchScanHalo = invalid;
    assert.throws(() => h.draw(), /searchScanHalo requires a 24-bit RGB color and strength between 0 and 1/);
    assert.equal(h.context.stack.length, 0);
    assert.equal(h.graph.getDiagnostics().nodeCount, 1);
  }
  h.material.userData.searchScanHalo = { color: 0, strength: 0 };
  h.draw();
  assert.ok(h.context.gradients[0].stops.every(([, value]) => rgba(value)[3] === 0));
  assert.equal(h.context.stack.length, 0);
});

function harness(t) {
  const context = {
    gradients: [], paints: [], stack: [], globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() { this.stack.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation, fillStyle: this.fillStyle }); },
    restore() { Object.assign(this, this.stack.pop()); },
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, rect() {},
    fill() { this.paints.push({ style: this.fillStyle, alpha: this.globalAlpha, composite: this.globalCompositeOperation }); },
    stroke() { this.paints.push({ style: this.strokeStyle, alpha: this.globalAlpha, composite: this.globalCompositeOperation }); },
    fillRect() { this.fill(); },
    createRadialGradient(...args) { const gradient = { args, stops: [], addColorStop(radius, value) { this.stops.push([radius, value]); } }; this.gradients.push(gradient); return gradient; }
  };
  const canvas = { style: {}, setAttribute() {}, getContext: () => context };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 400 / 300, 0.1, 4000);
  const model = { nodes: [{ id: 'target', fixed: { x: 6, y: -2, z: 0 }, data: { color: 0x52a283, radius: 0.18, groupId: 'one', kind: 'point' } }], links: [] };
  const { graph, renderer } = createSearchScanCanvasHost({ THREE, canvas, scene, camera, model });
  renderer.setSize(400, 300, false);
  graph.setCameraPose({ position: { x: 0, y: 0, z: 20 }, target: { x: 0, y: 0, z: 0 } });
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(halo);
  t.after(() => { graph.dispose(); renderer.dispose(); halo.geometry.dispose(); material.dispose(); });
  return {
    context, scene, camera, graph, renderer, material, halo,
    draw() { context.gradients.length = 0; context.paints.length = 0; renderer.render(scene, camera); },
    haloPaints() { return context.paints.filter(({ style }) => context.gradients.includes(style)); }
  };
}

function rgba(value) { return value.slice(5, -1).split(',').map(Number); }
function assertCenter(gradient, world, camera) {
  const point = world.clone().project(camera);
  assert.ok(Math.abs(gradient.args[0] - (point.x + 1) * 200) < 0.000001);
  assert.ok(Math.abs(gradient.args[1] - (1 - point.y) * 150) < 0.000001);
}
