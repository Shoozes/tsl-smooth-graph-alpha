import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStaticFixtureServer } from '../../scripts/browser/static-server.mjs';
import { buildShowcaseRoutes } from '../../scripts/showcase-server.mjs';
import { flowData, flowWalkLinkIds, flowWalkNodeIds } from '../../examples/showcase/showcase-model.js';
import { showcaseExamples } from '../../examples/showcase/examples/manifest.js';
import { buildCorpusGraph, createCorpusViews, loadCorpusManifest, validateCorpusManifest } from '../../examples/corpus/corpus-model.js';
import { sampleNodeBloomPosition } from '../../examples/corpus/node-position-motion.js';
import { durationForTempo, motionScenes, replayPresets, resolveMotionScene, searchMotionPresets } from '../../examples/corpus/motion-presets.js';

test('browser fixture server delivers JavaScript modules with an executable MIME type and rejects traversal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forcegraph-static-server-'));
  const fixture = path.join(root, 'fixture.mjs');
  const unknown = path.join(root, 'payload.unknown');
  await writeFile(fixture, 'export const fixture = true;\n', 'utf8');
  await writeFile(unknown, 'not executable\n', 'utf8');
  const server = await createStaticFixtureServer([{ prefix: '/fixture', root }]);

  try {
    const moduleResponse = await fetch(`${server.url}/fixture/fixture.mjs`);
    assert.equal(moduleResponse.status, 200);
    assert.equal(moduleResponse.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.equal(moduleResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await moduleResponse.text(), /fixture/);

    const unknownResponse = await fetch(`${server.url}/fixture/payload.unknown`);
    assert.equal(unknownResponse.status, 200);
    assert.equal(unknownResponse.headers.get('content-type'), 'application/octet-stream');

    const traversalResponse = await fetch(`${server.url}/fixture/%2e%2e/%2e%2e/package.json`);
    assert.equal(traversalResponse.status, 404);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('showcase gallery exposes every standalone example through shared executable assets', async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const server = await createStaticFixtureServer([
    { prefix: '/theme', root: path.join(repositoryRoot, 'examples', 'theme') },
    { prefix: '/showcase', root: path.join(repositoryRoot, 'examples', 'showcase') },
    { prefix: '/addons', root: path.join(repositoryRoot, 'node_modules', 'three', 'examples', 'jsm') }
  ]);
  const examples = showcaseExamples.map(({ slug }) => slug);

  try {
    for (const example of examples) {
      const response = await fetch(`${server.url}/showcase/examples/${example}/index.html`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.match(await response.text(), new RegExp(`data-example="${example}"`));
    }

    const runtimeResponse = await fetch(`${server.url}/showcase/examples/example.js`);
    assert.equal(runtimeResponse.status, 200);
    assert.equal(runtimeResponse.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.match(await runtimeResponse.text(), /forcegraph_example_browser_fixture_v1/);

    const modelResponse = await fetch(`${server.url}/showcase/showcase-model.js`);
    assert.equal(modelResponse.status, 200);
    assert.equal(modelResponse.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.match(await modelResponse.text(), /export const datasets/);

    const showcaseResponse = await fetch(`${server.url}/showcase/showcase.js`);
    assert.equal(showcaseResponse.status, 200);
    const showcaseSource = await showcaseResponse.text();
    assert.match(showcaseSource, /clearInterval\(metricsTimer\)/);
    const showcasePage = await fetch(`${server.url}/showcase/index.html`);
    const showcasePageSource = await showcasePage.text();
    assert.match(showcasePageSource, /class="control-dock"/);
    assert.match(showcasePageSource, /<summary>Options<\/summary>/);
    assert.match(showcasePageSource, /id="layout-button"[^>]*>Pause<\/button>/);
    assert.match(showcasePageSource, /data-ui-theme="vector-relay"/);
    const showcaseStyle = await (await fetch(`${server.url}/showcase/showcase.css`)).text();
    assert.match(showcaseStyle, /\.\.\/theme\/vector-relay\.css/);
    assert.doesNotMatch(showcaseStyle, /radial-gradient|backdrop-filter|border-radius:\s*999px/);
    const themeResponse = await fetch(`${server.url}/theme/vector-relay.css`);
    assert.equal(themeResponse.status, 200);
    const themeSource = await themeResponse.text();
    assert.match(themeSource, /--vr-teal:\s*#55e6d4/);
    assert.match(themeSource, /forced-colors:\s*active/);
    assert.doesNotMatch(themeSource, /animation:[^;]*infinite/);
    assert.match(await (await fetch(`${server.url}/showcase/showcase.css`)).text(), /\.stage\s*\{[^}]*overflow:\s*visible/);

    const bloomResponse = await fetch(`${server.url}/showcase/examples/bloom/bloom.js`);
    assert.equal(bloomResponse.status, 200);
    assert.equal(bloomResponse.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.match(await bloomResponse.text(), /new THREE\.RenderPipeline/);

    const bloomAddonResponse = await fetch(`${server.url}/addons/tsl/display/BloomNode.js`);
    assert.equal(bloomAddonResponse.status, 200);
    assert.equal(bloomAddonResponse.headers.get('content-type'), 'application/javascript; charset=utf-8');
  } finally {
    await server.close();
  }
});

test('showcase server exposes only explicit product directories under its prefix', () => {
  const routes = buildShowcaseRoutes({ basePath: '/demo' });
  assert.deepEqual(routes.map(({ prefix }) => prefix), [
    '/demo/theme', '/demo/showcase', '/demo/corpus', '/demo/dist', '/demo/vendor', '/demo/addons'
  ]);
  assert.throws(() => buildShowcaseRoutes({ basePath: '../escape' }), /without traversal/);
});

test('public showcase CSS reports a missing shared theme route as unavailable', async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const server = await createStaticFixtureServer([
    { prefix: '/showcase', root: path.join(repositoryRoot, 'examples', 'showcase') }
  ]);
  try {
    const cssUrl = `${server.url}/showcase/showcase.css`;
    const cssResponse = await fetch(cssUrl);
    assert.equal(cssResponse.status, 200);
    const importReference = /@import\s+url\(["']([^"']+)["']\)/i.exec(await cssResponse.text())?.[1];
    assert.equal(importReference, '../theme/vector-relay.css');
    const themeResponse = await fetch(new URL(importReference, cssUrl));
    assert.equal(themeResponse.status, 404);
  } finally {
    await server.close();
  }
});

test('local project-subpath routes serve the flagship pages and package modules', async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const prefix = '/tsl-smooth-graph';
  const server = await createStaticFixtureServer([
    { prefix: `${prefix}/theme`, root: path.join(repositoryRoot, 'examples', 'theme') },
    { prefix: `${prefix}/showcase`, root: path.join(repositoryRoot, 'examples', 'showcase') },
    { prefix: `${prefix}/corpus`, root: path.join(repositoryRoot, 'examples', 'corpus') },
    { prefix: `${prefix}/dist`, root: path.join(repositoryRoot, 'dist') },
    { prefix: `${prefix}/addons`, root: path.join(repositoryRoot, 'node_modules', 'three', 'examples', 'jsm') }
  ]);
  try {
    for (const route of ['showcase/index.html', 'corpus/index.html']) {
      const response = await fetch(`${server.url}${prefix}/${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', route);
      const source = await response.text();
      assert.match(source, /data-ui-theme="vector-relay"/, route);
      assert.doesNotMatch(source, /(?:src|href)=["']\/(?:dist|showcase|corpus)\//, route);
    }
    const moduleResponse = await fetch(`${server.url}${prefix}/dist/index.js`);
    assert.equal(moduleResponse.status, 200);
    assert.equal(moduleResponse.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.match(await moduleResponse.text(), /createForceGraph3D/);
  } finally {
    await server.close();
  }
});

test('data-flow showcase keeps one deterministic top-left-to-answer evidence walk', () => {
  const data = flowData();
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const links = new Map(data.links.map((link) => [link.id, link]));

  assert.deepEqual(nodes.get(flowWalkNodeIds[0])?.initialPosition, { x: -52, y: 24, z: -6 });
  assert.equal(flowWalkNodeIds.at(-1), 'core');
  assert.equal(flowWalkLinkIds.length, flowWalkNodeIds.length - 1);
  for (let index = 0; index < flowWalkLinkIds.length; index += 1) {
    const link = links.get(flowWalkLinkIds[index]);
    assert.equal(link?.source, flowWalkNodeIds[index]);
    assert.equal(link?.target, flowWalkNodeIds[index + 1]);
    assert.equal(link?.data.walk, 'route');
  }
  assert.match(nodes.get('flow-11')?.data.label, /Wikipedia/);
  assert.match(nodes.get('flow-22')?.data.label, /Section chunk/);
  assert.match(nodes.get('flow-23')?.data.label, /Embedding/);
  assert.equal(nodes.get('core')?.data.label, 'Answer');
});

test('corpus model represents every archive entry and keeps the type overlay optional', () => {
  const manifest = sampleCorpusManifest();
  validateCorpusManifest(manifest);
  const model = buildCorpusGraph(manifest);
  const views = createCorpusViews(model);

  assert.equal(views.hierarchy.nodes.length, manifest.entryCount + 1);
  assert.equal(views.hierarchy.links.length, manifest.entryCount);
  assert.equal(views.full.nodes.length, manifest.entryCount + 3);
  assert.equal(views.full.links.length, manifest.entryCount + manifest.fileCount);
  assert.ok(views.full.nodes.every((node) => Object.values(node.initialPosition).every(Number.isFinite)));
  assert.throws(() => validateCorpusManifest({ records: [] }), /invalid/);
  assert.throws(() => validateCorpusManifest({ ...manifest, entryCount: 2 }), /entryCount/);
  assert.throws(() => validateCorpusManifest({ ...manifest, records: [...manifest.records, manifest.records[0]], entryCount: 4, directoryCount: 2 }), /duplicate path/);
  assert.throws(() => validateCorpusManifest({ ...manifest, records: [{ ...manifest.records[0], path: '../Vault' }, ...manifest.records.slice(1)] }), /unsafe path/);
  assert.throws(() => validateCorpusManifest({ ...manifest, records: [{ ...manifest.records[0], path: 'Vault/\u0000note' }, ...manifest.records.slice(1)] }), /unsafe path/);
  assert.throws(() => validateCorpusManifest({ ...manifest, totalBytes: 1 }), /totalBytes/);
});

test('corpus manifest loader reports unavailable, malformed, and invalid inputs', async () => {
  const manifest = sampleCorpusManifest();
  let request;
  const loaded = await loadCorpusManifest('/corpus/sample-manifest.json', async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => manifest };
  });
  assert.equal(loaded, manifest);
  assert.deepEqual(request, { url: '/corpus/sample-manifest.json', options: { cache: 'no-store' } });
  await assert.rejects(loadCorpusManifest('/missing.json', async () => ({ ok: false })), /unavailable/);
  await assert.rejects(loadCorpusManifest('/offline.json', async () => { throw new TypeError('offline'); }), /unavailable/);
  await assert.rejects(loadCorpusManifest('/broken.json', async () => ({ ok: true, json: async () => { throw new SyntaxError('broken'); } })), /not valid JSON/);
  await assert.rejects(loadCorpusManifest('/invalid.json', async () => ({ ok: true, json: async () => ({ records: [] }) })), /invalid/);
});

test('Obsidian bloom position tween starts at its parent and lands at the atlas position', () => {
  const from = { x: 1, y: 2, z: 3 };
  const to = { x: 40, y: -10, z: 18 };
  assert.deepEqual(sampleNodeBloomPosition(from, to, 'note', 0), from);
  const middle = sampleNodeBloomPosition(from, to, 'note', 0.5);
  assert.ok(Object.values(middle).every(Number.isFinite));
  assert.notDeepEqual(middle, from);
  const end = sampleNodeBloomPosition(from, to, 'note', 1);
  assert.ok(Math.abs(end.x - to.x) < 1e-9);
  assert.ok(Math.abs(end.y - to.y) < 1e-9);
  assert.ok(Math.abs(end.z - to.z) < 1e-9);
});

test('corpus motion scenes pair three distinct search and replay animation systems', () => {
  assert.deepEqual(Object.keys(motionScenes), ['signal', 'lens', 'director']);
  assert.deepEqual(Object.values(motionScenes).map(({ search, replay }) => [search, replay]), [
    ['signal-relay', 'weave'],
    ['semantic-lens', 'orbit'],
    ['evidence-walk', 'score']
  ]);
  for (const scene of Object.values(motionScenes)) {
    assert.ok(searchMotionPresets[scene.search]);
    assert.ok(replayPresets[scene.replay]);
    assert.equal(resolveMotionScene(scene.search, scene.replay), scene.id);
  }
  assert.equal(resolveMotionScene('signal-relay', 'orbit'), undefined);
  assert.ok(durationForTempo(1000, 'calm') > durationForTempo(1000, 'standard'));
  assert.ok(durationForTempo(1000, 'fast') < durationForTempo(1000, 'standard'));
});

test('corpus atlas serves executable local modules without unsafe HTML rendering', async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const server = await createStaticFixtureServer([
    { prefix: '/theme', root: path.join(repositoryRoot, 'examples', 'theme') },
    { prefix: '/corpus', root: path.join(repositoryRoot, 'examples', 'corpus') },
    { prefix: '/dist', root: path.join(repositoryRoot, 'dist') }
  ]);
  try {
    const page = await fetch(`${server.url}/corpus/index.html`);
    assert.equal(page.status, 200);
    const pageSource = await page.text();
    assert.match(pageSource, /\.\/corpus\.js/);
    assert.match(pageSource, /data-replay/);
    assert.match(pageSource, /data-ingest-progress/);
    assert.match(pageSource, /data-search-results/);
    assert.match(pageSource, /data-search-animation/);
    assert.match(pageSource, /data-search-exit/);
    assert.match(pageSource, /data-trace-layer/);
    assert.match(pageSource, /data-studio-panel/);
    assert.match(pageSource, /data-control-group="search-navigation"/);
    assert.match(pageSource, /data-control-group="view"/);
    assert.match(pageSource, /data-control-group="motion-studio"/);
    assert.match(pageSource, /data-scene-presets/);
    assert.match(pageSource, /data-search-cues/);
    assert.match(pageSource, /data-replay-cues/);
    assert.match(pageSource, /data-trail/);
    assert.match(pageSource, /data-ui-theme="vector-relay"/);
    const styleResponse = await fetch(`${server.url}/corpus/corpus.css`);
    assert.equal(styleResponse.status, 200);
    const styleSource = await styleResponse.text();
    assert.match(styleSource, /\.\.\/theme\/vector-relay\.css/);
    assert.doesNotMatch(styleSource, /radial-gradient|backdrop-filter|border-radius:\s*999px/);
    assert.doesNotMatch(pageSource, /"\/(?:vendor|dist|showcase|corpus)\//);
    for (const asset of ['corpus.js', 'corpus-model.js', 'motion-presets.js', 'node-position-motion.js']) {
      const response = await fetch(`${server.url}/corpus/${asset}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/javascript; charset=utf-8');
      const source = await response.text();
      assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\s*=/);
      if (asset === 'corpus.js') {
        assert.match(source, /async function replayBuild/);
        assert.match(source, /graph\.applyPatch/);
        assert.match(source, /createNodeSpawnMotion/);
        assert.match(source, /frameSearchResults/);
        assert.match(source, /searchMotionPresets/);
        assert.match(source, /searchStateTheme/);
        assert.match(source, /function exitSearch/);
        assert.match(source, /source==='search'/);
        assert.match(source, /colorMix:\.94,scale:\.44/);
        assert.match(source, /runSearchMotion/);
        assert.match(source, /cancelSearchMotion/);
        assert.match(source, /cancelSearchMotion\(\);cameraAnimator\.cancel\(\)/);
        assert.match(source, /nodeMotion\.pulse/);
        assert.match(source, /replaceChildren/);
        assert.match(source, /spawnLightTrace/);
        assert.match(source, /nodeReaction:\{enabled:false\}/);
        assert.match(source, /planReplayBatch/);
        assert.match(source, /spawnSearchRipple/);
        assert.match(source, /applyMotionScene/);
        assert.match(source, /graph\.setLinkFlow/);
        assert.match(source, /replayBuild\(\)\.catch\(reportRuntimeError\)/);
        assert.match(source, /runSearchMotion\(matches\)\.catch\(reportRuntimeError\)/);
        assert.match(source, /clearTransientEffects/);
      }
    }
    const sampleResponse = await fetch(`${server.url}/corpus/sample-manifest.json`);
    assert.equal(sampleResponse.status, 200);
    assert.equal(sampleResponse.headers.get('content-type'), 'application/json; charset=utf-8');
    validateCorpusManifest(await sampleResponse.json());
  } finally {
    await server.close();
  }
});

function sampleCorpusManifest() {
  return {
    schema: 'forcegraph_local_corpus_manifest_v1', archive: 'sample.zip', entryCount: 3,
    fileCount: 2, directoryCount: 1, totalBytes: 3072,
    records: [
      { path: 'Vault', kind: 'directory', size: 0, extension: '' },
      { path: 'Vault/Brief.pdf', kind: 'file', size: 2048, extension: '.pdf' },
      { path: 'Vault/Still.png', kind: 'file', size: 1024, extension: '.png' }
    ]
  };
}
