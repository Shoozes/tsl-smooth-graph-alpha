# @ours/forcegraph-tsl

Deterministic graph state and layout, with an optional injected Three.js/TSL
renderer. The library is ESM TypeScript and MIT licensed.

Install the reviewed local archive into a consumer:

```sh
npm install ./ours-forcegraph-tsl-0.3.0-alpha.1.tgz
```

The library declares Node `>=20.19.0`. Rendered consumers supply Three r185;
the DOM-free headless entry does not need Three or browser globals.

```js
import { createHeadlessForceGraph } from '@ours/forcegraph-tsl/headless';

const graph = createHeadlessForceGraph({
  layout: { seed: 1337, autoStart: false, dimensions: 3 }
});

try {
  graph.setData({
    nodes: [{ id: 'root' }, { id: 'child' }],
    links: [{ id: 'root-child', source: 'root', target: 'child' }]
  });
  graph.stepLayout(32);
  console.log(graph.graph.getNodePosition('child'));
} finally {
  graph.dispose();
}
```

The rendered root exports `createForceGraph3D` and `createThreePlatform`.
Inject the application's exact `three/webgpu` and `three/tsl` modules. Managed
mode owns its graph renderer; embedded mode borrows the host renderer, scene,
and camera. The host keeps camera controls, labels, post-processing, storage,
and application policy.

Public subpaths are `./headless`, `./core`, `./three`, `./layout`, `./labels`,
`./camera`, and `./worker`, plus the rendered root entry. The runtime package
contains ESM output, declarations, source maps and their TypeScript sources,
[LICENSE](LICENSE), and [third-party notices](THIRD_PARTY_NOTICES.md).

The source snapshot includes the interactive examples, standalone app menu,
and contributor tests. This archive is the library distribution. It is an
alpha with explicit ownership and seeded layout contracts; browser/GPU results
are scoped to the actual tested consumer and backend.
