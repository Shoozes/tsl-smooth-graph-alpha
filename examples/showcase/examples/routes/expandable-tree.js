import { parentRelativePosition } from '../runtime/node-spawn-motion.js';

export function createExpandableTreeController(options) {
  const records = new Map(options.tree.map((record) => [record.id, record]));
  const children = new Map();
  for (const record of options.tree) {
    if (record.parentId === undefined) continue;
    const list = children.get(record.parentId) ?? [];
    list.push(record.id);
    children.set(record.parentId, list);
  }
  const rootId = options.tree.find((record) => record.parentId === undefined)?.id;
  if (rootId === undefined) throw new Error('Expandable tree requires one root record.');
  const visible = new Set([rootId]);
  const expanded = new Set();
  let lastMutation;

  const expand = (parentId) => {
    if (!visible.has(parentId)) return emptyResult('expand');
    const childIds = (children.get(parentId) ?? []).filter((id) => !visible.has(id));
    if (childIds.length === 0) return emptyResult('expand');
    const parentPosition = options.graph.getNodePosition(parentId);
    const nodes = childIds.map((id) => {
      const source = records.get(id);
      return {
        id,
        data: source.data,
        initialPosition: parentRelativePosition(parentPosition, parentId, id, {
          distance: options.spawnDistance ?? 2.4,
          dimensions: options.dimensions,
          seed: options.seed
        })
      };
    });
    const links = childIds.map((id) => ({
      id: `tree:${parentId}>${id}`,
      source: parentId,
      target: id,
      data: { color: records.get(id).data.color }
    }));
    const receipt = options.graph.applyPatch({ nodes: { upsert: nodes }, links: { upsert: links } });
    lastMutation = receipt;
    expanded.add(parentId);
    for (const id of childIds) visible.add(id);
    childIds.forEach((id, index) => options.motion.animate(id, { delayMs: index * (options.staggerMs ?? 55) }));
    options.onChange?.(snapshot());
    return mutationResult('expand', receipt);
  };

  const collapse = (parentId) => {
    if (!visible.has(parentId)) return emptyResult('collapse');
    const descendants = visibleDescendants(parentId, children, visible);
    if (descendants.length === 0) return emptyResult('collapse');
    const receipt = options.graph.applyPatch({ nodes: { remove: descendants } });
    lastMutation = receipt;
    for (const id of descendants) {
      visible.delete(id);
      expanded.delete(id);
      options.motion.remove(id);
    }
    expanded.delete(parentId);
    options.onChange?.(snapshot());
    return mutationResult('collapse', receipt);
  };

  const snapshot = () => Object.freeze({
    rootId,
    visibleNodeIds: Object.freeze([...visible]),
    expandedNodeIds: Object.freeze([...expanded]),
    activeMotionCount: options.motion.activeCount,
    lastMutation: lastMutation === undefined ? undefined : receiptSummary(lastMutation)
  });

  return Object.freeze({
    rootId,
    expand,
    collapse,
    toggle(id) {
      return expanded.has(id) ? collapse(id) : expand(id);
    },
    reset() {
      return collapse(rootId);
    },
    hasChildren(id) {
      return (children.get(id)?.length ?? 0) > 0;
    },
    isExpanded(id) {
      return expanded.has(id);
    },
    snapshot
  });
}

function visibleDescendants(parentId, children, visible) {
  const result = [];
  const pending = [...(children.get(parentId) ?? [])];
  while (pending.length > 0) {
    const id = pending.shift();
    if (!visible.has(id)) continue;
    result.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
}

function mutationResult(action, receipt) {
  return Object.freeze({ action, changed: true, ...receiptSummary(receipt) });
}

function emptyResult(action) {
  return Object.freeze({ action, changed: false, addedNodes: 0, removedNodes: 0, removedLinks: 0, cascadedLinks: 0 });
}

function receiptSummary(receipt) {
  return Object.freeze({
    revision: receipt.revision,
    addedNodes: receipt.addedNodeIds.length,
    removedNodes: receipt.removedNodeIds.length,
    addedLinks: receipt.addedLinkIds.length,
    removedLinks: receipt.removedLinkIds.length,
    cascadedLinks: receipt.cascadedLinkIds.length
  });
}
