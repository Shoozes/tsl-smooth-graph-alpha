import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';

import { GraphError } from '../../source/core/errors.js';
import { planPerspectiveCameraFocus, planPerspectiveCameraFrame, sampleCameraPoseTween } from '../../source/camera/index.js';

test('perspective camera framing centers finite graph bounds without mutating inputs', () => {
  const bounds = {
    min: { x: -10, y: -5, z: -2 },
    max: { x: 10, y: 5, z: 2 }
  };
  const direction = { x: 0, y: 3, z: 4 };
  const frame = planPerspectiveCameraFrame(bounds, {
    aspect: 1,
    verticalFovDegrees: 60,
    direction,
    padding: 1,
    minimumDistance: 0
  });

  const radius = Math.hypot(20, 10, 4) / 2;
  assert.deepEqual(bounds, {
    min: { x: -10, y: -5, z: -2 },
    max: { x: 10, y: 5, z: 2 }
  });
  assert.deepEqual(direction, { x: 0, y: 3, z: 4 });
  assert.deepEqual(frame.target, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(frame.radius - radius) < 1e-12);
  assert.ok(frame.distance < radius / Math.sin(Math.PI / 6));
  assert.ok(Math.abs(frame.position.y - frame.distance * 0.6) < 1e-12);
  assert.ok(Math.abs(frame.position.z - frame.distance * 0.8) < 1e-12);
  assert.ok(Object.isFrozen(frame));
  assert.ok(Object.isFrozen(frame.target));
  assert.ok(Object.isFrozen(frame.position));
});

test('perspective camera framing uses the limiting viewport field of view and minimum distance', () => {
  const bounds = {
    min: { x: -1, y: -1, z: -1 },
    max: { x: 1, y: 1, z: 1 }
  };
  const wide = planPerspectiveCameraFrame(bounds, {
    aspect: 2,
    verticalFovDegrees: 60,
    padding: 1,
    minimumDistance: 0
  });
  const narrow = planPerspectiveCameraFrame(bounds, {
    aspect: 0.5,
    verticalFovDegrees: 60,
    padding: 1,
    minimumDistance: 0
  });
  const point = planPerspectiveCameraFrame({
    min: { x: 2, y: 3, z: 4 },
    max: { x: 2, y: 3, z: 4 }
  }, {
    aspect: 1,
    verticalFovDegrees: 50,
    minimumDistance: 7
  });

  assert.ok(narrow.distance > wide.distance);
  assert.equal(point.distance, 7);
  assert.deepEqual(point.position, { x: 2, y: 3, z: 11 });
});

test('perspective camera framing uses projected extents for thin worlds and remains stable for tall viewports', () => {
  const thin = planPerspectiveCameraFrame({
    min: { x: -50, y: -0.25, z: -0.25 },
    max: { x: 50, y: 0.25, z: 0.25 }
  }, {
    aspect: 3,
    verticalFovDegrees: 60,
    direction: { x: 0, y: 0, z: 1 },
    padding: 1,
    minimumDistance: 0
  });
  const tall = planPerspectiveCameraFrame({
    min: { x: -1, y: -20, z: -1 },
    max: { x: 1, y: 20, z: 1 }
  }, {
    aspect: 0.35,
    verticalFovDegrees: 60,
    direction: { x: 0, y: 0, z: 1 },
    padding: 1,
    minimumDistance: 0
  });

  assert.ok(Math.abs(thin.distance - (50 / Math.tan(Math.PI / 6) / 3 + 0.25)) < 1e-12);
  assert.ok(Math.abs(tall.distance - (20 / Math.tan(Math.PI / 6) + 1)) < 1e-12);
  assert.ok(thin.distance < Math.hypot(100, 0.5, 0.5) / 2 / Math.sin(Math.PI / 6));
});

test('projected framing contains thin bounds near and at the Three lookAt poles', () => {
  const bounds = { min: { x: -40, y: -0.5, z: -0.5 }, max: { x: 40, y: 0.5, z: 0.5 } };
  for (const direction of [{ x: 0, y: 0.999999, z: 0.001 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }]) {
    const frame = planPerspectiveCameraFrame(bounds, {
      aspect: 0.3,
      verticalFovDegrees: 55,
      direction,
      padding: 1.05,
      minimumDistance: 0
    });
    const camera = new THREE.PerspectiveCamera(55, 0.3, 0.01, 100_000);
    camera.position.set(frame.position.x, frame.position.y, frame.position.z);
    camera.lookAt(frame.target.x, frame.target.y, frame.target.z);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const projected = new THREE.Vector3(x, y, z).project(camera);
          assert.ok(Math.abs(projected.x) <= 1 + 1e-9, `x escaped frame for ${JSON.stringify(direction)}`);
          assert.ok(Math.abs(projected.y) <= 1 + 1e-9, `y escaped frame for ${JSON.stringify(direction)}`);
        }
      }
    }
  }
});

test('camera focus and tween helpers are deterministic, immutable, and host-neutral', () => {
  const target = { x: 10, y: -2, z: 4 };
  const focus = planPerspectiveCameraFocus(target, 6, {
    aspect: 1,
    verticalFovDegrees: 60,
    direction: { x: 0, y: 0, z: 2 },
    padding: 1,
    minimumDistance: 0
  });
  const sample = sampleCameraPoseTween({
    from: { position: { x: 0, y: 0, z: 20 }, target: { x: 0, y: 0, z: 0 } },
    to: focus,
    durationMs: 800,
    easing: 'linear'
  }, 200);

  assert.deepEqual(target, { x: 10, y: -2, z: 4 });
  assert.equal(focus.radius, 6);
  assert.deepEqual(focus.target, target);
  assert.ok(Math.abs(focus.distance - 12) < 1e-12);
  assert.deepEqual(sample.position, { x: 2.5, y: -0.5, z: 19 });
  assert.deepEqual(sample.target, { x: 2.5, y: -0.5, z: 1 });
  assert.equal(sample.progress, 0.25);
  assert.equal(sample.complete, false);
  assert.equal(Object.isFrozen(sample), true);
});

test('camera tween path options support direct and caller-defined cinematic arcs', () => {
  const offset = { x: 0, y: 4, z: -2 };
  const options = {
    from: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } },
    to: { position: { x: 10, y: 0, z: 0 }, target: { x: 10, y: 0, z: 0 } },
    durationMs: 1_000,
    easing: 'linear' as const,
    path: { type: 'arc' as const, offset }
  };

  const start = sampleCameraPoseTween(options, 0);
  const midpoint = sampleCameraPoseTween(options, 500);
  const end = sampleCameraPoseTween(options, 1_000);

  assert.deepEqual(start.position, options.from.position);
  assert.deepEqual(midpoint.position, { x: 5, y: 4, z: -2 });
  assert.deepEqual(midpoint.target, { x: 5, y: 0, z: 0 });
  assert.deepEqual(end.position, options.to.position);
  assert.deepEqual(offset, { x: 0, y: 4, z: -2 });
  assert.equal(Object.isFrozen(midpoint.position), true);
});

test('perspective camera framing rejects invalid bounds and projection inputs', () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };

  assert.throws(
    () => planPerspectiveCameraFrame({ min: { x: 2, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, { aspect: 1, verticalFovDegrees: 50 }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_CAMERA_INVALID_BOUNDS'
  );
  assert.throws(
    () => planPerspectiveCameraFrame(bounds, { aspect: 0, verticalFovDegrees: 50 }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_CAMERA_INVALID_OPTIONS'
  );
  assert.throws(
    () => planPerspectiveCameraFrame(bounds, { aspect: 1, verticalFovDegrees: 180 }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_CAMERA_INVALID_OPTIONS'
  );
  assert.throws(
    () => planPerspectiveCameraFrame(bounds, { aspect: 1, verticalFovDegrees: 50, direction: { x: 0, y: 0, z: 0 } }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_CAMERA_INVALID_OPTIONS'
  );
  assert.throws(
    () => planPerspectiveCameraFocus({ x: 0, y: 0, z: 0 }, -1, { aspect: 1, verticalFovDegrees: 50 }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_CAMERA_INVALID_BOUNDS'
  );
  assert.throws(
    () => sampleCameraPoseTween({
      from: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } },
      to: { position: { x: 1, y: 1, z: 1 }, target: { x: 1, y: 1, z: 1 } },
      durationMs: -1
    }, 0),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_CAMERA_INVALID_OPTIONS'
  );
  assert.throws(
    () => sampleCameraPoseTween({
      from: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } },
      to: { position: { x: 1, y: 1, z: 1 }, target: { x: 1, y: 1, z: 1 } },
      durationMs: 100,
      path: { type: 'arc', offset: { x: 0, y: Number.NaN, z: 0 } }
    }, 0),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_CAMERA_INVALID_OPTIONS'
  );
});
