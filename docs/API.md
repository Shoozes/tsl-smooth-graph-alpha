# API and ownership

The package exposes eight ESM entry points, with TypeScript declarations for
each. Three.js is optional for the package and required by rendered consumers.

| Entry point | Purpose |
| --- | --- |
| `@ours/forcegraph-tsl/headless` | DOM-free graph state, patches, snapshots, deterministic local layout |
| `@ours/forcegraph-tsl` | High-level rendered graph and injected Three platform |
| `@ours/forcegraph-tsl/core` | Advanced graph/controller contracts |
| `@ours/forcegraph-tsl/three` | Three/TSL platform adapter |
| `@ours/forcegraph-tsl/layout` | Low-level fixed-step layout primitives |
| `@ours/forcegraph-tsl/labels` | Pure screen-space label visibility planning |
| `@ours/forcegraph-tsl/camera` | Pure perspective framing, focus, and camera tween planning |
| `@ours/forcegraph-tsl/worker` | Packaged browser layout Worker URL and factory |

## Data and layout

Each node has a stable string or number `id`. Each link has `id`, `source`, and
`target`. Optional `data` payloads remain caller-owned; structural inputs are
copied. Read views are frozen, and positions are copied rather than exposed as
mutable simulation buffers.

Use `setData` for full replacement and `applyPatch` for stable-ID upserts and
removals. Mutation receipts expose revision changes, affected/skipped IDs,
classification, warnings, and scheduling facts. Removing a node also removes
incident links. Payload-only patches preserve layout state. Topology changes
preserve surviving nodes and use a configurable partial reheat; full replacement
and restart use a full reheat.

The layout is seeded and fixed-step, with 2D/3D dimensions, link/charge/center
forces, optional center separation, pins, and bounded local/Worker paths.
The headless API advances synchronously with `stepLayout`. Rendered Worker
mutations have acknowledged async counterparts; use `setDataAsync` and
`applyPatchAsync` when selecting a Worker backend.

Snapshots use the `tsl-smooth-graph/graph-snapshot` version-2 envelope. The
legacy version-1 envelope is still validated on import. Serialization of opaque
payloads, storage, and network transport remain application responsibilities.

## Embedded Three scene

Supply the same modules and borrowed resources used by the host:

```js
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createForceGraph3D, createThreePlatform } from '@ours/forcegraph-tsl';

// renderer, scene, and camera are created and owned by the application.
const graph = await createForceGraph3D({
  platform: createThreePlatform({ THREE, TSL }),
  host: { mode: 'embedded', renderer, scene, camera },
  layout: { backend: 'local', autoStart: true },
  renderer: { frameLoop: 'external' }
});

function frame(deltaSeconds) {
  graph.update(deltaSeconds);
  graph.render();
  renderer.render(scene, camera);
}

// The host owns frame scheduling, controls, and its renderer disposal.
// graph.dispose() releases only graph-owned resources.
```

Managed mode owns its graph renderer and canvas listeners. Embedded mode
borrows renderer, scene, and camera. All modes require explicit `dispose()`
when finished. The startup report and diagnostics describe the selected
backend, fallback warnings, layout, and rendering facts.

## Rendering and application policy

The normal Three/TSL graph path uses batched node and link layers. Metallic
surfaces, directional flow, endpoint reactions, and perspective pixel widths
require supported TSL capabilities. A flat world-width path has a CPU fallback.
Creation validates requested capabilities before acquiring graph resources.

Selection, hover, click, and drag events use graph IDs. The host owns tooltips,
HTML labels, orbit/pan controls, compositor effects, and camera scheduling.
Camera helpers return advice and tween samples; label helpers return visibility
decisions. Neither takes over application rendering or scheduling.

See the declarations in [source/core/types.ts](../source/core/types.ts) and
[source/headless/types.ts](../source/headless/types.ts) for exact options,
events, receipts, and resource limits. See [architecture](ARCHITECTURE.md) for
the implementation map and [verification](VERIFICATION.md) for check scope.
