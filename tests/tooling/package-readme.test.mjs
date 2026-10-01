import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('consumer README references runtime metadata and demonstrates the headless entry', async () => {
  const source = await readFile(path.join(root, 'docs/PACKAGE_README.md'), 'utf8');
  const links = [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(links.sort(), ['LICENSE', 'THIRD_PARTY_NOTICES.md']);
  assert.match(source, /@ours\/forcegraph-tsl\/headless/);
  assert.match(source, /graph\.dispose\(\)/);
  assert.doesNotMatch(source, /examples\/|project\.tasks\.json|\.\/scripts\/|PUBLIC_MANIFEST/);
});

test('runtime archive keeps license/notices and source-map inputs without the source app surface', async () => {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(metadata.files.includes('dist'));
  assert.ok(metadata.files.includes('source/**/*.ts'));
  assert.ok(metadata.files.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(metadata.files.includes('docs/licenses/three-MIT.txt'));
  assert.ok(!metadata.files.some((file) => /^(?:examples|tests|scripts|project\.tasks)/.test(file)));
  assert.equal(Object.keys(metadata.exports).length, 8);
  const notice = await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const links = [...notice.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(links.sort(), ['LICENSE', 'docs/licenses/three-MIT.txt', 'package.json']);
});
