import assert from 'node:assert/strict';
import test from 'node:test';
import { observeSearchScanGraphics } from '../../examples/showcase/examples/search-scan/search-scan-graphics.js';

test('graphics errors keep original callback behavior and report only safe categories', () => {
  for (const [type, expected] of [
    ['GPUValidationError', /WebGPU validation failed/],
    ['GPUOutOfMemoryError', /WebGPU could not allocate enough graphics memory/],
    ['GPUInternalError', /WebGPU reported an internal graphics error/],
    ['UnknownDriverType', /WebGPU reported a graphics error/]
  ]) {
    const calls = [], errors = [];
    const original = function (...args) { calls.push({ receiver: this, args }); return 17; };
    const renderer = { onError: original, onDeviceLost() {}, debug: { onShaderError: null } };
    const info = { api: 'WebGPU', type, message: 'token=private-value https://example.invalid/?secret=private-value', originalEvent: { shaderSource: 'private shader' } };
    const dispose = observeSearchScanGraphics({ renderer, onError: (error) => errors.push(error) });
    assert.equal(renderer.onError(info, 'extra argument'), 17);
    assert.deepEqual(calls, [{ receiver: renderer, args: [info, 'extra argument'] }]);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.equal(errors[0].name, 'SearchScanGraphicsError');
    assert.match(errors[0].message, expected);
    assert.doesNotMatch(errors[0].message, /private|secret|token|https|shaderSource/);
    assert.equal('cause' in errors[0], false, 'Do not attach raw backend objects.');
    renderer.onError(info);
    assert.equal(calls.length, 2, 'Later original callbacks continue to run.');
    assert.equal(errors.length, 1, 'Deliver one recovery notification per observer.');
    dispose();
    assert.equal(renderer.onError, original);
  }
});

test('device loss distinguishes WebGL context and WebGPU device, ignoring intentional destruction', () => {
  for (const [api, expected] of [
    ['WebGPU', /^The WebGPU graphics device was lost\.$/],
    ['WebGL', /^The WebGL2 graphics context was lost\.$/],
    ['unknown private driver', /^The renderer graphics device was lost\.$/]
  ]) {
    const errors = [], calls = [];
    const renderer = { onDeviceLost(info) { calls.push(info); return 'original device result'; }, debug: {} };
    const dispose = observeSearchScanGraphics({ renderer, onError: (error) => errors.push(error) });
    const destroyed = { api, reason: 'destroyed' };
    assert.equal(renderer.onDeviceLost(destroyed), 'original device result');
    assert.equal(errors.length, 0);
    const lost = { api, reason: 'unknown', message: '/private/account/driver.log', originalEvent: {} };
    assert.equal(renderer.onDeviceLost(lost), 'original device result');
    assert.deepEqual(calls, [destroyed, lost]);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, expected);
    assert.doesNotMatch(errors[0].message, /private|driver\.log/);
    dispose();
  }
});

test('WebGL shader observation forwards exact handles without reading or exposing shader source', () => {
  const errors = [], calls = [];
  const gl = new Proxy({}, { get() { throw new Error('The observer must not inspect shader or program logs.'); } });
  const program = {}, vertex = {}, fragment = {};
  const original = function (...args) { calls.push({ receiver: this, args }); return 'shader result'; };
  const debug = { onShaderError: original };
  const renderer = { debug };
  const dispose = observeSearchScanGraphics({ renderer, onError: (error) => errors.push(error) });
  assert.equal(debug.onShaderError(gl, program, vertex, fragment), 'shader result');
  assert.deepEqual(calls, [{ receiver: debug, args: [gl, program, vertex, fragment] }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'WebGL2 shader compilation or linking failed.');
  dispose();
  assert.equal(debug.onShaderError, original);
});

test('disposal restores descriptors and inherited callbacks, and preserves a later owner', () => {
  const errors = [], calls = [];
  const inherited = function (...args) { calls.push(args); };
  const renderer = Object.create({ onError: inherited });
  const device = () => {};
  Object.defineProperty(renderer, 'onDeviceLost', { value: device, writable: true, configurable: true, enumerable: false });
  renderer.debug = { onShaderError: null };
  const before = Object.getOwnPropertyDescriptor(renderer, 'onDeviceLost');
  const dispose = observeSearchScanGraphics({ renderer, onError: (error) => errors.push(error) });
  const retainedHook = renderer.onError;
  const laterOwner = () => {};
  renderer.debug.onShaderError = laterOwner;
  dispose();
  dispose();
  assert.equal(Object.hasOwn(renderer, 'onError'), false);
  assert.equal(renderer.onError, inherited);
  assert.deepEqual(Object.getOwnPropertyDescriptor(renderer, 'onDeviceLost'), before);
  assert.equal(renderer.debug.onShaderError, laterOwner);
  retainedHook.call(renderer, { api: 'WebGPU' });
  assert.equal(calls.length, 1, 'A retained disposed hook still forwards to its original callback.');
  assert.equal(errors.length, 0, 'A disposed observer never reports.');
});

test('finite original callback reentry preserves nested results and reports once across graphics hooks', () => {
  const errors = [];
  const counts = { error: 0, device: 0, shader: 0 };
  const renderer = {
    onError(info) {
      counts.error += 1;
      if (info.depth === 0) return renderer.onError({ ...info, depth: 1 }) + 1;
      renderer.onDeviceLost({ api: 'WebGPU', reason: 'unknown' });
      return 7;
    },
    onDeviceLost() { counts.device += 1; },
    debug: { onShaderError() { counts.shader += 1; } }
  };
  const dispose = observeSearchScanGraphics({ renderer, onError(error) {
    errors.push(error);
    renderer.debug.onShaderError({}, {}, {}, {});
  } });
  assert.equal(renderer.onError({ api: 'WebGPU', type: 'GPUValidationError', depth: 0 }), 8);
  assert.deepEqual(counts, { error: 2, device: 1, shader: 1 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /validation failed/);
  dispose();
});

test('original callback exceptions still escape after notification and observer exceptions cannot mask them', () => {
  const errors = [];
  const originalError = new Error('original callback exception');
  const renderer = { onError() { throw originalError; }, debug: {} };
  const dispose = observeSearchScanGraphics({ renderer, onError(error) { errors.push(error); throw new Error('observer callback exception'); } });
  assert.throws(() => renderer.onError({ api: 'WebGPU' }), (error) => error === originalError);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /WebGPU reported a graphics error/);
  dispose();

  const returning = { onError() { return 42; } };
  const stop = observeSearchScanGraphics({ renderer: returning, onError() { throw new Error('observer callback exception'); } });
  assert.equal(returning.onError({}), 42);
  stop();
});

test('failed installation restores earlier callbacks and invalid options acquire no hooks', () => {
  const originalError = () => {}, originalDevice = () => {};
  const debug = {};
  Object.defineProperty(debug, 'onShaderError', { value: null, writable: false, configurable: false });
  const renderer = { onError: originalError, onDeviceLost: originalDevice, debug };
  assert.throws(() => observeSearchScanGraphics({ renderer, onError() {} }), TypeError);
  assert.equal(renderer.onError, originalError);
  assert.equal(renderer.onDeviceLost, originalDevice);
  assert.equal(debug.onShaderError, null);
  assert.throws(() => observeSearchScanGraphics(), TypeError);
  assert.throws(() => observeSearchScanGraphics({ renderer, onError: false }), TypeError);
  assert.throws(() => observeSearchScanGraphics({ renderer: { debug: [] }, onError() {} }), TypeError);
});

test('malformed backend metadata does not prevent original callbacks or leak arbitrary values', () => {
  let calls = 0;
  const errors = [];
  const renderer = { onError() { calls += 1; } };
  const dispose = observeSearchScanGraphics({ renderer, onError: (error) => errors.push(error) });
  const info = new Proxy({}, { get() { throw new Error('private metadata getter'); } });
  renderer.onError(info);
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'The renderer reported a graphics error.');
  dispose();
});

test('revoked metadata proxies preserve original callbacks without poisoning later observation', () => {
  let calls = 0;
  const errors = [];
  const renderer = { onError() { calls += 1; return calls; } };
  const dispose = observeSearchScanGraphics({ renderer, onError: (error) => errors.push(error) });
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(renderer.onError(proxy), 1);
  assert.equal(renderer.onError({ api: 'WebGPU', type: 'GPUValidationError' }), 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'The renderer reported a graphics error.');
  dispose();
});

test('accessor-backed callbacks restore their original value and descriptor', () => {
  for (const mode of ['configurable', 'nonconfigurable', 'inherited']) {
    const original = () => 23;
    let callback = original;
    const target = {};
    Object.defineProperty(target, 'onError', {
      get() { return callback; },
      set(value) { callback = value; },
      configurable: mode !== 'nonconfigurable',
      enumerable: false
    });
    const renderer = mode === 'inherited' ? Object.create(target) : target;
    const descriptor = Object.getOwnPropertyDescriptor(renderer, 'onError');
    const errors = [];
    const dispose = observeSearchScanGraphics({ renderer, onError: (error) => errors.push(error) });
    assert.equal(renderer.onError({ api: 'WebGPU' }), 23);
    assert.equal(errors.length, 1);
    dispose();
    assert.equal(renderer.onError, original, mode);
    assert.equal(callback, original, mode);
    assert.deepEqual(Object.getOwnPropertyDescriptor(renderer, 'onError'), descriptor, mode);
  }
});
