export const showcaseExamples = Object.freeze([
  route('basic', '01', 'Basic', 'Basic tree', 'basic', ['layout'], 'Data, layout, hover, drag, selection', 'Drag a node to pin it. Drag empty space to orbit.'),
  route('clusters', '02', 'Clusters', 'Community clusters', 'observatory', ['overview', 'layout'], 'Payload color, focus, state themes', 'Select any node, then use Focus to travel into its community.'),
  route('expandable', '03', 'Expand', 'Expandable tree', 'expandable', ['expand', 'collapse', 'overview', 'layout'], 'Stable tree expansion, collapse, and spawn motion', 'Select a branch, then expand or collapse its immutable subtree.'),
  route('materials', '04', 'Materials', 'Node materials', 'observatory', [], 'Live metallic and emissive shader uniforms', 'The inspector updates one shared TSL surface across every node.', { sliders: true }),
  route('flow', '05', 'Data Flow', 'Directional data flow', 'flow', ['walk', 'direction', 'flow', 'overview'], 'One evidence walk, node to node', 'Play one query walk from the top-left source through linked evidence to the answer.', { flowControls: true }),
  route('cinematic', '06', 'Camera', 'Cinematic focus', 'observatory', ['overview', 'layout'], 'Click a node, enter its world', 'Choose a tween path, then click a node to enter its world. Rapid clicks cancel the previous flight.', { cameraControls: true }),
  route('scale', '07', '1k Scale', 'One thousand nodes', 'scale', ['layout', 'theme'], 'Dense atlas, picking, two draws', 'One thousand nodes and three thousand links remain two batched draws.'),
  route('bloom', '08', 'Bloom', 'Bloom post shader', 'observatory', [], 'RenderPipeline glow after two draws', 'A host-owned RenderPipeline adds bloom after the two graph draws.'),
  route('pinned', '09', 'Pinned', 'Pinned drag behavior', 'basic', ['release', 'pin-mode', 'overview', 'layout'], 'Keep or release dragged nodes without payload mutation', 'Drag a node, let the layout run, then release it explicitly.'),
  route('dynamic', '10', 'Dynamic', 'Stable-ID dynamic graph', 'dynamic', ['dynamic', 'add', 'remove', 'overview'], 'Bounded Worker-backed add/remove churn', 'Watch stable nodes emerge from deterministic parents, or remove the selected node.'),
  route('search-scan', '11', 'Search scan', 'Cluster search replay', 'observatory', [], 'Travelling scanner, word reveals, and camera choreography', 'Replay the seeded constellation or search its labels. Pause, seek, and compare the same frame.')
]);

export const showcaseCatalog = Object.freeze(Object.fromEntries(showcaseExamples.map((example) => [example.slug, example])));

function route(slug, index, label, title, dataset, actions, summary, tip, extras = {}) {
  return Object.freeze({ slug, index, label, title, dataset, actions: Object.freeze(actions), summary, tip, ...extras });
}
