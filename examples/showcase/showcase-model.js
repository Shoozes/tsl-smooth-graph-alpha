export const metallicNodeSurface = Object.freeze({
  profile: 'metallic',
  metalness: 0.82,
  roughness: 0.28,
  emissive: 0.06,
  selectionEffect: Object.freeze({
    enabled: true,
    bubbleScale: 1.55,
    intensity: 0.9,
    color: 0x7c3aed,
    breathAmount: 0.015,
    breathSpeed: 2.1
  })
});

export const coolStateTheme = Object.freeze({
  hovered: { color: 0xdff8ff, colorMix: 0.72, scale: 1.35 },
  selected: { color: 0xd7c8f7, colorMix: 0.74, scale: 1 },
  focused: { color: 0xb7f4ff, colorMix: 0.52, scale: 1.55 },
  dimmed: { color: 0x07101d, colorMix: 0.78, scale: 0.72 },
  incidentLinks: { dimmed: { color: 0x07101d, colorMix: 0.72, scale: 0.38 } }
});

export const warmStateTheme = Object.freeze({
  hovered: { color: 0xffe5aa, colorMix: 0.72, scale: 1.35 },
  selected: { color: 0xd7c8f7, colorMix: 0.74, scale: 1 },
  focused: { color: 0xffd390, colorMix: 0.52, scale: 1.55 },
  dimmed: { color: 0x160f0a, colorMix: 0.78, scale: 0.72 },
  incidentLinks: { dimmed: { color: 0x160f0a, colorMix: 0.72, scale: 0.38 } }
});

export const datasets = Object.freeze({
  basic: basicTreeData,
  clusters: clusteredData,
  expandable: expandableRootData,
  dynamic: dynamicRootData,
  observatory: observatoryData,
  flow: flowData,
  scale: scaleData
});

export const flowWalkNodeIds = Object.freeze([
  'flow-0',
  'flow-1',
  'flow-2',
  'flow-11',
  'flow-12',
  'flow-21',
  'flow-22',
  'flow-23',
  'flow-32',
  'flow-33',
  'flow-34',
  'flow-35',
  'core'
]);

export const flowWalkLinkIds = Object.freeze([
  'flow-right-0',
  'flow-right-1',
  'flow-down-2',
  'flow-right-11',
  'flow-down-12',
  'flow-right-21',
  'flow-right-22',
  'flow-down-23',
  'flow-right-32',
  'flow-right-33',
  'flow-right-34',
  'flow-answer'
]);

const flowWalkLabels = Object.freeze({
  'flow-0': 'Query · Apollo mission',
  'flow-1': 'Keyword match',
  'flow-2': 'Apollo 11 entity',
  'flow-11': 'Wikipedia article',
  'flow-12': 'Outbound citation',
  'flow-21': 'Linked article',
  'flow-22': 'Section chunk',
  'flow-23': 'Embedding',
  'flow-32': 'Semantic neighbor',
  'flow-33': 'Rerank',
  'flow-34': 'Grounded context',
  'flow-35': 'Answer synthesis',
  core: 'Answer'
});

export function nodeColor(node) {
  const data = node.data;
  if (data && typeof data === 'object' && typeof data.color === 'number') return data.color;
  return node.id === 'core' ? 0x32c8ff : 0x7184ff;
}

export function basicTreeData() {
  const nodes = [{ id: 'core', data: { color: 0x32c8ff }, initialPosition: { x: 0, y: 72, z: 0 } }];
  const links = [];
  for (let index = 1; index < 32; index += 1) {
    const depth = Math.floor(Math.log2(index + 1));
    const firstAtDepth = (2 ** depth) - 1;
    const depthWidth = 2 ** depth;
    const slot = index - firstAtDepth;
    const parentIndex = Math.floor((index - 1) / 2);
    const id = `tree-${index}`;
    nodes.push({
      id,
      data: { color: [0x3d94ff, 0x7868f7, 0x39c990][depth % 3] },
      initialPosition: { x: (slot - (depthWidth - 1) / 2) * 24, y: 72 - depth * 30, z: ((index * 13) % 17) - 8 }
    });
    links.push({ id: `tree-link-${index}`, source: parentIndex === 0 ? 'core' : `tree-${parentIndex}`, target: id });
  }
  return { nodes, links };
}

export function clusteredData() {
  const nodes = [{ id: 'core', data: { color: 0x32c8ff }, initialPosition: { x: 0, y: 0, z: 0 } }];
  const links = [];
  for (let cluster = 0; cluster < 3; cluster += 1) {
    const anchor = `cluster-${cluster}`;
    const color = [0x29adff, 0x765cf4, 0x2fcf98][cluster];
    nodes.push({ id: anchor, data: { color }, initialPosition: { x: (cluster - 1) * 60, y: (cluster % 2 ? 34 : -28), z: cluster * 10 - 10 } });
    links.push({ id: `core-${anchor}`, source: 'core', target: anchor });
    for (let index = 0; index < 10; index += 1) {
      const id = `${anchor}-${index}`;
      nodes.push({ id, data: { color }, initialPosition: { x: (cluster - 1) * 60 + (index % 5) * 7, y: (cluster % 2 ? 34 : -28) + Math.floor(index / 5) * 7, z: (index % 3) * 5 } });
      links.push({ id: `${anchor}-${index}`, source: anchor, target: id });
    }
  }
  return { nodes, links };
}

const expandableRecords = [
  ['core', undefined, 'Knowledge root', 0x32c8ff],
  ['topic-a', 'core', 'Retrieval', 0x39c990],
  ['topic-b', 'core', 'Reasoning', 0x7868f7],
  ['topic-c', 'core', 'Evidence', 0xd99245],
  ['retrieval-keyword', 'topic-a', 'Keyword search', 0x39c990],
  ['retrieval-vector', 'topic-a', 'Vector search', 0x39c990],
  ['retrieval-graph', 'topic-a', 'Graph walk', 0x39c990],
  ['reasoning-rerank', 'topic-b', 'Rerank', 0x7868f7],
  ['reasoning-plan', 'topic-b', 'Plan', 0x7868f7],
  ['reasoning-synth', 'topic-b', 'Synthesis', 0x7868f7],
  ['evidence-wiki', 'topic-c', 'Wikipedia', 0xd99245],
  ['evidence-docs', 'topic-c', 'Project docs', 0xd99245],
  ['evidence-code', 'topic-c', 'Source code', 0xd99245],
  ['vector-embed', 'retrieval-vector', 'Embedding', 0x62e0b5],
  ['vector-neighbor', 'retrieval-vector', 'Nearest neighbor', 0x62e0b5],
  ['graph-links', 'retrieval-graph', 'Linked entities', 0x62e0b5],
  ['graph-path', 'retrieval-graph', 'Path scoring', 0x62e0b5],
  ['wiki-section', 'evidence-wiki', 'Section chunk', 0xf1b463],
  ['wiki-citation', 'evidence-wiki', 'Citation', 0xf1b463]
];

export const expandableTree = Object.freeze(expandableRecords.map(([id, parentId, label, color]) => Object.freeze({
  id,
  parentId,
  data: Object.freeze({ label, color })
})));

export function expandableRootData() {
  const root = expandableTree[0];
  return {
    nodes: [{ id: root.id, data: root.data, initialPosition: { x: 0, y: 0, z: 0 } }],
    links: []
  };
}

export function dynamicRootData() {
  return {
    nodes: [{ id: 'core', data: { color: 0x32c8ff, label: 'Dynamic root' }, initialPosition: { x: 0, y: 0, z: 0 } }],
    links: []
  };
}

/** A deterministic five-community graph used by the graph-first observatory demos. */
export function observatoryData() {
  const palettes = [0x16a9bd, 0x1873e8, 0x7740d5, 0xd29239, 0xb9792f];
  const centers = [
    { x: 2, y: 42, z: -8 },
    { x: -26, y: -30, z: 8 },
    { x: 42, y: 7, z: 14 },
    { x: -42, y: 22, z: -14 },
    { x: 29, y: -36, z: -6 }
  ];
  const shapes = [
    { x: 0.88, y: 1.22 },
    { x: 1.08, y: 0.94 },
    { x: 1.16, y: 0.92 },
    { x: 1.12, y: 0.82 },
    { x: 0.94, y: 1.12 }
  ];
  const nodes = [{
    id: 'core',
    data: { color: 0xd69a43, label: 'Node_054', community: 'bridge' },
    initialPosition: { x: 0, y: 0, z: 8 }
  }];
  const links = [];
  let labelIndex = 0;

  for (let community = 0; community < centers.length; community += 1) {
    const center = centers[community];
    const shape = shapes[community];
    const color = palettes[community];
    const anchorId = `community-${community}`;
    nodes.push({
      id: anchorId,
      data: { color, label: `Node_${String(++labelIndex).padStart(3, '0')}`, community },
      initialPosition: { ...center }
    });
    links.push({ id: `bridge-${community}`, source: 'core', target: anchorId, data: { color } });

    for (let index = 0; index < 32; index += 1) {
      const id = `${anchorId}-${index}`;
      const angle = index * 2.399963229728653;
      const spread = 8 + Math.sqrt(index + 1) * 4.1;
      const position = {
        x: center.x + Math.cos(angle) * spread * shape.x,
        y: center.y + Math.sin(angle) * spread * shape.y,
        z: center.z + ((index * 11 + community * 7) % 25) - 12
      };
      nodes.push({
        id,
        data: {
          color: scaleColor(color, 0.62 + (((index * 17 + community * 13) % 9) / 8) * 0.55),
          label: `Node_${String(++labelIndex).padStart(3, '0')}`,
          community
        },
        initialPosition: position
      });
      if (index < 3 || index % 7 === 0) {
        links.push({ id: `${anchorId}-spoke-${index}`, source: anchorId, target: id, data: { color } });
      }
      if (index > 0) {
        links.push({ id: `${anchorId}-ring-${index}`, source: `${anchorId}-${index - 1}`, target: id, data: { color } });
      }
      if (index > 3) {
        links.push({ id: `${anchorId}-cross-${index}`, source: `${anchorId}-${index - 3}`, target: id, data: { color } });
      }
      if (index > 8 && index % 2 === 0) {
        links.push({ id: `${anchorId}-chord-${index}`, source: `${anchorId}-${index - 7}`, target: id, data: { color } });
      }
    }
  }

  for (let community = 0; community < centers.length; community += 1) {
    const next = (community + 1) % centers.length;
    links.push({ id: `core-community-${community}`, source: 'core', target: `community-${community}-${community * 5 + 8}`, data: { color: 0x3a5f87 } });
    for (let bridge = 0; bridge < 4; bridge += 1) {
      links.push({
        id: `community-link-${community}-${bridge}`,
        source: `community-${community}-${(community * 5 + bridge * 7 + 4) % 32}`,
        target: `community-${next}-${(next * 4 + bridge * 9 + 6) % 32}`,
        data: { color: 0x3a5f87 }
      });
    }
  }

  const satelliteColor = 0x178da5;
  for (let index = 0; index < 12; index += 1) {
    const id = `satellite-${index}`;
    const angle = index * 2.399963229728653;
    const spread = 6 + Math.sqrt(index + 1) * 3.5;
    nodes.push({
      id,
      data: {
        color: scaleColor(satelliteColor, 0.66 + ((index * 5) % 7) * 0.08),
        label: `Node_${String(++labelIndex).padStart(3, '0')}`,
        community: 'satellite'
      },
      initialPosition: {
        x: -72 + Math.cos(angle) * spread,
        y: -10 + Math.sin(angle) * spread,
        z: ((index * 7) % 15) - 7
      }
    });
    if (index > 0) links.push({ id: `satellite-ring-${index}`, source: `satellite-${index - 1}`, target: id, data: { color: satelliteColor } });
    if (index > 3) links.push({ id: `satellite-cross-${index}`, source: `satellite-${index - 4}`, target: id, data: { color: satelliteColor } });
  }
  links.push({ id: 'satellite-blue-bridge', source: 'satellite-2', target: 'community-1-6', data: { color: satelliteColor } });
  links.push({ id: 'satellite-amber-bridge', source: 'satellite-9', target: 'community-3-12', data: { color: satelliteColor } });
  return { nodes, links };
}

function scaleColor(color, scale) {
  const channel = (shift) => Math.min(255, Math.round(((color >>> shift) & 0xff) * scale));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export function flowData() {
  const walkNodes = new Set(flowWalkNodeIds);
  const walkLinks = new Set(flowWalkLinkIds);
  const nodes = [{ id: 'core', data: { color: 0x8ff8ff, label: flowWalkLabels.core }, initialPosition: { x: 68, y: -30, z: 0 } }];
  const links = [];
  for (let index = 0; index < 36; index += 1) {
    const id = `flow-${index}`;
    nodes.push({
      id,
      data: {
        color: walkNodes.has(id) ? 0x57d5e7 : index % 2 ? 0xd8924f : 0x6678cf,
        label: flowWalkLabels[id] ?? `Candidate ${String(index + 1).padStart(2, '0')}`
      },
      initialPosition: { x: (index % 9) * 13 - 52, y: 24 - Math.floor(index / 9) * 16, z: ((index * 7) % 13) - 6 }
    });
    if (index % 9 < 8) {
      const linkId = `flow-right-${index}`;
      links.push({ id: linkId, source: id, target: `flow-${index + 1}`, data: { color: 0x284866, walk: walkLinks.has(linkId) ? 'route' : 'idle' } });
    }
    if (index < 27) {
      const linkId = `flow-down-${index}`;
      links.push({ id: linkId, source: id, target: `flow-${index + 9}`, data: { color: 0x263b67, walk: walkLinks.has(linkId) ? 'route' : 'idle' } });
    }
  }
  links.push({ id: 'flow-answer', source: 'flow-35', target: 'core', data: { color: 0x315f70, walk: 'route' } });
  return { nodes, links };
}

export function scaleData() {
  const count = 1_000;
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? 'core' : `scale-${index}`,
    data: { color: index === 0 ? 0x32c8ff : [0x2e9cff, 0x745ff4, 0x35c790, 0xee9748][index % 4] },
    initialPosition: { x: (index % 40) * 9 - 175, y: Math.floor(index / 40) * 9 - 108, z: ((index * 19) % 23) - 11 }
  }));
  const links = Array.from({ length: 3_000 }, (_, index) => {
    const sourceIndex = index % count;
    const targetIndex = (sourceIndex * 17 + Math.floor(index / count) * 43 + 11) % count;
    return {
      id: `scale-link-${index}`,
      source: sourceIndex === 0 ? 'core' : `scale-${sourceIndex}`,
      target: targetIndex === 0 ? 'core' : `scale-${targetIndex}`
    };
  });
  return { nodes, links };
}
