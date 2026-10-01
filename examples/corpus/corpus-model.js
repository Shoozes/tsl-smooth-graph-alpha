const CORPUS_MANIFEST_SCHEMA = 'forcegraph_local_corpus_manifest_v1';
const MAXIMUM_MANIFEST_RECORDS = 1_000_000;
const MAXIMUM_RECORD_PATH_CHARACTERS = 4_096;

export async function loadCorpusManifest(url, fetchManifest = globalThis.fetch) {
  if (typeof fetchManifest !== 'function') throw invalidManifest('fetch is unavailable');
  let response;
  try {
    response = await fetchManifest(url, { cache: 'no-store' });
  } catch (error) {
    throw new Error('The bundled synthetic corpus is unavailable. Reload the example or check that sample-manifest.json is served with it.', { cause: error });
  }
  if (!response?.ok) {
    throw new Error('The bundled synthetic corpus is unavailable. Reload the example or check that sample-manifest.json is served with it.');
  }
  let value;
  try {
    value = await response.json();
  } catch (error) {
    throw new Error('Local corpus manifest is not valid JSON.', { cause: error });
  }
  validateCorpusManifest(value);
  return value;
}

export function validateCorpusManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidManifest('expected an object');
  if (value.schema !== CORPUS_MANIFEST_SCHEMA) throw invalidManifest('unsupported schema');
  if (typeof value.archive !== 'string' || value.archive.length === 0) throw invalidManifest('archive name is missing');
  if (!Array.isArray(value.records)) throw invalidManifest('records must be an array');
  for (const field of ['entryCount', 'fileCount', 'directoryCount', 'totalBytes']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw invalidManifest(`${field} must be a non-negative safe integer`);
  }
  if (value.records.length > MAXIMUM_MANIFEST_RECORDS) throw invalidManifest('record limit exceeded');
  if (value.entryCount !== value.records.length) throw invalidManifest('entryCount does not match records');
  if (value.fileCount + value.directoryCount !== value.entryCount) throw invalidManifest('file and directory counts do not match entryCount');

  const paths = new Set();
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  for (const [index, record] of value.records.entries()) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw invalidManifest(`record ${index} must be an object`);
    if (!isCanonicalRecordPath(record.path)) throw invalidManifest(`record ${index} has an unsafe path`);
    if (paths.has(record.path)) throw invalidManifest(`duplicate path ${record.path}`);
    paths.add(record.path);
    if (record.kind !== 'file' && record.kind !== 'directory') throw invalidManifest(`record ${index} has an unsupported kind`);
    if (!Number.isSafeInteger(record.size) || record.size < 0) throw invalidManifest(`record ${index} has an invalid size`);
    if (typeof record.extension !== 'string' || (record.extension && !record.extension.startsWith('.'))) throw invalidManifest(`record ${index} has an invalid extension`);
    if (record.kind === 'directory') {
      if (record.size !== 0 || record.extension !== '') throw invalidManifest(`directory record ${index} must have zero size and no extension`);
      directoryCount += 1;
    } else {
      fileCount += 1;
      totalBytes += record.size;
      if (!Number.isSafeInteger(totalBytes)) throw invalidManifest('total byte count exceeds the safe integer range');
    }
  }
  if (fileCount !== value.fileCount || directoryCount !== value.directoryCount) throw invalidManifest('record kinds do not match the declared counts');
  if (totalBytes !== value.totalBytes) throw invalidManifest('totalBytes does not match file records');
  return value;
}

export function buildCorpusGraph(source) {
  validateCorpusManifest(source);
  const nodes = new Map();
  const links = new Map();
  const rootId = 'corpus:root';
  nodes.set(rootId, { id: rootId, data: { kind: 'root', label: source.archive, path: '', size: source.totalBytes } });

  const addLink = (sourceId, targetId, kind) => {
    const id = `${kind}:${sourceId}>${targetId}`;
    if (!links.has(id)) links.set(id, { id, source: sourceId, target: targetId, data: { kind } });
  };
  const ensureFolder = (folder) => {
    if (!folder) return rootId;
    const id = `folder:${folder}`;
    if (!nodes.has(id)) nodes.set(id, { id, data: { kind: 'folder', label: basename(folder), path: folder, size: 0 } });
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    addLink(ensureFolder(parent), id, 'hierarchy');
    return id;
  };

  for (const record of source.records) {
    if (record.kind === 'directory') {
      ensureFolder(record.path);
      continue;
    }
    const parent = record.path.includes('/') ? record.path.slice(0, record.path.lastIndexOf('/')) : '';
    const id = `file:${record.path}`;
    nodes.set(id, { id, data: { kind: fileKind(record.extension), label: basename(record.path), path: record.path, size: record.size, extension: record.extension || '(none)' } });
    addLink(ensureFolder(parent), id, 'hierarchy');
    const typeId = `type:${record.extension || '(none)'}`;
    if (!nodes.has(typeId)) nodes.set(typeId, { id: typeId, data: { kind: 'type', label: record.extension || '(none)', path: record.extension || '(none)', size: 0 } });
    addLink(typeId, id, 'type');
  }

  const positionedNodes = [...nodes.values()];
  seedCorpusPositions(positionedNodes);
  return Object.freeze({ nodes: Object.freeze(positionedNodes), links: Object.freeze([...links.values()]) });
}

export function createCorpusViews(model) {
  return Object.freeze({
    hierarchy: Object.freeze({
      nodes: Object.freeze(model.nodes.filter((node) => node.data.kind !== 'type')),
      links: Object.freeze(model.links.filter((link) => link.data.kind === 'hierarchy'))
    }),
    full: model
  });
}

// Skip single-folder archive wrappers; stop at the first branching folder.
export function corpusMainHub(model) {
  const children = new Map();
  const folders = new Set(model.nodes.filter(node => node.data.kind === 'folder').map(node => node.id));
  for (const link of model.links) {
    if (link.data?.kind !== 'hierarchy') continue;
    const list = children.get(link.source) ?? [];
    list.push(link.target); children.set(link.source, list);
  }
  let id = 'corpus:root';
  const visited = new Set();
  while (!visited.has(id)) {
    visited.add(id);
    const next = children.get(id);
    if (next?.length !== 1 || !folders.has(next[0])) break;
    id = next[0];
  }
  return id;
}

function seedCorpusPositions(nodes) {
  const corpusNodes = nodes.filter((node) => node.data.kind !== 'type' && node.data.kind !== 'root');
  const depth = (node) => node.data.path.split('/').filter(Boolean).length;
  // Avoid argument-count overflow on large manifests; small corpora need a
  // compact constellation rather than the same 165-unit shell as a full vault.
  let minimumDepth = Infinity;
  for (const node of corpusNodes) minimumDepth = Math.min(minimumDepth, depth(node));
  const densityScale = Math.min(1, Math.max(.08, Math.sqrt(corpusNodes.length / 650)));
  const groups = new Map();
  for (const node of corpusNodes) {
    const parts = node.data.path.split('/').filter(Boolean);
    const key = parts.slice(0, Math.min(parts.length, minimumDepth + 1)).join('/');
    const bucket = groups.get(key) ?? [];
    bucket.push(node);
    groups.set(key, bucket);
  }
  const groupEntries = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (let groupIndex = 0; groupIndex < groupEntries.length; groupIndex += 1) {
    const [key, members] = groupEntries[groupIndex];
    members.sort((left, right) => left.data.kind.localeCompare(right.data.kind) || left.data.path.localeCompare(right.data.path));
    const center = fibonacciPoint(groupIndex, groupEntries.length, 165 * densityScale, hashUnit(key) * Math.PI * 2);
    const spread = Math.max(4, Math.min(64, 15 + Math.sqrt(members.length) * 2.7) * densityScale);
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      const node = members[memberIndex];
      node.data.layoutGroup = key;
      const local = fibonacciPoint(memberIndex, members.length, spread * (node.data.kind === 'folder' ? 0.58 : 1), hashUnit(node.id) * Math.PI * 0.7);
      node.initialPosition = { x: center.x + local.x, y: center.y + local.y, z: center.z + local.z };
    }
  }
  const typeNodes = nodes.filter((node) => node.data.kind === 'type').sort((left, right) => left.id.localeCompare(right.id));
  typeNodes.forEach((node, index) => { node.initialPosition = fibonacciPoint(index, typeNodes.length, 270 * densityScale, 0.42); });
  nodes.filter((node) => node.data.kind === 'root').forEach((node) => { node.initialPosition = { x: 0, y: 0, z: 0 }; });
}

function fibonacciPoint(index, count, radius, phase = 0) {
  const safeCount = Math.max(1, count);
  const y = 1 - 2 * ((index + 0.5) / safeCount);
  const radial = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = index * 2.399963229728653 + phase;
  return { x: Math.cos(angle) * radial * radius, y: y * radius, z: Math.sin(angle) * radial * radius };
}

function hashUnit(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function fileKind(extension) {
  if (['.docx', '.pdf', '.txt', '.md'].includes(extension)) return 'document';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return 'image';
  if (['.json', '.csv', '.xml', '.xlsx'].includes(extension)) return 'data';
  return 'file';
}

function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

function isCanonicalRecordPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAXIMUM_RECORD_PATH_CHARACTERS) return false;
  if (/[\u0000-\u001F\u007F]/u.test(value) || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('//')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function invalidManifest(reason) {
  return new Error(`Local corpus manifest is invalid: ${reason}.`);
}
