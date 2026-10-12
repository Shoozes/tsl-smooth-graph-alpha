import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildPages } from '../../scripts/build-pages.mjs';
import { pagesStatusSummary, readPagesStatus } from '../../scripts/pages-status.mjs';
import { createStaticFixtureServer } from '../../scripts/browser/static-server.mjs';
import { showcaseExamples } from '../../examples/showcase/examples/manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputDirectory = `.artifacts/pages-test-${process.pid}`;
const output = path.join(root, outputDirectory);
const built = buildPages({ outputDirectory });
after(async () => {
  const completed = await built.catch(() => undefined);
  if (completed) await rm(completed.outputDirectory, { recursive: true, force: true });
});

test('Pages export records every shipped byte and excludes development/private inputs', async () => {
  const { manifest } = await built;
  const paths = manifest.files.map(file => file.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(manifest.fingerprint, sha256(JSON.stringify(manifest.files)));
  assert.equal(manifest.lockfileSha256, sha256(await readFile(path.join(root, 'pnpm-lock.yaml'))));
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(output, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
    assert.doesNotMatch(file.path, /(?:^|\/)(?:node_modules|tests|scripts|\.git|upload|\.env)(?:\/|$)/);
    assert.doesNotMatch(file.path, /(?:\.d\.ts|\.mp4|\.patch|\.zip|README\.md)$/);
  }
  assert.deepEqual((await walk(output)).sort(), [...paths, 'pages-manifest.json'].sort());
  assert.ok(paths.includes('vendor/LICENSE'));
  assert.ok(paths.includes('addons/LICENSE'));
  assert.ok(paths.includes('docs/licenses/three-MIT.txt'));
  assert.deepEqual(paths.filter(name => name.startsWith('addons/') && name.endsWith('.js')), [
    'addons/controls/OrbitControls.js', 'addons/tsl/display/BloomNode.js'
  ]);
});

test('every demo resolves its local import graph, CSS, source maps and Worker under a project Pages prefix', async () => {
  const { manifest } = await built;
  const files = new Set(manifest.files.map(file => file.path));
  const base = new URL('https://example.invalid/tsl-smooth-graph-alpha/');
  const pagePaths = ['showcase/index.html', 'corpus/index.html', ...showcaseExamples.map(({ slug }) => `showcase/examples/${slug}/index.html`)];
  const parsed = new Map();
  function resolve(reference, from) {
    assert.doesNotMatch(reference, /^(?:[a-z][a-z\d+.-]*:|\/)/i, `External/root-relative runtime URL: ${reference}`);
    const url = new URL(reference, from);
    assert.equal(url.origin, base.origin);
    assert.ok(url.pathname.startsWith(base.pathname), `URL escaped project prefix: ${url}`);
    const relative = decodeURIComponent(url.pathname.slice(base.pathname.length));
    if (!relative.endsWith('/')) assert.ok(files.has(relative), `Missing asset: ${relative} from ${from}`);
    return { url, relative };
  }
  async function visitCss(url) {
    const source = await readFile(path.join(output, url.pathname.slice(base.pathname.length)), 'utf8');
    for (const match of source.matchAll(/(?:url\(\s*["']?)([^)'"\s]+)|@import\s+["']([^"']+)["']/g)) {
      const reference = match[1] ?? match[2];
      if (reference.startsWith('data:')) continue;
      const asset = resolve(reference, url);
      if (asset.relative.endsWith('.css')) await visitCss(asset.url);
    }
  }
  for (const pagePath of pagePaths) {
    const page = new URL(pagePath, base);
    const html = await readFile(path.join(output, pagePath), 'utf8');
    const imports = JSON.parse(/<script\s+type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
    const seen = new Set();
    const importMap = Object.entries(imports).sort(([a], [b]) => b.length - a.length);
    for (const value of Object.values(imports)) resolve(value, page);
    async function visitModule(moduleUrl) {
      if (seen.has(moduleUrl.href)) return;
      seen.add(moduleUrl.href);
      const relative = moduleUrl.pathname.slice(base.pathname.length);
      let references = parsed.get(relative);
      if (!references) {
        const source = await readFile(path.join(output, relative), 'utf8');
        references = moduleReferences(source, relative);
        parsed.set(relative, references);
      }
      for (const reference of references) {
        let target;
        if (reference.kind === 'url' || reference.value.startsWith('.')) target = resolve(reference.value, moduleUrl);
        else {
          const entry = importMap.find(([key]) => key === reference.value || (key.endsWith('/') && reference.value.startsWith(key)));
          assert.ok(entry, `Unmapped bare import: ${reference.value} in ${relative} for ${pagePath}`);
          target = resolve(`${entry[1]}${entry[0].endsWith('/') ? reference.value.slice(entry[0].length) : ''}`, page);
        }
        if (target.relative.endsWith('.js')) await visitModule(target.url);
      }
    }
    for (const match of html.matchAll(/\b(src|href)="([^"]+)"/g)) {
      if (match[2].startsWith('data:') || match[2].startsWith('#')) continue;
      const asset = resolve(match[2], page);
      if (match[1] === 'src' && asset.relative.endsWith('.js')) await visitModule(asset.url);
      if (asset.relative.endsWith('.css')) await visitCss(asset.url);
    }
    assert.ok(seen.size > 5, `${pagePath} module graph was not traversed`);
  }
  for (const file of manifest.files.filter(file => file.path.endsWith('.js.map'))) {
    const map = JSON.parse(await readFile(path.join(output, file.path), 'utf8'));
    for (const source of map.sources) resolve(source, new URL(file.path, base));
  }
  const server = await createStaticFixtureServer([{ prefix: base.pathname, root: output }]);
  try {
    for (const name of ['index.html', ...pagePaths, 'dist/worker/force-worker-entry.js', 'vendor/three.core.js', 'addons/controls/OrbitControls.js', 'corpus/sample-manifest.json']) {
      const response = await fetch(`${server.url}${base.pathname}${name}`);
      assert.equal(response.status, 200, name);
      if (name.endsWith('.js')) assert.match(response.headers.get('content-type'), /javascript/);
    }
    assert.equal((await fetch(`${server.url}/vendor/three.core.js`)).status, 404);
    assert.equal((await fetch(`${server.url}${base.pathname}package.json`)).status, 404);
  } finally { await server.close(); }
});

test('Pages rebuild is deterministic and replaces only a previous generated output', async () => {
  const fixture = await createFixture();
  try {
    const first = await buildPages({ repositoryRoot: fixture });
    const bytes = await readFile(path.join(first.outputDirectory, 'pages-manifest.json'));
    await writeFile(path.join(first.outputDirectory, 'stale.js'), 'remove me');
    const second = await buildPages({ repositoryRoot: fixture });
    assert.deepEqual(await readFile(path.join(second.outputDirectory, 'pages-manifest.json')), bytes);
    assert.equal(first.manifest.fingerprint, second.manifest.fingerprint);
    await assert.rejects(readFile(path.join(second.outputDirectory, 'stale.js')), /ENOENT/);
    await assert.rejects(buildPages({ repositoryRoot: fixture, outputDirectory: 'examples/showcase' }), /child of \.artifacts/);
    await mkdir(path.join(fixture, '.artifacts', 'unowned'));
    await writeFile(path.join(fixture, '.artifacts', 'unowned', 'keep.txt'), 'keep');
    await assert.rejects(buildPages({ repositoryRoot: fixture, outputDirectory: '.artifacts/unowned' }), /without a Pages manifest/);
    assert.equal(await readFile(path.join(fixture, '.artifacts', 'unowned', 'keep.txt'), 'utf8'), 'keep');
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('missing, mismatched, or symlinked inputs fail without replacing the previous Pages build', async () => {
  const fixture = await createFixture();
  const external = await mkdtemp(path.join(os.tmpdir(), 'forcegraph-pages-external-'));
  try {
    const first = await buildPages({ repositoryRoot: fixture });
    const before = await readFile(path.join(first.outputDirectory, 'pages-manifest.json'));
    await rm(path.join(fixture, 'dist', 'index.js'));
    await assert.rejects(buildPages({ repositoryRoot: fixture }), /ENOENT/);
    await writeFile(path.join(fixture, 'dist', 'index.js'), 'export const restored = true;');
    await writeFile(path.join(fixture, 'node_modules', 'three', 'package.json'), '{"version":"0.0.0"}');
    await assert.rejects(buildPages({ repositoryRoot: fixture }), /Installed Three/);
    await writeFile(path.join(fixture, 'node_modules', 'three', 'package.json'), '{"version":"0.185.0"}');
    await symlink(path.join(fixture, 'LICENSE'), path.join(fixture, 'examples', 'theme', 'private.txt'));
    await assert.rejects(buildPages({ repositoryRoot: fixture }), /symbolic links/);
    await rm(path.join(fixture, 'examples', 'theme', 'private.txt'));
    for (const name of ['examples/theme', 'examples', 'source', 'dist', 'docs/licenses', 'docs', 'LICENSE']) {
      const input = path.join(fixture, name);
      const target = path.join(external, name.replaceAll('/', '-'));
      await rename(input, target);
      await symlink(target, input, name === 'LICENSE' ? 'file' : 'dir');
      try {
        await assert.rejects(buildPages({ repositoryRoot: fixture }), /symbolic links/, name);
        assert.deepEqual(await readFile(path.join(first.outputDirectory, 'pages-manifest.json')), before, name);
      } finally {
        await rm(input);
        await rename(target, input);
      }
    }
    assert.deepEqual(await readFile(path.join(first.outputDirectory, 'pages-manifest.json')), before);
    assert.deepEqual((await readdir(path.join(fixture, '.artifacts'))).filter(name => name.startsWith('.pages-build-')), []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('Pages preflight permits workflow sites and explains only disabled or legacy configuration', async () => {
  const options = { repository: 'Shoozes/tsl-smooth-graph-alpha', token: 'synthetic-test-token' };
  for (const [status, body, expected] of [
    [200, { build_type: 'workflow' }, { configured: true, reason: 'workflow' }],
    [200, { build_type: 'legacy' }, { configured: false, reason: 'legacy-source' }],
    [404, null, { configured: false, reason: 'not-enabled' }]
  ]) {
    let request;
    const result = await readPagesStatus({ ...options, fetchImpl: async (url, init) => {
      request = { url, init };
      return { status, json: async () => body };
    } });
    assert.deepEqual(result, expected);
    assert.equal(request.url, 'https://api.github.com/repos/Shoozes/tsl-smooth-graph-alpha/pages');
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.headers.Authorization, 'Bearer synthetic-test-token');
    assert.equal(request.init.headers['X-GitHub-Api-Version'], '2026-03-10');
    const summary = pagesStatusSummary(result);
    if (!result.configured) {
      assert.match(summary, /Settings → Pages → Build and deployment → Source → GitHub Actions/);
      assert.match(summary, /deployment is skipped/);
      assert.match(summary, /Run workflow/);
    }
    assert.doesNotMatch(summary, /synthetic-test-token/);
  }
});

test('Pages preflight fails on permission, network, schema, and input errors', async () => {
  const options = { repository: 'Shoozes/tsl-smooth-graph-alpha', token: 'synthetic-test-token' };
  for (const status of [301, 401, 403, 429, 500]) {
    await assert.rejects(readPagesStatus({ ...options, fetchImpl: async () => ({ status }) }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(readPagesStatus({ ...options, fetchImpl: async () => { throw new Error('network unreachable'); } }), /network unreachable/);
  await assert.rejects(readPagesStatus({ ...options, fetchImpl: async () => ({ status: 200, json: async () => ({}) }) }), /unexpected build_type/);
  await assert.rejects(readPagesStatus({ ...options, repository: '../escape' }), /owner\/repository/);
  await assert.rejects(readPagesStatus({ ...options, apiUrl: 'http://api.github.com' }), /HTTPS/);
  await assert.rejects(readPagesStatus({ ...options, token: '' }), /GITHUB_TOKEN/);
  const workflow = await readFile(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && needs\.build\.outputs\.pages-configured == 'true'/);
  assert.ok(workflow.indexOf('actions/upload-pages-artifact@') < workflow.indexOf('node scripts/pages-status.mjs'));
  assert.doesNotMatch(workflow, /continue-on-error|enablement:\s*true/);
  for (const action of workflow.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/g)) assert.match(action[2], /^[a-f0-9]{40}$/, action[1]);
});

function moduleReferences(source, file) {
  const result = [];
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push({ kind: 'import', value: node.moduleSpecifier.text });
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) result.push({ kind: 'import', value: node.arguments[0].text });
    if (ts.isNewExpression(node) && node.expression.getText(syntax) === 'URL' && node.arguments?.length === 2 && ts.isStringLiteral(node.arguments[0]) && node.arguments[1].getText(syntax) === 'import.meta.url') result.push({ kind: 'url', value: node.arguments[0].text });
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return result;
}
async function createFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'forcegraph-pages-'));
  const inputs = {
    'package.json': JSON.stringify({ name: '@ours/test', version: '0.0.0', packageManager: 'pnpm@11.19.0', devDependencies: { three: '0.185.0' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'node_modules/three/package.json': '{"version":"0.185.0"}',
    'node_modules/three/LICENSE': 'Three MIT fixture',
    'LICENSE': 'Project MIT fixture',
    'THIRD_PARTY_NOTICES.md': 'Three MIT',
    'docs/licenses/three-MIT.txt': 'Three MIT fixture',
    'dist/index.js': 'export const fixture = true;',
    'dist/worker/force-worker-entry.js': 'export {};',
    'source/index.ts': 'export const fixture = true;',
    'examples/theme/theme.css': 'body {}',
    'examples/showcase/index.html': '<!doctype html>',
    'examples/corpus/index.html': '<!doctype html>'
  };
  for (const name of ['three.core.js', 'three.module.js', 'three.tsl.js', 'three.webgpu.js']) inputs[`node_modules/three/build/${name}`] = 'export {};';
  for (const name of ['controls/OrbitControls.js', 'tsl/display/BloomNode.js']) inputs[`node_modules/three/examples/jsm/${name}`] = 'export {};';
  for (const [name, content] of Object.entries(inputs)) {
    await mkdir(path.dirname(path.join(fixture, name)), { recursive: true });
    await writeFile(path.join(fixture, name), content);
  }
  return fixture;
}
async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    assert.equal(entry.isSymbolicLink(), false, relative);
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), `${relative}/`));
    else files.push(relative);
  }
  return files;
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
