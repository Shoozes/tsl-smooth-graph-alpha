// Fit rendered spheres to the usable canvas, including asymmetric UI gutters.
// Camera and layout ownership stay with this example.
export function planCorpusFrame(points, { width, height, direction = { x: .35, y: .2, z: 1 }, insets = {}, padding = .06, minimumDistance = 12, anchor } = {}) {
  if (!(width > 0 && height > 0) || points.length === 0) return undefined;
  const back = normalize(direction);
  const right = normalize(cross({ x: 0, y: 1, z: 0 }, back), { x: 1, y: 0, z: 0 });
  const up = normalize(cross(back, right));
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const { position, radius } of points) {
    if (!Number.isFinite(radius) || radius < 0 || !Object.values(position).every(Number.isFinite)) throw new Error('Cannot frame non-finite corpus geometry.');
    for (const axis of ['x', 'y', 'z']) {
      min[axis] = Math.min(min[axis], position[axis] - radius);
      max[axis] = Math.max(max[axis], position[axis] + radius);
    }
  }
  if (anchor && !Object.values(anchor).every(Number.isFinite)) throw new Error('Cannot frame a non-finite anchor.');
  const center = anchor ?? { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const left = Math.min(width * .3, Math.max(0, insets.left ?? 0));
  const rightInset = Math.min(width * .3, Math.max(0, insets.right ?? 0));
  const top = Math.min(height * .3, Math.max(0, insets.top ?? 0));
  const bottom = Math.min(height * .3, Math.max(0, insets.bottom ?? 0));
  const xMin = 2 * (left + (width - left - rightInset) * padding) / width - 1;
  const xMax = 1 - 2 * (rightInset + (width - left - rightInset) * padding) / width;
  const yMin = 2 * (bottom + (height - top - bottom) * padding) / height - 1;
  const yMax = 1 - 2 * (top + (height - top - bottom) * padding) / height;
  const tanY = Math.tan(50 * Math.PI / 360), tanX = tanY * width / height;
  const sxMin = xMin * tanX, sxMax = xMax * tanX, syMin = yMin * tanY, syMax = yMax * tanY;
  let distance = minimumDistance;
  let leftEdge = -Infinity, rightEdge = Infinity, bottomEdge = -Infinity, topEdge = Infinity;
  for (const { position, radius } of points) {
    const relative = subtract(position, center);
    const x = dot(relative, right), y = dot(relative, up), z = dot(relative, back);
    distance = Math.max(distance, z + radius + .1);
    // Sphere/plane support distances include near-side depth. Each bound has
    // the same slope, so four extrema solve the entire cloud in linear time.
    leftEdge = Math.max(leftEdge, x + sxMax * z + radius * Math.hypot(1, sxMax));
    rightEdge = Math.min(rightEdge, x + sxMin * z - radius * Math.hypot(1, sxMin));
    bottomEdge = Math.max(bottomEdge, y + syMax * z + radius * Math.hypot(1, syMax));
    topEdge = Math.min(topEdge, y + syMin * z - radius * Math.hypot(1, syMin));
  }
  if (anchor) {
    const centerSlopeX = (sxMin + sxMax) / 2, centerSlopeY = (syMin + syMax) / 2;
    distance = Math.max(distance,
      leftEdge / (sxMax - centerSlopeX), -rightEdge / (centerSlopeX - sxMin),
      bottomEdge / (syMax - centerSlopeY), -topEdge / (centerSlopeY - syMin));
    const target = add(center, add(scale(right, -centerSlopeX * distance), scale(up, -centerSlopeY * distance)));
    return { target, position: add(target, scale(back, distance)), distance };
  }
  distance = Math.max(distance, (leftEdge - rightEdge) / (sxMax - sxMin), (bottomEdge - topEdge) / (syMax - syMin));
  const horizontal = (leftEdge + rightEdge - (sxMax + sxMin) * distance) / 2;
  const vertical = (bottomEdge + topEdge - (syMax + syMin) * distance) / 2;
  const target = add(center, add(scale(right, horizontal), scale(up, vertical)));
  return { target, position: add(target, scale(back, distance)), distance };
}

export function corpusFramePoints(nodes, getPosition, getRadius) {
  const points = [];
  for (const node of nodes) {
    const position = getPosition(node.id);
    if (position) points.push({ position, radius: getRadius(node) });
  }
  return points;
}

/** Reflow intact clusters in the camera plane, preserving their local shape. */
export function spreadCorpusPositions(points, { width, height, direction = { x: 0, y: 0, z: 1 } } = {}) {
  const copy = () => points.map(point => ({ ...point, position: { ...point.position } }));
  if (points.length < 2 || !(width > 0 && height > 0)) return copy();
  const back = normalize(direction);
  const right = normalize(cross({ x: 0, y: 1, z: 0 }, back), { x: 1, y: 0, z: 0 });
  const up = normalize(cross(back, right));
  const groups = new Map();
  for (const [index, point] of points.entries()) {
    const key = point.group ?? index;
    const group = groups.get(key) ?? { x: 0, y: 0, count: 0 };
    group.x += dot(point.position, right); group.y += dot(point.position, up); group.count += 1;
    groups.set(key, group);
  }
  if (groups.size < 2) return copy();
  for (const group of groups.values()) { group.x /= group.count; group.y /= group.count; }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { position } of points) {
    const x = dot(position, right), y = dot(position, up);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const spanX = maxX - minX, spanY = maxY - minY;
  // A single coincident point or straight line has no second layout dimension.
  if (!(spanX > 1e-6 && spanY > 1e-6)) return copy();
  const root = points.find(point => point.id === 'corpus:root');
  const centerX = root ? dot(root.position, right) : (minX + maxX) / 2;
  const centerY = root ? dot(root.position, up) : (minY + maxY) / 2;
  const desiredAspect = width / height;
  let scaleX = Math.max(1, desiredAspect * spanY / spanX);
  let scaleY = Math.max(1, spanX / (desiredAspect * spanY));
  let spread;
  // Correct perspective foreshortening with a small fixed work budget. Every
  // pass starts from canonical positions, so resize never compounds stretching.
  for (let pass = 0; pass < 4; pass += 1) {
    scaleX = Math.min(8, scaleX); scaleY = Math.min(8, scaleY);
    spread = points.map((point, index) => {
      const group = groups.get(point.group ?? index);
      return { ...point, position: add(point.position, add(
        scale(right, (group.x - centerX) * (scaleX - 1)),
        scale(up, (group.y - centerY) * (scaleY - 1))
      )) };
    });
    const frame = planCorpusFrame(spread, { width, height, direction, minimumDistance: 8 });
    let left = Infinity, rightEdge = -Infinity, bottom = Infinity, top = -Infinity;
    for (const { position } of spread) {
      const relative = subtract(position, frame.position), depth = -dot(relative, back);
      const x = dot(relative, right) / depth, y = dot(relative, up) / depth;
      left = Math.min(left, x); rightEdge = Math.max(rightEdge, x);
      bottom = Math.min(bottom, y); top = Math.max(top, y);
    }
    const ratio = (rightEdge - left) / (top - bottom);
    const correction = desiredAspect / ratio;
    if (Math.abs(correction - 1) < .015) break;
    if (correction > 1) scaleX *= correction; else scaleY /= correction;
  }
  return spread;
}

function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function subtract(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function scale(a, n) { return { x: a.x * n, y: a.y * n, z: a.z * n }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function normalize(a, fallback = { x: 0, y: 0, z: 1 }) { const length = Math.hypot(a.x, a.y, a.z); return length > 1e-8 ? scale(a, 1 / length) : fallback; }
