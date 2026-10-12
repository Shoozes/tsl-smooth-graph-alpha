import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = JSON.parse(await readFile(new URL('./public-api-baseline.json', import.meta.url), 'utf8'));
const installed = path.resolve('node_modules/@ours/forcegraph-tsl');
const modules = {};
for (const subpath of Object.keys(baseline.packageExports)) {
  const specifier = '@ours/forcegraph-tsl' + (subpath === '.' ? '' : subpath.slice(1));
  const expected = path.resolve(installed, baseline.packageExports[subpath].import);
  assert.equal(fileURLToPath(import.meta.resolve(specifier)), expected, 'Resolve the actual installed archive: ' + specifier);
  modules[subpath] = await import(specifier);
  assert.deepEqual(Object.keys(modules[subpath]).sort(), [...baseline.runtimeExports[subpath]].sort(), specifier);
}
assert.equal(typeof globalThis.window, 'undefined');
assert.equal(typeof globalThis.document, 'undefined');
await assert.rejects(import('three'), { code: 'ERR_MODULE_NOT_FOUND' }, 'The headless consumer must not receive Three from the source checkout.');

const data = {
  nodes: [
    { id: 0, fixed: { x: 0, y: 0, z: 0 }, data: { label: 'Numeric zero' } },
    { id: '0', initialPosition: { x: 10, y: 2, z: 1 }, data: { label: 'String zero' } },
    { id: 'leaf', initialPosition: { x: -7, y: 6, z: -2 }, data: { label: 'Leaf' } }
  ],
  links: [{ id: 'edge', source: 0, target: '0' }, { id: 'branch', source: '0', target: 'leaf' }]
};
const fingerprint = JSON.stringify(data);
const options = { layout: { autoStart: false, seed: 1337, dimensions: 3 } };
const first = modules['./headless'].createHeadlessForceGraph(options);
const second = modules['./headless'].createHeadlessForceGraph(options);
try {
  for (const graph of [first, second]) { graph.setData(data); graph.stepLayout(16); }
  assert.equal(first.graph.nodeCount, 3);
  assert.equal(first.graph.linkCount, 2);
  assert.deepEqual(first.graph.getNodePosition(0), { x: 0, y: 0, z: 0 });
  assert.notDeepEqual(first.graph.getNodePosition('0'), first.graph.getNodePosition(0));
  for (const node of data.nodes) {
    const position = first.graph.getNodePosition(node.id);
    assert.ok(Object.values(position).every(Number.isFinite));
    assert.deepEqual(position, second.graph.getNodePosition(node.id));
  }
  const snapshot = first.exportSnapshot();
  assert.equal(snapshot.schema, 'tsl-smooth-graph/graph-snapshot');
  assert.equal(snapshot.version, 2);
  assert.equal(JSON.stringify(data), fingerprint, 'The consumer input stays caller-owned.');
} finally {
  first.dispose(); second.dispose();
}
const renderedFactoryWithoutHost = await modules['.'].createForceGraph3D({ host: { mode: 'headless' }, layout: { backend: 'local', autoStart: false } });
try {
  renderedFactoryWithoutHost.setData(data);
  assert.equal(renderedFactoryWithoutHost.getGraphView().nodeCount, 3);
} finally { renderedFactoryWithoutHost.dispose(); }

const bounds = { min: { x: -4, y: -2, z: -1 }, max: { x: 4, y: 2, z: 1 } };
const framing = { aspect: 16 / 9, verticalFovDegrees: 42 };
const overview = modules['./camera'].planPerspectiveCameraFrame(bounds, framing);
const focus = modules['./camera'].planPerspectiveCameraFocus({ x: 1, y: 2, z: 3 }, 2, framing);
const tween = { from: overview, to: focus, durationMs: 1000, path: { type: 'arc', offset: { x: 2, y: 4, z: 1 } } };
const sample = modules['./camera'].sampleCameraPoseTween(tween, 250);
assert.equal(sample.progress, 0.25);
assert.ok(Object.values(sample.position).every(Number.isFinite));
assert.deepEqual(sample, modules['./camera'].sampleCameraPoseTween(tween, 250));
const decisions = modules['./labels'].planLabelVisibility([
  { id: 'first', bounds: { x: 10, y: 10, width: 20, height: 10 }, priority: 2 },
  { id: 'second', bounds: { x: 10, y: 10, width: 20, height: 10 }, priority: 1 }
], { viewport: { x: 0, y: 0, width: 100, height: 100 }, maximumVisible: 1 });
assert.equal(decisions.filter((decision) => decision.visible).length, 1);
assert.equal(decisions.find((decision) => decision.id === 'first').visible, true);

const workerUrl = modules['./worker'].forceGraphLayoutWorkerUrl;
assert.equal(fileURLToPath(workerUrl), path.join(installed, 'dist/worker/force-worker-entry.js'));
assert.ok((await readFile(workerUrl, 'utf8')).includes('Layout'));
assert.throws(() => modules['./worker'].createForceGraphLayoutWorker(), { code: 'FG_LAYOUT_WORKER_FAILED' });
console.log(JSON.stringify({ entry_points: Object.keys(modules), three_installed: false, browser_globals: false, deterministic_headless: true, root_headless_factory: true, camera_and_labels: true, packaged_worker_asset: true }));
