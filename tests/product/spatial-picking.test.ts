import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SpatialPickingIndex } from '../../source/render/SpatialPickingIndex.js';

const identityMatrix = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
];

test('SpatialPickingIndex rebuilds only on revisions and queries a sublinear nearby candidate set', () => {
  const positions = Array.from({ length: 1024 }, (_, index) => ({
    x: -0.96 + (index % 32) * 0.06,
    y: 0.96 - Math.floor(index / 32) * 0.06,
    z: 0
  }));
  const radii = positions.map(() => 0.01);
  const index = new SpatialPickingIndex(48);
  const camera = { view: identityMatrix, projection: identityMatrix };
  const viewport = { left: 0, top: 0, width: 1024, height: 1024 };
  const target = positions[528]!;
  const localX = (target.x * 0.5 + 0.5) * viewport.width;
  const localY = (-target.y * 0.5 + 0.5) * viewport.height;

  const pickable = positions.map(() => true);
  const first = index.query(localX, localY, positions, radii, pickable, camera, viewport, 4, 2);
  const second = index.query(localX, localY, positions, radii, pickable, camera, viewport, 4, 2);
  const moved = index.query(localX, localY, positions, radii, pickable, camera, viewport, 5, 2);

  assert.equal(first.instance, 528);
  assert.equal(first.rebuilt, true);
  assert.equal(first.scannedCellCount, 1);
  assert.ok(first.candidateCount < positions.length / 10);
  assert.equal(second.instance, 528);
  assert.equal(second.rebuilt, false);
  assert.equal(moved.rebuilt, true);
});

test('SpatialPickingIndex projects billboard radii along camera axes and excludes invisible nodes', () => {
  const projection = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, -1.020202, -1,
    0, 0, -2.020202, 0
  ];
  const viewport = { left: 0, top: 0, width: 1000, height: 1000 };
  const point = [{ x: 10, y: 0, z: 0 }];
  // Camera forward is +X. Its camera-right axis is world -Z, so an old
  // world-X radius approximation would collapse to the fallback radius.
  const lookingAlongX = [
    0, 0, -1, 0,
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 0, 1
  ];
  const index = new SpatialPickingIndex(48);
  const visible = index.query(580, 500, point, [2], [true], { view: lookingAlongX, projection }, viewport, 1, 1);
  const hidden = index.query(580, 500, point, [2], [false], { view: lookingAlongX, projection }, viewport, 2, 1);

  assert.equal(visible.instance, 0);
  assert.equal(hidden.instance, undefined);

  // Camera forward is +Y. The same billboard projection remains valid after
  // rotation, rather than assuming a world-axis-oriented node disc.
  const lookingAlongY = [
    1, 0, 0, 0,
    0, 0, -1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1
  ];
  const alongY = new SpatialPickingIndex(48).query(
    580,
    500,
    [{ x: 0, y: 10, z: 0 }],
    [2],
    [true],
    { view: lookingAlongY, projection },
    viewport,
    1,
    1
  );
  assert.equal(alongY.instance, 0);
});

test('SpatialPickingIndex keeps oversized nodes out of radius-expanded grid scans', () => {
  const normal = Array.from({ length: 400 }, (_, index) => ({
    x: -0.95 + (index % 20) * 0.1,
    y: 0.95 - Math.floor(index / 20) * 0.1,
    z: 0
  }));
  const positions = [{ x: 0, y: 0, z: -0.5 }, ...normal];
  const radii = [10, ...normal.map(() => 0.01)];
  const result = new SpatialPickingIndex(48).query(
    500,
    500,
    positions,
    radii,
    positions.map(() => true),
    { view: identityMatrix, projection: identityMatrix },
    { left: 0, top: 0, width: 1000, height: 1000 },
    1,
    1
  );

  assert.equal(result.instance, 0);
  assert.ok(result.scannedCellCount <= 6);
  assert.equal(result.oversizedCandidateCount, 1);
  assert.ok(result.ordinaryCandidateCount < 20);
  assert.equal(result.candidateCount, result.ordinaryCandidateCount + 1);
});

test('SpatialPickingIndex distributes many oversized nodes across bounded hierarchy cells', () => {
  const positions = Array.from({ length: 1_024 }, (_, index) => ({
    x: -0.96 + (index % 32) * 0.06,
    y: 0.96 - Math.floor(index / 32) * 0.06,
    z: index === 528 ? -0.5 : 0
  }));
  const viewport = { left: 0, top: 0, width: 4_096, height: 4_096 };
  const target = positions[528]!;
  const result = new SpatialPickingIndex(48).query(
    (target.x * 0.5 + 0.5) * viewport.width,
    (-target.y * 0.5 + 0.5) * viewport.height,
    positions,
    positions.map(() => 0.03),
    positions.map(() => true),
    { view: identityMatrix, projection: identityMatrix },
    viewport,
    1,
    1
  );

  assert.equal(result.instance, 528);
  assert.ok(result.scannedCellCount <= 8);
  assert.equal(result.ordinaryCandidateCount, 0);
  assert.ok(result.oversizedCandidateCount < positions.length / 20);
});

test('SpatialPickingIndex excludes candidates whose projected radius is not finite', () => {
  const viewport = { left: 0, top: 0, width: Number.MAX_VALUE, height: 1000 };
  const result = new SpatialPickingIndex(48).query(
    1,
    500,
    [{ x: 0, y: 0, z: 0 }],
    [Number.MAX_VALUE],
    [true],
    { view: identityMatrix, projection: identityMatrix },
    viewport,
    1,
    1
  );

  assert.equal(result.instance, undefined);
  assert.equal(result.candidateCount, 0);
});

test('SpatialPickingIndex retains overlapping offscreen circles and rejects invalid queries', () => {
  const index = new SpatialPickingIndex(48);
  const camera = { view: identityMatrix, projection: identityMatrix };
  const viewport = { left: 0, top: 0, width: 1000, height: 1000 };
  const overlapping = index.query(
    990,
    500,
    [{ x: 1.1, y: 0, z: 0 }],
    [0.2],
    [true],
    camera,
    viewport,
    1,
    1
  );
  const invalidPointer = index.query(
    Number.NaN,
    500,
    [{ x: 0, y: 0, z: 0 }],
    [1],
    [true],
    camera,
    viewport,
    2,
    1
  );
  const invalidViewport = index.query(
    0,
    0,
    [{ x: 0, y: 0, z: 0 }],
    [1],
    [true],
    camera,
    { ...viewport, width: Number.POSITIVE_INFINITY },
    2,
    1
  );

  assert.equal(overlapping.instance, 0);
  assert.equal(overlapping.oversizedCandidateCount, 1);
  assert.deepEqual(invalidPointer, {
    instance: undefined,
    candidateCount: 0,
    scannedCellCount: 0,
    ordinaryCandidateCount: 0,
    oversizedCandidateCount: 0,
    rebuilt: false
  });
  assert.deepEqual(invalidViewport, invalidPointer);
});
