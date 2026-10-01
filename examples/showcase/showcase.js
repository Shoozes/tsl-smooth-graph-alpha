import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createForceGraph3D, createThreePlatform, NodeFlags } from '../dist/index.js';
import { planPerspectiveCameraFocus, planPerspectiveCameraFrame, sampleCameraPoseTween } from '../dist/camera/index.js';
import {
  coolStateTheme,
  datasets,
  metallicNodeSurface,
  nodeColor,
  warmStateTheme
} from './showcase-model.js';
import { showcaseExamples } from './examples/manifest.js';
import { createNodeSpawnMotion, parentRelativePosition } from './examples/runtime/node-spawn-motion.js';
import { createResponsiveFramer } from './examples/runtime/responsive-framing.js';

const gallery = document.querySelector('[data-example-gallery]');
if (gallery) {
  gallery.innerHTML = showcaseExamples.map((example) => `
    <a class="example-card" href="./examples/${example.slug}/index.html">
      <span>${example.index}</span><strong>${example.title}</strong><small>${example.summary}</small>
    </a>`).join('');
}

const canvas = document.querySelector('#graph');
const status = document.querySelector('#runtime-status');
const requestedBackend = new URLSearchParams(location.search).get('backend') === 'webgl2' ? 'webgl2' : 'auto';
const controls = document.querySelectorAll('[data-dataset]');
const metrics = {
  backend: document.querySelector('#metric-backend'),
  size: document.querySelector('#metric-size'),
  draws: document.querySelector('#metric-draws'),
  transform: document.querySelector('#metric-transform'),
  surface: document.querySelector('#metric-surface')
};
const focusButton = document.querySelector('#focus-button');
const overviewButton = document.querySelector('#overview-button');
const themeButton = document.querySelector('#theme-button');
const surfaceButton = document.querySelector('#surface-button');
const layoutButton = document.querySelector('#layout-button');
const expandButton = document.querySelector('#expand-button');
let graph;
let activeDataset = 'basic';
let focused = false;
let focusedNodeId = 'core';
let warmTheme = false;
let metallicSurface = true;
let layoutRunning = true;
let activeNodeIds = [];
let expansionCount = 0;
let cameraTweenFrame;
let cameraTweenToken = 0;
let cameraTweenDestination;
let nodeMotion;
let metricsTimer;
let responsiveFramer;

const cameraMotion = Object.freeze({
  durationMs: 760,
  easing: 'cubic-in-out',
  verticalFovDegrees: 50,
  focusPadding: 2.75,
  focusMinimumDistance: 26,
  overviewPadding: 1,
  overviewMinimumDistance: 18,
  shoulder: Object.freeze({ x: 12, y: 8, z: 0 })
});

window.__forcegraphProof = { schema: 'forcegraph_showcase_browser_fixture_v1', status: 'running', done: false };

void start();

async function start() {
  try {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Showcase canvas is unavailable.');
    graph = await createForceGraph3D({
      platform: createThreePlatform({ THREE, TSL }),
      host: { mode: 'managed', canvas },
      renderer: {
        backend: requestedBackend,
        frameLoop: 'continuous',
        pixelRatio: { minimum: 1, maximum: 2 },
        nodeSurface: metallicNodeSurface
      },
      layout: { backend: 'local', autoStart: true, seed: 20260822, minimumNodeDistance: 12, separationStrength: 0.72, separationIterations: 2, topologyReheatAlpha: 0.35, alphaDecay: 0.025, alphaMinimum: 0.002 },
      nodes: { radius: (node) => (node.id === 'core' ? 11 : 6) * (nodeMotion?.scale(node.id) ?? 1), color: nodeColor },
      links: { opacity: 0.56 },
      interaction: { hover: true, selection: 'single', dragNodes: { enabled: true, releaseBehavior: 'keep-pinned' } }
    });
    nodeMotion = createNodeSpawnMotion({
      refreshNodeStyles: (ids) => graph.refreshNodeStyles(ids),
      reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      onError: (error) => setStatus(error instanceof Error ? error.message : String(error), 'error')
    });
    graph.on('node-hover', ({ nodeId }) => setStatus(nodeId === undefined ? 'Move across the graph' : `Hovering ${String(nodeId)}`, 'ready'));
    graph.on('node-click', ({ nodeId }) => {
      if (nodeId === undefined) {
        clearFocus();
        setStatus('Selection cleared', 'ready');
        return;
      }
      responsiveFramer?.markUserInteraction();
      focusNode(nodeId);
      setStatus(`Focused ${String(nodeId)}`, 'ready');
    });
    graph.on('error', ({ error }) => setStatus(error.message, 'error'));
    loadDataset(activeDataset);
    responsiveFramer = createResponsiveFramer({
      canvas,
      isReady: () => Boolean(graph && activeNodeIds.length),
      subscribeSettled: (listener) => graph.on('layout-settled', listener),
      isFocused: () => focused,
      frame: ({ animate }) => restoreCameraOverview({ animate })
    });
    applyTheme();
    bindControls();
    window.__forcegraphShowcaseExercise = exerciseShowcase;
    if (metricsTimer === undefined) metricsTimer = window.setInterval(updateMetrics, 300);
    updateMetrics();
    setStatus('Renderer ready — hover, click, or drag nodes', 'ready');
    await waitForShowcaseSettle();
    const initialPresentation = inspectShowcasePresentation();
    const assertions = {
      managedCanvas: graph.getDiagnostics().hostMode === 'managed',
      graphLoaded: graph.getDiagnostics().nodeCount > 0 && graph.getDiagnostics().linkCount > 0,
      scenarioControls: controls.length === 4,
      primaryControlsVisible: [layoutButton, overviewButton].every((control) => control instanceof HTMLButtonElement && control.getBoundingClientRect().width > 0),
      optionsDisclosure: document.querySelector('.options-panel') instanceof HTMLDetailsElement,
      optionsPanelUnclipped: initialPresentation.optionsPanelUnclipped,
      presentation: initialPresentation,
      sceneOccupancy: initialPresentation.graphOccupancy.x >= 0.4 && initialPresentation.graphOccupancy.y >= 0.3,
      projectedTargetFloor: initialPresentation.minimumProjectedRadius >= 3,
      vectorRelayTheme: initialPresentation.vectorRelayTheme,
      controlTargetFloor: initialPresentation.minimumControlHeight >= 44,
      requestedBackendObserved: requestedBackend !== 'webgl2' || graph.getDiagnostics().backend === 'webgl2'
    };
    window.__forcegraphProof = {
      schema: 'forcegraph_showcase_browser_fixture_v1',
      status: Object.values(assertions).every(Boolean) ? 'passed' : 'failed',
      done: true,
      diagnostics: graph.getDiagnostics(),
      assertions
    };
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
    window.__forcegraphProof = { schema: 'forcegraph_showcase_browser_fixture_v1', status: 'failed', done: true, error: String(error) };
  }
}

function bindControls() {
  const markManual = () => responsiveFramer?.markUserInteraction();
  canvas.addEventListener('pointerdown', markManual, { passive: true });
  canvas.addEventListener('wheel', markManual, { passive: true });
  for (const control of controls) {
    control.addEventListener('click', () => {
      activeDataset = control.dataset.dataset ?? 'basic';
      for (const candidate of controls) candidate.setAttribute('aria-pressed', String(candidate === control));
      clearFocus(false);
      loadDataset(activeDataset);
      updateMetrics();
      setStatus(`${labelFor(activeDataset)} loaded`, 'ready');
    });
  }
  focusButton.addEventListener('click', () => {
    if (focused && focusedNodeId === 'core') clearFocus(); else focusNode('core');
  });
  overviewButton.addEventListener('click', () => {
    responsiveFramer?.reset({ schedule: false });
    clearFocus();
    setStatus('Restoring overview', 'ready');
  });
  themeButton.addEventListener('click', () => {
    warmTheme = !warmTheme;
    themeButton.setAttribute('aria-pressed', String(warmTheme));
    applyTheme();
    updateMetrics();
  });
  surfaceButton.addEventListener('click', () => {
    metallicSurface = !metallicSurface;
    surfaceButton.setAttribute('aria-pressed', String(metallicSurface));
    surfaceButton.textContent = metallicSurface ? 'Metallic surface' : 'Flat surface';
    applySurface();
    updateMetrics();
  });
  layoutButton.addEventListener('click', () => {
    layoutRunning = !layoutRunning;
    layoutButton.setAttribute('aria-pressed', String(layoutRunning));
    layoutButton.textContent = layoutRunning ? 'Pause' : 'Play';
    if (layoutRunning) graph.restartLayout(); else graph.stopLayout();
    updateMetrics();
  });
  expandButton.addEventListener('click', () => {
    const source = focused ? focusedNodeId : 'core';
    const id = `branch-${++expansionCount}`;
    const color = warmTheme ? 0xffbd70 : 0x78c9ff;
    graph.applyPatch({
      nodes: { upsert: [{ id, data: { color }, initialPosition: parentRelativePosition(graph.getNodePosition(source), source, id, { distance: 2.4, seed: 20260822 }) }] },
      links: { upsert: [{ id: `link-${id}`, source, target: id }] }
    });
    if (!layoutRunning) graph.stopLayout();
    activeNodeIds.push(id);
    if (focused && id !== focusedNodeId) graph.setNodeFlags(id, NodeFlags.Dimmed);
    nodeMotion.animate(id);
    graph.render();
    updateMetrics();
    setStatus(`Expanded ${String(source)} with ${id}`, 'ready');
  });
  window.addEventListener('beforeunload', () => {
    canvas.removeEventListener('pointerdown', markManual);
    canvas.removeEventListener('wheel', markManual);
    if (metricsTimer !== undefined) window.clearInterval(metricsTimer);
    metricsTimer = undefined;
    cancelCameraTween();
    cancelNodePopTweens();
    nodeMotion?.dispose();
    responsiveFramer?.dispose();
    graph?.dispose();
  }, { once: true });
}

function loadDataset(name) {
  cancelNodePopTweens();
  const data = datasets[name]();
  activeNodeIds = data.nodes.map((node) => node.id);
  expansionCount = 0;
  focusedNodeId = 'core';
  graph.setData(data);
  if (layoutRunning) graph.restartLayout();
  applyTheme();
  graph.render();
  responsiveFramer?.reset();
}

function focusNode(nodeId) {
  responsiveFramer?.markUserInteraction();
  if (!activeNodeIds.includes(nodeId)) return;
  focused = true;
  focusedNodeId = nodeId;
  focusButton.setAttribute('aria-pressed', 'true');
  focusButton.textContent = nodeId === 'core' ? 'Clear focus' : `Clear ${String(nodeId)}`;
  graph.setNodeFlagsMany(activeNodeIds.filter((id) => id !== nodeId), NodeFlags.Dimmed, NodeFlags.Focused);
  graph.setNodeFlags(nodeId, NodeFlags.Focused, NodeFlags.Dimmed);
  graph.setSelection([nodeId]);
  focusCameraOnNode(nodeId);
  graph.render();
  updateMetrics();
}

function clearFocus(restoreOverview = true) {
  focused = false;
  focusedNodeId = 'core';
  focusButton.setAttribute('aria-pressed', 'false');
  focusButton.textContent = 'Focus core';
  cancelCameraTween();
  if (!graph) return;
  graph.setNodeFlagsMany(activeNodeIds, 0, NodeFlags.Dimmed | NodeFlags.Focused);
  graph.setSelection([]);
  if (restoreOverview) restoreCameraOverview();
  graph.render();
  updateMetrics();
}

function applyTheme() {
  graph.setStateTheme(warmTheme ? warmStateTheme : coolStateTheme);
  graph.render();
}

function applySurface() {
  graph.setNodeSurface(metallicSurface ? metallicNodeSurface : { profile: 'flat' });
  graph.render();
}

function updateMetrics() {
  if (!graph) return;
  const diagnostics = graph.getDiagnostics();
  metrics.backend.textContent = diagnostics.backend;
  metrics.size.textContent = `${diagnostics.nodeCount} / ${diagnostics.linkCount}`;
  metrics.draws.textContent = String(diagnostics.drawCalls);
  metrics.transform.textContent = diagnostics.transformPath;
  metrics.surface.textContent = metallicSurface ? 'metallic' : 'flat';
}

function setStatus(message, state) {
  status.textContent = message;
  status.dataset.state = state;
}

function inspectShowcasePresentation() {
  const stageElement = document.querySelector('.stage');
  const stage = stageElement?.getBoundingClientRect();
  const graphRect = canvas?.getBoundingClientRect();
  const dockRect = document.querySelector('.control-dock')?.getBoundingClientRect();
  const options = document.querySelector('.options-panel');
  const camera = graph?.getCameraPose();
  const points = camera ? activeNodeIds.map((id) => {
    const position = graph.getNodePosition(id);
    const projected = position ? projectShowcasePoint(position, camera) : undefined;
    if (!projected) return undefined;
    return { id, ...projected, radius: projectShowcaseRadius(id, position, camera) };
  }).filter(Boolean) : [];
  const bounds = projectedBounds(points);
  const width = canvas?.clientWidth ?? 0;
  const height = canvas?.clientHeight ?? 0;
  const visibleControls = [...document.querySelectorAll('button, select, summary')]
    .filter((control) => control.getClientRects().length > 0)
    .map((control) => control.getBoundingClientRect().height);
  const themeStyle = getComputedStyle(document.body);
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    primaryControlsVisible: [layoutButton, overviewButton].every((control) => control instanceof HTMLButtonElement && control.getBoundingClientRect().width > 0),
    optionsDisclosure: options instanceof HTMLDetailsElement,
    optionsPanelUnclipped: stageElement ? getComputedStyle(stageElement).overflow === 'visible' : false,
    sceneWithinStage: Boolean(stage && graphRect && graphRect.top >= stage.top && graphRect.bottom <= stage.bottom),
    graphNotObscured: Boolean(graphRect && dockRect && dockRect.top >= graphRect.bottom - 1),
    vectorRelayTheme: document.body.dataset.uiTheme === 'vector-relay' && themeStyle.getPropertyValue('--vr-teal').trim() === '#55e6d4',
    minimumControlHeight: visibleControls.length > 0 ? Math.min(...visibleControls) : 0,
    graphOccupancy: { x: width > 0 ? (bounds.maxX - bounds.minX) / width : 0, y: height > 0 ? (bounds.maxY - bounds.minY) / height : 0, count: points.length },
    minimumProjectedRadius: points.length > 0 ? Math.min(...points.map((point) => point.radius)) : 0,
    projectedBounds: bounds
  };
}

function projectedBounds(points) {
  const bounds = { count: points.length, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const point of points) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return bounds;
}

function projectShowcasePoint(point, camera) {
  const forward = normalizeShowcaseVector(subtractShowcaseVector(camera.target, camera.position));
  let right = normalizeShowcaseVector(crossShowcaseVector(forward, { x: 0, y: 1, z: 0 }));
  if (Math.hypot(right.x, right.y, right.z) < 0.001) right = { x: 1, y: 0, z: 0 };
  const up = normalizeShowcaseVector(crossShowcaseVector(right, forward));
  const relative = subtractShowcaseVector(point, camera.position);
  const depth = dotShowcaseVector(relative, forward);
  if (!(depth > 0)) return undefined;
  const scale = 1 / Math.tan(50 * Math.PI / 360);
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const ndcX = dotShowcaseVector(relative, right) * scale / (depth * aspect);
  const ndcY = dotShowcaseVector(relative, up) * scale / depth;
  return { x: (ndcX * 0.5 + 0.5) * canvas.clientWidth, y: (0.5 - ndcY * 0.5) * canvas.clientHeight, depth };
}

function projectShowcaseRadius(id, point, camera) {
  const projected = projectShowcasePoint(point, camera);
  if (!projected) return 0;
  const worldRadius = id === 'core' ? 11 : 6;
  return worldRadius * (1 / Math.tan(50 * Math.PI / 360)) * canvas.clientHeight / (2 * projected.depth);
}

function subtractShowcaseVector(left, right) { return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z }; }
function crossShowcaseVector(left, right) { return { x: left.y * right.z - left.z * right.y, y: left.z * right.x - left.x * right.z, z: left.x * right.y - left.y * right.x }; }
function dotShowcaseVector(left, right) { return left.x * right.x + left.y * right.y + left.z * right.z; }
function normalizeShowcaseVector(value) { const length = Math.hypot(value.x, value.y, value.z); return length > 0.0001 ? { x: value.x / length, y: value.y / length, z: value.z / length } : { x: 0, y: 0, z: 0 }; }

window.__forcegraphShowcaseInspect = inspectShowcasePresentation;

async function exerciseShowcase() {
  const presentation = {};
  document.querySelector('[data-dataset="basic"]')?.click();
  await waitForShowcaseSettle();
  presentation.basic = inspectShowcasePresentation();
  document.querySelector('[data-dataset="scale"]')?.click();
  await waitForShowcaseSettle();
  const scaleDiagnostics = graph.getDiagnostics();
  const scaleVerified = scaleDiagnostics.nodeCount === 1_000 && scaleDiagnostics.linkCount === 3_000;
  document.querySelector('[data-dataset="clusters"]')?.click();
  await waitForShowcaseSettle();
  presentation.clusters = inspectShowcasePresentation();
  document.querySelector('[data-dataset="flow"]')?.click();
  await waitForShowcaseSettle();
  presentation.flow = inspectShowcasePresentation();
  document.querySelector('[data-dataset="clusters"]')?.click();
  await waitForShowcaseSettle();
  focusButton.click();
  const cameraTweenScheduled = cameraTweenFrame !== undefined;
  const cameraTweenSettled = settleCameraTweenImmediately();
  themeButton.click();
  surfaceButton.click();
  const flatSurfaceSelected = !metallicSurface;
  surfaceButton.click();
  const metallicSurfaceRestored = metallicSurface;
  layoutButton.click();
  expandButton.click();
  const nodePopScheduled = nodeMotion.activeCount === 1;
  const nodePopImmediate = nodeMotion.activeCount === 0 && nodeMotion.scale(`branch-${expansionCount}`) === 1;
  const nodePopSettled = nodePopScheduled ? settleNodePopTweensImmediately() : nodePopImmediate;
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  updateMetrics();
  const diagnostics = graph.getDiagnostics();
  const presentationPassed = Object.values(presentation).every((state) => state.graphOccupancy.x >= 0.35 && state.graphOccupancy.y >= 0.3 && state.minimumProjectedRadius >= 3);
  return {
    passed: scaleVerified
      && diagnostics.nodeCount === 35
      && diagnostics.linkCount === 34
      && focused
      && warmTheme
      && !layoutRunning
      && diagnostics.layoutRunning === false
      && cameraTweenScheduled
      && cameraTweenSettled
      && cameraTweenFrame === undefined
      && flatSurfaceSelected
      && metallicSurfaceRestored
      && (nodePopScheduled || nodePopImmediate)
      && nodePopSettled
      && nodeMotion.activeCount === 0
      && presentationPassed,
    diagnostics,
    presentation,
    presentationPassed,
    controls: {
      focused,
      warmTheme,
      metallicSurface,
      layoutRunning,
      scaleVerified,
      cameraTweenScheduled,
      cameraTweenSettled,
      flatSurfaceSelected,
      metallicSurfaceRestored,
      nodePopScheduled,
      nodePopImmediate,
      nodePopSettled
    }
  };
}

async function waitForShowcaseSettle(timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (graph?.getDiagnostics().layoutRunning && performance.now() < deadline) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

function focusCameraOnNode(nodeId) {
  const target = graph.getNodePosition(nodeId);
  const from = graph.getCameraPose();
  if (!target || !from) return;
  const frame = planPerspectiveCameraFocus(target, focusRadiusFor(nodeId), {
    aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
    verticalFovDegrees: cameraMotion.verticalFovDegrees,
    direction: cinematicDirection(from.position, target),
    padding: cameraMotion.focusPadding,
    minimumDistance: cameraMotion.focusMinimumDistance
  });
  animateCamera(frame);
}

function restoreCameraOverview({ animate = true } = {}) {
  const bounds = graph.getGraphBounds();
  const from = graph.getCameraPose();
  if (!bounds || !from) return;
  const target = {
    x: (bounds.min.x + bounds.max.x) * 0.5,
    y: (bounds.min.y + bounds.max.y) * 0.5,
    z: (bounds.min.z + bounds.max.z) * 0.5
  };
  const frame = planPerspectiveCameraFrame(bounds, {
    aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
    verticalFovDegrees: cameraMotion.verticalFovDegrees,
    direction: cinematicDirection(from.position, target),
    padding: cameraMotion.overviewPadding,
    minimumDistance: cameraMotion.overviewMinimumDistance
  });
  if (animate) animateCamera(frame); else graph.setCameraPose(frame);
}

function animateCamera(frame) {
  const from = graph.getCameraPose();
  if (!from) return;
  cancelCameraTween();
  const token = ++cameraTweenToken;
  let startedAt;
  cameraTweenDestination = frame;
  const tick = (timestamp) => {
    if (token !== cameraTweenToken || !graph || graph.isDisposed) return;
    startedAt ??= timestamp;
    const sample = sampleCameraPoseTween({
      from,
      to: frame,
      durationMs: cameraMotion.durationMs,
      easing: cameraMotion.easing
    }, timestamp - startedAt);
    graph.setCameraPose(sample);
    if (sample.complete) {
      cameraTweenFrame = undefined;
      cameraTweenDestination = undefined;
      updateMetrics();
      return;
    }
    cameraTweenFrame = requestAnimationFrame(tick);
  };
  cameraTweenFrame = requestAnimationFrame(tick);
}

function cancelCameraTween() {
  cameraTweenToken += 1;
  if (cameraTweenFrame !== undefined) cancelAnimationFrame(cameraTweenFrame);
  cameraTweenFrame = undefined;
  cameraTweenDestination = undefined;
}

/** Browser proof settles the host-owned animation synchronously; live clicks retain the requestAnimationFrame tween. */
function settleCameraTweenImmediately() {
  const destination = cameraTweenDestination;
  if (!destination || !graph || graph.isDisposed) return false;
  cancelCameraTween();
  graph.setCameraPose(destination);
  return true;
}

function cancelNodePopTweens() {
  nodeMotion?.cancelAll(false);
}

/** Browser proof settles the visual pop synchronously; live expansion retains requestAnimationFrame timing. */
function settleNodePopTweensImmediately() {
  if (!graph || graph.isDisposed || nodeMotion.activeCount === 0) return false;
  nodeMotion.cancelAll(true);
  return true;
}

function cinematicDirection(from, target) {
  return normalize({
    x: from.x - target.x + cameraMotion.shoulder.x,
    y: from.y - target.y + cameraMotion.shoulder.y,
    z: from.z - target.z + cameraMotion.shoulder.z
  });
}

function focusRadiusFor(nodeId) {
  return nodeId === 'core' ? 11 : 6;
}

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length > 0.0001 ? { x: vector.x / length, y: vector.y / length, z: vector.z / length } : { x: 0, y: 0, z: 1 };
}

function labelFor(name) { return name[0].toUpperCase() + name.slice(1); }
