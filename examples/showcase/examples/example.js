import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createForceGraph3D, createThreePlatform, NodeFlags } from '../../dist/index.js';
import { planPerspectiveCameraFocus, planPerspectiveCameraFrame } from '../../dist/camera/index.js';
import {
  coolStateTheme,
  datasets,
  expandableTree,
  flowWalkLinkIds,
  flowWalkNodeIds,
  metallicNodeSurface,
  nodeColor,
  warmStateTheme
} from '../showcase-model.js';
import { showcaseCatalog, showcaseExamples } from './manifest.js';
import {
  add,
  cameraArcPath,
  createCameraAnimator,
  length,
  normalizedDirection,
  orbitCameraPose,
  panCameraPose,
  scale as scaleVector,
  subtract,
  zoomCameraPose
} from './runtime/camera-controls.js';
import { createExampleShell } from './runtime/create-example-shell.js';
import { createNodeSpawnMotion } from './runtime/node-spawn-motion.js';
import { createResponsiveFramer } from './runtime/responsive-framing.js';
import { createFpsTelemetry, createStatusController } from './runtime/status-and-telemetry.js';
import { createExpandableTreeController } from './routes/expandable-tree.js';
import { createDynamicGraphController } from './routes/dynamic-graph.js';

const kind = document.body.dataset.example ?? 'basic';
const config = showcaseCatalog[kind];
const requestedBackend = new URLSearchParams(location.search).get('backend') === 'webgl2' ? 'webgl2' : 'auto';
const motionPreferenceKey = 'forcegraph-showcase-motion';
const flowStateTheme = Object.freeze({
  ...coolStateTheme,
  hovered: { ...coolStateTheme.hovered, color: 0xe8fdff, colorMix: 0.78, scale: 1.18 },
  selected: { ...coolStateTheme.selected, color: 0xd7c8f7, colorMix: 0.74, scale: 1 },
  focused: { ...coolStateTheme.focused, color: 0xe8deff, colorMix: 0.12, scale: 1 }
});
const root = document.querySelector('#example-root');
if (!config || !(root instanceof HTMLElement)) throw new Error(`Unknown showcase example '${kind}'.`);

let graph;
let nodeIds = [];
let nodeRecords = new Map();
let linkRecords = new Map();
let selectedNodeId;
let layoutRunning = kind !== 'flow';
let warmTheme = false;
let reducedMotion = initialReducedMotion();
let surface = {
  ...metallicNodeSurface,
  selectionEffect: {
    ...metallicNodeSurface.selectionEffect,
    breathAmount: reducedMotion ? 0 : metallicNodeSurface.selectionEffect.breathAmount
  }
};
let linkFlow = {
  direction: 'source-to-target',
  speed: 0.72,
  frequency: 1.2,
  pulseWidth: 0.28,
  intensity: 1,
  color: 0xb8fbff,
  nodeReaction: { enabled: false, scale: 1.24, intensity: 0.72, color: 0x8ff8ff }
};
let cameraFlight = { path: 'arc-right', easing: 'cubic-in-out', durationMs: 1_100 };
let cameraAnimator;
let flowWalkFrame;
let flowWalkToken = 0;
let flowWalkState = createIdleFlowWalkState();
let nodeMotion;
let expandableController;
let dynamicController;
let pinReleaseAfterDrag = false;
let overviewFrame;
let responsiveFramer;
let flowRunning = !reducedMotion;
const ownedListeners = [];

createExampleShell({
  root,
  config,
  kind,
  examples: showcaseExamples,
  reducedMotion,
  actionLabel,
  inspectorContent: config.sliders
    ? materialControls()
    : config.flowControls
      ? flowControls()
      : config.cameraControls
        ? cameraFlightControls()
        : '<p class="inspector-summary" data-inspector="summary">Select a node to inspect it and travel into its world.</p>'
});

const canvas = document.querySelector('#graph');
const status = document.querySelector('#runtime-status');
const telemetry = Object.fromEntries([...document.querySelectorAll('[data-metric]')].map((element) => [element.dataset.metric, element]));
const inspector = document.querySelector('.node-inspector');
const inspectorFields = Object.fromEntries([...document.querySelectorAll('[data-inspector]')].map((element) => [element.dataset.inspector, element]));
const statusController = createStatusController(status);
const fpsTelemetry = createFpsTelemetry(telemetry.fps);

window.__forcegraphProof = { schema: 'forcegraph_example_browser_fixture_v1', status: 'running', done: false };
void start();

async function start() {
  try {
    if (!(canvas instanceof HTMLCanvasElement) || !(status instanceof HTMLOutputElement)) throw new Error('Example surface is unavailable.');
    graph = await createForceGraph3D({
      platform: createThreePlatform({ THREE, TSL }),
      host: { mode: 'managed', canvas },
      renderer: {
        backend: requestedBackend,
        frameLoop: 'continuous',
        linkWidthUnit: 'pixel',
        pixelRatio: { minimum: 1, maximum: 2 },
        nodeSurface: surface,
        linkFlow: kind === 'flow' ? { ...linkFlow, enabled: flowRunning && !reducedMotion } : undefined
      },
      layout: {
        backend: kind === 'dynamic' ? 'worker' : 'local',
        ...(kind === 'dynamic' ? { workerFactory: () => new Worker(new URL('../../dist/worker/force-worker-entry.js', import.meta.url), { type: 'module' }) } : {}),
        autoStart: kind !== 'flow',
        seed: 20260823,
        minimumNodeDistance: kind === 'scale' ? 0 : 12,
        separationStrength: 0.72,
        separationIterations: 2,
        topologyReheatAlpha: 0.35,
        linkDistance: kind === 'scale' ? 24 : 15,
        linkStrength: kind === 'scale' ? 0.16 : 0.3,
        chargeStrength: kind === 'scale' ? -24 : -26,
        centerStrength: kind === 'scale' ? 0.018 : 0.052,
        velocityDecay: 0.34,
        alphaDecay: 0.018,
        alphaMinimum: 0.002
      },
      nodes: {
        radius: (node) => nodeRadius(node.id) * (nodeMotion?.scale(node.id) ?? 1),
        color: nodeColor
      },
      links: {
        width: kind === 'scale' ? 0.48 : kind === 'flow' ? flowLinkWidth : 0.72,
        color: kind === 'flow' ? flowLinkColor : (link) => link.data && typeof link.data === 'object' && typeof link.data.color === 'number' ? link.data.color : 0x365378,
        opacity: kind === 'scale' ? 0.18 : kind === 'flow' ? 0.76 : 0.28
      },
      interaction: { hover: true, selection: 'single', dragNodes: { enabled: true, releaseBehavior: 'keep-pinned' } }
    });
    nodeMotion = createNodeSpawnMotion({
      refreshNodeStyles: (ids) => graph.refreshNodeStyles(ids),
      reducedMotion: () => reducedMotion,
      onError: (error) => setStatus(error instanceof Error ? error.message : String(error), 'error', true)
    });
    cameraAnimator = createCameraAnimator({ graph, canvas, reducedMotion: () => reducedMotion });
    graph.on('node-hover', ({ nodeId }) => {
      if (nodeId !== undefined && inspectorFields.summary) inspectorFields.summary.textContent = `Hovering ${nodeLabel(nodeId)}. Click to select and focus.`;
    });
    graph.on('node-click', ({ nodeId }) => selectNode(nodeId, kind === 'cinematic' || kind === 'clusters'));
    graph.on('node-drag', ({ nodeId, phase }) => {
      if (kind !== 'pinned' || phase !== 'end') return;
      if (pinReleaseAfterDrag) {
        graph.releaseNode(nodeId);
        setStatus(`${nodeLabel(nodeId)} released after drag.`, 'ready', true);
      } else {
        setStatus(`${nodeLabel(nodeId)} remains pinned while layout continues.`, 'ready', true, 0);
      }
    });
    graph.on('error', ({ error }) => setStatus(error.message, 'error', true));
    await resetData();
    responsiveFramer = createResponsiveFramer({
      canvas,
      isReady: () => Boolean(graph && nodeIds.length),
      subscribeSettled: (listener) => graph.on('layout-settled', listener),
      isFocused: () => Boolean(selectedNodeId && selectedNodeId !== 'core'),
      frame: ({ animate }) => showOverview({ animate, clearSelection: false })
    });
    bindControls();
    fpsTelemetry.start();
    updateMetrics();
    if (kind === 'cinematic' && reducedMotion) {
      setStatus('Reduced motion is on. Turn it off below to play camera flights.', 'ready', true, 0);
    } else {
      setStatus(config.tip, 'ready', false);
    }
    window.__forcegraphExampleExercise = exerciseExample;
    if (kind === 'cinematic') window.__forcegraphCameraJourney = createCameraJourneyApi();
    if (kind === 'flow') window.__forcegraphFlowJourney = createFlowJourneyApi();
    const diagnostics = graph.getDiagnostics();
    const assertions = {
      managedCanvas: diagnostics.hostMode === 'managed',
      graphLoaded: diagnostics.nodeCount > 0 && diagnostics.linkCount > 0,
      twoDraws: diagnostics.drawCalls === 2,
      requestedBackendObserved: requestedBackend !== 'webgl2' || diagnostics.backend === 'webgl2'
    };
    window.__forcegraphProof = { schema: 'forcegraph_example_browser_fixture_v1', status: Object.values(assertions).every(Boolean) ? 'passed' : 'failed', done: true, example: kind, diagnostics, assertions };
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error', true);
    window.__forcegraphProof = { schema: 'forcegraph_example_browser_fixture_v1', status: 'failed', done: true, example: kind, error: String(error) };
  }
}

function bindControls() {
  for (const button of document.querySelectorAll('[data-action]')) listen(button, 'click', () => performAction(button.dataset.action));
  for (const slider of document.querySelectorAll('[data-surface]')) listen(slider, 'input', () => {
    surface = { ...surface, [slider.dataset.surface]: Number(slider.value), profile: 'metallic' };
    graph.setNodeSurface(surface);
    const value = document.querySelector(`[data-value="${slider.dataset.surface}"]`);
    if (value) value.textContent = Number(slider.value).toFixed(2);
    updateMetrics();
  });
  for (const slider of document.querySelectorAll('[data-selection-surface]')) listen(slider, 'input', () => {
    const name = slider.dataset.selectionSurface;
    surface = {
      ...surface,
      selectionEffect: { ...surface.selectionEffect, [name]: Number(slider.value) }
    };
    graph.setNodeSurface(surface);
    const value = document.querySelector(`[data-selection-value="${name}"]`);
    if (value) value.textContent = selectionValueLabel(name, Number(slider.value));
    updateMetrics();
  });
  for (const slider of document.querySelectorAll('[data-flow]')) listen(slider, 'input', () => {
    linkFlow = { ...linkFlow, [slider.dataset.flow]: Number(slider.value) };
    graph.setLinkFlow({ ...linkFlow, enabled: flowRunning && !reducedMotion });
    const value = document.querySelector(`[data-flow-value="${slider.dataset.flow}"]`);
    if (value) value.textContent = Number(slider.value).toFixed(2);
    updateMetrics();
  });
  for (const slider of document.querySelectorAll('[data-reaction]')) listen(slider, 'input', () => {
    linkFlow = {
      ...linkFlow,
      nodeReaction: { ...linkFlow.nodeReaction, [slider.dataset.reaction]: Number(slider.value) }
    };
    graph.setLinkFlow({ ...linkFlow, enabled: flowRunning && !reducedMotion });
    const value = document.querySelector(`[data-reaction-value="${slider.dataset.reaction}"]`);
    if (value) value.textContent = Number(slider.value).toFixed(2);
    updateMetrics();
  });
  for (const control of document.querySelectorAll('[data-camera]')) {
    const eventType = control instanceof HTMLInputElement ? 'input' : 'change';
    listen(control, eventType, () => {
      const key = control.dataset.camera;
      cameraFlight = { ...cameraFlight, [key]: key === 'durationMs' ? Number(control.value) : control.value };
      const value = document.querySelector(`[data-camera-value="${key}"]`);
      if (value) value.textContent = key === 'durationMs' ? `${cameraFlight.durationMs} ms` : cameraPathLabel(cameraFlight.path);
      updateInspector();
      setStatus(`${cameraPathLabel(cameraFlight.path)} · ${cameraFlight.easing} · ${cameraFlight.durationMs} ms`, 'ready', true);
    });
  }
  const motionControl = document.querySelector('[data-control="reduced-motion"]');
  if (motionControl instanceof HTMLInputElement) listen(motionControl, 'change', () => {
    reducedMotion = motionControl.checked;
    sessionStorage.setItem(motionPreferenceKey, reducedMotion ? 'reduce' : 'animate');
    if (reducedMotion) cancelCameraTween();
    surface = {
      ...surface,
      selectionEffect: {
        ...surface.selectionEffect,
        breathAmount: reducedMotion ? 0 : metallicNodeSurface.selectionEffect.breathAmount
      }
    };
    graph.setNodeSurface(surface);
    if (kind === 'flow') {
      if (reducedMotion && flowWalkState.running) finishFlowWalk(true);
      graph.setLinkFlow({ ...linkFlow, enabled: flowRunning && !reducedMotion });
    }
    if (kind === 'cinematic') setStatus(
      reducedMotion ? 'Camera flights disabled. Focus changes are now instant.' : 'Camera flights enabled. Click a node to play the selected tween.',
      'ready',
      true,
      reducedMotion ? 0 : 2_400
    );
  });
  listen(window, 'keydown', onShortcut);
  bindCameraControls();
  window.addEventListener('pagehide', cleanup, { once: true });
}

function bindCameraControls() {
  const navigation = { pointerId: undefined, mode: 'rotate', x: 0, y: 0 };
  const pointerDown = (event) => {
    if (event.defaultPrevented) return;
    if (navigation.pointerId !== undefined || ![0, 1, 2].includes(event.button)) return;
    navigation.pointerId = event.pointerId;
    navigation.mode = event.shiftKey || event.button === 1 ? 'pan' : 'rotate';
    navigation.x = event.clientX;
    navigation.y = event.clientY;
    try { canvas.setPointerCapture?.(event.pointerId); } catch { /* synthetic or already-owned pointer */ }
    canvas.dataset.navigating = 'true';
    event.preventDefault();
  };
  const pointerMove = (event) => {
    if (event.pointerId !== navigation.pointerId) return;
    const deltaX = event.clientX - navigation.x;
    const deltaY = event.clientY - navigation.y;
    navigation.x = event.clientX;
    navigation.y = event.clientY;
    if (navigation.mode === 'pan') panCamera(deltaX, deltaY); else orbitCamera(deltaX, deltaY);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const pointerEnd = (event) => {
    if (event.pointerId !== navigation.pointerId) return;
    navigation.pointerId = undefined;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* capture may already be gone */ }
    delete canvas.dataset.navigating;
    event.preventDefault();
  };
  const wheel = (event) => {
    zoomCamera(event.deltaY);
    event.preventDefault();
  };
  const contextMenu = (event) => event.preventDefault();
  listen(canvas, 'pointerdown', pointerDown, { capture: true });
  listen(canvas, 'pointermove', pointerMove, { capture: true });
  listen(canvas, 'pointerup', pointerEnd, { capture: true });
  listen(canvas, 'pointercancel', pointerEnd, { capture: true });
  listen(canvas, 'wheel', wheel, { passive: false });
  listen(canvas, 'contextmenu', contextMenu);
}

function performAction(action) {
  if (action === 'reset') void resetData();
  if (action === 'layout') toggleLayout();
  if (action === 'theme') toggleTheme();
  if (action === 'focus') focusNode(selectedNodeId ?? 'core');
  if (action === 'overview') { responsiveFramer?.reset({ schedule: false }); showOverview(); }
  if (action === 'expand') expandSelectedBranch();
  if (action === 'collapse') collapseSelectedBranch();
  if (action === 'release') releaseSelectedNode();
  if (action === 'pin-mode') togglePinMode();
  if (action === 'dynamic') toggleDynamicGraph();
  if (action === 'add') void addDynamicNode();
  if (action === 'remove') void removeDynamicNode();
  if (action === 'flow') toggleFlow();
  if (action === 'direction') toggleFlowDirection();
  if (action === 'walk') toggleFlowWalk();
  if (action === 'effects') toggleSelectionEffects();
  if (action === 'close-inspector') setInspectorOpen(false);
  updateMetrics();
}

async function resetData() {
  cancelCameraTween();
  cancelFlowWalk({ clearGraph: false, restoreFlow: true });
  const dynamicDisposal = dynamicController?.dispose();
  nodeMotion?.cancelAll(false);
  if (dynamicDisposal) await dynamicDisposal;
  dynamicController = undefined;
  expandableController = undefined;
  const data = datasets[config.dataset]();
  nodeIds = data.nodes.map((node) => node.id);
  nodeRecords = new Map(data.nodes.map((node) => [node.id, node]));
  linkRecords = new Map(data.links.map((link) => [link.id, link]));
  if (kind === 'dynamic') await graph.setDataAsync(data); else graph.setData(data);
  initializeRouteController();
  if (expandableController) expandableController.expand(expandableController.rootId);
  if (dynamicController) {
    await dynamicController.addOne();
    dynamicController.resume();
  }
  graph.setStateTheme(kind === 'flow' ? flowStateTheme : warmTheme ? warmStateTheme : coolStateTheme);
  if (kind === 'flow') graph.setLinkFlow({ ...linkFlow, enabled: flowRunning && !reducedMotion });
  if (layoutRunning) graph.restartLayout();
  selectedNodeId = 'core';
  graph.setSelection(['core']);
  setInspectorOpen(kind === 'materials' || kind === 'flow' || kind === 'cinematic');
  updateInspector();
  updateFlowWalkUi();
  queueOverview();
  responsiveFramer?.reset();
  graph.render();
  setStatus(`${config.title} reset`, 'ready', true);
}

function initializeRouteController() {
  if (kind === 'expandable') {
    const sourceById = new Map(expandableTree.map((record) => [record.id, record]));
    expandableController = createExpandableTreeController({
      graph,
      motion: nodeMotion,
      tree: expandableTree,
      seed: 20260823,
      spawnDistance: 2.4,
      onChange: (snapshot) => {
        nodeIds = [...snapshot.visibleNodeIds];
        nodeRecords = new Map(nodeIds.map((id) => {
          const source = sourceById.get(id);
          return [id, { id, data: source?.data }];
        }));
        updateRouteReadout();
      }
    });
  }
  if (kind === 'dynamic') {
    dynamicController = createDynamicGraphController({
      graph,
      motion: nodeMotion,
      seed: 20260823,
      intervalMs: 820,
      maximumNodes: 40,
      spawnDistance: 2.4,
      onNodeAdded: (node) => {
        nodeIds.push(node.id);
        nodeRecords.set(node.id, node);
      },
      onNodeRemoved: (id) => {
        nodeIds = nodeIds.filter((nodeId) => nodeId !== id);
        nodeRecords.delete(id);
      },
      onChange: updateRouteReadout
    });
  }
  updateRouteReadout();
}

function expandSelectedBranch() {
  if (kind !== 'expandable' || !expandableController) {
    return;
  }
  const parentId = expandableController.hasChildren(selectedNodeId) ? selectedNodeId : expandableController.rootId;
  const result = expandableController.expand(parentId);
  updateRouteReadout();
  setStatus(
    result.changed
      ? `Expanded ${nodeLabel(parentId)}: +${result.addedNodes} nodes, +${result.addedLinks} links.`
      : `${nodeLabel(parentId)} has no hidden children.`,
    'ready',
    true,
    0
  );
  graph.render();
}

function collapseSelectedBranch() {
  if (!expandableController) return;
  const parentId = expandableController.isExpanded(selectedNodeId) ? selectedNodeId : expandableController.rootId;
  const result = expandableController.collapse(parentId);
  if (!nodeIds.includes(selectedNodeId)) {
    selectedNodeId = parentId;
    graph.setSelection([parentId]);
  }
  updateRouteReadout();
  setStatus(
    result.changed
      ? `Collapsed ${nodeLabel(parentId)}: -${result.removedNodes} nodes, ${result.cascadedLinks} cascaded links.`
      : `${nodeLabel(parentId)} has no visible descendants.`,
    'ready',
    true,
    0
  );
  graph.render();
}

function releaseSelectedNode() {
  if (kind !== 'pinned' || selectedNodeId === undefined) return;
  const released = graph.releaseNode(selectedNodeId);
  setStatus(released ? `${nodeLabel(selectedNodeId)} released back into the layout.` : `${nodeLabel(selectedNodeId)} is not pinned.`, 'ready', true, 0);
}

function togglePinMode() {
  pinReleaseAfterDrag = !pinReleaseAfterDrag;
  const button = document.querySelector('[data-action="pin-mode"]');
  if (button) {
    button.textContent = pinReleaseAfterDrag ? 'Release after drag' : 'Keep pinned';
    button.dataset.active = String(pinReleaseAfterDrag);
  }
  setStatus(pinReleaseAfterDrag ? 'Dragged nodes release when the pointer lifts.' : 'Dragged nodes stay pinned until Release selected.', 'ready', true, 0);
}

function toggleDynamicGraph() {
  if (!dynamicController) return;
  if (dynamicController.running) dynamicController.pause(); else dynamicController.resume();
  updateRouteReadout();
  setStatus(dynamicController.running ? 'Stable-ID additions resumed.' : 'Dynamic additions paused; no timer remains active.', 'ready', true, 0);
}

async function addDynamicNode() {
  if (!dynamicController) return;
  const result = await dynamicController.addOne();
  updateRouteReadout();
  setStatus(result.changed ? `Added one stable node at revision ${result.revision}.` : 'The bounded dynamic graph is at capacity.', 'ready', true, 0);
}

async function removeDynamicNode() {
  if (!dynamicController || selectedNodeId === undefined || selectedNodeId === 'core') {
    setStatus('Select a non-root dynamic node to remove it.', 'ready', true, 0);
    return;
  }
  const removedId = selectedNodeId;
  const result = await dynamicController.remove(removedId);
  selectedNodeId = 'core';
  graph.setSelection(['core']);
  updateRouteReadout();
  setStatus(
    result.changed
      ? `Removed ${nodeLabel(removedId)} with ${result.cascadedLinks} cascaded link.`
      : `${nodeLabel(removedId)} was already absent.`,
    'ready',
    true,
    0
  );
}

function updateRouteReadout() {
  if (kind === 'expandable' && expandableController && inspectorFields.summary) {
    const snapshot = expandableController.snapshot();
    const receipt = snapshot.lastMutation;
    inspectorFields.summary.textContent = receipt
      ? `${snapshot.visibleNodeIds.length} visible nodes · revision ${receipt.revision} · +${receipt.addedNodes ?? 0}/-${receipt.removedNodes ?? 0} nodes · ${receipt.cascadedLinks ?? 0} cascaded links.`
      : 'Select a visible branch, then expand or collapse its immutable children.';
  }
  if (kind === 'dynamic' && dynamicController && inspectorFields.summary) {
    const snapshot = dynamicController.snapshot();
    const receipt = snapshot.lastMutation;
    inspectorFields.summary.textContent = `${snapshot.nodeCount}/${snapshot.maximumNodes} nodes · revision ${snapshot.revision} · alpha ${snapshot.layoutAlpha.toFixed(3)}${receipt ? ` · last +${receipt.addedNodes}/-${receipt.removedNodes}, cascade ${receipt.cascadedLinks}` : ''}`;
    const button = document.querySelector('[data-action="dynamic"]');
    if (button) {
      button.textContent = snapshot.running ? 'Pause additions' : 'Resume additions';
      button.dataset.active = String(!snapshot.running);
    }
  }
  updateMetrics();
}

function toggleFlow() {
  if (flowWalkState.running || flowWalkState.completed) cancelFlowWalk({ clearGraph: true, restoreFlow: true });
  flowRunning = !flowRunning;
  graph.setLinkFlow({ ...linkFlow, enabled: flowRunning && !reducedMotion });
  const button = document.querySelector('[data-action="flow"]');
  if (button) {
    button.textContent = flowRunning ? 'Pause flow' : 'Run flow';
    button.dataset.active = String(!flowRunning);
  }
  setStatus(flowRunning ? 'Directional flow resumed' : 'Directional flow paused', 'ready', true);
}

function toggleSelectionEffects() {
  const enabled = surface.selectionEffect?.enabled === false;
  surface = {
    ...surface,
    selectionEffect: { ...surface.selectionEffect, enabled }
  };
  graph.setNodeSurface(surface);
  const button = document.querySelector('[data-action="effects"]');
  if (button) {
    button.textContent = enabled ? 'HAIO effects on' : 'HAIO effects off';
    button.dataset.active = String(enabled);
    button.setAttribute('aria-pressed', String(enabled));
  }
  setStatus(enabled ? 'HAIO hover, selection bubble, and selected-node breathing are on.' : 'HAIO selection treatment is off.', 'ready', true);
}

function toggleFlowDirection() {
  if (flowWalkState.running || flowWalkState.completed) cancelFlowWalk({ clearGraph: true, restoreFlow: true });
  linkFlow = {
    ...linkFlow,
    direction: linkFlow.direction === 'source-to-target' ? 'target-to-source' : 'source-to-target'
  };
  graph.setLinkFlow({ ...linkFlow, enabled: flowRunning && !reducedMotion });
  const reverse = linkFlow.direction === 'target-to-source';
  const button = document.querySelector('[data-action="direction"]');
  if (button) button.dataset.active = String(reverse);
  if (inspectorFields.label) inspectorFields.label.textContent = reverse ? 'Target → source' : 'Source → target';
  setStatus(reverse ? 'Flow reversed toward source nodes' : 'Flow follows source to target', 'ready', true);
}

function toggleFlowWalk() {
  if (flowWalkState.running) {
    cancelFlowWalk({ clearGraph: true, restoreFlow: true });
    setStatus('Query walk stopped', 'ready', true);
    return;
  }
  void startFlowWalk();
}

function startFlowWalk(options = {}) {
  const stepMs = options.stepMs ?? 620;
  if (!Number.isFinite(stepMs) || stepMs < 30 || stepMs > 2_000) {
    throw new Error('Flow walk stepMs must be between 30 and 2000 ms.');
  }
  cancelFlowWalk({ clearGraph: true, restoreFlow: true });
  const savedFlow = { ...linkFlow, nodeReaction: { ...linkFlow.nodeReaction } };
  linkFlow = {
    ...linkFlow,
    direction: 'source-to-target',
    speed: 1.15,
    frequency: 1,
    pulseWidth: 0.16,
    intensity: 1,
    nodeReaction: { ...linkFlow.nodeReaction, enabled: false }
  };
  flowRunning = true;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  flowWalkState = {
    running: true,
    completed: false,
    activeStep: 0,
    stepMs,
    savedFlow,
    resolveCompletion,
    completion
  };
  canvas.dataset.flowWalk = 'running';
  graph.setLinkFlow({ ...linkFlow, enabled: !reducedMotion });
  applyFlowWalkStep(0, performance.now());
  updateFlowButtons();
  setStatus(`Query entered ${nodeLabel(flowWalkNodeIds[0])}`, 'ready', true, 0);
  if (reducedMotion) {
    finishFlowWalk(true);
    return completion;
  }

  const token = ++flowWalkToken;
  let startedAt;
  const tick = (time) => {
    if (token !== flowWalkToken || !flowWalkState.running) return;
    startedAt ??= time;
    const progress = Math.min(flowWalkLinkIds.length, (time - startedAt) / stepMs);
    const step = Math.min(flowWalkLinkIds.length, Math.floor(progress));
    if (step !== flowWalkState.activeStep) applyFlowWalkStep(step, time);
    const nodeTweenRunning = updateFlowNodeTween(time);
    updateFlowWalkUi(progress);
    if (progress >= flowWalkLinkIds.length && !nodeTweenRunning) {
      finishFlowWalk(false);
      return;
    }
    flowWalkFrame = requestAnimationFrame(tick);
  };
  flowWalkFrame = requestAnimationFrame(tick);
  return completion;
}

function applyFlowWalkStep(step, time = performance.now(), animateNode = true) {
  const boundedStep = Math.max(0, Math.min(flowWalkLinkIds.length, step));
  const previousNodeId = selectedNodeId;
  flowWalkState.activeStep = boundedStep;
  const changedLinks = [];
  for (let index = 0; index < flowWalkLinkIds.length; index += 1) {
    const id = flowWalkLinkIds[index];
    const record = linkRecords.get(id);
    if (!record) continue;
    const walk = index < boundedStep ? 'visited' : index === boundedStep ? 'active' : 'route';
    if (record.data?.walk === walk) continue;
    const nextRecord = { ...record, data: { ...record.data, walk } };
    linkRecords.set(id, nextRecord);
    changedLinks.push(nextRecord);
  }
  if (changedLinks.length > 0) graph.applyPatch({ links: { upsert: changedLinks } });

  const visitedNodeIds = flowWalkNodeIds.slice(0, boundedStep + 1);
  const currentNodeId = flowWalkNodeIds[boundedStep];
  graph.setNodeFlagsMany(nodeIds, NodeFlags.Dimmed, NodeFlags.Focused);
  graph.setNodeFlagsMany(visitedNodeIds, 0, NodeFlags.Dimmed | NodeFlags.Focused);
  graph.setNodeFlags(currentNodeId, NodeFlags.Focused, NodeFlags.Dimmed);
  graph.setSelection([currentNodeId]);
  selectedNodeId = currentNodeId;
  beginFlowNodeTween(previousNodeId, currentNodeId, time, animateNode);
  updateInspector();
  updateFlowWalkUi(boundedStep);
  graph.render();
  if (boundedStep < flowWalkLinkIds.length) {
    const nextNodeId = flowWalkNodeIds[boundedStep + 1];
    setStatus(`Hop ${boundedStep + 1}: ${nodeLabel(currentNodeId)} → ${nodeLabel(nextNodeId)}`, 'ready', true, 0);
  }
}

function finishFlowWalk(reduced) {
  if (!flowWalkState.running) return;
  cancelAnimationFrame(flowWalkFrame);
  flowWalkFrame = undefined;
  flowWalkToken += 1;
  if (reduced || flowWalkState.activeStep < flowWalkLinkIds.length) {
    applyFlowWalkStep(flowWalkLinkIds.length, performance.now(), !reduced);
  }
  if (reduced) settleFlowNodeTween();
  flowWalkState.running = false;
  flowWalkState.completed = true;
  canvas.dataset.flowWalk = 'complete';
  graph.setLinkFlow({ ...linkFlow, enabled: !reducedMotion });
  updateFlowButtons();
  updateInspector();
  updateFlowWalkUi(flowWalkLinkIds.length);
  const result = { completed: true, cancelled: false, reducedMotion: reduced };
  const resolve = flowWalkState.resolveCompletion;
  flowWalkState.resolveCompletion = undefined;
  resolve?.(result);
  setStatus(
    reduced
      ? `Answer reached through ${flowWalkLinkIds.length} evidence hops. Final path shown without animation.`
      : `Answer reached through ${flowWalkLinkIds.length} evidence hops.`,
    'ready',
    true,
    0
  );
}

function cancelFlowWalk({ clearGraph = true, restoreFlow = true } = {}) {
  cancelAnimationFrame(flowWalkFrame);
  flowWalkFrame = undefined;
  flowWalkToken += 1;
  const previous = flowWalkState;
  previous.resolveCompletion?.({ completed: false, cancelled: true, reducedMotion: false });
  if (restoreFlow && previous.savedFlow) linkFlow = previous.savedFlow;
  flowWalkState = createIdleFlowWalkState();
  nodeMotion?.cancelAll(true);
  if (canvas) delete canvas.dataset.flowWalk;
  if (!clearGraph || !graph || kind !== 'flow') return;

  const changedLinks = [];
  for (const id of flowWalkLinkIds) {
    const record = linkRecords.get(id);
    if (!record || record.data?.walk === 'route') continue;
    const nextRecord = { ...record, data: { ...record.data, walk: 'route' } };
    linkRecords.set(id, nextRecord);
    changedLinks.push(nextRecord);
  }
  if (changedLinks.length > 0) graph.applyPatch({ links: { upsert: changedLinks } });
  setFlowNodePops(flowWalkNodeIds.map((id) => [id, 1]));
  graph.setNodeFlagsMany(nodeIds, 0, NodeFlags.Dimmed | NodeFlags.Focused);
  selectedNodeId = 'core';
  graph.setSelection(['core']);
  graph.setLinkFlow({ ...linkFlow, enabled: flowRunning && !reducedMotion });
  updateFlowButtons();
  updateInspector();
  updateFlowWalkUi();
  graph.render();
}

function beginFlowNodeTween(previousNodeId, currentNodeId, startedAt, animate) {
  if (!animate || previousNodeId === currentNodeId) {
    setFlowNodePops([
      ...(previousNodeId && previousNodeId !== currentNodeId ? [[previousNodeId, 1]] : []),
      [currentNodeId, 1]
    ]);
    return;
  }
  if (previousNodeId && previousNodeId !== currentNodeId) nodeMotion.cancel(previousNodeId, true);
  nodeMotion.pulse(currentNodeId, {
    from: nodePopValue(currentNodeId),
    peak: Math.max(1.05, Math.min(1.65, linkFlow.nodeReaction.scale ?? 1.24)),
    durationMs: 360
  });
}

function updateFlowNodeTween() {
  return (nodeMotion?.activeCount ?? 0) > 0;
}

function settleFlowNodeTween() {
  setFlowNodePops(flowWalkNodeIds.map((id) => [id, 1]));
}

function setFlowNodePops(entries) {
  if (!graph || kind !== 'flow') return;
  nodeMotion.setMany(entries.filter(([id]) => nodeRecords.has(id)));
}

function nodePopValue(id) {
  return nodeMotion?.scale(id) ?? 1;
}

function createIdleFlowWalkState() {
  return {
    running: false,
    completed: false,
    activeStep: -1,
    stepMs: 620,
    savedFlow: undefined,
    resolveCompletion: undefined,
    completion: Promise.resolve({ completed: false, cancelled: false, reducedMotion: false })
  };
}

function updateFlowButtons() {
  const walkButton = document.querySelector('[data-action="walk"]');
  if (walkButton) {
    walkButton.textContent = actionLabel('walk');
    walkButton.dataset.active = String(flowWalkState.running);
  }
  const flowButton = document.querySelector('[data-action="flow"]');
  if (flowButton) {
    flowButton.textContent = flowRunning ? 'Pause flow' : 'Run flow';
    flowButton.dataset.active = String(!flowRunning);
  }
  const directionButton = document.querySelector('[data-action="direction"]');
  if (directionButton) directionButton.dataset.active = String(linkFlow.direction === 'target-to-source');
}

function updateFlowWalkUi(progress = Math.max(0, flowWalkState.activeStep)) {
  if (kind !== 'flow') return;
  const step = Math.max(0, flowWalkState.activeStep);
  const currentNodeId = flowWalkNodeIds[Math.min(step, flowWalkNodeIds.length - 1)];
  const label = document.querySelector('[data-walk-label]');
  const output = document.querySelector('[data-walk-progress]');
  const bar = document.querySelector('[data-walk-bar]');
  if (label) label.textContent = flowWalkState.running || flowWalkState.completed
    ? nodeLabel(currentNodeId)
    : 'Ready at top-left query';
  if (output) output.textContent = `${Math.min(step, flowWalkLinkIds.length)} / ${flowWalkLinkIds.length}`;
  if (bar instanceof HTMLElement) bar.style.width = `${Math.min(100, Math.max(0, progress / flowWalkLinkIds.length * 100))}%`;
  updateFlowButtons();
}

function flowLinkWidth(link) {
  return ({ active: 3.8, visited: 2, route: 1.1, idle: 0.48 })[link.data?.walk] ?? 0.48;
}

function flowLinkColor(link) {
  return ({ active: 0xb8fbff, visited: 0x4fe2c5, route: 0x315f70, idle: 0x1b2a49 })[link.data?.walk]
    ?? (typeof link.data?.color === 'number' ? link.data.color : 0x1b2a49);
}

function queueOverview() {
  cancelAnimationFrame(overviewFrame);
  overviewFrame = requestAnimationFrame(() => showOverview({ animate: false, clearSelection: false }));
}

function toggleLayout() {
  layoutRunning = !layoutRunning;
  if (layoutRunning) graph.restartLayout(); else graph.stopLayout();
  const button = document.querySelector('[data-action="layout"]');
  if (button) {
    button.textContent = layoutRunning ? 'Pause layout' : 'Run layout';
    button.dataset.active = String(!layoutRunning);
  }
  setStatus(layoutRunning ? 'Layout resumed' : 'Layout paused', 'ready', true);
}

function toggleTheme() {
  warmTheme = !warmTheme;
  graph.setStateTheme(warmTheme ? warmStateTheme : coolStateTheme);
  const button = document.querySelector('[data-action="theme"]');
  if (button) button.dataset.active = String(warmTheme);
  graph.render();
}

function selectNode(nodeId, focus) {
  if (!nodeIds.includes(nodeId)) return;
  selectedNodeId = nodeId;
  graph.setSelection([nodeId]);
  setInspectorOpen(true);
  updateInspector();
  if (focus) focusNode(nodeId);
}

function focusNode(nodeId) {
  responsiveFramer?.markUserInteraction();
  if (!nodeIds.includes(nodeId)) return;
  selectedNodeId = nodeId;
  graph.setHoveredNode(undefined);
  graph.setNodeFlagsMany(nodeIds.filter((id) => id !== nodeId), NodeFlags.Dimmed, NodeFlags.Focused);
  graph.setNodeFlags(nodeId, NodeFlags.Focused, NodeFlags.Dimmed);
  graph.setSelection([nodeId]);
  setInspectorOpen(true);
  updateInspector();
  const target = graph.getNodePosition(nodeId);
  const from = graph.getCameraPose();
  let cameraMovement = 'unavailable';
  if (target && from) {
    cameraMovement = animateCamera(planPerspectiveCameraFocus(target, focusedNodeRadius(nodeId), {
      aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
      verticalFovDegrees: 50,
      direction: normalizedDirection(from.position, target),
      padding: kind === 'cinematic' ? 6.2 : 4.8,
      minimumDistance: kind === 'cinematic' ? 24 : 18
    }), {
      cinematic: kind === 'cinematic',
      onComplete: () => setStatus(`Arrived at ${nodeLabel(nodeId)}`, 'ready', true)
    });
  }
  graph.render();
  setStatus(
    cameraMovement === 'instant'
      ? `Focused ${nodeLabel(nodeId)} instantly — reduced motion is on.`
      : cameraMovement === 'animated'
        ? `Flying to ${nodeLabel(nodeId)} · ${cameraPathLabel(cameraFlight.path)}`
        : `Focused ${nodeLabel(nodeId)}`,
    'ready',
    true,
    cameraMovement === 'instant' ? 0 : 2_400
  );
}

function showOverview(options = {}) {
  const { animate = true, clearSelection = true } = options;
  graph.setNodeFlagsMany(nodeIds, 0, NodeFlags.Dimmed | NodeFlags.Focused);
  if (clearSelection) {
    selectedNodeId = undefined;
    graph.setSelection([]);
    setInspectorOpen(false);
  }
  const bounds = graph.getGraphBounds();
  const from = graph.getCameraPose();
  if (bounds && from) {
    const framedPose = planPerspectiveCameraFrame(bounds, {
      aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
      verticalFovDegrees: 50,
      direction: normalizedDirection(from.position, boundsCenter(bounds)),
      padding: kind === 'scale' ? 1.12 : 1.08,
      minimumDistance: 48
    });
    const pose = framedPose;
    if (animate) animateCamera(pose); else graph.setCameraPose(pose);
  }
  graph.render();
}

function animateCamera(to, options = {}) {
  const { cinematic = false, onComplete } = options;
  const from = graph.getCameraPose();
  if (!from) return 'unavailable';
  return cameraAnimator.animate(to, {
    durationMs: cinematic ? cameraFlight.durationMs : 780,
    easing: cinematic ? cameraFlight.easing : 'cubic-in-out',
    path: cinematic ? cameraArcPath(from, to, cameraFlight.path) : { type: 'direct' },
    mode: cinematic ? 'cinematic' : 'standard',
    onComplete
  });
}

function orbitCamera(deltaX, deltaY) {
  const pose = graph.getCameraPose();
  if (!pose) return;
  responsiveFramer?.markUserInteraction();
  cancelCameraTween();
  graph.setCameraPose(orbitCameraPose(pose, deltaX, deltaY));
}

function panCamera(deltaX, deltaY) {
  const pose = graph.getCameraPose();
  if (!pose) return;
  responsiveFramer?.markUserInteraction();
  cancelCameraTween();
  graph.setCameraPose(panCameraPose(pose, deltaX, deltaY));
}

function zoomCamera(deltaY) {
  const pose = graph.getCameraPose();
  if (!pose) return;
  responsiveFramer?.markUserInteraction();
  cancelCameraTween();
  graph.setCameraPose(zoomCameraPose(pose, deltaY));
}

async function exerciseExample() {
  const effectsInitiallyEnabled = surface.selectionEffect?.enabled !== false;
  toggleSelectionEffects();
  const effectsDisabled = surface.selectionEffect?.enabled === false;
  toggleSelectionEffects();
  const sharedEffectsExercised = effectsInitiallyEnabled
    && effectsDisabled
    && surface.selectionEffect?.enabled !== false;
  const cameraBefore = graph.getCameraPose();
  dispatchNavigationGesture(false, 18, -9, 71);
  dispatchNavigationGesture(true, 7, -5, 72);
  canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -42 }));
  const cameraAfter = graph.getCameraPose();
  const cameraControlsMoved = cameraBefore !== undefined
    && cameraAfter !== undefined
    && length(subtract(cameraBefore.position, cameraAfter.position)) > 0.01
    && length(subtract(cameraBefore.target, cameraAfter.target)) > 0.01;
  if (cameraBefore) graph.setCameraPose(cameraBefore);
  if (kind === 'materials') {
    surface = { ...surface, roughness: 0.34 };
    graph.setNodeSurface(surface);
    updateInspector();
  }
  let flowWalkExercised = kind !== 'flow';
  if (kind === 'flow') {
    reducedMotion = false;
    flowRunning = true;
    const motionControl = document.querySelector('[data-control="reduced-motion"]');
    if (motionControl instanceof HTMLInputElement) motionControl.checked = false;
    const result = await startFlowWalk({ stepMs: 45 });
    flowWalkExercised = result.completed
      && flowWalkState.completed
      && selectedNodeId === 'core'
      && Math.abs(nodePopValue('core') - 1) < 0.01
      && flowWalkLinkIds.every((id) => linkRecords.get(id)?.data?.walk === 'visited');
  }
  let expandableBehaviorExercised = kind !== 'expandable';
  if (kind === 'expandable') {
    const initialIds = expandableController.snapshot().visibleNodeIds;
    const collapsed = expandableController.collapse(expandableController.rootId);
    const expanded = expandableController.expand(expandableController.rootId);
    cancelPops(true);
    const finalSnapshot = expandableController.snapshot();
    expandableBehaviorExercised = collapsed.changed
      && expanded.changed
      && JSON.stringify(initialIds) === JSON.stringify(finalSnapshot.visibleNodeIds)
      && finalSnapshot.activeMotionCount === 0;
  }
  let pinnedBehaviorExercised = kind !== 'pinned';
  if (kind === 'pinned') {
    const id = 'tree-1';
    await graph.stopLayoutAsync();
    const position = graph.getNodePosition(id);
    await graph.setNodeFixedAsync(id, position);
    await graph.startLayoutAsync();
    await waitForAnimationFrames(4);
    const pinnedPosition = graph.getNodePosition(id);
    await graph.stopLayoutAsync();
    const released = await graph.releaseNodeAsync(id);
    await graph.startLayoutAsync();
    pinnedBehaviorExercised = JSON.stringify(position) === JSON.stringify(pinnedPosition) && released;
  }
  let dynamicBehaviorExercised = kind !== 'dynamic';
  if (kind === 'dynamic') {
    dynamicController.pause();
    await dynamicController.reset();
    const added = await dynamicController.addOne();
    const addedId = dynamicController.snapshot().nodeIds.find((id) => id !== 'core');
    const removed = await dynamicController.remove(addedId);
    const replacement = await dynamicController.addOne();
    cancelPops(true);
    const snapshot = dynamicController.snapshot();
    dynamicBehaviorExercised = added.changed
      && removed.changed
      && replacement.changed
      && addedId === 'dynamic-0001'
      && snapshot.nodeIds.includes('dynamic-0002')
      && snapshot.nodeCount === 2
      && snapshot.pendingTimer === false
      && snapshot.activeMotionCount === 0;
  }
  let cinematicTweenOptionsExercised = kind !== 'cinematic';
  let cinematicTweenEvidence;
  if (kind === 'cinematic') {
    reducedMotion = false;
    const motionControl = document.querySelector('[data-control="reduced-motion"]');
    if (motionControl instanceof HTMLInputElement) motionControl.checked = false;
    const flightBefore = graph.getCameraPose();
    const priorFlight = cameraFlight;
    cameraFlight = { path: 'arc-left', easing: 'smoothstep', durationMs: 600 };
    const flightStartedAt = performance.now();
    focusNode(nodeIds[Math.max(0, Math.floor(nodeIds.length / 3))]);
    // Eight frames can outlast this flight on a slow renderer. Capture its start before yielding.
    const flightStarted = canvas.dataset.cameraFlight === 'cinematic';
    await waitForAnimationFrames(8);
    const flightObserved = graph.getCameraPose();
    const positionDelta = flightBefore !== undefined && flightObserved !== undefined
      ? length(subtract(flightBefore.position, flightObserved.position))
      : 0;
    cinematicTweenEvidence = {
      started: flightStarted,
      positionDelta,
      flightAtObservation: canvas.dataset.cameraFlight ?? null,
      statusAtObservation: status?.textContent ?? '',
      observationElapsedMs: Math.max(0, performance.now() - flightStartedAt)
    };
    cinematicTweenOptionsExercised = flightStarted && positionDelta > 0.001;
    cancelCameraTween();
    cameraFlight = priorFlight;
    showOverview({ animate: false, clearSelection: false });
  }
  await waitForAnimationFrames(kind === 'flow' ? 12 : 2);
  const diagnostics = graph.getDiagnostics();
  return {
    passed: diagnostics.drawCalls === 2
      && diagnostics.transformPath === 'tsl'
      && diagnostics.instanceMatrixAllocationBytes === 0
      && sharedEffectsExercised
      && cameraControlsMoved
      && cinematicTweenOptionsExercised
      && flowWalkExercised
      && expandableBehaviorExercised
      && pinnedBehaviorExercised
      && dynamicBehaviorExercised
      && (kind !== 'flow' || (diagnostics.linkFlowEnabled && diagnostics.linkFlowTimeSeconds > 0))
      && diagnostics.nodeCount === nodeIds.length,
    example: kind,
    cameraControlsMoved,
    sharedEffectsExercised,
    cinematicTweenOptionsExercised,
    cinematicTweenEvidence,
    flowWalkExercised,
    expandableBehaviorExercised,
    pinnedBehaviorExercised,
    dynamicBehaviorExercised,
    flowWalk: kind === 'flow' ? flowJourneySnapshot() : undefined,
    diagnostics
  };
}

function createFlowJourneyApi() {
  return Object.freeze({
    start(options = {}) {
      return startFlowWalk(options).then(() => flowJourneySnapshot());
    },
    reset() {
      cancelFlowWalk({ clearGraph: true, restoreFlow: true });
      return flowJourneySnapshot();
    },
    snapshot: flowJourneySnapshot
  });
}

function flowJourneySnapshot() {
  const diagnostics = graph.getDiagnostics();
  const currentNodeId = flowWalkState.activeStep < 0
    ? null
    : flowWalkNodeIds[Math.min(flowWalkState.activeStep, flowWalkNodeIds.length - 1)];
  return {
    route: kind,
    running: flowWalkState.running,
    completed: flowWalkState.completed,
    activeStep: flowWalkState.activeStep,
    currentNodeId,
    currentNodeScale: currentNodeId === null ? 1 : nodePopValue(currentNodeId),
    visitedLinkCount: flowWalkLinkIds.filter((id) => linkRecords.get(id)?.data?.walk === 'visited').length,
    hopCount: flowWalkLinkIds.length,
    reducedMotion,
    status: status?.textContent ?? '',
    drawCalls: diagnostics.drawCalls,
    linkFlowEnabled: diagnostics.linkFlowEnabled,
    linkFlowTimeSeconds: diagnostics.linkFlowTimeSeconds
  };
}

function createCameraJourneyApi() {
  return Object.freeze({
    overview() {
      cancelCameraTween();
      graph.stopLayout();
      showOverview({ animate: false, clearSelection: true });
      setInspectorOpen(true);
      return cameraJourneySnapshot();
    },
    start(options = {}) {
      const paths = ['direct', 'arc-left', 'arc-right', 'arc-over'];
      const easings = ['linear', 'smoothstep', 'cubic-in-out'];
      const path = options.path ?? cameraFlight.path;
      const easing = options.easing ?? cameraFlight.easing;
      const durationMs = options.durationMs ?? cameraFlight.durationMs;
      const nodeIndex = options.nodeIndex ?? 0;
      if (!paths.includes(path)) throw new Error(`Unsupported camera journey path '${path}'.`);
      if (!easings.includes(easing)) throw new Error(`Unsupported camera journey easing '${easing}'.`);
      if (!Number.isFinite(durationMs) || durationMs < 450 || durationMs > 2_000) throw new Error('Camera journey duration must be between 450 and 2000 ms.');
      if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodeIds.length) throw new Error('Camera journey nodeIndex is out of range.');
      cameraFlight = { path, easing, durationMs };
      reducedMotion = options.reducedMotion === true;
      const motionControl = document.querySelector('[data-control="reduced-motion"]');
      if (motionControl instanceof HTMLInputElement) motionControl.checked = reducedMotion;
      for (const control of document.querySelectorAll('[data-camera]')) {
        const key = control.dataset.camera;
        control.value = String(cameraFlight[key]);
      }
      focusNode(nodeIds[nodeIndex]);
      return cameraJourneySnapshot();
    },
    snapshot: cameraJourneySnapshot
  });
}

function cameraJourneySnapshot() {
  const diagnostics = graph.getDiagnostics();
  return {
    route: kind,
    selectedNodeId,
    pose: graph.getCameraPose(),
    flight: canvas.dataset.cameraFlight ?? null,
    reducedMotion,
    cameraFlight: { ...cameraFlight },
    status: status?.textContent ?? '',
    frameLoopMode: diagnostics.frameLoopMode,
    drawCalls: diagnostics.drawCalls
  };
}

function waitForAnimationFrames(count) {
  return new Promise((resolve) => {
    let remaining = count;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function dispatchNavigationGesture(shiftKey, deltaX, deltaY, pointerId) {
  const bounds = canvas.getBoundingClientRect();
  const startX = bounds.left + 2;
  const startY = bounds.top + 2;
  const event = (type, x, y, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: type === 'pointerdown' ? 0 : -1,
    buttons,
    clientX: x,
    clientY: y,
    pointerId,
    pointerType: 'mouse',
    isPrimary: true,
    shiftKey
  }));
  event('pointerdown', startX, startY, 1);
  event('pointermove', startX + deltaX, startY + deltaY, 1);
  event('pointerup', startX + deltaX, startY + deltaY, 0);
}

function updateMetrics() {
  if (!graph) return;
  const diagnostics = graph.getDiagnostics();
  telemetry.backend.textContent = diagnostics.backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  telemetry.backend.dataset.ready = 'true';
  telemetry.draws.textContent = `${diagnostics.drawCalls} draws`;
  if (inspectorFields.surface) inspectorFields.surface.textContent = kind === 'flow' ? 'pulse' : surface.profile;
  if (inspectorFields.transform) inspectorFields.transform.textContent = diagnostics.transformPath;
}

function updateInspector() {
  const flowWalkVisible = kind === 'flow' && (flowWalkState.running || flowWalkState.completed);
  if (inspectorFields.label) inspectorFields.label.textContent = flowWalkVisible
    ? flowWalkState.completed
      ? 'Answer reached'
      : flowWalkState.activeStep >= flowWalkLinkIds.length
        ? 'Answer arriving'
        : `Evidence hop ${flowWalkState.activeStep + 1} / ${flowWalkLinkIds.length}`
    : kind === 'flow'
      ? linkFlow.direction === 'target-to-source' ? 'Target → source' : 'Source → target'
      : selectedNodeId === undefined ? 'No selection' : nodeLabel(selectedNodeId);
  if (inspectorFields.summary) inspectorFields.summary.textContent = flowWalkVisible
    ? flowWalkState.completed
      ? 'The query reached grounded context and synthesis through one visible evidence path.'
      : `${nodeLabel(selectedNodeId)} is active; the bright edge carries the query to the next evidence node.`
    : selectedNodeId === undefined
      ? 'Select a node to inspect it and travel into its world.'
      : kind === 'flow'
        ? 'Play one query walk to follow retrieval, linked evidence, reranking, and answer synthesis.'
        : `${config.title}. GPU state and transforms remain shared across the batch.`;
  if (kind === 'expandable' || kind === 'dynamic') updateRouteReadout();
  updateMetrics();
}

function setInspectorOpen(open) {
  if (inspector) inspector.dataset.open = String(open);
}

function onShortcut(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target instanceof Element && event.target.matches('input, button, a')) return;
  if (event.key.toLowerCase() === 'r') performAction('reset');
  if (event.key.toLowerCase() === 'f') performAction('focus');
  if (event.key === 'Escape') setInspectorOpen(false);
}

function cancelPops(settle = false) {
  nodeMotion?.cancelAll(settle);
}

function cancelCameraTween() {
  cameraAnimator?.cancel();
}

function cleanup() {
  dynamicController?.terminate();
  dynamicController = undefined;
  cancelCameraTween();
  cancelFlowWalk({ clearGraph: false, restoreFlow: false });
  cancelAnimationFrame(overviewFrame);
  fpsTelemetry.dispose();
  statusController.dispose();
  cancelPops();
  cameraAnimator?.dispose();
  responsiveFramer?.dispose();
  nodeMotion?.dispose();
  for (const remove of ownedListeners.splice(0)) remove();
  delete window.__forcegraphCameraJourney;
  delete window.__forcegraphFlowJourney;
  graph?.dispose();
}

function listen(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  ownedListeners.push(() => target.removeEventListener(type, listener, options));
}

function setStatus(message, state, visible, timeoutMs = 2_400) {
  statusController.set(message, state, visible, timeoutMs);
}

function nodeRadius(nodeId) {
  if (nodeId === 'core') return kind === 'scale' ? 2.4 : kind === 'flow' ? 2.35 : 1.9;
  if (String(nodeId).startsWith('community-') && !String(nodeId).match(/-\d+$/)) return 1.85;
  return kind === 'scale' ? 1.2 : kind === 'flow' ? 1.95 : 1.65;
}

function initialReducedMotion() {
  const override = sessionStorage.getItem(motionPreferenceKey);
  if (override === 'animate') return false;
  if (override === 'reduce') return true;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function focusedNodeRadius(nodeId) {
  const theme = warmTheme ? warmStateTheme : coolStateTheme;
  return nodeRadius(nodeId) * (theme.selected.scale ?? 1) * (theme.focused.scale ?? 1);
}

function nodeLabel(nodeId) {
  const data = nodeRecords.get(nodeId)?.data;
  return data && typeof data === 'object' && typeof data.label === 'string' ? data.label : String(nodeId);
}

function materialControls() {
  return `<section class="material-controls" aria-label="Shared material uniforms">
    <p class="inspector-kicker">Material shading</p>${surfaceSlider('metalness', surface.metalness)}${surfaceSlider('roughness', surface.roughness)}${surfaceSlider('emissive', surface.emissive)}
    <p class="inspector-kicker">HAIO selection</p>${selectionSurfaceSlider('bubbleScale', surface.selectionEffect.bubbleScale, 1, 2.3, 0.01)}${selectionSurfaceSlider('intensity', surface.selectionEffect.intensity, 0, 1, 0.01)}${selectionSurfaceSlider('breathAmount', surface.selectionEffect.breathAmount, 0, 0.08, 0.001)}${selectionSurfaceSlider('breathSpeed', surface.selectionEffect.breathSpeed, 0, 5, 0.05)}
    <p class="inspector-summary">Emissive retains node color in the material. The Bloom example demonstrates a real post-processing pass.</p>
  </section>`;
}

function flowControls() {
  return `<section class="material-controls" aria-label="Directional flow uniforms">
    <p class="inspector-summary" data-inspector="summary">Play one query walk to follow retrieval, linked evidence, reranking, and answer synthesis.</p>
    <div class="flow-walk-readout" aria-label="Query walk progress">
      <div class="flow-walk-meta"><strong data-walk-label>Ready at top-left query</strong><output data-walk-progress>0 / ${flowWalkLinkIds.length}</output></div>
      <div class="flow-walk-track" aria-hidden="true"><span data-walk-bar></span></div>
    </div>
    <p class="inspector-kicker">Flow uniforms</p>${flowSlider('speed', linkFlow.speed, 0, 2, 0.05)}${flowSlider('frequency', linkFlow.frequency, 0.25, 6, 0.05)}${flowSlider('pulseWidth', linkFlow.pulseWidth, 0.02, 0.8, 0.01)}${reactionSlider('scale', linkFlow.nodeReaction.scale, 1.05, 1.65, 0.01)}${reactionSlider('intensity', linkFlow.nodeReaction.intensity, 0, 1, 0.01)}
  </section>`;
}

function cameraFlightControls() {
  return `<section class="camera-controls" aria-label="Camera tween options">
    <p class="inspector-summary" data-inspector="summary">Choose a path and easing curve, then click any node.</p>
    <label class="option-row"><span>Path</span><select data-camera="path">
      <option value="direct">Direct dolly</option>
      <option value="arc-left">Arc left</option>
      <option value="arc-right" selected>Arc right</option>
      <option value="arc-over">Arc over</option>
    </select></label>
    <label class="option-row"><span>Easing</span><select data-camera="easing">
      <option value="linear">Linear</option>
      <option value="smoothstep">Smoothstep</option>
      <option value="cubic-in-out" selected>Cubic in/out</option>
    </select></label>
    <label class="slider-row"><span>Duration</span><output data-camera-value="durationMs">${cameraFlight.durationMs} ms</output><input type="range" min="450" max="2000" step="50" value="${cameraFlight.durationMs}" data-camera="durationMs"></label>
  </section>`;
}

function cameraPathLabel(path) {
  return ({ direct: 'Direct dolly', 'arc-left': 'Arc left', 'arc-right': 'Arc right', 'arc-over': 'Arc over' })[path] ?? String(path);
}

function flowSlider(name, value, minimum, maximum, step) {
  const label = name === 'pulseWidth' ? 'pulse width' : name;
  return `<label class="slider-row"><span>${label}</span><output data-flow-value="${name}">${value.toFixed(2)}</output><input type="range" min="${minimum}" max="${maximum}" step="${step}" value="${value}" data-flow="${name}"></label>`;
}

function reactionSlider(name, value, minimum, maximum, step) {
  const label = name === 'scale' ? 'arrival bounce' : 'arrival glow';
  return `<label class="slider-row"><span>${label}</span><output data-reaction-value="${name}">${value.toFixed(2)}</output><input type="range" min="${minimum}" max="${maximum}" step="${step}" value="${value}" data-reaction="${name}"></label>`;
}

function surfaceSlider(name, value) {
  return `<label class="slider-row"><span>${name}</span><output data-value="${name}">${value.toFixed(2)}</output><input type="range" min="0" max="1" step="0.01" value="${value}" data-surface="${name}"></label>`;
}

function selectionSurfaceSlider(name, value, minimum, maximum, step) {
  const label = ({ bubbleScale: 'bubble scale', intensity: 'bubble intensity', breathAmount: 'breath amount', breathSpeed: 'breath speed' })[name];
  return `<label class="slider-row"><span>${label}</span><output data-selection-value="${name}">${selectionValueLabel(name, value)}</output><input type="range" min="${minimum}" max="${maximum}" step="${step}" value="${value}" data-selection-surface="${name}"></label>`;
}

function selectionValueLabel(name, value) {
  return name === 'breathAmount' ? value.toFixed(3) : value.toFixed(2);
}

function actionLabel(action) {
  return ({
    layout: layoutRunning ? 'Pause layout' : 'Run layout',
    overview: 'Overview',
    theme: 'Warm theme',
    expand: 'Expand selected',
    collapse: 'Collapse selected',
    release: 'Release selected',
    'pin-mode': pinReleaseAfterDrag ? 'Release after drag' : 'Keep pinned',
    dynamic: dynamicController?.running ? 'Pause additions' : 'Resume additions',
    add: 'Add now',
    remove: 'Remove selected',
    flow: flowRunning ? 'Pause flow' : 'Run flow',
    direction: 'Reverse flow',
    walk: flowWalkState.running ? 'Stop walk' : flowWalkState.completed ? 'Replay walk' : 'Play walk',
    effects: 'HAIO effects on'
  })[action];
}

function boundsCenter(bounds) {
  return { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z: (bounds.min.z + bounds.max.z) / 2 };
}
