import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const reviewedFiles = ['README.md', 'scripts/pack.mjs', 'source/Main.ts'];

test('package refuses a failed review before npm, staging, cache, or output', async () => {
  await rejected({ manifest: (value) => { value.status = 'fail'; }, error: /complete passing/ });
});

test('package refuses an incomplete review before npm, staging, cache, or output', async () => {
  await rejected({ manifest: (value) => { value.manifest_complete = false; }, error: /complete passing/ });
});

test('package requires explicit passing and complete review fields', async () => {
  await rejected({ manifest: (value) => { delete value.status; delete value.manifest_complete; }, error: /complete passing/ });
});

test('package rejects added ordinary source even when the listed table still hashes correctly', async () => {
  await rejected({ afterSeal: (directory) => writeFile(path.join(directory, 'source/Extra.ts'), 'export const extra = 1;\n'), error: /unreviewed file: source\/Extra\.ts/ });
});

test('package rejects missing ordinary source before npm or staging', async () => {
  await rejected({ afterSeal: (directory) => rm(path.join(directory, 'source/Main.ts')), error: /missing a reviewed file/ });
});

test('package refuses a changed reviewed file before npm or staging', async () => {
  await rejected({ afterSeal: (directory) => writeFile(path.join(directory, 'source/Main.ts'), 'export const changed = 2;\n'), error: /Source manifest is stale: source\/Main\.ts/ });
});

test('package rejects ordinary-source and nested generated-root exclusion tricks', async () => {
  for (const exclusion of ['source', 'source/dist', '../dist']) {
    await rejected({ manifest: (value) => { value.verification_exclusions = [exclusion]; }, error: /Unsafe source verification exclusions/ });
  }
});

test('package rejects duplicate or excessive generated exclusions', async () => {
  for (const exclusions of [['dist', 'dist'], ['dist', 'node_modules', '.artifacts', 'build']]) {
    await rejected({ manifest: (value) => { value.verification_exclusions = exclusions; }, error: /Unsafe source verification exclusions/ });
  }
});

test('package rejects file-table entries that hide underneath generated exclusions', async () => {
  await rejected({ manifest: (value) => { value.files.push({ path: 'dist/hidden.js', bytes: 0, sha256: digest('') }); }, error: /invalid, excluded, duplicate, or unordered/ });
});

test('package ignores only declared generated roots and root Git when checking ordinary source', async () => {
  await rejected({ afterSeal: async (directory) => {
    for (const name of ['.git', '.artifacts', 'dist', 'node_modules']) {
      await mkdir(path.join(directory, name));
      await writeFile(path.join(directory, name, 'fixture.txt'), 'Unshipped local fixture.\n');
    }
    await rm(path.join(directory, 'source/Main.ts'));
  }, error: /missing a reviewed file/, existingArtifacts: true });
});

async function rejected({ manifest: mutate = () => {}, afterSeal = async () => {}, error, existingArtifacts = false }) {
  const temporaryRoot = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'forcegraph pack review-'));
  const candidate = path.join(directory, 'source candidate');
  const output = path.join(directory, 'output');
  const marker = path.join(directory, 'npm-called.txt');
  try {
    await mkdir(path.join(candidate, 'scripts'), { recursive: true });
    await mkdir(path.join(candidate, 'source'));
    await copyFile(path.join(root, 'scripts/pack.mjs'), path.join(candidate, 'scripts/pack.mjs'));
    await writeFile(path.join(candidate, 'README.md'), 'Fixture source.\n');
    await writeFile(path.join(candidate, 'source/Main.ts'), 'export const main = 1;\n');
    const files = await Promise.all(reviewedFiles.map(async (name) => {
      const bytes = await readFile(path.join(candidate, name));
      return { path: name, bytes: bytes.length, sha256: digest(bytes) };
    }));
    const review = { schema: 'public-release-manifest/v1', status: 'pass', manifest_complete: true,
      fingerprint_algorithm: 'sha256-json-file-table-v1', self_manifest_exclusion: 'PUBLIC_MANIFEST.json',
      verification_exclusions: ['.artifacts', 'dist', 'node_modules'], files };
    mutate(review);
    review.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    review.source_fingerprint_sha256 = digest(JSON.stringify({ schema: 'public-source-content/v1', files: review.files }) + '\n');
    await writeFile(path.join(candidate, 'PUBLIC_MANIFEST.json'), JSON.stringify(review));
    await afterSeal(candidate);
    const fakeNpm = path.join(directory, 'npm-cli.js');
    await writeFile(path.join(directory, 'package.json'), '{"type":"commonjs"}');
    await writeFile(fakeNpm, "require('node:fs').writeFileSync(process.env.PACK_TEST_NPM_MARKER, 'Unexpected npm invocation.'); process.exit(9);\n");
    const result = spawnSync(process.execPath, [path.join(candidate, 'scripts/pack.mjs'), '--output', output], {
      cwd: directory, env: { ...process.env, PROJECT_NPM: fakeNpm, PACK_TEST_NPM_MARKER: marker },
      encoding: 'utf8', timeout: 10_000, windowsHide: true
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    assert.equal(await exists(marker), false, 'npm must not start for an invalid review.');
    assert.equal(await exists(output), false, 'Output must not be created for an invalid review.');
    const artifacts = path.join(candidate, '.artifacts');
    assert.equal(await exists(artifacts), existingArtifacts, 'Invalid review must not create staging or cache.');
    if (existingArtifacts) assert.equal(await exists(path.join(artifacts, 'npm-cache')), false);
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('forcegraph pack review-')) {
      throw new Error('Unsafe package review fixture cleanup path.');
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
