/**
 * Keeps the first graph view useful across aspect ratios without taking over
 * once the viewer has begun navigating. The host supplies the actual framing
 * policy so examples can choose their own padding and animation.
 */
export function createResponsiveFramer({
  canvas,
  frame,
  isReady = () => true,
  isFocused = () => false,
  subscribeSettled,
  requestFrame = globalThis.requestAnimationFrame,
  cancelFrame = globalThis.cancelAnimationFrame
}) {
  let disposed = false;
  let pristine = true;
  let scheduled;
  let initialTimer;
  let observer;

  const settle = (animate = false) => {
    if (disposed || !isReady() || !pristine || isFocused()) return;
    frame({ reason: 'initial', animate });
  };

  const scheduleInitial = () => {
    if (initialTimer !== undefined) cancelFrame(initialTimer);
    let passes = 3;
    const tick = () => {
      if (disposed) return;
      if (passes-- > 0) initialTimer = requestFrame(tick);
      else { initialTimer = undefined; settle(false); }
    };
    initialTimer = requestFrame(tick);
  };

  const onResize = () => {
    if (disposed || !pristine || isFocused() || !isReady()) return;
    if (scheduled !== undefined) cancelFrame(scheduled);
    scheduled = requestFrame(() => {
      scheduled = undefined;
      if (!disposed && pristine && !isFocused() && isReady()) frame({ reason: 'resize', animate: false });
    });
  };

  const markUserInteraction = () => { pristine = false; };
  const reset = ({ schedule = true } = {}) => {
    pristine = true;
    if (scheduled !== undefined) cancelFrame(scheduled);
    if (initialTimer !== undefined) cancelFrame(initialTimer);
    scheduled = initialTimer = undefined;
    if (schedule) scheduleInitial();
  };
  if (typeof ResizeObserver === 'function' && canvas) {
    observer = new ResizeObserver(onResize);
    observer.observe(canvas);
  }
  scheduleInitial();
  const unsubscribeSettled = subscribeSettled?.(onResize);

  return Object.freeze({
    markUserInteraction,
    reset,
    dispose() {
      disposed = true;
      observer?.disconnect();
      unsubscribeSettled?.();
      if (scheduled !== undefined) cancelFrame(scheduled);
      if (initialTimer !== undefined) cancelFrame(initialTimer);
    }
  });
}
