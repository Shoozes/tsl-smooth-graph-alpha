# Architecture

ForceGraph TSL separates graph data, deterministic layout, rendering, and
application policy. The DOM-free API can run independently; the Three adapter
constructs resources from modules supplied by the application.

| Source area | Responsibility |
| --- | --- |
| `core/` | Typed options, validation, events, graph controller, resource limits |
| `data/` | Immutable structural input, stable IDs, typed storage, patch planning |
| `layout/` | Fixed-step forces, Barnes-Hut charge, separation, local/Worker bridge |
| `platform/three/` | Injected Three/TSL capabilities and managed/embedded host ownership |
| `render/` | Batched graph layers, dense position atlas, appearance, picking |
| `interaction/` | Optional pointer adapter emitting semantic graph IDs |
| `headless/` | High-level DOM-free local graph API and portable declarations |
| `labels/` | Independent screen-space ranking/culling/overlap planner |
| `camera/` | Independent perspective frame/focus/tween planner |
| `worker/` | Separate layout Worker entry and packaged Worker factory |

Graph state is private. Frozen read views and immutable receipts expose what
changed without granting write access to the store. Prepared mutation plans,
revision checks, bounded Worker requests, and explicit failure policy protect
the replacement/patch boundary. Observer failures do not take ownership of
graph work.

The renderer uses shared node/link resources and topology/position attributes,
with incremental appearance refresh rather than an object/material per node.
Camera, labels, post-processing, and application data semantics remain with the
host. The examples compose those APIs; example styles and controls are not
part of the runtime package.

RAG Method is a separate consumer. Language contracts, retrieval, document
indexing, and the knowledge-exploration application belong there. This graph
library remains reusable for other Three.js and headless graph applications.

Package commands and a small task menu provide the build, tests, and local
example server from the public source root.
