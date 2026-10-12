/**
 * Observe the first graphics failure through Three's renderer callbacks.
 * Existing callbacks keep their receiver, arguments, return values and thrown
 * exceptions. The observer reports fixed, useful categories rather than raw
 * driver messages, shader source, URLs or original events.
 *
 * This does not certify GPU pipeline compilation: Three can log and consume
 * some pipeline errors without invoking any of these callbacks.
 *
 * @param {{renderer: object, onError: (error: Error) => void}} options
 * @returns {() => void} Idempotent disposer that restores only still-owned hooks.
 */
export function observeSearchScanGraphics({ renderer, onError } = {}) {
  if (!isObject(renderer)) throw new TypeError('Graphics observation requires a renderer object.');
  if (typeof onError !== 'function') throw new TypeError('Graphics observation requires an onError callback.');
  const debug = renderer.debug;
  if (debug !== undefined && debug !== null && !isObject(debug)) throw new TypeError('Renderer debug settings must be an object.');
  const releases = [];
  let disposed = false;
  let reported = false;
  let pendingError;
  let depth = 0;

  function flush() {
    if (disposed || reported || !pendingError) return;
    const error = pendingError;
    pendingError = undefined;
    reported = true;
    try { onError(error); } catch {
      // An observer must not replace the renderer callback's result or error.
    }
  }

  function install(target, name, describe) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const original = target[name];
    const usesSetter = descriptor && !('value' in descriptor) && !descriptor.configurable;
    function hook(...args) {
      const invokeOriginal = () => typeof original === 'function' ? Reflect.apply(original, this, args) : undefined;
      if (disposed) return invokeOriginal();
      depth += 1;
      try {
        if (!reported && !pendingError) pendingError = describe(args);
        return invokeOriginal();
      }
      finally {
        depth -= 1;
        if (depth === 0) flush();
      }
    }
    releases.push(() => {
      if (target[name] !== hook) return;
      if (usesSetter) target[name] = original;
      else if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete target[name];
    });
    // Avoid changing accessor backing state when a temporary own slot is possible.
    if (usesSetter) target[name] = hook;
    else Object.defineProperty(target, name, {
      value: hook,
      writable: descriptor && 'writable' in descriptor ? descriptor.writable : true,
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? true
    });
    if (target[name] !== hook) throw new TypeError(`Renderer callback ${name} could not be observed.`);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    pendingError = undefined;
    for (const release of releases.splice(0).reverse()) {
      try { release(); } catch {
        // Continue restoring independent hooks if another owner changed one.
      }
    }
  }

  try {
    install(renderer, 'onError', ([info]) => {
      const api = apiName(readField(info, 'api'));
      const type = readField(info, 'type');
      if (type === 'GPUValidationError') return graphicsError(`${api} validation failed while rendering the search graph.`);
      if (type === 'GPUOutOfMemoryError') return graphicsError(`${api} could not allocate enough graphics memory for the search graph.`);
      if (type === 'GPUInternalError') return graphicsError(`${api} reported an internal graphics error.`);
      return graphicsError(`${api} reported a graphics error.`);
    });
    install(renderer, 'onDeviceLost', ([info]) => {
      // An intentional device destruction is normal during renderer teardown.
      if (readField(info, 'reason') === 'destroyed') return undefined;
      const api = apiName(readField(info, 'api'));
      if (api === 'WebGL2') return graphicsError('The WebGL2 graphics context was lost.');
      return graphicsError(api === 'WebGPU' ? 'The WebGPU graphics device was lost.' : 'The renderer graphics device was lost.');
    });
    if (debug) install(debug, 'onShaderError', () => graphicsError('WebGL2 shader compilation or linking failed.'));
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

function graphicsError(message) {
  const error = new Error(message);
  error.name = 'SearchScanGraphicsError';
  return error;
}

function apiName(value) {
  if (value === 'WebGPU') return 'WebGPU';
  if (value === 'WebGL' || value === 'WebGL2') return 'WebGL2';
  return 'The renderer';
}

function readField(value, key) {
  try { return isObject(value) ? value[key] : undefined; } catch { return undefined; }
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
