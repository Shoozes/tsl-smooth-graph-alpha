import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createForceGraph3D } from '@ours/forcegraph-tsl';
import type { ForceGraph, ForceGraphOptions } from '@ours/forcegraph-tsl';
import type { GraphErrorCode, WorkerLike } from '@ours/forcegraph-tsl/core';
import type { CameraTweenPath, PerspectiveCameraFrameOptions } from '@ours/forcegraph-tsl/camera';
import type { LabelCandidate } from '@ours/forcegraph-tsl/labels';
import type { HeadlessGraphSnapshot } from '@ours/forcegraph-tsl/headless';

const protocolErrorCode: GraphErrorCode = 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED';
const graphFactory: (options?: ForceGraphOptions) => Promise<ForceGraph> = createForceGraph3D;
const optionalWorker: WorkerLike | undefined = undefined;
void protocolErrorCode;
void graphFactory;
void optionalWorker;
const labelCandidate: LabelCandidate = { id: 'label', bounds: { x: 0, y: 0, width: 1, height: 1 } };
void labelCandidate;
const cameraOptions: PerspectiveCameraFrameOptions = { aspect: 1, verticalFovDegrees: 50 };
void cameraOptions;
const cameraTweenPath: CameraTweenPath = { type: 'arc', offset: { x: 0, y: 4, z: 0 } };
void cameraTweenPath;
const headlessSnapshot: HeadlessGraphSnapshot = {
  schema: 'tsl-smooth-graph/graph-snapshot',
  version: 2,
  data: { nodes: [], links: [] }
};
void headlessSnapshot;

test('built package exposes every declared public subpath', async () => {
  const [root, core, three, layout, labels, camera, worker, headless] = await Promise.all([
    import('@ours/forcegraph-tsl'),
    import('@ours/forcegraph-tsl/core'),
    import('@ours/forcegraph-tsl/three'),
    import('@ours/forcegraph-tsl/layout'),
    import('@ours/forcegraph-tsl/labels'),
    import('@ours/forcegraph-tsl/camera'),
    import('@ours/forcegraph-tsl/worker'),
    import('@ours/forcegraph-tsl/headless')
  ]);

  assert.equal(typeof root.createForceGraph3D, 'function');
  assert.equal('GraphController' in root, false);
  assert.equal(typeof core.GraphController, 'function');
  assert.equal(typeof three.createThreePlatform, 'function');
  assert.equal(typeof layout.DeterministicForceLayout, 'function');
  assert.equal(typeof labels.planLabelVisibility, 'function');
  assert.equal(typeof camera.planPerspectiveCameraFrame, 'function');
  assert.equal(typeof camera.sampleCameraPoseTween, 'function');
  assert.equal(typeof worker.createForceGraphLayoutWorker, 'function');
  assert.equal(typeof headless.createHeadlessForceGraph, 'function');
  assert.ok(worker.forceGraphLayoutWorkerUrl instanceof URL);
  assert.throws(
    () => worker.createForceGraphLayoutWorker(),
    (error: unknown) => error instanceof root.GraphError && error.code === 'FG_LAYOUT_WORKER_FAILED'
  );
});
