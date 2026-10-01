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
  console.log(JSON.stringify({
    nodes: graph.graph.nodeCount,
    links: graph.graph.linkCount,
    childPosition: graph.graph.getNodePosition('child')
  }, null, 2));
} finally {
  graph.dispose();
}
