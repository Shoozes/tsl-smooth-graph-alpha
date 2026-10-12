import { createHeadlessForceGraph } from '@ours/forcegraph-tsl/headless';
import type { HeadlessGraphData, HeadlessGraphSnapshot, HeadlessVec3 } from '@ours/forcegraph-tsl/headless';

const data: HeadlessGraphData<{ label: string }> = {
  nodes: [{ id: 0, data: { label: 'Numeric zero' } }, { id: '0', data: { label: 'String zero' } }],
  links: [{ id: 'edge', source: 0, target: '0' }]
};
const graph = createHeadlessForceGraph<{ label: string }>({ layout: { autoStart: false, dimensions: 3, seed: 1337 } });
graph.setData(data);
const snapshot: HeadlessGraphSnapshot<{ label: string }> = graph.exportSnapshot();
const position: Readonly<HeadlessVec3> | undefined = graph.graph.getNodePosition(0);
void snapshot;
void position;
// @ts-expect-error Graph IDs remain string | number in the installed declarations.
graph.graph.getNodePosition({ id: 0 });
// @ts-expect-error A headless layout only supports 2D or 3D.
createHeadlessForceGraph({ layout: { dimensions: 4 } });
graph.dispose();
