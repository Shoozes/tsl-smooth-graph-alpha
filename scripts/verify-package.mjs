import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 1 && !(args.length === 3 && args[1] === '--output')) {
  throw new Error('Use node scripts/verify-package.mjs <archive.tgz> [--output <external-report.json>].');
}
const archive = await realpath(path.resolve(args[0]));
const archiveStat = await lstat(archive);
if (!archive.endsWith('.tgz') || !archiveStat.isFile() || archiveStat.size <= 0 || archiveStat.size > 16 * 1024 * 1024) {
  throw new Error('The consumer check requires a local .tgz file of at most 16 MiB.');
}
const report = path.resolve(args[2] ?? archive + '.consumer.json');
const reportParent = await realpath(path.dirname(report));
if (isWithin(reportParent, await realpath(root))) throw new Error('Write the consumer report outside the source directory.');
if (await exists(report)) throw new Error('Refusing to overwrite an existing consumer report.');
const archiveBytes = await readFile(archive);
const expectedMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const baseline = JSON.parse(await readFile(path.join(root, 'tests/package/public-api-baseline.json'), 'utf8'));
const compiler = await realpath(path.join(root, 'node_modules/typescript/bin/tsc'));
const npm = await npmCli();
const temporaryRoot = await realpath(tmpdir());
const consumer = await mkdtemp(path.join(temporaryRoot, 'forcegraph-consumer-'));

try {
  if (isWithin(await realpath(consumer), await realpath(root))) throw new Error('The consumer must be outside the source checkout.');
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'forcegraph-consumer-smoke', version: '0.0.0', private: true, type: 'module' }) + '\n');
  await writeFile(path.join(consumer, 'input.tgz'), archiveBytes);
  for (const name of ['consumer-smoke.mjs', 'consumer-types.ts', 'consumer-headless.ts', 'public-api-baseline.json']) {
    await copyFile(path.join(root, 'tests/package', name), path.join(consumer, name));
  }
  const environment = {
    ...process.env,
    NODE_PATH: '',
    npm_config_cache: path.join(consumer, 'npm-cache'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    COREPACK_ENABLE_NETWORK: '0'
  };
  await runNode(npm, [
    'install', './input.tgz', '--global=false', '--location=project', '--prefix', consumer, '--workspaces=false',
    '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--omit=optional', '--omit=peer'
  ], consumer, environment);

  const installed = path.join(consumer, 'node_modules', ...expectedMetadata.name.split('/'));
  assert.equal((await lstat(installed)).isSymbolicLink(), false, 'The consumer must install archive files, not link the source checkout.');
  assert.ok(isWithin(await realpath(installed), await realpath(consumer)), 'The installed package must stay within the isolated consumer.');
  const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, expectedMetadata.name);
  assert.equal(metadata.version, expectedMetadata.version);
  assert.deepEqual(metadata.exports, baseline.packageExports, 'The archive must preserve every frozen public export condition.');
  const files = await inventory(installed);
  const names = new Set(files.map((file) => file.path));
  for (const name of names) {
    assert.ok(/^(?:package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|docs\/licenses\/three-MIT\.txt|dist\/.+|source\/.+\.ts)$/.test(name), 'Unexpected runtime package file: ' + name);
  }
  for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/licenses/three-MIT.txt']) {
    assert.ok(names.has(name), 'The archive is missing ' + name);
  }
  assert.equal(await readFile(path.join(installed, 'README.md'), 'utf8'), await readFile(path.join(root, 'docs/PACKAGE_README.md'), 'utf8'), 'The archive needs the consumer README produced by pack:release.');
  for (const [subpath, conditions] of Object.entries(metadata.exports)) {
    for (const [condition, target] of Object.entries(conditions)) {
      assert.ok(target.startsWith('./dist/') && names.has(target.slice(2)), `${subpath} ${condition} target is missing from the archive.`);
    }
  }
  let sourceMapCount = 0;
  for (const file of files) {
    if (file.path.startsWith('dist/') && /(?:\.js|\.d\.ts)$/.test(file.path)) {
      assert.ok(names.has(file.path + '.map'), 'Compiled output is missing its source map: ' + file.path);
      const compiled = await readFile(path.join(installed, file.path), 'utf8');
      const mapping = compiled.match(/\/\/# sourceMappingURL=([^\r\n]+)\s*$/);
      assert.equal(mapping?.[1], path.basename(file.path) + '.map', 'Compiled output must reference its packaged source map: ' + file.path);
    }
    if (!file.path.endsWith('.map')) continue;
    const map = JSON.parse(await readFile(path.join(installed, file.path), 'utf8'));
    assert.equal(map.version, 3, 'Unsupported source map version: ' + file.path);
    assert.equal(map.file, path.basename(file.path).slice(0, -4), 'Source map must describe its sibling compiled output: ' + file.path);
    assert.ok(Array.isArray(map.sources) && map.sources.length > 0, 'Source map has no source inputs: ' + file.path);
    for (const source of map.sources) {
      assert.equal(typeof source, 'string');
      const target = path.resolve(installed, path.dirname(file.path), map.sourceRoot ?? '', source);
      assert.ok(isWithin(target, installed), 'Source map input escapes the archive: ' + file.path);
      assert.ok(names.has(path.relative(installed, target).split(path.sep).join('/')), 'Source map input is missing: ' + file.path);
    }
    sourceMapCount += 1;
  }
  assert.ok(sourceMapCount > 0, 'The runtime archive must include its declaration and JavaScript source maps.');

  const runtime = JSON.parse(await runNode(path.join(consumer, 'consumer-smoke.mjs'), [], consumer, environment));
  const compilerOptions = {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    noEmit: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    skipLibCheck: false, types: [], lib: ['ES2022']
  };
  for (const [name, lib] of [['consumer-headless.ts', ['ES2022']], ['consumer-types.ts', ['ES2022', 'DOM']]]) {
    const config = path.join(consumer, name + '.json');
    await writeFile(config, JSON.stringify({ compilerOptions: { ...compilerOptions, lib }, files: [name] }) + '\n');
    await runNode(compiler, ['--project', config], consumer, environment);
  }
  const result = {
    schema: 'forcegraph-package-consumer/v1', status: 'pass', package: metadata.name, version: metadata.version,
    archive: path.basename(archive), archive_bytes: archiveBytes.length, archive_sha256: digest(archiveBytes),
    node_version: process.version, package_file_count: files.length, source_map_count: sourceMapCount,
    isolated_archive_install: true, offline: true, lifecycle_scripts: false,
    runtime, declarations: { all_entry_points: true, headless_without_dom_lib: true, source_path_aliases: false, skip_lib_check: false },
    scope: 'Local archive installation, exported runtime behavior, assets, and consumer declarations. Does not certify source review, registry ownership, a browser Worker, or GPU rendering.'
  };
  await writeFile(report, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report, ...result }, null, 2));
} finally {
  if (path.dirname(consumer) !== temporaryRoot || !path.basename(consumer).startsWith('forcegraph-consumer-')) {
    throw new Error('Unsafe consumer cleanup path.');
  }
  await rm(consumer, { recursive: true, force: true });
}

async function inventory(directory) {
  const files = [];
  let bytes = 0;
  const visit = async (relative = '', depth = 0) => {
    if (depth > 32) throw new Error('Package directory depth exceeds its bound.');
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('The installed archive contains a symbolic link: ' + name);
      if (entry.isDirectory()) await visit(name, depth + 1);
      else if (entry.isFile()) {
        const stat = await lstat(path.join(directory, name));
        bytes += stat.size;
        files.push({ path: name, bytes: stat.size });
        if (files.length > 512 || bytes > 16 * 1024 * 1024) throw new Error('Package inventory exceeds its bound.');
      } else throw new Error('Unexpected installed archive entry: ' + name);
    }
  };
  await visit();
  return files;
}

async function npmCli() {
  for (const candidate of [
    process.env.PROJECT_NPM,
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  ]) {
    if (candidate && path.basename(candidate) === 'npm-cli.js' && await exists(candidate)) return candidate;
  }
  throw new Error('Run with npm, or set PROJECT_NPM to the installed npm-cli.js.');
}

function runNode(entry, args, cwd, env, { timeoutMs = 60_000, killGraceMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', diagnostic = '';
    let outputBytes = 0, failure, forceTimer;
    const terminate = (error) => {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    const timer = setTimeout(() => terminate(new Error('Package consumer command timed out.')), timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > 128 * 1024) { terminate(new Error('Package consumer output exceeds its bound.')); return; }
      output += chunk;
    });
    child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(0, 16_384); });
    child.once('error', (error) => { failure ??= error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      // Let the child and its output streams close before the caller removes its working directory.
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${path.basename(entry)} failed (${code}):\n${diagnostic}\n${output}`));
      else resolve(output);
    });
  });
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
