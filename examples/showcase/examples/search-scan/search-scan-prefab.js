import { planPerspectiveCameraFocus, planPerspectiveCameraFrame, sampleCameraPoseTween } from '@ours/forcegraph-tsl/camera';
import { planLabelVisibility } from '@ours/forcegraph-tsl/labels';
import { createSearchScanTimeline } from './search-scan-timeline.js';

/** Host-owned presentation. Borrows the graph, scene, camera and Three modules. */
export function createSearchScanPrefab({ THREE, TSL, graph, scene, camera, labelLayer, model, travelMs = 300, overviewMs = 1500 } = {}) {
  const validated = validateInputs({ THREE, TSL, graph, scene, camera, labelLayer, model, travelMs, overviewMs });
  model = validated.model;
  const groups = new Map(model.groups.map((group) => [group.id, group]));
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  const words = model.nodes.filter((node) => typeof node.data?.label === 'string');
  let timeline = validated.timeline;
  let width = 1;
  let height = 1;
  let disposed = false;
  let visibleLabels = 0;
  let lastSample;
  let resultIds = validated.resultIds;
  const projection = new THREE.Vector3();
  const labels = new Map();
  const releases = [];
  const own = (resource) => { releases.push(() => resource.dispose()); return resource; };
  const attach = (object) => { releases.push(() => object.removeFromParent()); scene.add(object); };
  function releaseOwned() {
    for (const release of releases.splice(0).reverse()) {
      try { release(); } catch { /* Continue releasing independent owned resources. */ }
    }
    labels.clear();
  }
  let marker, travel;
  try {
    const document = validated.document;
    const ownedLabels = document.createElement('div');
    releases.push(() => ownedLabels.remove());
    ownedLabels.className = 'scan-owned-labels';
    ownedLabels.setAttribute('aria-hidden', 'true');
    labelLayer.append(ownedLabels);
    marker = createMarker(THREE, TSL, own);
    attach(marker.group);
    const bridges = createBridgeLayer(THREE, model, nodes, own);
    attach(bridges.object);
    travel = createTravelLayer(THREE, own);
    attach(travel.object);

    for (const group of model.groups) {
      const element = document.createElement('div');
      element.className = 'scan-group-label';
      element.style.setProperty('--group-color', hex(group.color));
      const heading = document.createElement('strong');
      heading.textContent = group.label;
      const progress = document.createElement('span');
      element.append(heading, progress);
      ownedLabels.append(element);
      labels.set(labelKey('group', group.id), { element, progress, group });
    }
    for (const node of words) {
      const element = document.createElement('span');
      element.className = 'scan-word-label';
      element.style.setProperty('--group-color', hex(node.data.color));
      element.textContent = node.data.label;
      ownedLabels.append(element);
      labels.set(labelKey('node', node.id), { element, node });
    }
  } catch (error) {
    releaseOwned();
    throw error;
  }

  function position(id) {
    if (id == null) return null;
    return readGraphPosition(graph, id);
  }

  function overviewPose() {
    return validatePose(planPerspectiveCameraFrame(readBounds(graph.getGraphBounds() ?? model.bounds), {
      aspect: width / height, verticalFovDegrees: camera.fov, padding: 1.7,
      direction: { x: 0, y: 0, z: 1 }, minimumDistance: 45
    }));
  }

  function focusPose(groupId, point) {
    const group = groups.get(groupId);
    if (!group) return overviewPose();
    const center = point ? mix(group.center, point, 0.22) : group.center;
    return validatePose(planPerspectiveCameraFocus(center, group.radius * 1.7, {
      aspect: width / height, verticalFovDegrees: camera.fov, padding: 1.02,
      direction: { x: 0, y: 0, z: 1 }, minimumDistance: 45
    }));
  }

  function sampleCursor(sample, reducedMotion) {
    const from = position(sample.fromNodeId);
    const to = position(sample.toNodeId);
    if (!from || !to) return null;
    const amount = sample.nodeProgress;
    const point = mix(from, to, amount);
    const moving = sample.phase === 'travel';
    const bend = reducedMotion ? 0 : Math.sin(Math.PI * amount);
    point.y += bend * (moving ? Math.min(13, Math.hypot(to.x - from.x, to.y - from.y) * 0.12) : 0.65);
    point.z += bend * (moving ? 4 : 0.5);
    return point;
  }

  function cameraPose(sample, cursor) {
    if (sample.phase === 'overview' || sample.phase === 'complete') {
      return sampleCameraPoseTween({ from: focusPose(sample.groupId, cursor), to: overviewPose(), durationMs: 1, easing: 'cubic-in-out' }, sample.overviewProgress);
    }
    if (sample.phase === 'travel') {
      return sampleCameraPoseTween({
        from: focusPose(sample.previousGroupId, position(sample.fromNodeId)),
        to: focusPose(sample.groupId, position(sample.toNodeId)), durationMs: 1,
        easing: 'cubic-in-out', path: { type: 'arc', offset: { x: 0, y: 4, z: 8 } }
      }, sample.phaseProgress);
    }
    return focusPose(sample.groupId, cursor);
  }

  function project(point) {
    projection.set(point.x, point.y, point.z).project(camera);
    return { x: (projection.x * 0.5 + 0.5) * width, y: (-projection.y * 0.5 + 0.5) * height, z: projection.z };
  }

  function renderLabels(sample) {
    const visible = new Set(sample.visibleNodeIds);
    const completed = new Set(sample.completedGroupIds);
    const candidates = [];
    const allRevealed = sample.phase === 'overview' || sample.phase === 'complete';
    const fontSize = width < 680 ? (allRevealed ? 6 : 7) : (allRevealed ? 9 : 10);
    for (const [key, record] of labels) {
      const { element, group, node } = record;
      element.hidden = true;
      if (group) {
        const point = project({ x: group.center.x - group.radius * 0.23, y: group.center.y + group.radius * 0.84, z: group.center.z });
        if (point.z < -1 || point.z > 1) continue;
        const scanned = group.nodeIds.filter((nodeId) => visible.has(nodeId)).length;
        const active = sample.groupId === group.id && (sample.phase === 'scan' || sample.phase === 'travel');
        const state = active ? 'revealing' : completed.has(group.id) ? 'shown' : allRevealed ? 'overview' : 'queued';
        record.progress.textContent = `${scanned}/${group.nodeIds.length} labels · ${state}`;
        element.style.opacity = sample.groupId === group.id || allRevealed ? '1' : '.62';
        const labelWidth = width < 680 ? 88 : 118;
        candidates.push({ id: key, bounds: { x: point.x - 12, y: point.y - 12, width: labelWidth, height: width < 680 ? 21 : 25 }, priority: 1000 });
      } else {
        const id = node.id;
        if (!visible.has(id)) continue;
        const actual = position(id);
        if (!actual) continue;
        const point = project(actual);
        if (point.z < -1 || point.z > 1) continue;
        const active = id === sample.activeNodeId;
        const match = resultIds.has(id);
        const inGroup = node.data.groupId === sample.groupId;
        element.dataset.active = String(active);
        element.dataset.match = String(match);
        element.style.fontSize = `${fontSize}px`;
        element.style.opacity = active ? '1' : match ? '.92' : inGroup || allRevealed ? '.68' : '.25';
        candidates.push({ id: key, bounds: { x: point.x + (active ? 16 : 5), y: point.y - fontSize - 1, width: element.textContent.length * fontSize * 0.61 + 8, height: fontSize + 5 }, priority: active ? 500 : match ? 180 : inGroup ? 80 : 20 });
      }
    }
    const decisions = planLabelVisibility(candidates, {
      viewport: { x: 10, y: 10, width: Math.max(1, width - 20), height: Math.max(1, height - 20) },
      collisionPadding: 1, maximumVisible: width < 680 ? 65 : 110
    });
    visibleLabels = 0;
    for (const decision of decisions) {
      const element = labels.get(decision.id).element;
      element.hidden = !decision.visible;
      if (!decision.visible) continue;
      visibleLabels += 1;
      element.style.transform = `translate3d(${decision.bounds.x.toFixed(2)}px,${decision.bounds.y.toFixed(2)}px,0)`;
    }
  }

  return Object.freeze({
    get durationMs() { return timeline.durationMs; },
    resize(nextWidth, nextHeight) {
      if (disposed) return;
      if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth <= 0 || nextHeight <= 0 || !Number.isFinite(nextWidth / nextHeight) || nextWidth / nextHeight <= 0) throw new RangeError('Viewport dimensions and aspect must be positive and finite.');
      width = nextWidth;
      height = nextHeight;
    },
    setSequence(steps, { resultNodeIds = [] } = {}) {
      if (disposed) throw new Error('Search scan is disposed.');
      if (!Array.isArray(steps)) throw new TypeError('Search scan steps must be an array.');
      const next = createSearchScanTimeline({ groups: model.groups, steps, travelMs, overviewMs });
      const nextResults = validateResultIds(resultNodeIds, nodes, graph);
      for (const step of steps) for (const id of step.nodeIds) readGraphPosition(graph, id);
      timeline = next;
      resultIds = nextResults;
      return timeline.durationMs;
    },
    render(elapsedMs, { followCamera = true, reducedMotion = false, overview = false } = {}) {
      if (disposed) return null;
      const sample = timeline.sample(elapsedMs);
      const cursor = sampleCursor(sample, reducedMotion);
      if (followCamera) {
        const pose = reducedMotion || overview ? overviewPose() : cameraPose(sample, cursor);
        graph.setCameraPose(pose);
      }
      camera.updateMatrixWorld();
      marker.group.visible = cursor !== null;
      if (cursor) {
        marker.group.position.set(cursor.x, cursor.y, cursor.z + 2);
        marker.group.scale.setScalar(Math.max(0.65, Math.min(1.8, (groups.get(sample.groupId)?.radius ?? 25) / 25)));
        marker.group.quaternion.copy(camera.quaternion);
        marker.update(reducedMotion ? 0 : sample.timeMs / 1000, sample.phase === 'travel' ? sample.phaseProgress : 0);
      }
      travel.update(position(sample.fromNodeId), cursor, sample.phase === 'travel' && !reducedMotion ? sample.phaseProgress : null);
      renderLabels(sample);
      lastSample = sample;
      return sample;
    },
    inspect() {
      return { disposed, visibleLabels, durationMs: timeline.durationMs, sample: lastSample, ownedObjects: disposed ? 0 : 3, labelCapacity: labels.size };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseOwned();
    }
  });
}

function createMarker(THREE, TSL, own) {
  const group = new THREE.Group();
  group.name = 'search-scan-marker';
  function mesh(geometry, material, order) {
    const object = new THREE.Mesh(geometry, material);
    object.renderOrder = order;
    object.frustumCulled = false;
    group.add(object);
    return object;
  }
  const material = (color, opacity = 1) => own(new THREE.MeshBasicMaterial({ color, opacity, transparent: opacity < 1, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  const haloMaterial = own(new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
  haloMaterial.colorNode = TSL.color(0x67d9c1);
  haloMaterial.opacityNode = TSL.float(1).sub(TSL.smoothstep(0.04, 0.5, TSL.uv().sub(0.5).length())).pow(2).mul(0.19);
  mesh(own(new THREE.PlaneGeometry(19, 19)), haloMaterial, 10);
  mesh(own(new THREE.CircleGeometry(2.2, 56)), material(0x061719, 0.96), 12);
  mesh(own(new THREE.RingGeometry(2.2, 2.27, 64)), material(0x67d9c1, 0.86), 13);
  const core = mesh(own(new THREE.PlaneGeometry(0.92, 0.92)), material(0xed4d91), 15);
  core.rotation.z = 0.28;
  const rays = 30;
  const segments = 10;
  const positions = new Float32Array(rays * segments * 6);
  const colors = new Float32Array(positions.length);
  const teal = new THREE.Color(0x67d9c1);
  for (let ray = 0; ray < rays; ray += 1) for (let s = 0; s < segments; s += 1) {
    const intensity = (1 - s / segments * 0.86) * (0.5 + noise(ray * 7.1) * 0.5);
    for (let endpoint = 0; endpoint < 2; endpoint += 1) {
      const offset = (ray * segments * 2 + s * 2 + endpoint) * 3;
      colors[offset] = teal.r * intensity;
      colors[offset + 1] = teal.g * intensity;
      colors[offset + 2] = teal.b * intensity;
    }
  }
  const geometry = own(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const lineMaterial = own(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.82, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
  const lines = new THREE.LineSegments(geometry, lineMaterial);
  lines.frustumCulled = false;
  lines.renderOrder = 14;
  group.add(lines);
  return {
    group,
    update(time, traveling) {
      for (let ray = 0; ray < rays; ray += 1) {
        const base = ray / rays * Math.PI * 2;
        const length = 4.1 + noise(ray + 19) * 5.3;
        const wave = Math.sin(time * (0.72 + noise(ray + 3) * 0.5) + ray * 2.7);
        for (let s = 0; s < segments; s += 1) for (let endpoint = 0; endpoint < 2; endpoint += 1) {
          const t = (s + endpoint) / segments;
          const radius = 2.25 + t * length * (1 + Math.sin(Math.PI * traveling) * 0.16);
          const angle = base + t * t * wave * 0.29 + Math.sin(t * 3.8 + time * 0.8 + ray) * 0.09 * t;
          const offset = (ray * segments * 2 + s * 2 + endpoint) * 3;
          positions[offset] = Math.cos(angle) * radius;
          positions[offset + 1] = Math.sin(angle) * radius;
          positions[offset + 2] = 0.06;
        }
      }
      geometry.attributes.position.needsUpdate = true;
    }
  };
}

function createBridgeLayer(THREE, model, nodes, own) {
  const positions = [];
  const seen = new Set();
  for (const link of model.links) {
    const from = nodes.get(link.source);
    const to = nodes.get(link.target);
    if (!from || !to || from.data.groupId === to.data.groupId) continue;
    const key = JSON.stringify([from.data.groupId, to.data.groupId].sort());
    if (seen.has(key) || seen.size >= 16) continue;
    seen.add(key);
    const a = from.initialPosition;
    const b = to.initialPosition;
    for (let i = 0; i < 32; i += 1) for (const t of [i / 32, (i + 1) / 32]) {
      const point = mix(a, b, t);
      positions.push(point.x, point.y + Math.sin(Math.PI * t) * (8 + seen.size * 0.8), point.z);
    }
  }
  const geometry = own(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = own(new THREE.LineBasicMaterial({ color: 0x8ca19c, transparent: true, opacity: 0.13, depthWrite: false }));
  const object = new THREE.LineSegments(geometry, material);
  object.visible = positions.length > 0;
  return { object };
}

function createTravelLayer(THREE, own) {
  const points = new Float32Array(5 * 28 * 6);
  const geometry = own(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(points, 3).setUsage(THREE.DynamicDrawUsage));
  const material = own(new THREE.LineBasicMaterial({ color: 0xa6dbcb, transparent: true, opacity: 0.48, depthTest: false, depthWrite: false }));
  const object = new THREE.LineSegments(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = 9;
  object.visible = false;
  return {
    object,
    update(from, to, progress) {
      object.visible = from !== null && to !== null && progress !== null;
      if (!object.visible) return;
      material.opacity = Math.sin(Math.PI * progress) * 0.5;
      for (let strand = 0; strand < 5; strand += 1) for (let i = 0; i < 28; i += 1) for (let endpoint = 0; endpoint < 2; endpoint += 1) {
        const t = (i + endpoint) / 28;
        const point = mix(from, to, t);
        const offset = (strand * 28 * 2 + i * 2 + endpoint) * 3;
        points[offset] = point.x + Math.sin(Math.PI * t) * (strand - 2) * 2;
        points[offset + 1] = point.y + Math.sin(Math.PI * t) * (5 + strand * 2.5);
        points[offset + 2] = point.z + 1;
      }
      geometry.attributes.position.needsUpdate = true;
    }
  };
}

function validateInputs({ THREE, TSL, graph, scene, camera, labelLayer, model, travelMs, overviewMs }) {
  for (const method of ['getNodePosition', 'getGraphBounds', 'setCameraPose']) {
    if (typeof graph?.[method] !== 'function') throw new TypeError(`Search scan graph requires ${method}().`);
  }
  if (typeof scene?.add !== 'function' || typeof scene?.remove !== 'function') throw new TypeError('Search scan requires a borrowed Three scene.');
  if (!camera?.isPerspectiveCamera || typeof camera.updateMatrixWorld !== 'function' || !Number.isFinite(camera.fov) || camera.fov <= 0 || camera.fov >= 180) {
    throw new TypeError('Search scan requires a perspective camera with a finite field of view between 0 and 180 degrees.');
  }
  const document = labelLayer?.ownerDocument ?? globalThis.document;
  if (typeof labelLayer?.append !== 'function' || typeof document?.createElement !== 'function') throw new TypeError('Search scan requires a DOM label layer.');
  for (const name of ['Vector3', 'Group', 'Mesh', 'Color', 'PlaneGeometry', 'CircleGeometry', 'RingGeometry', 'BufferGeometry', 'BufferAttribute', 'Float32BufferAttribute', 'MeshBasicMaterial', 'MeshBasicNodeMaterial', 'LineBasicMaterial', 'LineSegments']) {
    if (typeof THREE?.[name] !== 'function') throw new TypeError(`Search scan requires injected THREE.${name}.`);
  }
  for (const name of ['color', 'float', 'smoothstep', 'uv']) {
    if (typeof TSL?.[name] !== 'function') throw new TypeError(`Search scan requires injected TSL.${name}.`);
  }
  if (!isRecord(model) || !Array.isArray(model.groups) || !Array.isArray(model.nodes) || !Array.isArray(model.links)) {
    throw new TypeError('Search scan model requires groups, nodes, and links arrays.');
  }
  const groupIds = new Set();
  const groups = model.groups.map((group) => {
    if (!isRecord(group)) throw new TypeError('Search scan group must be an object.');
    validateId(group.id, 'group id');
    if (groupIds.has(group.id)) throw new TypeError(`Duplicate search scan group: ${group.id}.`);
    groupIds.add(group.id);
    validateText(group.label, `group ${group.id} label`);
    validateColor(group.color, `group ${group.id} color`);
    if (!Number.isFinite(group.radius) || group.radius <= 0 || !Number.isFinite(Math.fround(group.radius))) throw new TypeError(`Search scan group ${group.id} radius must be positive and finite.`);
    if (!Array.isArray(group.nodeIds)) throw new TypeError(`Search scan group ${group.id} nodeIds must be an array.`);
    for (const id of group.nodeIds) validateId(id, `group ${group.id} node id`);
    return Object.freeze({ id: group.id, label: group.label, color: group.color, center: readPoint(group.center, `group ${group.id} center`), radius: group.radius, nodeIds: Object.freeze([...group.nodeIds]) });
  });
  const nodeIds = new Set();
  let labelCount = 0;
  const nodes = model.nodes.map((node) => {
    if (!isRecord(node)) throw new TypeError('Search scan node must be an object.');
    validateId(node.id, 'node id');
    if (nodeIds.has(node.id)) throw new TypeError(`Duplicate search scan node: ${node.id}.`);
    nodeIds.add(node.id);
    if (!isRecord(node.data)) throw new TypeError(`Search scan node ${node.id} requires data.`);
    validateId(node.data.groupId, `node ${node.id} group id`);
    if (!groupIds.has(node.data.groupId)) throw new TypeError(`Search scan node ${node.id} refers to an unknown group.`);
    validateColor(node.data.color, `node ${node.id} color`);
    if (node.data.label !== undefined) {
      validateText(node.data.label, `node ${node.id} label`);
      if (++labelCount > 512) throw new RangeError('Search scan supports at most 512 presentation labels.');
    }
    if (node.data.annotation !== undefined) validateText(node.data.annotation, `node ${node.id} annotation`, true);
    const data = Object.freeze({ groupId: node.data.groupId, color: node.data.color, label: node.data.label, annotation: node.data.annotation });
    return Object.freeze({ id: node.id, data, initialPosition: readGraphPosition(graph, node.id) });
  });
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const presentationIds = new Set();
  for (const group of groups) for (const id of group.nodeIds) {
    const node = nodeMap.get(id);
    if (!node) throw new TypeError(`Search scan group ${group.id} refers to unknown node ${id}.`);
    if (node.data.groupId !== group.id) throw new TypeError(`Search scan node ${id} is assigned to the wrong group.`);
    if (node.data.label === undefined) throw new TypeError(`Search scan presentation node ${id} requires a label.`);
    presentationIds.add(id);
  }
  for (const node of nodes) {
    if (node.data.label !== undefined && !presentationIds.has(node.id)) throw new TypeError(`Search scan label ${node.id} is missing from its group nodeIds.`);
  }
  const links = model.links.map((link) => {
    if (!isRecord(link)) throw new TypeError('Search scan link must be an object.');
    validateId(link.source, 'link source id');
    validateId(link.target, 'link target id');
    if (!nodeMap.has(link.source) || !nodeMap.has(link.target)) throw new TypeError('Search scan link refers to an unknown node.');
    return Object.freeze({ source: link.source, target: link.target });
  });
  const bounds = readBounds(graph.getGraphBounds() ?? model.bounds);
  const timeline = createSearchScanTimeline({ groups, steps: model.steps ?? [], travelMs, overviewMs });
  const resultIds = validateResultIds(model.resultNodeIds ?? [], nodeMap, graph);
  const options = { aspect: 1, verticalFovDegrees: camera.fov, direction: { x: 0, y: 0, z: 1 }, padding: 1.4, minimumDistance: 45 };
  validatePose(planPerspectiveCameraFrame(bounds, options));
  for (const group of groups) validatePose(planPerspectiveCameraFocus(group.center, group.radius * 2.15, options));
  return { document, timeline, resultIds, model: Object.freeze({ groups: Object.freeze(groups), nodes: Object.freeze(nodes), links: Object.freeze(links), bounds }) };
}

function validateResultIds(value, nodes, graph) {
  if (!Array.isArray(value)) throw new TypeError('Search scan resultNodeIds must be an array of string IDs.');
  const result = new Set();
  for (const id of value) {
    validateId(id, 'result node id');
    if (!nodes.has(id) || nodes.get(id).data.label === undefined) throw new TypeError(`Unknown search scan result label: ${id}.`);
    readGraphPosition(graph, id);
    result.add(id);
  }
  return result;
}

function readGraphPosition(graph, id) {
  const point = graph.getNodePosition(id);
  if (point === undefined || point === null) throw new TypeError(`Search scan node ${id} is missing from the graph.`);
  return readPoint(point, `graph node ${id} position`);
}

function readPoint(value, field) {
  if (!isRecord(value) || !['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]) && Number.isFinite(Math.fround(value[axis])))) {
    throw new TypeError(`Search scan ${field} must contain finite float32 x, y, and z coordinates.`);
  }
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function readBounds(value) {
  if (!isRecord(value)) throw new TypeError('Search scan requires finite graph or model bounds.');
  const min = readPoint(value.min, 'bounds minimum');
  const max = readPoint(value.max, 'bounds maximum');
  if (['x', 'y', 'z'].some((axis) => min[axis] > max[axis])) throw new TypeError('Search scan bounds minimum must not exceed maximum.');
  return Object.freeze({ min, max });
}

function validatePose(pose) {
  if (![pose.position, pose.target].every((point) => ['x', 'y', 'z'].every((axis) => Number.isFinite(point[axis])))) throw new TypeError('Search scan camera framing must remain finite.');
  return pose;
}

function validateId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Search scan ${field} must be a nonempty string ID of at most 128 characters; numeric IDs are not converted.`);
  }
}

function validateText(value, field, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 160) throw new TypeError(`Search scan ${field} must be a string of ${allowEmpty ? '0' : '1'} to 160 characters.`);
}

function validateColor(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new TypeError(`Search scan ${field} must be a 24-bit RGB integer.`);
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function labelKey(kind, id) { return JSON.stringify([kind, id]); }
function mix(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }; }
function hex(value) { return `#${(Number(value) >>> 0).toString(16).padStart(6, '0').slice(-6)}`; }
function noise(value) { const n = Math.sin(value * 127.1 + 31.7) * 43758.5453; return n - Math.floor(n); }
