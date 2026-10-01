import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

import { createForceGraph3D, createThreePlatform, InvalidationReason, NodeFlags } from '../../source/index.js';
import { GraphError } from '../../source/core/errors.js';
import type { WorkerLike } from '../../source/core/types.js';
import { GraphStore } from '../../source/data/GraphStore.js';
import { ThreeGraphRenderer } from '../../source/render/ThreeGraphRenderer.js';

test('embedded mode uses the supplied Three instance and does not dispose borrowed resources', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  let renderCalls = 0;
  let disposeCalls = 0;
  const renderer = {
    render: () => { renderCalls += 1; },
    dispose: () => { disposeCalls += 1; }
  };
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer },
    layout: { backend: 'local', autoStart: false }
  });

  graph.setData({
    nodes: [{ id: 'a', initialPosition: { x: -2, y: 0, z: 0 } }, { id: 'b', initialPosition: { x: 2, y: 0, z: 0 } }],
    links: [{ id: 'a-b', source: 'a', target: 'b' }]
  });
  const graphObject = graph.object3D;
  assert.ok(graphObject instanceof THREE.Object3D);
  assert.equal(scene.children.includes(graphObject as THREE.Object3D), true);
  graph.render();
  assert.equal(graph.getDiagnostics().drawCalls, 2);

  graph.setLinkStyle({ opacity: 0.2 });
  const linkMesh = (graphObject as THREE.Object3D).children[0] as THREE.InstancedMesh;
  const linkMaterial = linkMesh.material as THREE.Material;
  assert.equal(linkMaterial.opacity, 0.2);
  assert.equal(linkMaterial.transparent, true);
  assert.equal(linkMaterial.depthWrite, false);

  graph.render();
  assert.equal(renderCalls, 0);
  graph.dispose();
  assert.equal(disposeCalls, 0);
  assert.equal(scene.children.includes(graphObject as THREE.Object3D), false);
});

test('startup report replays embedded backend policy and fallback facts', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: {
      mode: 'embedded',
      scene,
      camera,
      renderer: {
        backend: { isWebGLBackend: true },
        render: () => undefined,
        dispose: () => undefined
      }
    },
    renderer: { backend: 'webgpu-preferred' },
    layout: { backend: 'local', autoStart: false }
  });

  const report = graph.getStartupReport();
  assert.equal(report.hostMode, 'embedded');
  assert.deepEqual(report.layout, { requested: 'local', selected: 'local' });
  assert.equal(report.renderer.policy, 'webgpu-preferred');
  assert.equal(report.renderer.selected, 'webgl2');
  assert.equal(report.renderer.materialPath, 'tsl');
  assert.equal(report.renderer.transformPath, 'tsl');
  assert.equal(report.renderer.requestedWidthUnit, 'world');
  assert.equal(report.renderer.selectedWidthUnit, 'world');
  assert.equal(report.renderer.cameraProjection, 'perspective');
  assert.equal(report.renderer.nodeDynamicOpacityRequested, false);
  assert.equal(report.renderer.nodeDynamicOpacitySelected, false);
  assert.equal(report.renderer.linkDynamicOpacityRequested, false);
  assert.equal(report.renderer.linkDynamicOpacitySelected, false);
  assert.ok(report.warnings.some((warning) => warning.code === 'FG_STARTUP_RENDERER_FALLBACK'));
  assert.equal(Object.isFrozen(report), true);
  graph.dispose();
});

test('camera-pose API applies finite host camera changes and invalidates picking', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 20);
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    renderer: { nodeSurface: { profile: 'flat' } },
    layout: { backend: 'local', autoStart: false }
  });
  const before = graph.getDiagnostics().pickingRevision;

  graph.setCameraPose({ position: { x: 6, y: 7, z: 8 }, target: { x: 1, y: 2, z: 3 } });

  assert.deepEqual(graph.getCameraPose(), {
    position: { x: 6, y: 7, z: 8 },
    target: { x: 1, y: 2, z: 3 }
  });
  assert.deepEqual(camera.position.toArray(), [6, 7, 8]);
  assert.ok(graph.getDiagnostics().pickingRevision > before);
  graph.dispose();
});

test('embedded patches preserve layout for payloads and rebuild rendered layers for topology', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D<{ radius: number }>({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    layout: { backend: 'local', autoStart: false },
    nodes: { radius: (node) => node.data?.radius ?? 1 }
  });
  graph.setData({
    nodes: [{ id: 'a', data: { radius: 1 } }, { id: 'b', data: { radius: 1 } }],
    links: [{ id: 'a-b', source: 'a', target: 'b' }]
  });
  const graphObject = graph.object3D as THREE.Object3D;
  graph.render();
  const linkMesh = graphObject.children[0] as THREE.Mesh;
  const nodeMesh = graphObject.children[1] as THREE.Mesh;
  const before = graph.getDiagnostics();
  assert.equal(before.transformPath, 'tsl');
  const nodeRadiusAttribute = nodeMesh.geometry.getAttribute('graphRadius') as THREE.InstancedBufferAttribute;
  const linkWidthAttribute = linkMesh.geometry.getAttribute('graphWidth') as THREE.InstancedBufferAttribute;
  const nodeRadiusVersion = nodeRadiusAttribute.version;
  const linkWidthVersion = linkWidthAttribute.version;

  graph.applyPatch({ nodes: { upsert: [{ id: 'a', data: { radius: 3 } }] } });
  graph.render();

  const after = graph.getDiagnostics();
  assert.equal(after.layoutRevision, before.layoutRevision);
  assert.equal(after.layoutAlpha, before.layoutAlpha);
  assert.ok(nodeRadiusAttribute.version > nodeRadiusVersion);
  assert.equal(linkWidthAttribute.version, linkWidthVersion);

  graph.applyPatch({ nodes: { remove: ['a'] } });
  graph.render();

  const topology = graph.getDiagnostics();
  const topologyLinkMesh = graphObject.children[0] as THREE.Mesh;
  const topologyNodeMesh = graphObject.children[1] as THREE.Mesh;
  assert.equal(topology.layoutRevision, before.layoutRevision + 1);
  assert.equal(topology.renderedNodeCount, 1);
  assert.equal(topology.renderedLinkSegmentCount, 0);
  assert.notEqual(topologyNodeMesh, nodeMesh);
  assert.notEqual(topologyLinkMesh, linkMesh);
  assert.equal((topologyNodeMesh.geometry as THREE.InstancedBufferGeometry).instanceCount, 1);
  assert.equal((topologyLinkMesh.geometry as THREE.InstancedBufferGeometry).instanceCount, 0);
  assert.equal('instanceMatrix' in topologyNodeMesh, false);
  assert.equal('instanceMatrix' in topologyLinkMesh, false);
  graph.dispose();
});

test('targeted node-style refresh is atomic and sparse on TSL and CPU fallback paths', async () => {
  for (const [label, tsl] of [
    ['tsl', TSL as unknown as Record<string, unknown>],
    ['cpu', {} as Record<string, unknown>]
  ] as const) {
    const scaleById = new Map<string, number>([['a', 1], ['b', 1]]);
    let failB = false;
    const graph = await createForceGraph3D({
      platform: createThreePlatform({ THREE: THREE as unknown as Record<string, unknown>, TSL: tsl }),
      host: {
        mode: 'embedded',
        scene: new THREE.Scene(),
        camera: new THREE.PerspectiveCamera(),
        renderer: { render: () => undefined, dispose: () => undefined }
      },
      layout: { backend: 'local', autoStart: false },
      nodes: {
        radius: (node) => {
          if (node.id === 'b' && failB) throw new Error('style failed');
          return scaleById.get(String(node.id)) ?? 1;
        }
      }
    });
    graph.setData({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ id: 'a-b', source: 'a', target: 'b' }]
    });
    graph.render();
    const nodeMesh = (graph.object3D as THREE.Object3D).children[1] as THREE.Mesh;
    const radius = nodeMesh.geometry.getAttribute('graphRadius') as THREE.InstancedBufferAttribute | undefined;
    const readRadius = (): number => {
      if (radius) return radius.array[0]!;
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3();
      (nodeMesh as THREE.InstancedMesh).getMatrixAt(0, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      return scale.x;
    };
    const graphRevision = graph.getGraphView().revision;
    const before = graph.getDiagnostics();
    const initialRadius = readRadius();

    scaleById.set('a', 2);
    const changed = graph.refreshNodeStyles(['a', 'a', 'missing']);
    assert.deepEqual(changed, ['a'], label);
    assert.equal(Object.isFrozen(changed), true, label);
    graph.render();
    const after = graph.getDiagnostics();
    assert.equal(readRadius(), initialRadius * 2, label);
    assert.equal(graph.getGraphView().revision, graphRevision, label);
    assert.equal(after.layoutRevision, before.layoutRevision, label);
    assert.equal(after.layoutAlpha, before.layoutAlpha, label);
    assert.equal(after.completeSyncs, before.completeSyncs, label);
    assert.ok(after.partialUpdateRanges > before.partialUpdateRanges, label);

    const retained = readRadius();
    scaleById.set('a', 3);
    scaleById.set('b', 2);
    failB = true;
    assert.deepEqual(graph.refreshNodeStyles(['a', 'b']), [], label);
    graph.render();
    assert.equal(readRadius(), retained, label);
    assert.equal(graph.getGraphView().revision, graphRevision, label);
    graph.dispose();
  }
});

test('TSL state themes apply public selection and hidden flags through owned attributes', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    layout: { backend: 'local', autoStart: false },
    stateTheme: {
      selected: { scale: 2, color: 0xff0000, colorMix: 1 },
      hidden: { visible: false }
    }
  });
  graph.setData({
    nodes: [{ id: 'a' }, { id: 'b' }],
    links: [{ id: 'a-b', source: 'a', target: 'b' }]
  });
  graph.render();
  graph.setSelection(['b']);
  graph.render();

  const nodeMesh = (graph.object3D as THREE.Object3D).children[1] as THREE.Mesh;
  const radius = nodeMesh.geometry.getAttribute('graphRadius') as THREE.InstancedBufferAttribute;
  const color = nodeMesh.geometry.getAttribute('graphColor') as THREE.InstancedBufferAttribute;
  const state = nodeMesh.geometry.getAttribute('graphState') as THREE.InstancedBufferAttribute;
  const linkWidth = ((graph.object3D as THREE.Object3D).children[0] as THREE.Mesh).geometry
    .getAttribute('graphWidth') as THREE.InstancedBufferAttribute;
  const baseRadius = radius.array[1];
  const baseColor = Array.from(color.array.slice(3, 6));
  assert.equal(radius.array[1], baseRadius);
  assert.deepEqual(Array.from(color.array.slice(3, 6)), baseColor);
  assert.equal(state.array[1], NodeFlags.Visible | NodeFlags.Selected);

  const beforeTheme = graph.getDiagnostics();
  graph.setStateTheme({ selected: { scale: 1.5, color: 0x00ff00, colorMix: 1, visible: false } });
  graph.render();
  const afterTheme = graph.getDiagnostics();
  assert.equal(afterTheme.nodeAttributeWrites, beforeTheme.nodeAttributeWrites);
  assert.equal(radius.array[1], baseRadius);
  assert.deepEqual(Array.from(color.array.slice(3, 6)), baseColor);
  assert.equal(linkWidth.array[0], 0);

  const beforeHidden = graph.getDiagnostics().pickingRevision;
  assert.equal(graph.setNodeFlags('a', NodeFlags.Hidden), true);
  assert.ok(graph.getDiagnostics().pickingRevision > beforeHidden);
  graph.render();
  assert.equal(radius.array[0], 1);
  assert.equal(state.array[0], NodeFlags.Visible | NodeFlags.Hidden);
  graph.dispose();
});

test('TSL node surfaces update shared material and selection-effect uniforms without graph-buffer writes', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    renderer: {
      nodeSurface: {
        profile: 'flat',
        selectionEffect: { enabled: true, bubbleScale: 1.55, intensity: 0.9, color: 0x7c3aed, breathAmount: 0.015, breathSpeed: 2.1 }
      }
    },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }, { id: 'b' }], links: [{ id: 'a-b', source: 'a', target: 'b' }] });
  graph.render();
  const nodeMesh = (graph.object3D as THREE.Object3D).children[1] as THREE.InstancedMesh;
  const material = nodeMesh.material;
  graph.setSelection(['a']);
  graph.render();
  const before = graph.getDiagnostics();
  assert.equal(graph.getStartupReport().renderer.nodeDynamicOpacityRequested, true);
  assert.equal(graph.getStartupReport().renderer.nodeDynamicOpacitySelected, true);
  graph.setNodeSurface({
    profile: 'metallic',
    metalness: 0.9,
    roughness: 0.18,
    emissive: 0.06,
    selectionEffect: { intensity: 0.72, breathSpeed: 2.6 }
  });
  graph.update(0.5);
  graph.render();
  const metallic = graph.getDiagnostics();
  graph.setNodeSurface({ profile: 'flat', selectionEffect: { enabled: false } });
  graph.render();
  const disabled = graph.getDiagnostics();

  assert.equal(graph.getDiagnostics().transformPath, 'tsl');
  assert.equal(before.nodeDynamicOpacityRequested, true);
  assert.equal(before.nodeDynamicOpacitySelected, true);
  assert.equal(nodeMesh.material, material);
  assert.equal((material as THREE.Material).transparent, true);
  assert.equal(metallic.drawCalls, 2);
  assert.equal(metallic.nodeSurfaceAnimating, true);
  assert.equal(metallic.nodeSurfaceTimeSeconds, 0.5);
  assert.equal(metallic.nodeAttributeWrites, before.nodeAttributeWrites);
  assert.equal(metallic.linkAttributeWrites, before.linkAttributeWrites);
  assert.equal(metallic.positionAtlasLogicalWriteBytes, before.positionAtlasLogicalWriteBytes);
  assert.equal(disabled.nodeSurfaceAnimating, false);
  assert.equal(disabled.nodeSurfaceTimeSeconds, 0.5);
  graph.dispose();
});

test('node surface options reject invalid values before graph initialization', async () => {
  await assert.rejects(
    createForceGraph3D({ renderer: { nodeSurface: { metalness: 1.01 } } }),
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_RENDER_PLATFORM_INVALID'
      && error.message.includes('nodeSurface metalness')
  );
  await assert.rejects(
    createForceGraph3D({ renderer: { nodeSurface: { selectionEffect: { bubbleScale: 3.01 } } } }),
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_RENDER_PLATFORM_INVALID'
      && error.message.includes('selectionEffect bubbleScale')
  );
  await assert.rejects(
    createForceGraph3D({ renderer: { nodeSurface: { selectionEffect: { color: 0x1000000 } } } }),
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_RENDER_PLATFORM_INVALID'
      && error.message.includes('selectionEffect color')
  );
});

test('TSL directional link flow advances one shared clock without rewriting graph buffers', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    renderer: {
      nodeSurface: {
        profile: 'metallic',
        metalness: 0.82,
        roughness: 0.28,
        emissive: 0.06,
        selectionEffect: { enabled: true }
      },
      linkFlow: {
        direction: 'source-to-target',
        speed: 0.8,
        frequency: 2,
        pulseWidth: 0.18,
        intensity: 0.9,
        color: 0xa9f6ff,
        nodeReaction: { scale: 1.4, intensity: 0.75, color: 0x7deaff }
      }
    },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({
    nodes: [{ id: 'source' }, { id: 'relay' }, { id: 'target' }, { id: 'isolated' }],
    links: [
      { id: 'source-relay', source: 'source', target: 'relay' },
      { id: 'relay-target', source: 'relay', target: 'target' }
    ]
  });
  graph.render();
  graph.setSelection(['relay']);
  graph.render();
  const nodeMesh = (graph.object3D as THREE.Object3D).children[1] as THREE.Mesh;
  const nodeMaterial = nodeMesh.material as THREE.Material & { opacityNode?: unknown };
  const flowRole = nodeMesh.geometry.getAttribute('graphFlowRole') as THREE.InstancedBufferAttribute;
  const before = graph.getDiagnostics();
  assert.equal(graph.getStartupReport().renderer.linkDynamicOpacityRequested, true);
  assert.equal(graph.getStartupReport().renderer.linkDynamicOpacitySelected, true);

  graph.update(0.5);
  graph.render();
  const advanced = graph.getDiagnostics();
  graph.setLinkFlow({
    direction: 'target-to-source',
    speed: 1.2,
    color: 0xffd27a,
    nodeReaction: { scale: 1.55, intensity: 0.5, color: 0xffb86b }
  });
  graph.render();
  const reversed = graph.getDiagnostics();
  graph.setLinkFlow({ enabled: false });
  graph.update(1);
  graph.render();
  const disabled = graph.getDiagnostics();

  assert.equal(before.linkFlowEnabled, true);
  assert.equal(before.nodeDynamicOpacityRequested, true);
  assert.equal(before.nodeDynamicOpacitySelected, true);
  assert.equal(before.linkDynamicOpacityRequested, true);
  assert.equal(before.linkDynamicOpacitySelected, true);
  assert.equal(nodeMaterial.transparent, true);
  assert.equal(nodeMaterial.depthWrite, false);
  assert.ok(nodeMaterial.opacityNode);
  assert.deepEqual(Array.from(flowRole.array.slice(0, 4)), [2, 3, 1, 0]);
  assert.equal(advanced.linkFlowTimeSeconds, 0.5);
  assert.equal(advanced.drawCalls, 2);
  assert.equal(advanced.nodeAttributeWrites, before.nodeAttributeWrites);
  assert.equal(advanced.linkAttributeWrites, before.linkAttributeWrites);
  assert.equal(advanced.positionAtlasLogicalWriteBytes, before.positionAtlasLogicalWriteBytes);
  assert.equal(advanced.topologyLogicalWriteBytes, before.topologyLogicalWriteBytes);
  assert.equal(reversed.linkFlowEnabled, true);
  assert.equal(reversed.linkFlowTimeSeconds, 0.5);
  assert.equal(reversed.linkAttributeWrites, before.linkAttributeWrites);
  assert.equal(disabled.linkFlowEnabled, false);
  assert.equal(disabled.linkFlowTimeSeconds, 0.5);
  graph.dispose();
});

test('directional link flow validates its profile and rejects non-TSL render paths', async () => {
  await assert.rejects(
    createForceGraph3D({ renderer: { linkFlow: { pulseWidth: 0 } } }),
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_RENDER_PLATFORM_INVALID'
      && error.message.includes('linkFlow pulseWidth')
  );

  await assert.rejects(
    createForceGraph3D({ renderer: { linkFlow: { nodeReaction: { scale: 3.01 } } } }),
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_RENDER_PLATFORM_INVALID'
      && error.message.includes('linkFlow nodeReaction scale')
  );

  await assert.rejects(
    createForceGraph3D({
      platform: createThreePlatform({
        THREE: THREE as unknown as Record<string, unknown>,
        TSL: {} as Record<string, unknown>
      }),
      host: {
        mode: 'embedded',
        scene: new THREE.Scene(),
        camera: new THREE.PerspectiveCamera(),
        renderer: { render: () => undefined, dispose: () => undefined }
      },
      renderer: { linkFlow: { enabled: true } },
      layout: { backend: 'local', autoStart: false }
    }),
    (error: unknown) => error instanceof GraphError
      && error.code === 'FG_RENDER_CAPABILITY_UNAVAILABLE'
      && error.message.includes('Directional link flow')
  );
});

test('TSL links update endpoint radii when dynamic node appearances change', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D<{ radius: number }>({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    layout: { backend: 'local', autoStart: false },
    nodes: { radius: (node) => node.data?.radius ?? 1 },
    stateTheme: { selected: { scale: 2 }, hovered: { scale: 1.5 } }
  });
  graph.setData({
    nodes: [{ id: 'a', data: { radius: 4 } }, { id: 'b', data: { radius: 2 } }],
    links: [{ id: 'a-b', source: 'a', target: 'b' }]
  });
  graph.render();

  const linkGeometry = ((graph.object3D as THREE.Object3D).children[0] as THREE.InstancedMesh).geometry;
  const sourceRadius = linkGeometry.getAttribute('graphSourceRadius') as THREE.InstancedBufferAttribute;
  const targetRadius = linkGeometry.getAttribute('graphTargetRadius') as THREE.InstancedBufferAttribute;
  assert.equal(sourceRadius.array[0], 4);
  assert.equal(targetRadius.array[0], 2);

  graph.setSelection(['a']);
  graph.render();
  assert.equal(sourceRadius.array[0], 8);
  assert.equal(targetRadius.array[0], 2);

  graph.setHoveredNode('b');
  graph.render();
  assert.equal(sourceRadius.array[0], 8);
  assert.equal(targetRadius.array[0], 3);
  graph.dispose();
});

test('embedded rendering consumes dirty channels once and skips idle graph writes', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    layout: { backend: 'local', autoStart: false }
  });

  graph.setData({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    links: [{ id: 'a-b', source: 'a', target: 'b' }, { id: 'b-c', source: 'b', target: 'c' }]
  });
  graph.render();
  const first = graph.getDiagnostics();
  assert.equal(first.transformPath, 'tsl');
  graph.render();
  const idle = graph.getDiagnostics();
  assert.equal(idle.nodeAttributeWrites, first.nodeAttributeWrites);
  assert.equal(idle.linkAttributeWrites, first.linkAttributeWrites);
  assert.ok(idle.skippedSyncPasses > first.skippedSyncPasses);

  const noOp = graph.applyPatch({});
  assert.equal(noOp.frameScheduled, false);
  graph.render();
  const afterNoOp = graph.getDiagnostics();
  assert.equal(afterNoOp.nodeAttributeWrites, idle.nodeAttributeWrites);
  assert.equal(afterNoOp.linkAttributeWrites, idle.linkAttributeWrites);

  const beforeCameraMove = graph.getDiagnostics();
  camera.position.x += 3;
  camera.updateMatrixWorld();
  graph.invalidate(InvalidationReason.Camera);
  graph.render();
  const afterCameraMove = graph.getDiagnostics();
  assert.equal(afterCameraMove.nodeAttributeWrites, beforeCameraMove.nodeAttributeWrites);
  assert.equal(afterCameraMove.linkAttributeWrites, beforeCameraMove.linkAttributeWrites);

  const beforeProjectionChange = graph.getDiagnostics();
  camera.fov = 35;
  camera.updateProjectionMatrix();
  graph.invalidate(InvalidationReason.Camera);
  graph.render();
  const afterProjectionChange = graph.getDiagnostics();
  assert.ok(afterProjectionChange.cameraRevision > beforeProjectionChange.cameraRevision);
  assert.equal(afterProjectionChange.nodeAttributeWrites, beforeProjectionChange.nodeAttributeWrites);
  assert.equal(afterProjectionChange.linkAttributeWrites, beforeProjectionChange.linkAttributeWrites);

  graph.setHoveredNode('b');
  graph.render();
  const hovered = graph.getDiagnostics();
  assert.equal(hovered.nodeAttributeWrites, idle.nodeAttributeWrites + 1);
  assert.equal(hovered.linkAttributeWrites, idle.linkAttributeWrites + 2);

  const nodeMesh = (graph.object3D as THREE.Object3D).children[1] as THREE.InstancedMesh;
  const nodeColor = nodeMesh.geometry.getAttribute('graphColor') as THREE.InstancedBufferAttribute;
  const hoveredColor = Array.from(nodeColor.array.slice(3, 6));

  const beforeStep = hovered.completeSyncs;
  await graph.stepLayout(1);
  graph.render();
  const afterStep = graph.getDiagnostics();
  assert.equal(afterStep.completeSyncs, beforeStep + 1);
  assert.deepEqual(Array.from(nodeColor.array.slice(3, 6)), hoveredColor);
  graph.dispose();
});

test('embedded layout and payload colors upload together on the TSL path', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D<{ color: number }, { color: number }>({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    layout: { backend: 'local', autoStart: false },
    nodes: { color: (node) => node.data?.color ?? 0x71a7ff },
    links: { color: (link) => link.data?.color ?? 0x8ca0c8 }
  });
  graph.setData({
    nodes: [
      { id: 'a', data: { color: 0x112233 } },
      { id: 'b', data: { color: 0x223344 } }
    ],
    links: [{ id: 'edge', source: 'a', target: 'b', data: { color: 0x334455 } }]
  });
  graph.render();
  const object = graph.object3D as THREE.Object3D;
  const nodeColor = (object.children[1] as THREE.InstancedMesh).geometry.getAttribute('graphColor') as THREE.InstancedBufferAttribute;
  const linkColor = (object.children[0] as THREE.InstancedMesh).geometry.getAttribute('graphLinkColor') as THREE.InstancedBufferAttribute;
  const nodeVersion = nodeColor.version;
  const linkVersion = linkColor.version;

  graph.applyPatch({
    nodes: { upsert: [{ id: 'b', data: { color: 0xaabbcc } }] },
    links: { upsert: [{ id: 'edge', source: 'a', target: 'b', data: { color: 0xccbbaa } }] }
  });
  await graph.stepLayout(1);
  graph.render();

  assert.ok(nodeColor.version > nodeVersion);
  assert.ok(linkColor.version > linkVersion);
  graph.dispose();
});

test('TSL partial style uploads keep sparse ranges and untouched channels clean', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D<{ color?: number }>(
    {
      platform,
      host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
      layout: { backend: 'local', autoStart: false },
      nodes: { color: (node) => node.data?.color ?? 0x71a7ff }
    }
  );
  graph.setData({
    nodes: Array.from({ length: 10001 }, (_, index) => ({ id: `node-${index}` })),
    links: [{ id: 'edge', source: 'node-0', target: 'node-1' }]
  });
  graph.render();

  const object = graph.object3D as THREE.Object3D;
  const nodeGeometry = (object.children[1] as THREE.InstancedMesh).geometry;
  const linkGeometry = (object.children[0] as THREE.InstancedMesh).geometry;
  const nodeColor = nodeGeometry.getAttribute('graphColor') as THREE.InstancedBufferAttribute;
  const linkColor = linkGeometry.getAttribute('graphLinkColor') as THREE.InstancedBufferAttribute;
  nodeColor.clearUpdateRanges();
  linkColor.clearUpdateRanges();
  const nodeColorVersion = nodeColor.version;
  const linkColorVersion = linkColor.version;
  const beforePatch = graph.getDiagnostics();

  graph.applyPatch({
    nodes: {
      upsert: [
        { id: 'node-1', data: { color: 0xaabbcc } },
        { id: 'node-10000', data: { color: 0xccbbaa } }
      ]
    }
  });
  graph.render();

  assert.equal(nodeGeometry.getAttribute('graphPosition'), undefined);
  assert.equal(linkColor.version, linkColorVersion);
  assert.equal(graph.getDiagnostics().positionAtlasUploadBytes, beforePatch.positionAtlasUploadBytes);
  assert.equal(graph.getDiagnostics().topologyUploadBytes, beforePatch.topologyUploadBytes);
  assert.ok(graph.getDiagnostics().positionAtlasBytes > 0);
  assert.ok(nodeColor.version > nodeColorVersion);
  assert.deepEqual(nodeColor.updateRanges, [
    { start: 3, count: 3 },
    { start: 30000, count: 3 }
  ]);
  graph.dispose();
});

test('TSL position-only sync writes the atlas without traversing links or dirtying styles', () => {
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const store = new GraphStore();
  store.setData({
    nodes: [
      { id: 'a', initialPosition: { x: -5, y: 0, z: 0 } },
      { id: 'b', initialPosition: { x: 5, y: 0, z: 0 } },
      { id: 'c', initialPosition: { x: 0, y: 5, z: 0 } }
    ],
    links: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'bc', source: 'b', target: 'c' }
    ]
  });
  const renderer = new ThreeGraphRenderer(platform);
  renderer.syncData(store);
  const object = renderer.object3D as unknown as THREE.Object3D;
  const nodeGeometry = (object.children[1] as THREE.InstancedMesh).geometry;
  const linkGeometry = (object.children[0] as THREE.InstancedMesh).geometry;
  const nodeRadius = nodeGeometry.getAttribute('graphRadius') as THREE.InstancedBufferAttribute;
  const nodeColor = nodeGeometry.getAttribute('graphColor') as THREE.InstancedBufferAttribute;
  const linkWidth = linkGeometry.getAttribute('graphWidth') as THREE.InstancedBufferAttribute;
  const linkColor = linkGeometry.getAttribute('graphLinkColor') as THREE.InstancedBufferAttribute;
  const before = renderer.getStats();
  const versions = {
    nodeRadius: nodeRadius.version,
    nodeColor: nodeColor.version,
    linkWidth: linkWidth.version,
    linkColor: linkColor.version
  };
  const originalForEachLink = store.forEachLink.bind(store);
  (store as unknown as { forEachLink: () => never }).forEachLink = () => {
    throw new Error('position-only TSL sync must not iterate graph links');
  };
  store.setNodeFixed('a', { x: -7, y: 3, z: 1 });
  try {
    renderer.syncFrame(store, undefined, {
      positions: true,
      positionRevision: 1,
      nodeStateIds: [],
      linkStyleIds: []
    });
  } finally {
    (store as unknown as { forEachLink: typeof originalForEachLink }).forEachLink = originalForEachLink;
  }
  const after = renderer.getStats();

  assert.equal(after.topologyLogicalWriteBytes, before.topologyLogicalWriteBytes);
  assert.equal(after.styleLogicalWriteBytes, before.styleLogicalWriteBytes);
  assert.equal(after.positionAtlasLogicalWriteBytes - before.positionAtlasLogicalWriteBytes, before.nodeCount * 16);
  assert.equal(after.positionAtlasUploadRequestedBytes - before.positionAtlasUploadRequestedBytes, before.positionAtlasAllocationBytes);
  assert.equal(after.positionSyncRevision, before.positionSyncRevision + 1);
  assert.equal(nodeRadius.version, versions.nodeRadius);
  assert.equal(nodeColor.version, versions.nodeColor);
  assert.equal(linkWidth.version, versions.linkWidth);
  assert.equal(linkColor.version, versions.linkColor);
  renderer.dispose();
});

test('TSL layout movement reports logical and requested atlas bytes without rewriting link topology', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    layout: { backend: 'local', autoStart: false, seed: 20260821 }
  });
  graph.setData({
    nodes: [
      { id: 'a', initialPosition: { x: -5, y: 0, z: 0 } },
      { id: 'b', initialPosition: { x: 5, y: 0, z: 0 } },
      { id: 'c', initialPosition: { x: 0, y: 5, z: 0 } }
    ],
    links: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'bc', source: 'b', target: 'c' }
    ]
  });
  graph.render();
  const before = graph.getDiagnostics();
  await graph.stepLayout(1);
  graph.render();
  const after = graph.getDiagnostics();

  assert.equal(after.transformPath, 'tsl');
  assert.equal(after.topologyUploadBytes, before.topologyUploadBytes);
  assert.equal(after.positionAtlasLogicalWriteBytes - before.positionAtlasLogicalWriteBytes, before.nodeCount * 16);
  assert.equal(after.positionAtlasUploadRequestedBytes - before.positionAtlasUploadRequestedBytes, before.positionAtlasAllocationBytes);
  assert.equal(after.positionAtlasUploadBytes, after.positionAtlasUploadRequestedBytes);
  assert.equal(after.positionAtlasBytes, after.positionAtlasAllocationBytes);
  assert.equal(after.instanceMatrixAllocationBytes, 0);
  assert.ok(after.gpuBufferBytes >= after.positionAtlasAllocationBytes);
  graph.dispose();
});

test('TSL atlas rejects renderer capacity growth above the configured texture height', () => {
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const deviceBoundRenderer = new ThreeGraphRenderer(platform, 0.55, 'world', 128, {}, undefined, undefined, 64);
  assert.deepEqual(
    {
      width: deviceBoundRenderer.getStats().positionAtlasWidth,
      height: deviceBoundRenderer.getStats().positionAtlasMaxHeight,
      capacity: deviceBoundRenderer.getStats().positionAtlasMaxNodeCapacity,
      device: deviceBoundRenderer.getStats().deviceMaxTextureSize
    },
    { width: 64, height: 64, capacity: 4096, device: 64 }
  );
  deviceBoundRenderer.dispose();

  const renderer = new ThreeGraphRenderer(platform, 0.55, 'world', 1);
  const atLimit = new GraphStore();
  atLimit.setData({
    nodes: Array.from({ length: 1024 }, (_, index) => ({ id: `node-${index}` })),
    links: []
  });
  renderer.syncData(atLimit);
  const aboveLimit = new GraphStore();
  aboveLimit.setData({
    nodes: Array.from({ length: 1025 }, (_, index) => ({ id: `node-${index}` })),
    links: []
  });
  assert.throws(
    () => renderer.syncData(aboveLimit),
    (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === 'FG_RENDER_CAPACITY_EXCEEDED'
  );
  renderer.dispose();
});

test('TSL compaction shrinks a temporary atlas peak and its requested upload size', () => {
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const renderer = new ThreeGraphRenderer(platform);
  const peak = new GraphStore();
  peak.setData({ nodes: Array.from({ length: 1025 }, (_, index) => ({ id: `node-${index}` })), links: [] });
  renderer.syncData(peak);
  const before = renderer.getStats();
  const reduced = new GraphStore();
  reduced.setData({ nodes: [{ id: 'node-0' }], links: [] });

  assert.equal(renderer.compact(reduced), true);
  const after = renderer.getStats();
  assert.equal(after.nodeCount, 1);
  assert.ok(after.positionAtlasAllocationBytes < before.positionAtlasAllocationBytes);
  assert.ok(after.positionAtlasUploadRequestedBytes > before.positionAtlasUploadRequestedBytes);
  assert.equal(renderer.compact(reduced), false);
  renderer.dispose();
});

test('TSL link layer preserves world and pixel width units as shader inputs', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    renderer: { linkWidthUnit: 'pixel' },
    layout: { backend: 'local', autoStart: false },
    links: { width: 7 }
  });
  graph.setData({
    nodes: [
      { id: 'a', initialPosition: { x: -10, y: 0, z: 0 } },
      { id: 'b', initialPosition: { x: 10, y: 0, z: 0 } }
    ],
    links: [{ id: 'edge', source: 'a', target: 'b' }]
  });
  graph.render();
  const linkMesh = (graph.object3D as THREE.Object3D).children[0] as THREE.InstancedMesh;
  const width = linkMesh.geometry.getAttribute('graphWidth') as THREE.InstancedBufferAttribute;
  assert.equal(graph.getDiagnostics().transformPath, 'tsl');
  assert.equal(width.array[0], 7);
  graph.dispose();
});

test('renderer reports CPU world fallback and rejects unsupported pixel widths', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: {} as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    layout: { backend: 'local', autoStart: false }
  });
  const fallbackDiagnostics = graph.getDiagnostics();
  assert.equal(fallbackDiagnostics.transformPath, 'cpu');
  assert.equal(fallbackDiagnostics.widthUnitRequested, 'world');
  assert.equal(fallbackDiagnostics.widthUnitSelected, 'world');
  assert.equal(fallbackDiagnostics.positionAtlasWidth, 0);
  assert.equal(fallbackDiagnostics.positionAtlasMaxHeight, 0);
  assert.equal(fallbackDiagnostics.positionAtlasMaxNodeCapacity, 0);
  graph.dispose();

  let workersCreated = 0;
  await assert.rejects(
    () => createForceGraph3D({
      platform,
      host: { mode: 'embedded', scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: { render: () => undefined } },
      renderer: { nodeSurface: { profile: 'flat', selectionEffect: { enabled: true } } },
      layout: {
        backend: 'worker',
        workerFactory: () => {
          workersCreated += 1;
          throw new Error('worker must not be acquired');
        }
      }
    }),
    (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_CAPABILITY_UNAVAILABLE'
  );
  assert.equal(workersCreated, 0);

  await assert.rejects(
    () => createForceGraph3D({
      platform,
      host: { mode: 'embedded', scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: { render: () => undefined, dispose: () => undefined } },
      renderer: { linkWidthUnit: 'pixel' },
      layout: { backend: 'local', autoStart: false }
    }),
    (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === 'FG_RENDER_CAPABILITY_UNAVAILABLE'
  );

  await assert.rejects(
    () => createForceGraph3D({
      platform: createThreePlatform({
        THREE: THREE as unknown as Record<string, unknown>,
        TSL: TSL as unknown as Record<string, unknown>
      }),
      host: { mode: 'embedded', scene: new THREE.Scene(), camera: new THREE.OrthographicCamera(), renderer: { render: () => undefined, dispose: () => undefined } },
      renderer: { linkWidthUnit: 'pixel' },
      layout: { backend: 'local', autoStart: false }
    }),
    (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === 'FG_RENDER_CAPABILITY_UNAVAILABLE'
  );
});

test('TSL-only preflight rejects missing Three resources and malformed node-material attachment before Worker acquisition', async () => {
  const baseThree = THREE as unknown as Record<string, unknown>;
  const variants: Array<readonly [string, Record<string, unknown>]> = [];
  for (const name of ['RGBAFormat', 'FloatType', 'NearestFilter', 'InstancedBufferAttribute'] as const) {
    variants.push([name, { ...baseThree, [name]: undefined }]);
  }
  variants.push(['node material', {
    ...baseThree,
    MeshBasicNodeMaterial: undefined,
    SpriteNodeMaterial: undefined
  }]);
  class BrokenPlaneGeometry extends THREE.PlaneGeometry {}
  Object.defineProperty(BrokenPlaneGeometry.prototype, 'setAttribute', { configurable: true, value: undefined });
  variants.push(['geometry attribute attachment', { ...baseThree, PlaneGeometry: BrokenPlaneGeometry }]);
  class BrokenNodeMaterial {
    constructor(_parameters?: unknown) {}
    dispose(): void {}
  }
  variants.push(['node material attachment', { ...baseThree, MeshBasicNodeMaterial: BrokenNodeMaterial }]);

  for (const [label, three] of variants) {
    let workersCreated = 0;
    const platform = createThreePlatform({
      THREE: three,
      TSL: TSL as unknown as Record<string, unknown>
    });
    await assert.rejects(
      () => createForceGraph3D({
        platform,
        host: {
          mode: 'embedded',
          scene: new THREE.Scene(),
          camera: new THREE.PerspectiveCamera(),
          renderer: { render: () => undefined }
        },
        renderer: { nodeSurface: { profile: 'metallic' } },
        layout: {
          backend: 'worker',
          workerFactory: () => {
            workersCreated += 1;
            return {} as WorkerLike;
          }
        }
      }),
      (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_CAPABILITY_UNAVAILABLE',
      label
    );
    assert.equal(workersCreated, 0, label);
  }
});

test('dynamic-opacity features reject partial material attachment before Worker acquisition and dispose probes', async () => {
  let materialsDisposed = 0;
  class MissingOpacityNodeMaterial extends THREE.MeshBasicMaterial {
    constructor(parameters?: THREE.MeshBasicMaterialParameters) {
      super(parameters);
      Object.defineProperty(this, 'opacityNode', {
        configurable: true,
        get: () => undefined,
        set: () => undefined
      });
    }

    override dispose(): void {
      materialsDisposed += 1;
      super.dispose();
    }
  }
  const platform = createThreePlatform({
    THREE: {
      ...(THREE as unknown as Record<string, unknown>),
      MeshBasicNodeMaterial: MissingOpacityNodeMaterial
    },
    TSL: TSL as unknown as Record<string, unknown>
  });

  for (const renderer of [
    { nodeSurface: { profile: 'flat' as const, selectionEffect: { enabled: true } } },
    { linkFlow: { enabled: true } }
  ]) {
    let workersCreated = 0;
    const disposedBefore = materialsDisposed;
    await assert.rejects(
      () => createForceGraph3D({
        platform,
        host: {
          mode: 'embedded',
          scene: new THREE.Scene(),
          camera: new THREE.PerspectiveCamera(),
          renderer: { render: () => undefined }
        },
        renderer,
        layout: {
          backend: 'worker',
          workerFactory: () => {
            workersCreated += 1;
            return {} as WorkerLike;
          }
        }
      }),
      (error: unknown) => error instanceof GraphError && error.code === 'FG_RENDER_CAPABILITY_UNAVAILABLE'
    );
    assert.equal(workersCreated, 0);
    assert.ok(materialsDisposed > disposedBefore);
  }
});

test('style accessor failures leave the previous style configuration and buffers intact', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
  graph.render();
  const nodeMesh = (graph.object3D as THREE.Object3D).children[1] as THREE.InstancedMesh;
  const radiusAttribute = nodeMesh.geometry.getAttribute('graphRadius') as THREE.InstancedBufferAttribute;
  const radiusBefore = radiusAttribute.array[0];
  const writesBefore = graph.getDiagnostics().nodeAttributeWrites;

  graph.setNodeStyle({
    radius: (_node, index) => {
      if (index === 1) {
        throw new Error('late style failure');
      }
      return 4;
    }
  });
  graph.render();
  assert.equal(radiusAttribute.array[0], radiusBefore);
  assert.equal(graph.getDiagnostics().nodeAttributeWrites, writesBefore);
  graph.dispose();
});

test('controller retains dirty IDs when renderer synchronization fails', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const platform = createThreePlatform({
    THREE: THREE as unknown as Record<string, unknown>,
    TSL: TSL as unknown as Record<string, unknown>
  });
  const graph = await createForceGraph3D({
    platform,
    host: { mode: 'embedded', scene, camera, renderer: { render: () => undefined, dispose: () => undefined } },
    layout: { backend: 'local', autoStart: false }
  });
  graph.setData({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
  graph.render();
  const before = graph.getDiagnostics().nodeAttributeWrites;
  const internals = graph as unknown as {
    renderer: {
      syncFrame: (...args: unknown[]) => void;
    };
  };
  const original = internals.renderer.syncFrame.bind(internals.renderer);
  let fail = true;
  internals.renderer.syncFrame = (...args: unknown[]) => {
    if (fail) {
      fail = false;
      throw new Error('transient renderer failure');
    }
    original(...args);
  };
  graph.setHoveredNode('b');
  assert.throws(() => graph.render(), /transient renderer failure/);
  graph.render();
  assert.equal(graph.getDiagnostics().nodeAttributeWrites, before + 1);
  graph.dispose();
});
