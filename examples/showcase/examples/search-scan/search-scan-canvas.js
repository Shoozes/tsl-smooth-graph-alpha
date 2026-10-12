import { createHeadlessForceGraph } from '@ours/forcegraph-tsl/headless';

/** Canvas2D fallback for this prefab's primitives; it does not execute TSL or use GPU draws. */
export function createSearchScanCanvasHost({ THREE, canvas, scene, camera, model }) {
  if (!THREE?.Matrix4 || !canvas?.getContext || !scene?.isScene || !camera?.isPerspectiveCamera) throw new TypeError('Canvas2D fallback requires Three, a canvas, scene, and perspective camera.');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas2D fallback needs a fresh canvas without an existing GPU context.');
  const owner = createHeadlessForceGraph({ layout: { dimensions: 3, autoStart: false, seed: 1337 } });
  const projection = new THREE.Matrix4();
  const vector = new THREE.Vector3();
  const tint = new THREE.Color();
  let records = [], linkBatches = [], nodeBatches = [];
  let projected = [], disposed = false, rendererDisposed = false;
  let width = 1, height = 1, pixelRatio = 1, clearColor = '#070708', clearAlpha = 1;
  let cameraTarget = { x: 0, y: 0, z: 0 };
  let focalScale = 1;
  let focusedGroups = null;
  const info = { render: { calls: 0, canvasPaintCalls: 0 } };
  canvas.setAttribute('data-renderer', 'canvas2d-fallback');
  canvas.setAttribute('aria-label', 'Search graph, Canvas2D fallback. Drag to orbit, scroll or pinch to zoom. Automatic camera motion stops when you navigate.');

  function active() { if (disposed || rendererDisposed) throw new Error('Canvas2D fallback host is disposed.'); }
  function color(value) { return new THREE.Color(value ?? 0x78aea2).getStyle(); }
  function painted() { info.render.calls += 1; info.render.canvasPaintCalls += 1; }
  function accept(data) {
    active();
    if (!Array.isArray(data?.nodes) || !Array.isArray(data?.links) || data.nodes.length > 30_000 || data.links.length > 90_000) throw new RangeError('Canvas2D fallback supports at most 30,000 nodes and 90,000 links.');
    for (const node of data.nodes) {
      if (node.data?.radius !== undefined && (!Number.isFinite(node.data.radius) || node.data.radius < 0 || node.data.radius > 100)) throw new RangeError('Canvas2D node radius must be finite and between 0 and 100.');
    }
    const result = owner.setData({ nodes: data.nodes, links: data.links });
    const view = owner.graph;
    // Capture accepted structure and Float32 positions for this static pinned graph.
    records = data.nodes.map(({ id }) => {
      const node = view.getNode(id);
      return { id, position: view.getNodePosition(id), radius: node.data?.radius ?? 0.18, color: color(node.data?.color), groupId: node.data?.groupId ?? '', kind: node.data?.kind };
    });
    const indices = new Map(records.map((node, index) => [node.id, index]));
    const lines = new Map(), points = new Map();
    for (const { id } of data.links) {
      const link = view.getLink(id);
      const style = color(link.data?.color ?? 0x527163);
      const groupId = link.data?.groupId ?? records[indices.get(link.source)].groupId;
      const key = `${groupId}:${style}`;
      const batch = lines.get(key) ?? { groupId, style, pairs: [] };
      batch.pairs.push([indices.get(link.source), indices.get(link.target)]);
      lines.set(key, batch);
    }
    records.forEach((node, index) => {
      const opacity = node.kind === 'word' ? 0.94 : 0.78;
      const key = `${node.groupId}:${node.color}:${opacity}`;
      const batch = points.get(key) ?? { groupId: node.groupId, style: node.color, opacity, indices: [] };
      batch.indices.push(index);
      points.set(key, batch);
    });
    linkBatches = [...lines.values()];
    nodeBatches = [...points.values()];
    return result;
  }

  function project(x, y, z) {
    const m = projection.elements;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0 || !Number.isFinite(w)) return null;
    const depth = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    if (depth < -1 || depth > 1) return null;
    return { x: ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * width / 2, y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * height / 2, scale: focalScale / w };
  }
  function vertex(object, attribute, index) {
    vector.fromBufferAttribute(attribute, index).applyMatrix4(object.matrixWorld);
    return project(vector.x, vector.y, vector.z);
  }
  function path(points) {
    if (!points.length || points.some(point => point === null)) return false;
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
    context.closePath();
    return true;
  }

  function drawGraph() {
    projected = records.map(node => project(node.position.x, node.position.y, node.position.z));
    context.lineWidth = 0.55;
    for (const batch of linkBatches) {
      context.globalAlpha = 0.35 * (focusedGroups === null || focusedGroups.has(batch.groupId) ? 1 : 0.27);
      context.beginPath();
      for (const [a, b] of batch.pairs) {
        const from = projected[a], to = projected[b];
        if (!from || !to) continue;
        context.moveTo(from.x, from.y); context.lineTo(to.x, to.y);
      }
      context.strokeStyle = batch.style; context.stroke(); painted();
    }
    for (const batch of nodeBatches) {
      context.beginPath();
      for (const index of batch.indices) {
        const point = projected[index];
        if (!point) continue;
        const radius = Math.max(0.25, records[index].radius * point.scale);
        if (point.x + radius < 0 || point.y + radius < 0 || point.x - radius > width || point.y - radius > height) continue;
        context.rect(point.x - radius, point.y - radius, radius * 2, radius * 2);
      }
      context.fillStyle = batch.style;
      context.globalAlpha = batch.opacity * (focusedGroups === null || focusedGroups.has(batch.groupId) ? 1 : 0.27);
      context.fill(); painted();
    }
  }

  function drawObject(object) {
    const material = object.material;
    if (Array.isArray(material)) throw new TypeError('Canvas2D fallback supports one material per prefab object.');
    if (!material || material.visible === false || material.opacity <= 0) return;
    const geometry = object.geometry;
    const positions = geometry?.getAttribute('position');
    if (!positions) return;
    context.save();
    context.globalAlpha = material.opacity;
    context.globalCompositeOperation = material.blending === THREE.AdditiveBlending ? 'lighter' : 'source-over';
    if (object.isLineSegments) {
      const colors = geometry.getAttribute('color');
      const count = Math.min(geometry.index?.count ?? positions.count, geometry.drawRange.start + geometry.drawRange.count);
      context.lineWidth = material.linewidth || 0.65;
      for (let index = geometry.drawRange.start; index + 1 < count; index += 2) {
        const a = geometry.index?.getX(index) ?? index, b = geometry.index?.getX(index + 1) ?? index + 1;
        const from = vertex(object, positions, a), to = vertex(object, positions, b);
        if (!from || !to) continue;
        tint.copy(material.color);
        if (material.vertexColors && colors) tint.multiply(new THREE.Color().setRGB((colors.getX(a) + colors.getX(b)) / 2, (colors.getY(a) + colors.getY(b)) / 2, (colors.getZ(a) + colors.getZ(b)) / 2));
        context.strokeStyle = tint.getStyle();
        context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); painted();
      }
    } else if (material.isMeshBasicNodeMaterial && geometry.type === 'PlaneGeometry') {
      // The marker's UV halo is the only shader approximation in this host.
      const corners = [0, 1, 3, 2].map(index => vertex(object, positions, index));
      if (corners.every(Boolean)) {
        const x = (corners[0].x + corners[2].x) / 2, y = (corners[0].y + corners[2].y) / 2;
        const radius = Math.max(0.01, Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) / 2);
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(103,217,193,.19)'); gradient.addColorStop(0.35, 'rgba(103,217,193,.09)'); gradient.addColorStop(1, 'rgba(103,217,193,0)');
        context.fillStyle = gradient; context.beginPath(); path(corners); context.fill(); painted();
      }
    } else {
      context.fillStyle = material.color.getStyle(); context.beginPath();
      let valid = false;
      if (geometry.type === 'PlaneGeometry') valid = path([0, 1, 3, 2].map(index => vertex(object, positions, index)));
      else if (geometry.type === 'CircleGeometry') valid = path(Array.from({ length: positions.count - 1 }, (_, i) => vertex(object, positions, i + 1)));
      else if (geometry.type === 'RingGeometry') {
        const segments = geometry.parameters.thetaSegments + 1;
        const outer = geometry.parameters.phiSegments * segments;
        valid = path(Array.from({ length: segments }, (_, i) => vertex(object, positions, outer + i))) && path(Array.from({ length: segments }, (_, i) => vertex(object, positions, segments - i - 1)));
      } else throw new TypeError(`Canvas2D fallback does not support ${geometry.type}.`);
      if (valid) { context.fill('evenodd'); painted(); }
    }
    context.restore();
  }

  function setSize(nextWidth, nextHeight, updateStyle = false) {
    active();
    if (![nextWidth, nextHeight].every(value => Number.isFinite(value) && value > 0 && value <= 8192) || nextWidth * nextHeight * pixelRatio ** 2 > 32_000_000) throw new RangeError('Canvas2D viewport exceeds its bounded raster size.');
    width = nextWidth; height = nextHeight;
    canvas.width = Math.max(1, Math.round(width * pixelRatio)); canvas.height = Math.max(1, Math.round(height * pixelRatio));
    if (updateStyle) { canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
  }

  const renderer = {
    domElement: canvas, backend: Object.freeze({ isCanvasFallback: true }), info,
    setGraphFocus(groupIdsOrNull) {
      active();
      if (groupIdsOrNull === null) { focusedGroups = null; return; }
      const count = Array.isArray(groupIdsOrNull) ? groupIdsOrNull.length : groupIdsOrNull instanceof Set ? groupIdsOrNull.size : -1;
      if (count < 0 || count > 128) throw new TypeError('Canvas2D graph focus must be null, or an array/Set of at most 128 string IDs.');
      const ids = [...groupIdsOrNull];
      if (ids.some(id => typeof id !== 'string' || !id.length || id.length > 128 || /[\u0000-\u001f\u007f]/u.test(id))) throw new TypeError('Canvas2D graph focus IDs must be nonempty strings of at most 128 characters.');
      focusedGroups = new Set(ids);
    },
    setPixelRatio(value) { active(); if (!Number.isFinite(value) || value <= 0 || value > 3) throw new RangeError('Canvas2D pixel ratio must be between 0 and 3.'); pixelRatio = value; setSize(width, height); },
    setClearColor(value, alpha = 1) { active(); if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new RangeError('Clear alpha must be between 0 and 1.'); clearColor = color(value); clearAlpha = alpha; },
    setSize,
    render(nextScene = scene, nextCamera = camera) {
      active();
      nextScene.updateMatrixWorld(true); nextCamera.updateMatrixWorld();
      projection.multiplyMatrices(nextCamera.projectionMatrix, nextCamera.matrixWorldInverse);
      focalScale = nextCamera.projectionMatrix.elements[5] * height / 2;
      info.render.calls = 0; info.render.canvasPaintCalls = 0;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.globalCompositeOperation = 'source-over'; context.globalAlpha = clearAlpha;
      context.clearRect(0, 0, width, height); context.fillStyle = clearColor; context.fillRect(0, 0, width, height); painted();
      drawGraph();
      const objects = [];
      nextScene.traverseVisible(object => { if ((object.isMesh || object.isLineSegments) && object.layers.test(nextCamera.layers)) objects.push(object); });
      objects.sort((a, b) => a.renderOrder - b.renderOrder);
      for (const object of objects) drawObject(object);
      context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    },
    dispose() { if (rendererDisposed) return; rendererDisposed = true; info.render.calls = 0; info.render.canvasPaintCalls = 0; context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height); }
  };
  const graph = {
    get isDisposed() { return disposed; },
    setData: accept,
    getNodePosition(id) { active(); return owner.graph.getNodePosition(id); },
    getGraphBounds() { active(); return owner.graph.getBounds(); },
    getCameraPose() { active(); return { position: { x: camera.position.x, y: camera.position.y, z: camera.position.z }, target: { ...cameraTarget } }; },
    setCameraPose(pose) {
      active();
      for (const point of [pose?.position, pose?.target]) if (!point || !['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))) throw new TypeError('Camera position and target must be finite.');
      camera.position.set(pose.position.x, pose.position.y, pose.position.z); cameraTarget = { ...pose.target };
      camera.lookAt(pose.target.x, pose.target.y, pose.target.z); camera.updateMatrixWorld();
    },
    update(seconds) { active(); if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Frame time must be finite and nonnegative.'); },
    render() { active(); },
    getDiagnostics() { return { backend: 'canvas2d-fallback', hostMode: 'headless', nodeCount: disposed ? 0 : owner.graph.nodeCount, linkCount: disposed ? 0 : owner.graph.linkCount, drawCalls: 0, canvasPaintCalls: info.render.canvasPaintCalls, focusedGroupIds: focusedGroups === null ? null : [...focusedGroups], layoutRunning: false, disposed }; },
    // This synchronous host reports errors by throwing to the caller's frame handler.
    on() { return () => {}; },
    dispose() { if (disposed) return; disposed = true; owner.dispose(); records = []; linkBatches = []; nodeBatches = []; projected = []; focusedGroups = null; }
  };
  try { accept(model); } catch (error) { owner.dispose(); throw error; }
  return { graph, renderer };
}
