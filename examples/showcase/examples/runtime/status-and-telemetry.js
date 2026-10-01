export function createStatusController(output) {
  let timer;
  return Object.freeze({
    set(message, state, visible, timeoutMs = 2_400) {
      if (!output) return;
      output.textContent = message;
      output.dataset.state = state;
      output.dataset.visible = String(visible);
      clearTimeout(timer);
      if (visible && state !== 'error' && timeoutMs > 0) {
        timer = setTimeout(() => { output.dataset.visible = 'false'; }, timeoutMs);
      }
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    }
  });
}

export function createFpsTelemetry(output) {
  let frame;
  let frameCount = 0;
  let previousFrame = performance.now();
  let smoothedFps = 0;
  const tick = (time) => {
    frameCount += 1;
    const frameFps = 1000 / Math.max(1, time - previousFrame);
    smoothedFps = smoothedFps === 0 ? frameFps : smoothedFps * 0.8 + frameFps * 0.2;
    previousFrame = time;
    if (frameCount % 4 === 0) {
      if (output) output.textContent = `${Math.round(smoothedFps)} FPS`;
      frameCount = 0;
    }
    frame = requestAnimationFrame(tick);
  };
  return Object.freeze({
    start() {
      if (frame === undefined) frame = requestAnimationFrame(tick);
    },
    dispose() {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
  });
}
