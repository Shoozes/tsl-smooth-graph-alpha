import assert from 'node:assert/strict';
import test from 'node:test';
import { createResponsiveFramer } from '../../examples/showcase/examples/runtime/responsive-framing.js';

function harness() {
  const frames = new Map();
  let nextFrame = 1;
  const observers = [];
  const priorResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const requestFrame = (callback) => { const id = nextFrame++; frames.set(id, callback); return id; };
  const cancelFrame = (id) => frames.delete(id);
  const flush = (limit = 20) => {
    let count = 0;
    while (frames.size && count++ < limit) {
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(count);
    }
  };
  return { frames, observers, requestFrame, cancelFrame, flush, restore() { globalThis.ResizeObserver = priorResizeObserver; } };
}

test('responsive framing frames a ready host after its initial commit frames', () => {
  const h = harness();
  let ready = false;
  const reasons = [];
  const framer = createResponsiveFramer({ canvas: {}, isReady: () => ready, frame: (event) => reasons.push(event.reason), requestFrame: h.requestFrame, cancelFrame: h.cancelFrame });
  h.flush();
  assert.deepEqual(reasons, []);
  ready = true;
  framer.reset();
  h.flush();
  assert.deepEqual(reasons, ['initial']);
  framer.dispose();
  h.restore();
});

test('responsive framing never steals the camera after manual input and disposes observers', () => {
  const h = harness();
  const reasons = [];
  const framer = createResponsiveFramer({ canvas: {}, frame: (event) => reasons.push(event.reason), requestFrame: h.requestFrame, cancelFrame: h.cancelFrame });
  h.flush();
  framer.markUserInteraction();
  h.observers[0].callback();
  h.flush();
  assert.deepEqual(reasons, ['initial']);
  framer.dispose();
  assert.equal(h.observers[0].disconnected, true);
  h.observers[0].callback();
  h.flush();
  assert.deepEqual(reasons, ['initial']);
  h.restore();
});

test('layout settlement reframes pristine views and unscheduled reset cancels competing frames', () => {
  const h=harness();
  let notifySettled,unsubscribed=false;
  const reasons=[];
  const framer=createResponsiveFramer({canvas:{},frame:event=>reasons.push(event.reason),requestFrame:h.requestFrame,cancelFrame:h.cancelFrame,subscribeSettled:listener=>{notifySettled=listener;return()=>{unsubscribed=true;};}});
  try {
    framer.reset({schedule:false});
    h.flush();
    assert.deepEqual(reasons,[]);
    notifySettled();h.flush();
    assert.deepEqual(reasons,['resize']);
    framer.markUserInteraction();notifySettled();h.flush();
    assert.equal(reasons.length,1);
    framer.dispose();
    assert.equal(unsubscribed,true);
    notifySettled();h.flush();
    assert.equal(reasons.length,1);
  } finally {framer.dispose();h.restore();}
});
