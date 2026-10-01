import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

// The browser examples resolve /dist through the showcase server's route map;
// load the same module in Node with its camera dependency made file-addressable.
const navigationPath = path.resolve('examples/corpus/corpus-navigation.js');
const navigationSource = await readFile(navigationPath, 'utf8');
const cameraShim = `
const orbitCameraPose = (pose, dx, dy) => ({ target: pose.target, position: { x: pose.position.x + dx, y: pose.position.y + dy, z: pose.position.z } });
const panCameraPose = (pose, dx, dy) => ({ target: { x: pose.target.x + dx, y: pose.target.y + dy, z: pose.target.z }, position: { x: pose.position.x + dx, y: pose.position.y + dy, z: pose.position.z } });
const zoomCameraPose = (pose, delta) => ({ target: pose.target, position: { x: pose.position.x, y: pose.position.y, z: pose.position.z + delta } });
`;
const navigationModule = await import(`data:text/javascript;base64,${Buffer.from(navigationSource.replace("import { orbitCameraPose, panCameraPose, zoomCameraPose } from '../showcase/examples/runtime/camera-controls.js';", cameraShim)).toString('base64')}`);
const { bindCorpusNavigation } = navigationModule;

function setup() {
  const handlers = new Map();
  const canvas = {
    clientHeight: 400,
    dataset: {},
    setPointerCapture() {},
    addEventListener(type, callback) { handlers.set(`canvas:${type}`, callback); },
  };
  const fakeWindow = {
    addEventListener(type, callback) { handlers.set(`window:${type}`, callback); }
  };
  const poses = [];
  const graph = {
    pose: { position: { x: 0, y: 0, z: 100 }, target: { x: 0, y: 0, z: 0 } },
    getCameraPose() { return this.pose; },
    setCameraPose(pose) { this.pose = pose; poses.push(pose); }
  };
  const animator = { cancelCount: 0, cancel() { this.cancelCount += 1; } };
  const manual = { count: 0 };
  const overview = { count: 0 };
  const priorWindow = globalThis.window;
  globalThis.window = fakeWindow;
  bindCorpusNavigation({ canvas, graph, animator, listen: (target, type, callback) => target.addEventListener(type, callback), onManual: () => manual.count += 1, onOverview: () => overview.count += 1 });
  const event = (extra = {}) => ({ button: 0, pointerType: 'mouse', clientX: 10, clientY: 10, pointerId: 1, deltaY: 1, deltaMode: 0, key: '', defaultPrevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra });
  return { canvas, graph, poses, animator, manual, overview, handlers, event, restore() { globalThis.window = priorWindow; } };
}

test('mouse orbit and shift or middle-button pan are distinct gestures', () => {
  const h = setup();
  h.handlers.get('canvas:pointerdown')(h.event());
  h.handlers.get('canvas:pointermove')(h.event({ clientX: 30, clientY: 18 }));
  const orbit = h.poses.at(-1);
  h.handlers.get('window:pointerup')(h.event());
  h.handlers.get('canvas:pointerdown')(h.event({ pointerId: 2, shiftKey: true }));
  h.handlers.get('canvas:pointermove')(h.event({ pointerId: 2, shiftKey: true, clientX: 30, clientY: 18 }));
  const pan = h.poses.at(-1);
  assert.notDeepEqual(orbit, pan);
  assert.equal(h.manual.count, 2);
  h.restore();
});

test('touch pinch pans and zooms with two pointers, then cleans up capture loss', () => {
  const h = setup();
  h.handlers.get('canvas:pointerdown')(h.event({ pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10 }));
  h.handlers.get('canvas:pointerdown')(h.event({ pointerType: 'touch', pointerId: 2, clientX: 50, clientY: 10 }));
  h.handlers.get('canvas:pointermove')(h.event({ pointerType: 'touch', pointerId: 2, clientX: 90, clientY: 10 }));
  assert.equal(h.canvas.dataset.navigating, 'true');
  assert.ok(h.poses.length > 0);
  h.handlers.get('canvas:lostpointercapture')(h.event({ pointerId: 1 }));
  h.handlers.get('canvas:lostpointercapture')(h.event({ pointerId: 2 }));
  assert.equal(h.canvas.dataset.navigating, undefined);
  h.restore();
});

test('wheel units and keyboard commands produce bounded camera actions', () => {
  const h = setup();
  h.handlers.get('canvas:wheel')(h.event({ deltaY: 2, deltaMode: 1 }));
  const lineZoom = h.poses.at(-1);
  h.handlers.get('canvas:wheel')(h.event({ deltaY: 1, deltaMode: 2 }));
  assert.notDeepEqual(lineZoom, h.poses.at(-1));
  h.handlers.get('canvas:keydown')(h.event({ key: 'Home' }));
  h.handlers.get('canvas:keydown')(h.event({ key: '+' }));
  assert.equal(h.overview.count, 1);
  assert.ok(h.animator.cancelCount >= 3);
  h.restore();
});

test('navigation yields to graph-owned pointer gestures and ignores unsupported pointers', () => {
  const h = setup();
  h.handlers.get('canvas:pointerdown')(h.event({ defaultPrevented: true }));
  h.handlers.get('canvas:pointerdown')(h.event({ button: 3 }));
  const browserZoom=h.event({key:'+',ctrlKey:true});
  h.handlers.get('canvas:keydown')(browserZoom);
  assert.equal(browserZoom.prevented,undefined);
  assert.equal(h.canvas.dataset.navigating, undefined);
  assert.equal(h.poses.length, 0);
  h.restore();
});
