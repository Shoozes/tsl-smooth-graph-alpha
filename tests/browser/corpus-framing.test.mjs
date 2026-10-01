import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCorpusFrame, spreadCorpusPositions } from '../../examples/corpus/corpus-framing.js';
import { buildCorpusGraph, corpusMainHub } from '../../examples/corpus/corpus-model.js';

test('corpus frame contains sphere surfaces in wide, tall and asymmetric viewports', () => {
  const points = Array.from({ length: 400 }, (_, i) => ({ position: { x: Math.sin(i * 2.4) * 120, y: Math.cos(i * .91) * 50, z: Math.sin(i) * 85 }, radius: 1 + i % 5 }));
  for (const [width, height] of [[3440, 1220], [1440, 740], [390, 656], [320, 380]]) {
    for (const direction of [{ x: .3, y: .2, z: 1 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }]) {
      const frame = planCorpusFrame(points, { width, height, direction, insets: { top: 66, bottom: 72, left: 12, right: 12 } });
      const back = normalize(subtract(frame.position, frame.target));
      let right = normalize(cross({ x: 0, y: 1, z: 0 }, back));
      if (!Math.hypot(right.x, right.y, right.z)) right = { x: 1, y: 0, z: 0 };
      const up = normalize(cross(back, right));
      const tan = Math.tan(50 * Math.PI / 360);
      const screen = [];
      for (const { position, radius } of points) {
        // Independently project a sphere surface sampling, including depth.
        for (let sample = 0; sample < 48; sample += 1) {
          const y = 1 - 2 * (sample + .5) / 48;
          const r = Math.sqrt(1 - y * y), a = sample * 2.399963;
          const relative = subtract({ x: position.x + radius * Math.cos(a) * r, y: position.y + radius * y, z: position.z + radius * Math.sin(a) * r }, frame.position);
          const depth = -dot(relative, back);
          assert.ok(depth > 0);
          const x = width / 2 + dot(relative, right) / (depth * tan) * height / 2;
          const py = height / 2 - dot(relative, up) / (depth * tan) * height / 2;
          assert.ok(x >= 12 && x <= width - 12, `horizontal clipping ${width}x${height}: ${x}`);
          assert.ok(py >= 66 && py <= height - 72, `vertical clipping ${width}x${height}: ${py}`);
          screen.push({ x, y: py });
        }
      }
      const occupiedWidth = Math.max(...screen.map(p => p.x)) - Math.min(...screen.map(p => p.x));
      const occupiedHeight = Math.max(...screen.map(p => p.y)) - Math.min(...screen.map(p => p.y));
      assert.ok(Math.max(occupiedWidth / (width - 24), occupiedHeight / (height - 138)) > .8, `At least one usable dimension should be well filled: ${width}x${height} ${JSON.stringify(direction)} ${occupiedWidth / (width - 24)}, ${occupiedHeight / (height - 138)}`);
    }
  }
});

test('empty and one-node corpus framing is finite and bounded', () => {
  assert.equal(planCorpusFrame([], { width: 390, height: 650 }), undefined);
  assert.equal(planCorpusFrame([{ position: { x: 0, y: 0, z: 0 }, radius: 4 }], { width: 0, height: 0 }), undefined);
  const frame = planCorpusFrame([{ position: { x: 12, y: 40, z: 2 }, radius: 4 }], { width: 390, height: 650 });
  assert.ok(frame.distance >= 12 && frame.distance < 40);
  assert.ok(Object.values(frame.position).every(Number.isFinite));
});

test('main hub skips archive wrappers but does not choose an arbitrary branch or file', () => {
  const nodes = [{ id: 'corpus:root', data: { kind: 'root' } }, ...['a','b','c'].map(id => ({ id, data: { kind: 'folder' } })), { id: 'file', data: { kind: 'document' } }];
  const edge = (source, target) => ({ source, target, data: { kind: 'hierarchy' } });
  assert.equal(corpusMainHub({ nodes, links: [] }), 'corpus:root');
  assert.equal(corpusMainHub({ nodes, links: [edge('corpus:root','a'),edge('a','b'),edge('b','c'),edge('b','file')] }), 'b');
  assert.equal(corpusMainHub({ nodes, links: [edge('corpus:root','a'),edge('corpus:root','b')] }), 'corpus:root');
  assert.equal(corpusMainHub({ nodes, links: [edge('corpus:root','file')] }), 'corpus:root');
});

test('small corpus positions are compact while large manifests avoid argument overflow', () => {
  const manifest = (count) => ({ schema: 'forcegraph_local_corpus_manifest_v1', archive: 'fixture.zip', entryCount: count, fileCount: count, directoryCount: 0, totalBytes: count, records: Array.from({ length: count }, (_, i) => ({ path: `Note-${i}.md`, kind: 'file', size: 1, extension: '.md' })) });
  const sparse = buildCorpusGraph(manifest(3));
  assert.ok(sparse.nodes.every(node => Math.hypot(...Object.values(node.initialPosition)) < 40));
  const dense = buildCorpusGraph(manifest(130_000));
  assert.equal(dense.nodes.length, 130_002);
  assert.ok(dense.nodes.every(node => Object.values(node.initialPosition).every(Number.isFinite)));
});

test('corpus spreading fills landscape and portrait camera space without changing depth or radii', () => {
  const points = [
    { id: 'a', position: { x: -2, y: -1, z: -3 }, radius: 2 },
    { id: 'b', position: { x: 0, y: 2, z: 0 }, radius: 4 },
    { id: 'c', position: { x: 3, y: -1, z: 2 }, radius: 1 },
    { id: 'd', position: { x: 1, y: 3, z: 5 }, radius: 3 }
  ];
  const original = structuredClone(points);
  const project = (items, width, height) => {
    const frame = planCorpusFrame(items, { width, height, direction: { x: 0, y: 0, z: 1 }, minimumDistance: 8 });
    const projected = items.map(({ position }) => ({
      x: (position.x - frame.position.x) / (-frame.position.z + position.z),
      y: (position.y - frame.position.y) / (-frame.position.z + position.z)
    }));
    return {
      width: Math.max(...projected.map(point => point.x)) - Math.min(...projected.map(point => point.x)),
      height: Math.max(...projected.map(point => point.y)) - Math.min(...projected.map(point => point.y))
    };
  };
  const landscape = spreadCorpusPositions(points, { width: 1600, height: 700 });
  const portrait = spreadCorpusPositions(points, { width: 390, height: 820 });
  assert.deepEqual(points, original);
  assert.deepEqual(landscape.map(point => point.id), points.map(point => point.id));
  assert.deepEqual(portrait.map(point => point.id), points.map(point => point.id));
  for (const [before, after] of points.map((point, index) => [point, landscape[index]])) {
    assert.equal(after.radius, before.radius);
    assert.equal(after.position.z, before.position.z);
  }
  for (const [before, after] of points.map((point, index) => [point, portrait[index]])) {
    assert.equal(after.radius, before.radius);
    assert.equal(after.position.z, before.position.z);
  }
  const landscapeSpan = project(landscape, 1600, 700);
  const portraitSpan = project(portrait, 390, 820);
  assert.ok(landscapeSpan.width > landscapeSpan.height, 'landscape layout should use horizontal camera space');
  assert.ok(portraitSpan.height > portraitSpan.width, 'portrait layout should use vertical camera space');
  assert.ok(landscapeSpan.width > .7 && landscapeSpan.height > .25);
  assert.ok(portraitSpan.width > .2 && portraitSpan.height > .45);
});

test('corpus spreading is finite and non-mutating for empty, single, and collinear inputs', () => {
  const single = [{ id: 'one', position: { x: 1, y: 2, z: 3 }, radius: 2 }];
  const collinear = [
    { id: 'a', position: { x: -4, y: 0, z: 1 }, radius: 1 },
    { id: 'b', position: { x: 0, y: 0, z: 2 }, radius: 2 },
    { id: 'c', position: { x: 7, y: 0, z: 3 }, radius: 3 }
  ];
  const before = structuredClone(collinear);
  for (const result of [
    spreadCorpusPositions([], { width: 800, height: 600 }),
    spreadCorpusPositions(single, { width: 800, height: 600 }),
    spreadCorpusPositions(collinear, { width: 800, height: 600 })
  ]) {
    assert.ok(result.every(point => Object.values(point.position).every(Number.isFinite)));
  }
  assert.deepEqual(collinear, before);
  assert.notEqual(spreadCorpusPositions(single, { width: 800, height: 600 })[0], single[0]);
});

test('responsive spread translates clusters without stretching their internal geometry', () => {
  const points = [{ id: 'corpus:root', group: 'root', position: { x: 0, y: 0, z: 0 }, radius: 3 }];
  for (let group = 0; group < 4; group += 1) {
    for (let i = 0; i < 12; i += 1) points.push({
      id: `${group}:${i}`, group, radius: 1,
      position: { x: (group % 2 ? 30 : -30) + Math.cos(i) * 8, y: (group < 2 ? -40 : 40) + Math.sin(i) * 8, z: i % 3 }
    });
  }
  const before = structuredClone(points);
  for (const [width, height] of [[2560, 900], [390, 820]]) {
    const options = { width, height, direction: { x: .3, y: .2, z: 1 } };
    const spread = spreadCorpusPositions(points, options);
    assert.deepEqual(spread[0].position, points[0].position, 'root world anchor stays fixed');
    assert.deepEqual(spread, spreadCorpusPositions(points, options), 'reflow is deterministic');
    assert.ok(spread.some((point, i) => Math.hypot(...Object.values(subtract(point.position, points[i].position))) > 1));
    for (let group = 0; group < 4; group += 1) {
      const indices = points.flatMap((point, i) => point.group === group ? [i] : []);
      for (const i of indices) {
        const originalOffset = subtract(points[i].position, points[indices[0]].position);
        const actualOffset = subtract(spread[i].position, spread[indices[0]].position);
        assert.ok(Math.hypot(...Object.values(subtract(originalOffset, actualOffset))) < 1e-10, 'cluster shape must not become an ellipse');
      }
    }
  }
  assert.deepEqual(points, before);
  const singleCluster = points.filter(point => point.group === 0);
  assert.deepEqual(spreadCorpusPositions(singleCluster, { width: 2560, height: 900 }), singleCluster);
});

test('anchored corpus framing centers the root in the usable viewport while containing spheres', () => {
  const points = [
    { position: { x: -80, y: -12, z: -25 }, radius: 5 },
    { position: { x: 18, y: 74, z: 30 }, radius: 7 },
    { position: { x: 42, y: -20, z: 55 }, radius: 3 }
  ];
  const anchor = { x: 0, y: 0, z: 0 };
  for (const [width, height, insets] of [
    [1800, 760, { left: 220, right: 80, top: 70, bottom: 90 }],
    [390, 820, { left: 18, right: 14, top: 64, bottom: 96 }]
  ]) {
    const frame = planCorpusFrame(points, {
      width, height, anchor, insets,
      direction: { x: .25, y: .18, z: 1 },
      padding: .06,
      minimumDistance: 8
    });
    const back = normalize(subtract(frame.position, frame.target));
    const right = normalize(cross({ x: 0, y: 1, z: 0 }, back));
    const up = normalize(cross(back, right));
    const tanY = Math.tan(50 * Math.PI / 360);
    const project = (position) => {
      const relative = subtract(position, frame.position);
      const depth = -dot(relative, back);
      return {
        x: width / 2 + dot(relative, right) / (depth * tanY) * height / 2,
        y: height / 2 - dot(relative, up) / (depth * tanY) * height / 2
      };
    };
    const root = project(anchor);
    const usableCenter = {
      x: (insets.left + width - insets.right) / 2,
      y: (insets.top + height - insets.bottom) / 2
    };
    assert.ok(Math.abs(root.x - usableCenter.x) <= 1, `root x is not centered: ${root.x} vs ${usableCenter.x}`);
    assert.ok(Math.abs(root.y - usableCenter.y) <= 1, `root y is not centered: ${root.y} vs ${usableCenter.y}`);
    for (const { position, radius } of points) {
      for (let sample = 0; sample < 32; sample += 1) {
        const angle = sample * Math.PI * 2 / 32;
        const surface = { x: position.x + Math.cos(angle) * radius, y: position.y + Math.sin(angle) * radius, z: position.z };
        const pixel = project(surface);
        assert.ok(pixel.x >= insets.left - 1 && pixel.x <= width - insets.right + 1);
        assert.ok(pixel.y >= insets.top - 1 && pixel.y <= height - insets.bottom + 1);
      }
    }
  }
});

function subtract(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function normalize(a) { const n = Math.hypot(a.x, a.y, a.z); return n ? { x: a.x / n, y: a.y / n, z: a.z / n } : { x: 0, y: 0, z: 0 }; }
