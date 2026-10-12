const MAX_POINTS_PER_GROUP = 4_096;
const TAU = Math.PI * 2;

const GROUPS = [
  ['objective', 'objective', 0x5799b2, [0, 86, -2], 23,
    ['query', 'scope', 'intent', 'keywords', 'local match', 'question', 'preview', 'collect', 'reference', 'compare', 'extract', 'related note', 'evidence', 'summary', 'source', 'inspect', 'result', 'outline', 'answer', 'next step']],
  ['context', 'context', 0xb26487, [-72, 25, 2], 27,
    ['notebook', 'chapter', 'section', 'passage', 'local match', 'detail', 'topic', 'setting', 'example', 'record', 'source', 'related note', 'quote', 'heading', 'paragraph', 'link', 'result', 'tag', 'context', 'reference']],
  ['role', 'role', 0xbdcbcd, [72, 27, -3], 24,
    ['reader', 'author', 'editor', 'reviewer', 'local match', 'curator', 'owner', 'contributor', 'observer', 'researcher', 'publisher', 'related note', 'librarian', 'guide', 'operator', 'maintainer', 'result', 'visitor', 'analyst', 'helper']],
  ['roles', 'roles', 0xc2a04f, [-5, -83, 1], 27,
    ['source', 'extract', 'document', 'note', 'local match', 'draft', 'reference', 'index', 'revision', 'record', 'chapter', 'related note', 'entry', 'snippet', 'example', 'collection', 'result', 'outline', 'summary', 'archive']],
  ['rules', 'rules', 0x4d9b8b, [57, -34, 2], 25,
    ['query', 'scope', 'filter', 'token', 'local match', 'phrase', 'section', 'path', 'prefix', 'heading', 'tag', 'related note', 'range', 'field', 'weight', 'order', 'result', 'limit', 'select', 'inspect']],
  ['review', 'review', 0x9577ce, [-62, -36, -3], 23,
    ['inspect', 'compare', 'context', 'excerpt', 'local match', 'citation', 'passage', 'source', 'detail', 'summary', 'reference', 'related note', 'question', 'evidence', 'outline', 'preview', 'result', 'check', 'revisit', 'retain']],
  ['start', 'start', 0xb98570, [1, 0, 5], 22,
    ['question', 'search', 'source', 'collect', 'local match', 'excerpt', 'inspect', 'context', 'rank', 'preview', 'reference', 'related note', 'select', 'summary', 'trace', 'answer', 'result', 'review', 'finish', 'overview']]
];

/** Synthetic, seeded display data. No search, indexing, or model calls occur. */
export function buildSearchScanFixture(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Search scan fixture options must be an object.');
  const { seed = 1337, pointsPerGroup = 450 } = options;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Search scan seed must be an integer from 0 to 4294967295.');
  if (!Number.isInteger(pointsPerGroup) || pointsPerGroup < 0 || pointsPerGroup > MAX_POINTS_PER_GROUP) {
    throw new RangeError(`Search scan pointsPerGroup must be an integer from 0 to ${MAX_POINTS_PER_GROUP}.`);
  }

  const random = seededRandom(seed);
  const groups = [];
  const nodes = [];
  const links = [];
  for (const [groupIndex, [id, label, color, xyz, baseRadius, words]] of GROUPS.entries()) {
    const radius = baseRadius * 1.45;
    const center = Object.freeze({ x: xyz[0] * 1.03, y: xyz[1] * 0.62, z: xyz[2] });
    const group = { id, label, color, center, radius, nodeIds: [] };
    const members = [];
    const rotation = groupIndex * 0.63;
    for (let index = 0; index < pointsPerGroup; index += 1) {
      const angle = random() * TAU;
      const contour = 0.73 + 0.14 * Math.sin(angle * 3 + rotation) + 0.09 * Math.cos(angle * 5 - rotation);
      const spread = Math.sqrt(random()) * radius * contour;
      const position = localPosition(center, angle, spread, rotation, (random() - 0.5) * radius * 0.22);
      const accent = index % 79 === 0;
      members.push(makeNode(`${id}-point-${index}`, position, {
        groupId: id, color: scaleColor(color, 0.65 + random() * 0.5),
        radius: accent ? 0.48 + random() * 0.3 : 0.055 + random() * 0.12,
        kind: 'point'
      }));
    }
    for (const [index, word] of words.entries()) {
      const nodeId = `${id}-word-${index}`;
      const angle = rotation + index * 0.59;
      const spread = radius * (0.12 + 0.53 * index / (words.length - 1));
      const position = localPosition(center, angle, spread, rotation, (random() - 0.5) * 1.2);
      const data = { groupId: id, color, radius: 0.36 + random() * 0.14, label: word, kind: 'word' };
      if (index === 4 || index === 16) data.annotation = 'match';
      if (index === 11) data.annotation = 'related';
      group.nodeIds.push(nodeId);
      members.push(makeNode(nodeId, position, data));
    }
    addLocalLinks(group, members, links);
    nodes.push(...members);
    groups.push(Object.freeze({ ...group, nodeIds: Object.freeze(group.nodeIds) }));
  }

  const byGroup = new Map(groups.map(group => [group.id, group]));
  const byNode = new Map(nodes.map(node => [node.id, node]));
  const steps = ['roles', 'rules', 'review', 'start'].map((groupId, index) => Object.freeze({
    groupId, nodeIds: Object.freeze([...byGroup.get(groupId).nodeIds]), durationMs: index === 0 ? 900 : 2_600
  }));
  const resultNodeIds = steps.flatMap(step => step.nodeIds.filter(id => byNode.get(id).data.annotation === 'match'));
  return Object.freeze({
    groups: Object.freeze(groups), nodes: Object.freeze(nodes), links: Object.freeze(links),
    steps: Object.freeze(steps), resultNodeIds: Object.freeze(resultNodeIds), bounds: measureBounds(nodes)
  });
}

function makeNode(id, position, data) {
  const fixed = Object.freeze(position);
  return Object.freeze({ id, initialPosition: fixed, fixed, data: Object.freeze(data) });
}

function localPosition(center, angle, spread, rotation, depth) {
  const x = Math.cos(angle) * spread;
  const y = Math.sin(angle) * spread * 0.84;
  return {
    x: center.x + x * Math.cos(rotation) - y * Math.sin(rotation),
    y: center.y + x * Math.sin(rotation) + y * Math.cos(rotation),
    z: center.z + depth
  };
}

// A density-scaled XY grid keeps candidate sets local as point counts increase.
function addLocalLinks(group, members, links) {
  const cellSize = group.radius / Math.sqrt(members.length / 4);
  const cells = new Map();
  const locations = members.map((node, index) => {
    const x = Math.floor(node.initialPosition.x / cellSize);
    const y = Math.floor(node.initialPosition.y / cellSize);
    const key = `${x},${y}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(index);
    cells.set(key, bucket);
    return { x, y };
  });
  const pairs = new Set();
  const maximumDistanceSquared = (group.radius * 0.55) ** 2;
  for (let index = 0; index < members.length; index += 1) {
    const cell = locations[index];
    const candidates = [];
    for (let ring = 0; ring <= 3; ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const other of cells.get(`${cell.x + dx},${cell.y + dy}`) ?? []) {
            if (other === index) continue;
            const distance = distanceSquared(members[index].initialPosition, members[other].initialPosition);
            if (distance <= maximumDistanceSquared) candidates.push({ other, distance });
          }
        }
      }
      if (candidates.length >= 8) break;
    }
    candidates.sort((a, b) => a.distance - b.distance || a.other - b.other);
    let added = 0;
    for (const { other } of candidates) {
      const low = Math.min(index, other);
      const high = Math.max(index, other);
      const key = `${low}:${high}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      links.push(Object.freeze({
        id: `${group.id}-link-${key}`, source: members[low].id, target: members[high].id,
        data: Object.freeze({ groupId: group.id, color: group.color, kind: 'local' })
      }));
      added += 1;
      if (added === (index % 3 === 0 ? 3 : 2)) break;
    }
  }
}

function measureBounds(nodes) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const node of nodes) {
    for (const axis of ['x', 'y', 'z']) {
      min[axis] = Math.min(min[axis], node.initialPosition[axis] - node.data.radius);
      max[axis] = Math.max(max[axis], node.initialPosition[axis] + node.data.radius);
    }
  }
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  let radius = 0;
  for (const node of nodes) radius = Math.max(radius, Math.sqrt(distanceSquared(center, node.initialPosition)) + node.data.radius);
  return Object.freeze({ min: Object.freeze(min), max: Object.freeze(max), center: Object.freeze(center), size: Object.freeze(size), radius });
}

function distanceSquared(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

function scaleColor(color, scale) {
  const byte = shift => Math.min(255, Math.round(((color >>> shift) & 255) * scale));
  return (byte(16) << 16) | (byte(8) << 8) | byte(0);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
