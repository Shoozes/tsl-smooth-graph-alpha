import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { NodeFlags } from '../../dist/index.js';
import { buildSearchScanFixture } from '../../examples/showcase/examples/search-scan/search-scan-model.js';
import { createSearchScanPrefab } from '../../examples/showcase/examples/search-scan/search-scan-prefab.js';
import { createSearchScanCanvasHost } from '../../examples/showcase/examples/search-scan/search-scan-canvas.js';
import { observeSearchScanGraphics } from '../../examples/showcase/examples/search-scan/search-scan-graphics.js';

const filename = new URL('../../examples/showcase/examples/search-scan/search-scan.js', import.meta.url);
const source = await readFile(filename, 'utf8');
assert.ok(source.includes("import('./search-scan-canvas.js')") && source.includes('void start();'));
// Inject browser dependencies and await the real startup. All application state,
// event handlers, frame scheduling, prefab math and Canvas rendering stay real.
const application = source.replace(/^import .+ from .+;\r?$/gm, '')
  .replace("import('./search-scan-canvas.js')", 'loadCanvasHost()')
  .replace('void start();', 'const startup = start();');

test('visible sparse frames keep replay duration in wall-clock milliseconds', async (t) => {
  const h = await harness(t);
  h.frame(1_000);
  h.frame(2_500);
  assert.equal(h.inspect().timeMs, 1_500);
  h.frame(4_100);
  assert.equal(h.inspect().timeMs, 3_100);
  h.frame(1_000 + h.inspect().durationMs);
  assert.equal(h.inspect().timeMs, h.inspect().durationMs);
  assert.equal(h.inspect().playing, false);
  assert.equal(h.inspect().sample.phase, 'complete');
  assert.match(h.ui.status.textContent, /^Replay complete/);
  h.frame(30_000); // Flush the final requested UI redraw.
  assert.equal(h.frames.size, 0);
});

test('pause, seek, speed and hidden-page intervals use fresh playback baselines', async (t) => {
  const h = await harness(t);
  h.frame(1_000);
  h.frame(1_500);
  h.ui.play.click();
  h.frame(2_500);
  assert.equal(h.inspect().timeMs, 500);
  assert.match(h.ui.status.textContent, /^Paused/);
  assert.equal(h.frames.size, 0);
  h.ui.play.click();
  assert.match(h.ui.status.textContent, /^Playing/);
  h.frame(9_000);
  h.frame(9_500);
  assert.equal(h.inspect().timeMs, 1_000);
  h.document.hidden = true;
  h.document.emit('visibilitychange');
  assert.equal(h.frames.size, 0);
  h.document.hidden = false;
  h.document.emit('visibilitychange');
  h.frame(50_000);
  assert.equal(h.inspect().timeMs, 1_000, 'Hidden time is excluded.');
  h.frame(50_500);
  assert.equal(h.inspect().timeMs, 1_500);
  h.ui.time.value = '2000';
  h.ui.time.emit('input');
  h.frame(60_000);
  assert.equal(h.inspect().timeMs, 2_000);
  assert.equal(h.inspect().playing, false);
  h.ui.play.click();
  h.frame(61_000);
  h.frame(62_000);
  assert.equal(h.inspect().timeMs, 3_000);
  h.ui.speed.value = '2';
  h.ui.speed.emit('change');
  h.frame(63_000);
  h.frame(64_000);
  assert.equal(h.inspect().timeMs, 5_000);
});

test('system reduced motion is the default and Play explicitly enables animation for this page', async (t) => {
  const h = await harness(t, { systemReduced: true });
  h.frame(0);
  assert.equal(h.inspect().reducedMotion, true);
  assert.equal(h.inspect().playing, false);
  assert.equal(h.inspect().timeMs, h.inspect().durationMs);
  assert.equal(h.frames.size, 0);
  assert.equal(h.ui.play.disabled, false);
  assert.equal(h.ui.play.textContent, 'Play animation');
  assert.equal(h.ui.reduced.disabled, false);
  h.ui.play.click();
  assert.equal(h.inspect().reducedMotion, false);
  assert.equal(h.inspect().playing, true);
  assert.equal(h.inspect().timeMs, 0);
  assert.match(h.ui.status.textContent, /^Playing/);
  h.frame(1_000);
  h.frame(2_000);
  assert.equal(h.inspect().timeMs, 1_000);
  h.media.matches = false;
  h.media.emit('change');
  h.media.matches = true;
  h.media.emit('change');
  assert.equal(h.inspect().reducedMotion, false, 'The explicit page choice survives system preference changes.');
  assert.equal(h.inspect().playing, true);
});

test('URL reduction can be changed explicitly and enabling reduction pauses immediately', async (t) => {
  const h = await harness(t, { search: '?backend=canvas2d&motion=reduced' });
  h.frame(0);
  assert.equal(h.inspect().reducedMotion, true);
  h.ui.reduced.checked = false;
  h.ui.reduced.emit('change');
  assert.equal(h.inspect().reducedMotion, false);
  assert.equal(h.inspect().playing, false, 'Clearing reduced motion does not autoplay.');
  h.ui.play.click();
  h.frame(1_000);
  h.frame(1_500);
  assert.equal(h.inspect().timeMs, 500);
  h.ui.reduced.checked = true;
  h.ui.reduced.emit('change');
  assert.equal(h.inspect().playing, false, 'The input handler pauses before another frame runs.');
  assert.equal(h.inspect().reducedMotion, true);
  h.frame(10_000);
  assert.equal(h.inspect().timeMs, h.inspect().durationMs);
  assert.equal(h.frames.size, 0);
  h.canvas.emit('keydown', { key: ' ' });
  assert.equal(h.inspect().reducedMotion, false, 'Space uses the same explicit Play action.');
  assert.equal(h.inspect().playing, true);
  assert.equal(h.inspect().timeMs, 0);
});

test('graphics recovery preserves explicit page motion choices on the new Canvas page', async (t) => {
  const first = source.indexOf('function fail(error) {');
  const last = source.indexOf('function cleanup() {', first);
  assert.ok(first >= 0 && last > first);
  // Exercise the actual error-to-navigation handler without claiming GPU support.
  // The resulting URL then boots the full application with the real Canvas host.
  const failureHandler = source.slice(first, last);
  for (const reduced of [false, true]) {
    let replacement;
    let cleanups = 0;
    const context = {
      URL, disposed: false, gpuRequested: true, localReducedMotion: reduced,
      prefab: {}, currentMode: 'reference', timeMs: 1_300, playing: !reduced,
      location: { href: 'https://example.invalid/search-scan/index.html?backend=webgl2&motion=reduced', replace(value) { replacement = value; } },
      document: { body: { dataset: {} } }, ui: { status: { dataset: {} } }, canvas: { dataset: {} },
      console: { error() {} }, cleanup() { cleanups += 1; }
    };
    vm.runInNewContext(`${failureHandler}\nfail(new Error('Injected graphics failure'));`, context);
    assert.equal(cleanups, 1);
    const url = new URL(replacement);
    assert.equal(url.searchParams.get('backend'), 'canvas2d');
    assert.equal(url.searchParams.get('motion'), reduced ? 'reduced' : 'full');
    const h = await harness(t, { systemReduced: true, search: url.search });
    h.frame(0);
    assert.equal(h.inspect().reducedMotion, reduced);
    assert.equal(h.inspect().playing, !reduced);
    assert.equal(h.inspect().timeMs, reduced ? h.inspect().durationMs : 1_300);
    assert.equal(h.ui.reduced.disabled, false);
  }
});

test('a never-settling graphics adapter reaches one bounded Canvas recovery', async (t) => {
  const h = await harness(t, { search: '', stalledAdapter: true, waitForReady: false, allowFailure: true });
  assert.equal(h.timers.size, 1);
  assert.equal(h.window.__searchScan, undefined);
  h.advanceTimers(9_999);
  assert.equal(h.location.replacement, undefined);
  h.advanceTimers(1);
  const replacement = h.location.replacement;
  assert.equal(new URL(replacement).searchParams.get('backend'), 'canvas2d');
  assert.equal(new URL(replacement).searchParams.get('fallback'), 'graphics');
  assert.equal(h.canvas.dataset.disposed, 'true');
  assert.equal(h.timers.size, 0, 'Failure cleanup releases the initialization deadline.');
  assert.equal(h.errors.length, 1);
  h.advanceTimers(20_000);
  assert.equal(h.location.replacement, replacement);
  assert.equal(h.errors.length, 1, 'The stalled startup reports once.');
});

async function harness(t, { systemReduced = false, search = '?backend=canvas2d', stalledAdapter = false, waitForReady = true, allowFailure = false } = {}) {
  const document = new EventTargetStub();
  document.hidden = false;
  document.createElement = () => new ElementStub(document);
  document.body = new ElementStub(document);
  const selectors = {
    canvas: '#scan-canvas', layer: '.scan-label-layer', play: '[data-action="play"]',
    restart: '[data-action="restart"]', overview: '[data-action="overview"]', reset: '[data-action="reset"]',
    time: '#scan-time', clock: '[data-time]', speed: '[data-speed]', follow: '[data-follow]', reduced: '[data-reduced]',
    status: '[data-status]', counts: '[data-counts]', mode: '[data-mode]', query: '#scan-query', search: '.scan-search',
    searchStatus: '[data-search-status]', phase: '[data-phase]', group: '[data-group]', step: '[data-step]'
  };
  const ui = Object.fromEntries(Object.keys(selectors).map(key => [key, new ElementStub(document)]));
  const elements = new Map(Object.entries(selectors).map(([key, selector]) => [selector, ui[key]]));
  document.querySelector = selector => elements.get(selector);
  document.querySelectorAll = () => ['play', 'restart', 'overview', 'reset', 'time', 'speed', 'follow', 'reduced', 'query'].map(key => ui[key]);
  const context2d = new Proxy({ createRadialGradient() { return { addColorStop() {} }; } }, {
    get(target, name) { return name in target ? target[name] : () => {}; }
  });
  ui.canvas.getContext = kind => kind === '2d' ? context2d : null;
  ui.speed.value = '1';
  const media = new EventTargetStub();
  media.matches = systemReduced;
  const window = new EventTargetStub();
  const frames = new Map();
  let nextFrame = 1;
  const timers = new Map();
  let nextTimer = 1;
  let clock = 0;
  const errors = [];
  const location = { search, href: `https://example.invalid/search-scan/index.html${search}`, replace(url) {
    this.replacement = url;
    if (!allowFailure) errors.push(new Error(`Unexpected recovery: ${url}`));
  } };
  const context = {
    THREE, TSL, NodeFlags, OrbitControls: OrbitControlsStub,
    buildSearchScanFixture, createSearchScanPrefab, observeSearchScanGraphics,
    createForceGraph3D() { throw new Error('The Canvas playback test unexpectedly requested a GPU graph.'); },
    createThreePlatform() { throw new Error('The Canvas playback test unexpectedly requested a GPU platform.'); },
    loadCanvasHost: async () => ({ createSearchScanCanvasHost }),
    document, window, URL, URLSearchParams, location,
    matchMedia: () => media, navigator: stalledAdapter ? { gpu: { requestAdapter: () => new Promise(() => {}) } } : {}, devicePixelRatio: 1, queueMicrotask,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, deadline: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { error(...args) { errors.push(args); }, warn(...args) { errors.push(args); } }
  };
  const lifecycle = await vm.runInNewContext(`(async () => { ${application}\nreturn { startup, cleanup }; })()`, context, { filename: filename.pathname });
  if (waitForReady) await lifecycle.startup;
  assert.deepEqual(errors, [], 'The real application starts without error.');
  if (waitForReady) {
    assert.ok(window.__searchScan, 'The application exposes its ready inspection API.');
    assert.equal(timers.size, 0, 'Successful startup releases its initialization deadline.');
  }
  t.after(() => {
    lifecycle.cleanup();
    if (!allowFailure) assert.deepEqual(errors, [], 'Playback and teardown do not fail.');
    assert.equal(frames.size, 0, 'Teardown cancels scheduled frames.');
    assert.equal(timers.size, 0, 'Teardown cancels pending initialization deadlines.');
  });
  return {
    ui, canvas: ui.canvas, document, window, media, frames, timers, location, errors,
    inspect: () => window.__searchScan.inspect(),
    frame(timestamp) {
      const pending = [...frames];
      for (const [id] of pending) frames.delete(id);
      for (const [, callback] of pending) callback(timestamp);
      assert.deepEqual(errors, [], 'The frame completes without error.');
    },
    advanceTimers(milliseconds) {
      clock += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.deadline <= clock) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
}

class EventTargetStub {
  listeners = new Map();
  addEventListener(type, callback) { const list = this.listeners.get(type) ?? []; list.push(callback); this.listeners.set(type, list); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== callback)); }
  emit(type, fields = {}) { for (const callback of [...(this.listeners.get(type) ?? [])]) callback({ type, preventDefault() {}, ...fields }); }
}

class ElementStub extends EventTargetStub {
  children = []; dataset = {}; attributes = {}; style = { setProperty() {} };
  textContent = ''; value = ''; checked = false; disabled = false; hidden = false; clientWidth = 900; clientHeight = 600;
  constructor(document) { super(); this.ownerDocument = document; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  click() { if (!this.disabled) this.emit('click'); }
}

class OrbitControlsStub extends EventTargetStub {
  target = new THREE.Vector3();
  update() {}
  dispose() {}
}
