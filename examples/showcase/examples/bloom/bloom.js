import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createForceGraph3D, createThreePlatform } from '../../../dist/index.js';
import { planPerspectiveCameraFrame } from '../../../dist/camera/index.js';
import {
  coolStateTheme,
  datasets,
  metallicNodeSurface,
  nodeColor
} from '../../showcase-model.js';
import { showcaseExamples } from '../manifest.js';

const root = document.querySelector('#example-root');
if (!(root instanceof HTMLElement)) throw new Error('Bloom example root is unavailable.');
const showcaseBase = new URL('../../', import.meta.url).pathname;
const examplePath = (slug) => `${showcaseBase}examples/${slug}/index.html`;

let bloomEnabled = true;
let effectsEnabled = true;
let bloomSettings = { strength: 0.92, radius: 0.42, threshold: 0.28 };
let frameRequest;
let graph;
let renderer;
let scene;
let camera;
let renderPipeline;
let bloomPass;
let controls;
let resizeObserver;
let bloomCameraPristine = true;
let bloomSettleFrame;
let previousTime = performance.now();
let disposed = false;
let frameCount = 0;
let fpsStartedAt = performance.now();
const markBloomManual = () => { bloomCameraPristine = false; };

document.body.dataset.uiTheme = 'vector-relay';
root.innerHTML = `
  <div class="observatory">
    <aside class="example-rail" aria-label="Showcase examples">
      <a class="rail-home" href="${showcaseBase}index.html" aria-label="ForceGraph TSL showcase"><span>FG</span><span>TSL</span></a>
      <p class="rail-heading">Examples</p>
      <nav class="rail-links">${showcaseExamples.map(({ slug, index, label }) => `<a href="${examplePath(slug)}" ${slug === 'bloom' ? 'aria-current="page"' : ''}><span class="rail-index">${index}</span><span>${label}</span></a>`).join('')}</nav>
    </aside>
    <header class="telemetry" aria-label="Renderer status">
      <output class="telemetry-chip" data-metric="backend">Starting</output>
      <output class="telemetry-chip" data-metric="fps">-- FPS</output>
      <output class="telemetry-chip telemetry-detail" data-metric="draws">2 graph draws + bloom</output>
    </header>
    <section class="graph-stage" aria-label="Bloom post-processing graph">
      <canvas id="graph" tabindex="0" aria-label="Interactive force graph with a host-owned bloom render pipeline."></canvas>
      <output id="runtime-status" class="stage-status" data-state="loading" aria-live="polite">Starting render pipeline</output>
    </section>
    <aside class="node-inspector" data-open="true" aria-label="Post-processing inspector">
      <header class="inspector-header"><div><p class="inspector-kicker">Render pipeline</p><h1>Bloom post shader</h1></div></header>
      <section class="material-controls" aria-label="Bloom uniforms">
        <p class="inspector-summary">A real Three RenderPipeline pass runs after the two batched graph draws. Material emissive and bloom are separate controls.</p>
        ${bloomSlider('strength', 0, 2, 0.01)}
        ${bloomSlider('radius', 0, 1, 0.01)}
        ${bloomSlider('threshold', 0, 1, 0.01)}
      </section>
      <dl class="inspector-facts">
        <div><dt>Surface</dt><dd>metallic + emissive</dd></div>
        <div><dt>Post</dt><dd data-post-state>bloom on</dd></div>
        <div><dt>Host</dt><dd>embedded</dd></div>
      </dl>
    </aside>
    <footer class="interaction-bar" aria-label="Graph controls">
      <span class="gesture-hint"><strong>Drag</strong> Rotate</span>
      <span class="gesture-hint"><strong>Wheel</strong> Zoom</span>
      <span class="gesture-hint"><strong>Shift drag</strong> Pan</span>
      <button type="button" data-action="bloom" data-active="true" aria-pressed="true">Bloom on</button>
      <button type="button" data-action="effects" data-active="true" aria-pressed="true">HAIO effects on</button>
      <button type="button" data-action="overview">Full overview</button>
    </footer>
  </div>`;

const canvas = document.querySelector('#graph');
const status = document.querySelector('#runtime-status');
const telemetry = Object.fromEntries([...document.querySelectorAll('[data-metric]')].map((element) => [element.dataset.metric, element]));
window.__forcegraphProof = { schema: 'forcegraph_example_browser_fixture_v1', status: 'running', done: false };
void start();

async function start() {
  try {
    if (!(canvas instanceof HTMLCanvasElement) || !(status instanceof HTMLOutputElement)) throw new Error('Bloom surface is unavailable.');
    const forceWebGL = new URLSearchParams(location.search).get('backend') === 'webgl2';
    renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false, forceWebGL });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x02040c, 1);
    await renderer.init();
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100_000);
    camera.position.set(0, 8, 108);
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 12;
    controls.maxDistance = 360;
    graph = await createForceGraph3D({
      platform: createThreePlatform({ THREE, TSL: await import('three/tsl') }),
      host: { mode: 'embedded', renderer, scene, camera, canvas, controls },
      renderer: {
        backend: forceWebGL ? 'webgl2' : 'auto',
        frameLoop: 'external',
        linkWidthUnit: 'pixel',
        nodeSurface: {
          ...metallicNodeSurface,
          emissive: 0.24,
          selectionEffect: { ...metallicNodeSurface.selectionEffect }
        }
      },
      layout: { seed: 184, alphaDecay: 0.055, velocityDecay: 0.33, linkDistance: 16, linkStrength: 0.28, chargeStrength: -28, centerStrength: 0.05 },
      stateTheme: coolStateTheme,
      nodes: { radius: (node) => node.id === 'core' ? 2.1 : 1.65, color: nodeColor },
      links: { width: 0.8, color: (link) => typeof link.data?.color === 'number' ? link.data.color : 0x365378, opacity: 0.34 },
      interaction: { hover: true, selection: 'single', dragNodes: { enabled: true, releaseBehavior: 'keep-pinned' } }
    });
    graph.setData(datasets.observatory());
    graph.setSelection(['core']);
    graph.on('node-click', ({ nodeId }) => graph.setSelection([nodeId]));

    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode('output');
    bloomPass = bloom(sceneColor, bloomSettings.strength, bloomSettings.radius, bloomSettings.threshold);
    renderPipeline = new THREE.RenderPipeline(renderer);
    renderPipeline.outputNode = sceneColor.add(bloomPass);

    bindControls();
    resize();
    fitCameraToGraph();
    controls.addEventListener('start', markBloomManual);
    graph.on('layout-settled', () => {
      if (bloomSettleFrame !== undefined) cancelAnimationFrame(bloomSettleFrame);
      bloomSettleFrame = requestAnimationFrame(() => {
        bloomSettleFrame = undefined;
        if (!disposed && bloomCameraPristine) fitCameraToGraph();
      });
    });
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    telemetry.backend.textContent = forceWebGL ? 'WebGL2 + TSL' : 'WebGPU + TSL';
    telemetry.backend.dataset.ready = 'true';
    status.textContent = 'Bloom is a host-owned post pass; emissive remains a node material control.';
    status.dataset.state = 'ready';
    status.dataset.visible = 'true';
    window.__forcegraphExampleExercise = exerciseExample;
    window.__forcegraphCleanup = cleanup;
    frameRequest = requestAnimationFrame(frame);
    requestAnimationFrame(() => {
      const diagnostics = graph.getDiagnostics();
      const assertions = {
        embeddedHost: diagnostics.hostMode === 'embedded',
        graphLoaded: diagnostics.nodeCount > 0 && diagnostics.linkCount > 0,
        twoGraphDraws: diagnostics.drawCalls === 2,
        postPipelineReady: renderPipeline !== undefined && bloomPass !== undefined
      };
      window.__forcegraphProof = {
        schema: 'forcegraph_example_browser_fixture_v1',
        status: Object.values(assertions).every(Boolean) ? 'passed' : 'failed',
        done: true,
        example: 'bloom',
        diagnostics,
        assertions
      };
    });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.dataset.state = 'error';
    status.dataset.visible = 'true';
    window.__forcegraphProof = { schema: 'forcegraph_example_browser_fixture_v1', status: 'failed', done: true, example: 'bloom', error: String(error) };
  }
}

function bindControls() {
  document.querySelector('[data-action="overview"]')?.addEventListener('click', () => {
    bloomCameraPristine = true;
    fitCameraToGraph();
  });
  document.querySelector('[data-action="bloom"]')?.addEventListener('click', toggleBloom);
  document.querySelector('[data-action="effects"]')?.addEventListener('click', toggleEffects);
  for (const input of document.querySelectorAll('[data-bloom]')) input.addEventListener('input', () => {
    const name = input.dataset.bloom;
    bloomSettings = { ...bloomSettings, [name]: Number(input.value) };
    bloomPass[name].value = bloomSettings[name];
    const output = document.querySelector(`[data-bloom-value="${name}"]`);
    if (output) output.textContent = bloomSettings[name].toFixed(2);
  });
  window.addEventListener('pagehide', cleanup, { once: true });
}

function toggleBloom() {
  bloomEnabled = !bloomEnabled;
  const button = document.querySelector('[data-action="bloom"]');
  if (button) {
    button.textContent = bloomEnabled ? 'Bloom on' : 'Bloom off';
    button.dataset.active = String(bloomEnabled);
    button.setAttribute('aria-pressed', String(bloomEnabled));
  }
  const state = document.querySelector('[data-post-state]');
  if (state) state.textContent = bloomEnabled ? 'bloom on' : 'bloom off';
}

function toggleEffects() {
  effectsEnabled = !effectsEnabled;
  graph.setNodeSurface({ selectionEffect: { enabled: effectsEnabled } });
  const button = document.querySelector('[data-action="effects"]');
  if (button) {
    button.textContent = effectsEnabled ? 'HAIO effects on' : 'HAIO effects off';
    button.dataset.active = String(effectsEnabled);
    button.setAttribute('aria-pressed', String(effectsEnabled));
  }
}

function resize() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  renderer.setSize(width, height, false);
  const camera = controls.object;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (bloomCameraPristine) fitCameraToGraph();
}

function fitCameraToGraph() {
  if (!graph || !camera || !controls) return;
  const bounds = graph.getGraphBounds();
  if (!bounds) return;
  const center = { x: (bounds.min.x + bounds.max.x) * 0.5, y: (bounds.min.y + bounds.max.y) * 0.5, z: (bounds.min.z + bounds.max.z) * 0.5 };
  const direction = camera.position.clone().sub(controls.target).normalize();
  const pose = planPerspectiveCameraFrame(bounds, { aspect: camera.aspect, verticalFovDegrees: camera.fov, direction: { x: direction.x, y: direction.y, z: direction.z }, padding: 1.25, minimumDistance: 28 });
  controls.target.set(pose.target.x, pose.target.y, pose.target.z);
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  camera.lookAt(new THREE.Vector3(center.x, center.y, center.z));
}

function frame(time) {
  if (disposed) return;
  const deltaSeconds = Math.min(0.05, Math.max(0, (time - previousTime) / 1_000));
  previousTime = time;
  controls.update();
  graph.update(deltaSeconds);
  graph.render();
  if (bloomEnabled) renderPipeline.render(); else renderer.render(scene, camera);
  frameCount += 1;
  if (time - fpsStartedAt >= 500) {
    telemetry.fps.textContent = `${Math.round(frameCount * 1_000 / (time - fpsStartedAt))} FPS`;
    frameCount = 0;
    fpsStartedAt = time;
  }
  frameRequest = requestAnimationFrame(frame);
}

async function exerciseExample() {
  const initialStrength = bloomPass.strength.value;
  toggleBloom();
  const disabled = bloomEnabled === false;
  toggleBloom();
  toggleEffects();
  const effectsDisabled = effectsEnabled === false;
  toggleEffects();
  bloomPass.strength.value = 1.08;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const diagnostics = graph.getDiagnostics();
  return {
    passed: disabled && bloomEnabled && effectsDisabled && effectsEnabled && bloomPass.strength.value !== initialStrength && diagnostics.drawCalls === 2,
    bloomToggleExercised: disabled && bloomEnabled,
    effectsToggleExercised: effectsDisabled && effectsEnabled,
    postUniformExercised: bloomPass.strength.value !== initialStrength,
    graphDrawCalls: diagnostics.drawCalls
  };
}

function cleanup() {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(frameRequest);
  if (bloomSettleFrame !== undefined) cancelAnimationFrame(bloomSettleFrame);
  resizeObserver?.disconnect();
  controls?.removeEventListener('start', markBloomManual);
  controls?.dispose();
  graph?.dispose();
  bloomPass?.dispose();
  renderPipeline?.dispose();
  renderer?.dispose();
  delete window.__forcegraphExampleExercise;
}

function bloomSlider(name, minimum, maximum, step) {
  return `<label class="slider-row"><span>${name}</span><output data-bloom-value="${name}">${bloomSettings[name].toFixed(2)}</output><input type="range" min="${minimum}" max="${maximum}" step="${step}" value="${bloomSettings[name]}" data-bloom="${name}"></label>`;
}
