import { orbitCameraPose, panCameraPose, zoomCameraPose } from '../showcase/examples/runtime/camera-controls.js';

export function bindCorpusNavigation({ canvas, graph, animator, listen, onManual, onOverview }) {
  const pointers = new Map();
  let previous;
  const gesture = () => {
    const values = [...pointers.values()];
    if (values.length < 2) return { ...values[0], count: values.length };
    const [a, b] = values;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y), count: 2 };
  };
  listen(canvas, 'pointerdown', (event) => {
    if (event.defaultPrevented || ![0, 1, 2].includes(event.button) || pointers.size >= 2) return;
    if (pointers.size && event.pointerType !== 'touch') return;
    animator.cancel();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 1 });
    previous = gesture();
    canvas.dataset.navigating = 'true';
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Owning-window release below is the fallback. */ }
    event.preventDefault();
  });
  listen(canvas, 'pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    const pointer = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { ...pointer, x: event.clientX, y: event.clientY });
    const current = gesture();
    let pose = graph.getCameraPose();
    if (pose && previous?.count === current.count) {
      const dx = current.x - previous.x, dy = current.y - previous.y;
      if (dx || dy || current.distance !== previous.distance) {
        onManual();
        pose = current.count === 2 || pointer.pan ? panCameraPose(pose, dx, dy) : orbitCameraPose(pose, dx, dy);
        if (current.count === 2 && previous.distance > 2 && current.distance > 2) {
          pose = zoomCameraPose(pose, Math.log(previous.distance / current.distance) / .0012);
        }
        graph.setCameraPose(pose);
      }
    }
    previous = current;
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  const end = (event) => {
    if (!pointers.delete(event.pointerId)) return;
    previous = pointers.size ? gesture() : undefined;
    if (!pointers.size) delete canvas.dataset.navigating;
  };
  listen(window, 'pointerup', end);
  listen(window, 'pointercancel', end);
  listen(canvas, 'lostpointercapture', end);
  listen(canvas, 'wheel', (event) => {
    animator.cancel();
    onManual();
    const pose = graph.getCameraPose();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    if (pose) graph.setCameraPose(zoomCameraPose(pose, pixels));
    event.preventDefault();
  }, { passive: false });
  listen(canvas, 'keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '0' || event.key === 'Home' || event.key === 'Escape') {
      event.preventDefault();
      onOverview();
      return;
    }
    const arrows = { ArrowLeft: [-22, 0], ArrowRight: [22, 0], ArrowUp: [0, -22], ArrowDown: [0, 22] };
    if (!arrows[event.key] && !['+', '=', '-'].includes(event.key)) return;
    const pose = graph.getCameraPose();
    if (!pose) return;
    event.preventDefault();
    animator.cancel();
    onManual();
    graph.setCameraPose(arrows[event.key] ? orbitCameraPose(pose, ...arrows[event.key]) : zoomCameraPose(pose, event.key === '-' ? 150 : -150));
  });
  listen(canvas, 'contextmenu', (event) => event.preventDefault());
}
