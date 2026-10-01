import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GraphError } from '../../source/core/errors.js';
import { BarnesHutOctree } from '../../source/layout/BarnesHutOctree.js';
import { DeterministicForceLayout, resolveLayoutConfiguration } from '../../source/layout/ForceLayout.js';

function fixture() {
  return {
    nodeIndices: new Uint32Array([4, 9, 12]),
    positions: new Float32Array([-20, 0, 0, 0, 0, 0, 20, 0, 0]),
    velocities: new Float32Array(9),
    fixedMask: new Uint8Array(3),
    fixedPositions: new Float32Array(9),
    links: new Uint32Array([0, 1, 1, 2])
  };
}

test('layout configuration normalizes an invalid runtime dimension to 3D', () => {
  assert.equal(resolveLayoutConfiguration({ dimensions: 4 as 2 | 3 }).dimensions, 3);
});

test('direct layout configuration caps caller-controlled work at the shared hard ceilings', () => {
  const configuration = resolveLayoutConfiguration({
    maxStepsPerUpdate: Number.MAX_SAFE_INTEGER,
    maxStepsPerRequest: Number.MAX_SAFE_INTEGER
  });
  assert.equal(configuration.maxStepsPerUpdate, 256);
  assert.equal(configuration.maxStepsPerRequest, 4_096);
});

test('layout initialization accepts a partial alpha while explicit restart fully reheats', () => {
  const layout = new DeterministicForceLayout({ alphaMinimum: 0.001 });
  layout.initialize(fixture(), { alpha: 0.35 });
  assert.equal(layout.currentAlpha, 0.35);
  layout.restart();
  assert.equal(layout.currentAlpha, 1);
});

test('pin movement and release reheat only to the interaction floor without resetting steps', () => {
  const layout = new DeterministicForceLayout({
    alphaMinimum: 1e-9,
    alphaDecay: 0.5,
    interactionReheatAlpha: 0.2
  });
  layout.initialize(fixture(), { alpha: 0.1 });
  layout.start();
  layout.runSteps(1);
  const steps = layout.steps;
  assert.equal(layout.setPinnedNode(9, { x: 3, y: 4, z: 5 }), true);
  assert.equal(layout.currentAlpha, 0.2);
  assert.equal(layout.steps, steps);
  assert.equal(layout.setPinnedNode(9, { x: 3, y: 4, z: 5 }), false);
  assert.equal(layout.currentAlpha, 0.2);
  assert.equal(layout.setPinnedNode(9, { x: 4, y: 4, z: 5 }), true);
  assert.equal(layout.currentAlpha, 0.2);
  assert.equal(layout.releasePinnedNode(9), true);
  assert.equal(layout.currentAlpha, 0.2);
  assert.equal(layout.releasePinnedNode(9), false);
  layout.restart();
  assert.equal(layout.currentAlpha, 1);
});

test('DeterministicForceLayout produces repeatable fixed-step snapshots', () => {
  const first = new DeterministicForceLayout({ dimensions: 3, chargeStrength: -30, linkDistance: 12 });
  const second = new DeterministicForceLayout({ dimensions: 3, chargeStrength: -30, linkDistance: 12 });
  first.initialize(fixture());
  second.initialize(fixture());
  first.start();
  second.start();
  const firstSnapshot = first.step(30);
  const secondSnapshot = second.step(30);

  assert.deepEqual([...firstSnapshot.positions], [...secondSnapshot.positions]);
  assert.deepEqual([...firstSnapshot.velocities], [...secondSnapshot.velocities]);
  assert.ok(firstSnapshot.alpha <= 1);
  assert.ok(firstSnapshot.positions.every(Number.isFinite));
});

test('DeterministicForceLayout writes a snapshot into caller-owned transfer buffers', () => {
  const layout = new DeterministicForceLayout({ chargeStrength: -30 });
  layout.initialize(fixture());
  layout.runSteps(2);
  const buffers = {
    nodeIndices: new Uint32Array(layout.snapshotNodeCount),
    positions: new Float32Array(layout.snapshotNodeCount * 3),
    velocities: new Float32Array(layout.snapshotNodeCount * 3)
  };
  const snapshot = layout.snapshotInto(buffers);
  const copied = layout.snapshot();

  assert.equal(snapshot.nodeIndices, buffers.nodeIndices);
  assert.equal(snapshot.positions, buffers.positions);
  assert.equal(snapshot.velocities, buffers.velocities);
  assert.deepEqual([...snapshot.positions], [...copied.positions]);
  assert.deepEqual([...snapshot.velocities], [...copied.velocities]);
});

test('DeterministicForceLayout reports an invalid caller-owned snapshot buffer through the layout error contract', () => {
  const layout = new DeterministicForceLayout();
  layout.initialize(fixture());

  assert.throws(
    () => layout.snapshotInto({
      nodeIndices: new Uint32Array(2),
      positions: new Float32Array(6),
      velocities: new Float32Array(6)
    }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED'
  );
});

test('DeterministicForceLayout honors a pinned node across solver steps', () => {
  const layout = new DeterministicForceLayout({ chargeStrength: -50 });
  layout.initialize(fixture());
  layout.setPinnedNode(9, { x: 3, y: 4, z: 5 });
  const snapshot = layout.step(10);
  const denseIndex = snapshot.nodeIndices.indexOf(9);
  const offset = denseIndex * 3;

  assert.equal(snapshot.positions[offset], 3);
  assert.equal(snapshot.positions[offset + 1], 4);
  assert.equal(snapshot.positions[offset + 2], 5);
});

test('DeterministicForceLayout settles from movable axes instead of diluting motion with pinned nodes', () => {
  const createPinnedMajority = (dimensions: 2 | 3) => {
    const nodeCount = 101;
    const movingNode = nodeCount - 1;
    const fixedMask = new Uint8Array(nodeCount);
    fixedMask.fill(dimensions === 3 ? 0b111 : 0b011);
    fixedMask[movingNode] = dimensions === 3 ? 0b011 : 0b001;
    const velocities = new Float32Array(nodeCount * 3);
    velocities[movingNode * 3 + (dimensions === 3 ? 2 : 1)] = 1;
    const layout = new DeterministicForceLayout({
      dimensions,
      chargeStrength: 0,
      linkStrength: 0,
      centerStrength: 0,
      velocityDecay: 1,
      alphaDecay: 0,
      settleThreshold: 0.2
    });
    layout.initialize({
      nodeIndices: Uint32Array.from({ length: nodeCount }, (_, index) => index),
      positions: new Float32Array(nodeCount * 3),
      velocities,
      fixedMask,
      fixedPositions: new Float32Array(nodeCount * 3),
      links: new Uint32Array(0)
    });
    layout.start();
    return layout.step(1);
  };

  assert.equal(createPinnedMajority(2).settled, false);
  assert.equal(createPinnedMajority(3).settled, false);

  const allPinned = new DeterministicForceLayout({
    dimensions: 3,
    chargeStrength: 0,
    linkStrength: 0,
    centerStrength: 0,
    alphaDecay: 0
  });
  allPinned.initialize({
    nodeIndices: new Uint32Array([0, 1]),
    positions: new Float32Array(6),
    velocities: new Float32Array([4, 5, 6, 7, 8, 9]),
    fixedMask: new Uint8Array([0b111, 0b111]),
    fixedPositions: new Float32Array(6),
    links: new Uint32Array(0)
  });
  allPinned.start();
  assert.equal(allPinned.step(1).settled, true);
});

test('DeterministicForceLayout bounds catch-up and ignores invalid elapsed time', () => {
  const layout = new DeterministicForceLayout({ maxStepsPerUpdate: 3 });
  layout.initialize(fixture());
  layout.start();

  layout.advance(0);
  layout.advance(Number.POSITIVE_INFINITY);
  assert.equal(layout.steps, 0);

  layout.advance(1);
  assert.equal(layout.steps, 3);

  const fractional = new DeterministicForceLayout({ fixedDeltaSeconds: 0.1 });
  fractional.initialize(fixture());
  fractional.start();
  fractional.advance(0.05);
  assert.equal(fractional.steps, 0);
  fractional.advance(0.05);
  assert.equal(fractional.steps, 1);
});

test('DeterministicForceLayout keeps an explicit stop effective for elapsed-time advancement', () => {
  const layout = new DeterministicForceLayout();
  layout.initialize(fixture());
  layout.start();
  layout.stop();

  layout.advance(1);

  assert.equal(layout.isRunning, false);
  assert.equal(layout.steps, 0);
  layout.step(1);
  assert.equal(layout.steps, 1);
});

test('DeterministicForceLayout rejects excessive explicit work and uses constant-time slot lookups', () => {
  const layout = new DeterministicForceLayout({ maxStepsPerRequest: 2, dimensions: 2 });
  layout.initialize(fixture());

  assert.throws(
    () => layout.runSteps(3),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_STEP_LIMIT_EXCEEDED'
  );
  layout.setPinnedNode(9, { x: 3, y: 4, z: 99 });
  const snapshot = layout.snapshot();
  const denseIndex = snapshot.nodeIndices.indexOf(9);
  assert.equal(snapshot.positions[denseIndex * 3 + 2], 0);
  assert.equal(snapshot.velocities[denseIndex * 3 + 2], 0);
});

test('DeterministicForceLayout ignores input Z in two-dimensional charge calculations', () => {
  const create = (z: number) => {
    const layout = new DeterministicForceLayout({
      dimensions: 2,
      chargeStrength: -50,
      centerStrength: 0,
      linkStrength: 0,
      alphaDecay: 0
    });
    layout.initialize({
      nodeIndices: new Uint32Array([0, 1]),
      positions: new Float32Array([0, 0, z, 10, 0, -z]),
      velocities: new Float32Array(6),
      fixedMask: new Uint8Array(2),
      fixedPositions: new Float32Array(6),
      links: new Uint32Array(0)
    });
    return layout.step(1);
  };

  const planar = create(0);
  const nonPlanarInput = create(50_000);
  assert.deepEqual([...nonPlanarInput.positions], [...planar.positions]);
  assert.deepEqual([...nonPlanarInput.velocities], [...planar.velocities]);
  assert.equal(nonPlanarInput.positions[2], 0);
  assert.equal(nonPlanarInput.positions[5], 0);
});

test('DeterministicForceLayout separates colocated nodes deterministically', () => {
  const layout = new DeterministicForceLayout({ chargeStrength: -50, centerStrength: 0 });
  layout.initialize({
    nodeIndices: new Uint32Array([0, 1]),
    positions: new Float32Array(6),
    velocities: new Float32Array(6),
    fixedMask: new Uint8Array(2),
    fixedPositions: new Float32Array(6),
    links: new Uint32Array([0, 1])
  });
  layout.start();
  const snapshot = layout.step(1);

  assert.notDeepEqual(
    [...snapshot.positions.subarray(0, 3)],
    [...snapshot.positions.subarray(3, 6)]
  );
});

test('DeterministicForceLayout enforces deterministic minimum spacing in 2D and 3D', () => {
  const solve = (dimensions: 2 | 3) => {
    const layout = new DeterministicForceLayout({
      dimensions,
      chargeStrength: 0,
      linkStrength: 0,
      centerStrength: 0,
      velocityDecay: 1,
      alphaDecay: 0,
      minimumNodeDistance: 12,
      separationStrength: 1,
      separationIterations: 1
    });
    layout.initialize({
      nodeIndices: new Uint32Array([7, 11]),
      positions: new Float32Array(6),
      velocities: new Float32Array(6),
      fixedMask: new Uint8Array(2),
      fixedPositions: new Float32Array(6),
      links: new Uint32Array([0, 1])
    });
    layout.start();
    const snapshot = layout.step(1);
    return { snapshot, diagnostics: layout.separationDiagnostics };
  };

  for (const dimensions of [2, 3] as const) {
    const first = solve(dimensions);
    const second = solve(dimensions);
    assert.deepEqual([...first.snapshot.positions], [...second.snapshot.positions]);
    assert.ok(Math.abs(Math.hypot(
      first.snapshot.positions[3]! - first.snapshot.positions[0]!,
      first.snapshot.positions[4]! - first.snapshot.positions[1]!,
      first.snapshot.positions[5]! - first.snapshot.positions[2]!
    ) - 12) < 1e-5);
    assert.equal(first.diagnostics.resolvableOverlapPairCount, 0);
    assert.ok(first.diagnostics.pairChecks >= 2);
  }
});

test('minimum spacing diagnostics measure the post-movement positions', () => {
  const layout = new DeterministicForceLayout({
    dimensions: 2,
    chargeStrength: 0,
    linkStrength: 0,
    centerStrength: 0,
    velocityDecay: 1,
    alphaDecay: 0,
    minimumNodeDistance: 12,
    separationStrength: 1,
    separationIterations: 1
  });
  layout.initialize({
    nodeIndices: new Uint32Array([0, 1]),
    positions: new Float32Array(6),
    velocities: new Float32Array(6),
    fixedMask: new Uint8Array(2),
    fixedPositions: new Float32Array(6),
    links: new Uint32Array(0)
  });
  layout.start();
  layout.step(1);
  assert.equal(layout.separationDiagnostics.resolvableOverlapPairCount, 0);

  // Move the live position after the prior spatial sweep. The next report
  // must describe this position, not the old sweep's cell snapshot.
  assert.equal(layout.setPinnedNode(0, { x: 100, y: 0, z: 0 }), true);
  layout.step(1);
  assert.equal(layout.separationDiagnostics.resolvableOverlapPairCount, 0);
  assert.equal(layout.separationDiagnostics.maximumPenetration, 0);
});

test('minimum spacing respects pinned and partially fixed axes without blocking all-pinned settlement', () => {
  const create = (fixedMask: Uint8Array) => {
    const layout = new DeterministicForceLayout({
      dimensions: 2,
      chargeStrength: 0,
      linkStrength: 0,
      centerStrength: 0,
      velocityDecay: 1,
      alphaDecay: 0,
      minimumNodeDistance: 10,
      separationStrength: 1
    });
    layout.initialize({
      nodeIndices: new Uint32Array([0, 1]),
      positions: new Float32Array(6),
      velocities: new Float32Array(6),
      fixedMask,
      fixedPositions: new Float32Array(6),
      links: new Uint32Array(0)
    });
    layout.start();
    return layout;
  };

  const onePinned = create(new Uint8Array([0b011, 0]));
  const onePinnedSnapshot = onePinned.step(1);
  assert.deepEqual([...onePinnedSnapshot.positions.subarray(0, 3)], [0, 0, 0]);
  assert.ok(Math.abs(Math.hypot(onePinnedSnapshot.positions[3]!, onePinnedSnapshot.positions[4]!) - 10) < 1e-5);

  const xFixed = create(new Uint8Array([0b001, 0b001]));
  const xFixedSnapshot = xFixed.step(1);
  assert.equal(xFixedSnapshot.positions[0], 0);
  assert.equal(xFixedSnapshot.positions[3], 0);
  assert.ok(Math.abs(Math.abs(xFixedSnapshot.positions[4]! - xFixedSnapshot.positions[1]!) - 10) < 1e-5);

  const allPinned = create(new Uint8Array([0b011, 0b011]));
  const allPinnedSnapshot = allPinned.step(1);
  assert.equal(allPinnedSnapshot.settled, true);
  assert.deepEqual([...allPinnedSnapshot.positions], [0, 0, 0, 0, 0, 0]);
  assert.equal(allPinned.separationDiagnostics.resolvableOverlapPairCount, 0);
});

test('minimum spacing uses subquadratic pair checks for separated nodes', () => {
  const nodeCount = 4_096;
  const positions = new Float32Array(nodeCount * 3);
  for (let node = 0; node < nodeCount; node += 1) positions[node * 3] = node * 3;
  const layout = new DeterministicForceLayout({
    dimensions: 2,
    chargeStrength: 0,
    linkStrength: 0,
    centerStrength: 0,
    minimumNodeDistance: 1,
    separationStrength: 1
  });
  layout.initialize({
    nodeIndices: Uint32Array.from({ length: nodeCount }, (_, index) => index),
    positions,
    velocities: new Float32Array(nodeCount * 3),
    fixedMask: new Uint8Array(nodeCount),
    fixedPositions: new Float32Array(nodeCount * 3),
    links: new Uint32Array(0)
  });
  layout.start();
  layout.step(1);

  assert.ok(layout.separationDiagnostics.pairChecks < nodeCount * 4);
  assert.equal(layout.separationDiagnostics.resolvableOverlapPairCount, 0);
});

test('minimum spacing bounds fully collocated pair work and continues deterministically', () => {
  const nodeCount = 4_096;
  const create = () => {
    const layout = new DeterministicForceLayout({
      dimensions: 2,
      chargeStrength: 0,
      linkStrength: 0,
      centerStrength: 0,
      velocityDecay: 1,
      alphaDecay: 0,
      minimumNodeDistance: 1,
      separationStrength: 0.5,
      maxSeparationPairChecksPerStep: 5_000
    });
    layout.initialize({
      nodeIndices: Uint32Array.from({ length: nodeCount }, (_, index) => index),
      positions: new Float32Array(nodeCount * 3),
      velocities: new Float32Array(nodeCount * 3),
      fixedMask: new Uint8Array(nodeCount),
      fixedPositions: new Float32Array(nodeCount * 3),
      links: new Uint32Array(0)
    });
    layout.start();
    return layout;
  };
  const first = create();
  const second = create();
  const firstSnapshot = first.step(3);
  const secondSnapshot = second.step(3);
  assert.deepEqual([...firstSnapshot.positions], [...secondSnapshot.positions]);
  assert.ok(first.separationDiagnostics.pairChecks <= 5_000);
  assert.equal(first.separationDiagnostics.budgetExhausted, true);
  assert.ok(first.separationDiagnostics.deferredPairCount > 0);
});

test('minimum spacing reports constrained settlement after deterministic no-progress', () => {
  const layout = new DeterministicForceLayout({
    dimensions: 2,
    chargeStrength: 0,
    linkStrength: 0,
    centerStrength: 0,
    velocityDecay: 1,
    alphaDecay: 0,
    settleThreshold: Number.MIN_VALUE,
    minimumNodeDistance: 1,
    separationStrength: Number.MIN_VALUE,
    maxSeparationPairChecksPerStep: 10
  });
  layout.initialize({
    nodeIndices: new Uint32Array([0, 1]),
    positions: new Float32Array(6),
    velocities: new Float32Array(6),
    fixedMask: new Uint8Array(2),
    fixedPositions: new Float32Array(6),
    links: new Uint32Array(0)
  });
  layout.start();
  const snapshot = layout.step(130);
  assert.equal(snapshot.settled, true);
  assert.equal(layout.separationDiagnostics.constrainedSettlement, true);
  assert.equal(layout.separationDiagnostics.consecutiveNoProgressSteps, 120);
  assert.ok(layout.separationDiagnostics.verificationSweepsCompleted >= 121);
  assert.equal(layout.separationDiagnostics.verifiedOverlapPairCount, 1);
  assert.ok(layout.separationDiagnostics.verifiedMaximumPenetration > 0);
  assert.ok(layout.separationDiagnostics.correctionSweepsCompleted >= layout.separationDiagnostics.verificationSweepsCompleted);
  layout.restart();
  assert.equal(layout.isRunning, true);
  assert.equal(layout.separationDiagnostics.constrainedSettlement, false);
  assert.equal(layout.separationDiagnostics.consecutiveNoProgressSteps, 0);
});

test('minimum spacing counts no-progress only after a bounded pair sweep completes', () => {
  const layout = new DeterministicForceLayout({
    dimensions: 2,
    chargeStrength: 0,
    linkStrength: 0,
    centerStrength: 0,
    velocityDecay: 1,
    alphaDecay: 0,
    settleThreshold: Number.MIN_VALUE,
    minimumNodeDistance: 1,
    separationStrength: Number.MIN_VALUE,
    maxSeparationPairChecksPerStep: 1
  });
  layout.initialize({
    nodeIndices: new Uint32Array([0, 1, 2]),
    positions: new Float32Array(9),
    velocities: new Float32Array(9),
    fixedMask: new Uint8Array(3),
    fixedPositions: new Float32Array(9),
    links: new Uint32Array(0)
  });
  layout.start();
  layout.step(2);
  assert.equal(layout.separationDiagnostics.budgetExhausted, true);
  assert.equal(layout.separationDiagnostics.consecutiveNoProgressSteps, 0);
  layout.step(1);
  assert.equal(layout.separationDiagnostics.budgetExhausted, false);
  assert.equal(layout.separationDiagnostics.deferredPairCount, 0);
  assert.equal(layout.separationDiagnostics.consecutiveNoProgressSteps, 0);
  layout.step(3);
  assert.equal(layout.separationDiagnostics.verificationSweepsCompleted, 1);
  assert.equal(layout.separationDiagnostics.consecutiveNoProgressSteps, 0);
  const snapshot = layout.step(120);
  assert.equal(snapshot.settled, false);
  assert.equal(layout.separationDiagnostics.constrainedSettlement, false);
  assert.ok(layout.separationDiagnostics.consecutiveNoProgressSteps < 60);
});

test('minimum spacing completes a frozen read-only verification sweep across bounded steps', () => {
  const nodeCount = 4;
  const velocities = new Float32Array(nodeCount * 3);
  for (let node = 0; node < nodeCount; node += 1) velocities[node * 3] = 1;
  const layout = new DeterministicForceLayout({
    dimensions: 2,
    chargeStrength: 0,
    linkStrength: 0,
    centerStrength: 0,
    velocityDecay: 1,
    alphaDecay: 0,
    settleThreshold: Number.MIN_VALUE,
    minimumNodeDistance: 1,
    separationStrength: Number.MIN_VALUE,
    maxSeparationPairChecksPerStep: 2
  });
  layout.initialize({
    nodeIndices: Uint32Array.from({ length: nodeCount }, (_, index) => index),
    positions: new Float32Array(nodeCount * 3),
    velocities,
    fixedMask: new Uint8Array(nodeCount),
    fixedPositions: new Float32Array(nodeCount * 3),
    links: new Uint32Array(0)
  });
  layout.start();

  layout.step(3);
  assert.equal(layout.separationDiagnostics.correctionSweepsCompleted, 1);
  assert.equal(layout.separationDiagnostics.verificationSweepsCompleted, 0);
  const verificationEpochPositions = layout.snapshot().positions;

  layout.step(1);
  assert.equal(layout.separationDiagnostics.budgetExhausted, true);
  assert.equal(layout.separationDiagnostics.verificationSweepsCompleted, 0);
  assert.deepEqual([...layout.snapshot().positions], [...verificationEpochPositions]);

  layout.step(2);
  assert.equal(layout.separationDiagnostics.verificationSweepsCompleted, 1);
  assert.equal(layout.separationDiagnostics.verifiedOverlapPairCount, 6);
  assert.ok(layout.separationDiagnostics.verifiedMaximumPenetration > 0);
  assert.deepEqual([...layout.snapshot().positions], [...verificationEpochPositions]);
});

test('effective pin and release changes begin a fresh separation epoch', () => {
  const layout = new DeterministicForceLayout({
    dimensions: 2,
    chargeStrength: 0,
    linkStrength: 0,
    centerStrength: 0,
    velocityDecay: 1,
    alphaDecay: 0,
    minimumNodeDistance: 1,
    separationStrength: Number.MIN_VALUE
  });
  layout.initialize({
    nodeIndices: new Uint32Array([7, 8]),
    positions: new Float32Array(6),
    velocities: new Float32Array(6),
    fixedMask: new Uint8Array(2),
    fixedPositions: new Float32Array(6),
    links: new Uint32Array(0)
  });
  layout.start();
  layout.step(5);
  assert.ok(layout.separationDiagnostics.consecutiveNoProgressSteps > 0);
  assert.equal(layout.setPinnedNode(7, { x: 0, y: 0, z: 0 }), true);
  assert.equal(layout.separationDiagnostics.consecutiveNoProgressSteps, 0);
  layout.step(5);
  assert.ok(layout.separationDiagnostics.consecutiveNoProgressSteps > 0);
  assert.equal(layout.releasePinnedNode(7), true);
  assert.equal(layout.separationDiagnostics.consecutiveNoProgressSteps, 0);
});

test('DeterministicForceLayout rejects malformed layout buffers before replacing state', () => {
  const layout = new DeterministicForceLayout();

  assert.throws(
    () => layout.initialize({
      nodeIndices: new Uint32Array([0, 0]),
      positions: new Float32Array(6),
      velocities: new Float32Array(6),
      fixedMask: new Uint8Array(2),
      fixedPositions: new Float32Array(6),
      links: new Uint32Array(0)
    }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED'
  );
  assert.equal(layout.snapshot().nodeIndices.length, 0);
});

test('DeterministicForceLayout rejects non-finite typed state before replacing state', () => {
  const layout = new DeterministicForceLayout();
  assert.throws(
    () => layout.initialize({
      nodeIndices: new Uint32Array([0]),
      positions: new Float32Array([Number.NaN, 0, 0]),
      velocities: new Float32Array(3),
      fixedMask: new Uint8Array(1),
      fixedPositions: new Float32Array(3),
      links: new Uint32Array(0)
    }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_BUFFER_PROTOCOL_FAILED'
  );
  assert.equal(layout.snapshot().nodeIndices.length, 0);
});

test('DeterministicForceLayout rejects finite inputs that overflow solver output', () => {
  const layout = new DeterministicForceLayout({
    chargeStrength: 1e308,
    linkStrength: 0,
    centerStrength: 0,
    fixedDeltaSeconds: 1,
    velocityDecay: 1,
    alphaDecay: 0
  });
  layout.initialize({
    nodeIndices: new Uint32Array([1, 2]),
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    velocities: new Float32Array(6),
    fixedMask: new Uint8Array(2),
    fixedPositions: new Float32Array(6),
    links: new Uint32Array(0)
  });
  layout.start();
  assert.throws(
    () => layout.step(1),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_LAYOUT_NONFINITE_OUTPUT'
  );
  assert.equal(layout.isRunning, false);
});

test('BarnesHutOctree reuses cell storage without changing deterministic forces', () => {
  const positions = new Float32Array([
    -4, -2, 0,
    0, 0, 0,
    4, 2, 0,
    0, 0, 0
  ]);
  const octree = new BarnesHutOctree();
  const options = { theta: 0.8, strength: -20, softening: 0.5, dimensions: 2 as const };
  octree.build(positions, 4, 2);
  const firstStorage = (octree as unknown as { cellPool: unknown[] }).cellPool.length;
  const first = new Float64Array(12);
  for (let index = 0; index < 4; index += 1) {
    octree.apply(index, first, options);
  }

  octree.build(positions, 4, 2);
  const secondStorage = (octree as unknown as { cellPool: unknown[] }).cellPool.length;
  const second = new Float64Array(12);
  for (let index = 0; index < 4; index += 1) {
    octree.apply(index, second, options);
  }

  assert.equal(secondStorage, firstStorage);
  assert.deepEqual([...second], [...first]);
});

test('DeterministicForceLayout bounds deeply collocated leaves deterministically', () => {
  const makeLayout = () => {
    const layout = new DeterministicForceLayout({ maxStepsPerRequest: 2 });
    const nodeIndices = Uint32Array.from({ length: 256 }, (_, index) => index);
    layout.initialize({
      nodeIndices,
      positions: new Float32Array(nodeIndices.length * 3),
      velocities: new Float32Array(nodeIndices.length * 3),
      fixedMask: new Uint8Array(nodeIndices.length),
      fixedPositions: new Float32Array(nodeIndices.length * 3),
      links: new Uint32Array(0)
    });
    layout.start();
    layout.step(1);
    return layout.snapshot();
  };
  const first = makeLayout();
  const second = makeLayout();
  assert.deepEqual([...second.positions], [...first.positions]);
  assert.deepEqual([...second.velocities], [...first.velocities]);
  assert.equal([...first.positions].every(Number.isFinite), true);
});
