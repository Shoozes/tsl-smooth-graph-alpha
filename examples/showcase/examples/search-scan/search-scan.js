import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createForceGraph3D, createThreePlatform, NodeFlags } from '@ours/forcegraph-tsl';
import { buildSearchScanFixture } from './search-scan-model.js';
import { createSearchScanPrefab } from './search-scan-prefab.js';

const find = (selector) => document.querySelector(selector);
const canvas = find('#scan-canvas');
const layer = find('.scan-label-layer');
const ui = {
  play: find('[data-action="play"]'), restart: find('[data-action="restart"]'), overview: find('[data-action="overview"]'),
  reset: find('[data-action="reset"]'), time: find('#scan-time'), clock: find('[data-time]'), speed: find('[data-speed]'),
  follow: find('[data-follow]'), reduced: find('[data-reduced]'), status: find('[data-status]'),
  counts: find('[data-counts]'), mode: find('[data-mode]'), query: find('#scan-query'), search: find('.scan-search'),
  searchStatus: find('[data-search-status]'), phase: find('[data-phase]'), group: find('[data-group]'), step: find('[data-step]')
};
const parameters = new URLSearchParams(location.search);
const media = matchMedia('(prefers-reduced-motion: reduce)');
const model = buildSearchScanFixture({ seed: 1337, pointsPerGroup: 900 });
const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
const groupById = new Map(model.groups.map((group) => [group.id, group]));
const initialFingerprint = JSON.stringify({ nodes: model.nodes, links: model.links });
const removeListeners = [];
let renderer, scene, camera, graph, controls, prefab, resizeObserver;
let frameRequest;
let previousTime;
let timeMs = 0;
let playing = false;
const urlReducedMotion = parameters.get('motion') === 'reduced';
let localReducedMotion = false;
let reducedMotion = media.matches || urlReducedMotion;
let followCamera = true;
let showOverview = false;
let disposed = false;
let lastPhase = '';
let lastGraphFocus = '';
let currentMode = 'reference';
let backend = 'Starting';
let drawCount = 0;
let renderedFrames = 0;

document.body.dataset.presentation = String(parameters.get('presentation') === '1');
ui.reduced.checked = reducedMotion;
listen(window, 'pagehide', (event) => {
  if (!event.persisted) { cleanup(); return; }
  previousTime = undefined;
  cancelAnimationFrame(frameRequest);
  frameRequest = undefined;
});
listen(window, 'pageshow', (event) => {
  canvas.dataset.pageRestored = String(event.persisted);
  previousTime = undefined;
  scheduleFrame();
});
listen(document, 'visibilitychange', () => {
  previousTime = undefined;
  if (document.hidden) { cancelAnimationFrame(frameRequest); frameRequest = undefined; }
  else scheduleFrame();
});
listen(canvas, 'webglcontextlost', (event) => { event.preventDefault(); fail(new Error('Graphics context lost. Reload this example to restart the renderer.')); });
listen(media, 'change', applyReducedMotion);
bindControls();
setEnabled(false);
void start();

async function start() {
  try {
    const requestedBackend = parameters.get('backend');
    const forceWebGL = requestedBackend === 'webgl2';
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 4000);
    camera.position.set(0, 0, 260);
    const gpuAvailable = requestedBackend !== 'canvas2d' && await hasGraphicsContext(forceWebGL);
    if (disposed) return;
    if (forceWebGL && !gpuAvailable) throw new Error('WebGL2 is unavailable in this browser. Open the example without backend=webgl2 to use the Canvas fallback.');
    if (!gpuAvailable) {
      const { createSearchScanCanvasHost } = await import('./search-scan-canvas.js');
      if (disposed) return;
      ({ graph, renderer } = createSearchScanCanvasHost({ THREE, canvas, scene, camera, model }));
      backend = 'Canvas2D fallback';
    } else {
      renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false, forceWebGL });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
      renderer.setClearColor(0x070708, 1);
      await renderer.init();
      if (disposed) { renderer.dispose(); return; }
      graph = await createForceGraph3D({
      platform: createThreePlatform({ THREE, TSL }),
      // The host's OrbitControls owns pointer input; avoid a second DOM controller.
      host: { mode: 'embedded', renderer, scene, camera },
      renderer: { backend: forceWebGL ? 'webgl2' : 'auto', frameLoop: 'external', linkWidthUnit: 'pixel', nodeSurface: { profile: 'flat' } },
      layout: { backend: 'local', dimensions: 3, autoStart: false, seed: 1337 },
      nodes: { radius: (node) => node.data.radius, color: (node) => node.data.color },
      links: { width: 0.55, opacity: 0.35, color: (link) => link.data?.color ?? 0x527163 },
      stateTheme: {
        pinned: { colorMix: 0, scale: 1 },
        dimmed: { color: 0x070708, colorMix: 0.8, scale: 1 },
        incidentLinks: { dimmed: { color: 0x070708, colorMix: 0.8, scale: 1 } }
      },
      interaction: { hover: false, dragNodes: false, selection: 'none' }
      });
      backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    }
    if (disposed) { graph.dispose(); renderer.dispose(); return; }
    graph.setData({ nodes: model.nodes, links: model.links });
    graph.on?.('error', ({ error }) => fail(error));
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.minDistance = 30;
    controls.maxDistance = 900;
    controls.addEventListener('start', onManualNavigation);
    controls.addEventListener('change', scheduleFrame);
    prefab = createSearchScanPrefab({ THREE, TSL, graph, scene, camera, labelLayer: layer, model });
    canvas.dataset.backend = backend;
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();
    const desired = Number(parameters.get('t') ?? 0);
    timeMs = Number.isFinite(desired) ? Math.max(0, Math.min(prefab.durationMs, desired)) : 0;
    if (reducedMotion) timeMs = prefab.durationMs;
    playing = !reducedMotion && parameters.get('paused') !== '1' && timeMs < prefab.durationMs;
    ui.time.max = String(prefab.durationMs);
    ui.counts.textContent = `${model.nodes.length.toLocaleString()} nodes · ${model.links.length.toLocaleString()} links · ${backend}`;
    ui.status.textContent = reducedMotion ? 'Reduced motion · stationary overview, all replay results available.' : 'Ready · drag to explore, or keep Follow camera enabled for the full sequence.';
    setEnabled(true);
    updatePlaybackControls();
    scheduleFrame();
    renderer.backend?.device?.lost?.then((info) => { if (!disposed) fail(new Error(`GPU device lost: ${info.message || info.reason}. Reload to restart.`)); });
    window.__searchScan = Object.freeze({
      seek(milliseconds) { seek(milliseconds); },
      inspect() { return {
        schema: 'search_scan_example_v1', backend, renderedFrames, sceneDraws: drawCount,
        graphDraws: graph?.getDiagnostics().drawCalls, nodeCount: model.nodes.length, linkCount: model.links.length,
        playing, reducedMotion, followCamera, timeMs, mode: currentMode,
        sourceUnchanged: JSON.stringify({ nodes: model.nodes, links: model.links }) === initialFingerprint,
        ...prefab?.inspect()
      }; },
      dispose: cleanup
    });
  } catch (error) { fail(error); }
}

async function hasGraphicsContext(forceWebGL) {
  if (!forceWebGL && navigator.gpu) {
    try { if (await navigator.gpu.requestAdapter()) return true; } catch { /* Try WebGL2 next. */ }
  }
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) return false;
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}

function bindControls() {
  listen(ui.play, 'click', () => {
    if (!prefab || reducedMotion) return;
    if (timeMs >= prefab.durationMs) timeMs = 0;
    playing = !playing;
    showOverview = false;
    previousTime = undefined;
    updatePlaybackControls();
  });
  listen(ui.restart, 'click', () => {
    if (!prefab) return;
    timeMs = reducedMotion ? prefab.durationMs : 0;
    showOverview = false;
    setFollow(true);
    playing = !reducedMotion && prefab.durationMs > 0;
    previousTime = undefined;
    updatePlaybackControls();
  });
  listen(ui.overview, 'click', () => {
    showOverview = true;
    playing = false;
    setFollow(true);
    ui.status.textContent = 'Overview · the playhead is preserved. Play resumes the sequence.';
    updatePlaybackControls();
  });
  listen(ui.time, 'input', () => seek(Number(ui.time.value)));
  listen(ui.speed, 'change', () => { previousTime = undefined; });
  listen(ui.follow, 'change', () => setFollow(ui.follow.checked));
  listen(ui.reduced, 'change', () => { localReducedMotion = ui.reduced.checked; applyReducedMotion(); });
  listen(ui.search, 'submit', (event) => { event.preventDefault(); runSearch(); });
  listen(ui.reset, 'click', restoreReference);
  listen(canvas, 'keydown', (event) => {
    if (event.key === ' ' && !reducedMotion) { event.preventDefault(); ui.play.click(); }
    else if (event.key === 'Home') { event.preventDefault(); ui.overview.click(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seek(timeMs + 300); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(timeMs - 300); }
  });
}

function runSearch() {
  if (!prefab) return;
  const query = ui.query.value.trim().toLocaleLowerCase();
  if (!query) { restoreReference(); return; }
  const hits = model.nodes.filter((node) => node.data.label && `${node.data.label} ${node.data.annotation ?? ''}`.toLocaleLowerCase().includes(query));
  const steps = [];
  for (const node of hits) {
    let step = steps.at(-1);
    if (!step || step.groupId !== node.data.groupId) { step = { groupId: node.data.groupId, nodeIds: [], durationMs: 0 }; steps.push(step); }
    step.nodeIds.push(node.id);
    step.durationMs = Math.max(900, step.nodeIds.length * 220);
  }
  prefab.setSequence(steps, { resultNodeIds: hits.map((node) => node.id) });
  currentMode = 'search';
  timeMs = reducedMotion ? prefab.durationMs : 0;
  playing = !reducedMotion && hits.length > 0;
  showOverview = hits.length === 0;
  setFollow(true);
  previousTime = undefined;
  ui.time.max = String(prefab.durationMs);
  ui.mode.textContent = 'Local text-match replay';
  ui.searchStatus.textContent = hits.length ? `${hits.length} matching labels · replay follows fixture order.` : `No matching labels for “${ui.query.value.trim()}”.`;
  ui.status.textContent = hits.length ? 'Matches are available now. The scanner replays their presentation.' : 'No results · graph is preserved. Reset restores the reference sequence.';
  updatePlaybackControls();
}

function restoreReference() {
  if (!prefab) return;
  prefab.setSequence(model.steps, { resultNodeIds: model.resultNodeIds });
  currentMode = 'reference';
  ui.query.value = '';
  ui.mode.textContent = 'Synthetic demo replay';
  ui.searchStatus.textContent = 'Try source, scope or reference. Searches demo labels and annotations.';
  ui.time.max = String(prefab.durationMs);
  timeMs = reducedMotion ? prefab.durationMs : 0;
  playing = !reducedMotion;
  showOverview = false;
  setFollow(true);
  previousTime = undefined;
  ui.status.textContent = 'Reference sequence restored · roles → rules → review → start → overview.';
  updatePlaybackControls();
}

function seek(value) {
  if (!prefab || disposed) return;
  if (!Number.isFinite(value)) throw new RangeError('Playhead must be finite.');
  timeMs = Math.max(0, Math.min(prefab.durationMs, value));
  playing = false;
  showOverview = false;
  previousTime = undefined;
  updatePlaybackControls();
}

function applyReducedMotion() {
  const next = media.matches || urlReducedMotion || localReducedMotion;
  const changed = next !== reducedMotion;
  reducedMotion = next;
  ui.reduced.checked = reducedMotion;
  updateMotionControl();
  if (!changed) return;
  playing = false;
  showOverview = reducedMotion;
  if (prefab && reducedMotion) timeMs = prefab.durationMs;
  setFollow(true);
  updatePlaybackControls();
  ui.status.textContent = reducedMotion ? 'Reduced motion · stationary overview, all replay results available.' : 'Full motion available · press Play or Restart.';
}

function setFollow(value) { followCamera = Boolean(value); ui.follow.checked = followCamera; scheduleFrame(); }
function onManualNavigation() {
  setFollow(false);
  ui.status.textContent = 'Manual camera · enable Follow camera to rejoin the scanner.';
}

function frame(timestamp) {
  frameRequest = undefined;
  if (disposed) return;
  try {
    const elapsed = previousTime === undefined || document.hidden ? 0 : Math.max(0, Math.min(100, timestamp - previousTime));
    previousTime = timestamp;
    if (playing) {
      timeMs = Math.min(prefab.durationMs, timeMs + elapsed * Number(ui.speed.value));
      if (timeMs === prefab.durationMs) { playing = false; updatePlaybackControls(); }
    }
    if (!followCamera) {
      controls.update();
      graph.setCameraPose({ position: { x: camera.position.x, y: camera.position.y, z: camera.position.z }, target: { x: controls.target.x, y: controls.target.y, z: controls.target.z } });
    }
    const sample = prefab.render(timeMs, { followCamera, reducedMotion, overview: showOverview });
    applyGraphFocus(sample);
    if (followCamera) {
      const pose = graph.getCameraPose();
      controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    }
    graph.update(elapsed / 1000);
    graph.render();
    renderer.render(scene, camera);
    renderedFrames += 1;
    drawCount = renderer.info.render.calls;
    ui.time.value = String(Math.round(timeMs));
    ui.clock.textContent = `${(timeMs / 1000).toFixed(2)} / ${(prefab.durationMs / 1000).toFixed(2)} s`;
    canvas.dataset.phase = sample.phase;
    canvas.dataset.group = sample.groupId ?? '';
    canvas.dataset.playing = String(playing);
    canvas.dataset.renderedFrames = String(renderedFrames);
    const stateKey = `${sample.phase}:${sample.groupId}:${sample.activeNodeId}`;
    if (lastPhase !== stateKey) {
      lastPhase = stateKey;
      ui.phase.textContent = sample.phase === 'complete' ? 'Replay complete' : sample.phase === 'travel' ? 'Cluster transition' : sample.phase === 'overview' ? 'Pulling back' : 'Label reveal';
      ui.group.textContent = sample.phase === 'complete' || sample.phase === 'overview' ? 'Constellation overview' : groupById.get(sample.groupId)?.label ?? 'No matches';
      ui.step.textContent = nodeById.get(sample.activeNodeId)?.data.label ?? 'Stable graph · deterministic replay';
    }
    if (playing) scheduleFrame();
  } catch (error) { fail(error); }
}

function applyGraphFocus(sample) {
  const all = reducedMotion || showOverview || sample.phase === 'overview' || sample.phase === 'complete';
  const focused = all ? null : [sample.groupId, ...(sample.phase === 'travel' ? [sample.previousGroupId] : [])].filter(Boolean);
  const key = focused?.join('\u0000') ?? 'all';
  if (key === lastGraphFocus) return;
  lastGraphFocus = key;
  if (renderer.backend?.isCanvasFallback) { renderer.setGraphFocus(focused); return; }
  const bright = [], dim = [];
  for (const node of model.nodes) (focused === null || focused.includes(node.data.groupId) ? bright : dim).push(node.id);
  graph.setNodeFlagsMany(bright, 0, NodeFlags.Dimmed);
  graph.setNodeFlagsMany(dim, NodeFlags.Dimmed, 0);
}

function resize() {
  if (disposed || !prefab) return;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  prefab.resize(width, height);
  scheduleFrame();
}

function updatePlaybackControls() {
  ui.play.textContent = playing ? 'Pause' : timeMs >= (prefab?.durationMs ?? Infinity) ? 'Replay' : 'Play';
  ui.play.setAttribute('aria-pressed', String(playing));
  ui.play.disabled = !prefab || reducedMotion || prefab.durationMs === 0 || disposed;
  updateMotionControl();
  scheduleFrame();
}
function updateMotionControl() {
  ui.reduced.disabled = !prefab || disposed || media.matches || urlReducedMotion;
  ui.reduced.title = media.matches ? 'Enabled by your operating system.' : urlReducedMotion ? 'Enabled by this preview URL.' : 'Use a stationary overview.';
}
function scheduleFrame() {
  if (!disposed && prefab && !document.hidden && frameRequest === undefined) frameRequest = requestAnimationFrame(frame);
}
function setEnabled(enabled) { for (const element of document.querySelectorAll('.scan-controls button, .scan-controls input, .scan-controls select, .scan-search button, .scan-search input')) element.disabled = !enabled; }
function listen(target, type, handler, options) { target.addEventListener(type, handler, options); removeListeners.push(() => target.removeEventListener(type, handler, options)); }
function fail(error) {
  if (disposed) return;
  ui.status.textContent = error instanceof Error ? error.message : String(error);
  ui.status.dataset.error = 'true';
  canvas.dataset.phase = 'error';
  console.error('Search scan failed:', error);
  cleanup();
}
function cleanup() {
  if (disposed) return;
  disposed = true;
  canvas.dataset.disposed = 'true';
  playing = false;
  cancelAnimationFrame(frameRequest);
  resizeObserver?.disconnect();
  for (const remove of removeListeners.splice(0)) remove();
  controls?.removeEventListener('start', onManualNavigation);
  controls?.removeEventListener('change', scheduleFrame);
  controls?.dispose();
  prefab?.dispose();
  layer.replaceChildren();
  graph?.dispose();
  renderer?.dispose();
  setEnabled(false);
}
