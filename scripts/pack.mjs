import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let output = path.resolve(root, '..', 'forcegraph-package');
if (args.length === 2 && args[0] === '--output') output = path.resolve(args[1]);
else if (args.length === 1 && args[0].startsWith('--output=')) output = path.resolve(args[0].slice(9));
else if (args.length) throw new Error('Use node scripts/pack.mjs [--output <external-directory>].');
if (isWithin(output, root)) throw new Error('Package output must be outside the source directory.');

const manifestPath = path.join(root, 'PUBLIC_MANIFEST.json');
const manifestStat = await lstat(manifestPath);
if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('The source manifest must be a regular file.');
const sourceManifestBytes = await readFile(manifestPath);
const sourceManifest = JSON.parse(sourceManifestBytes);
if (sourceManifest.schema !== 'public-release-manifest/v1'
    || sourceManifest.fingerprint_algorithm !== 'sha256-json-file-table-v1'
    || sourceManifest.status !== 'pass'
    || sourceManifest.manifest_complete !== true
    || sourceManifest.self_manifest_exclusion !== 'PUBLIC_MANIFEST.json'
    || !/^[a-f0-9]{64}$/.test(sourceManifest.source_fingerprint_sha256)
    || !Array.isArray(sourceManifest.files) || sourceManifest.files.length === 0
    || sourceManifest.files.length > 20_000) throw new Error('A complete passing PUBLIC_MANIFEST.json review is required.');
const knownGeneratedRoots = new Set(['.artifacts', 'dist', 'node_modules']);
const exclusions = sourceManifest.verification_exclusions;
if (!Array.isArray(exclusions) || exclusions.length > knownGeneratedRoots.size
    || exclusions.some((value) => !knownGeneratedRoots.has(value))
    || new Set(exclusions).size !== exclusions.length) throw new Error('Unsafe source verification exclusions.');
const sourceFiles = new Map();
const foldedPaths = new Set();
let previousPath;
for (const file of sourceManifest.files) {
  if (!file || !portablePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256)
      || file.path === 'PUBLIC_MANIFEST.json' || file.path === '.git' || file.path.startsWith('.git/')
      || exclusions.some((value) => file.path === value || file.path.startsWith(value + '/'))
      || foldedPaths.has(file.path.toLowerCase()) || (previousPath !== undefined && file.path <= previousPath)) {
    throw new Error('Source manifest has an invalid, excluded, duplicate, or unordered file entry.');
  }
  sourceFiles.set(file.path, file);
  foldedPaths.add(file.path.toLowerCase());
  previousPath = file.path;
}
if (digest(JSON.stringify({ schema: 'public-source-content/v1', files: sourceManifest.files }) + '\n')
    !== sourceManifest.source_fingerprint_sha256) throw new Error('Source manifest fingerprint is invalid.');
const realRoot = await realpath(root);
await verifySourceInventory(new Set(exclusions));
for (const file of sourceManifest.files) {
  const source = await containedFile(file.path);
  const bytes = await readFile(source);
  if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('Source manifest is stale: ' + file.path);
}

const artifactRoot = path.join(root, '.artifacts');
await mkdir(artifactRoot, { recursive: true });
if ((await lstat(artifactRoot)).isSymbolicLink() || !isWithin(await realpath(artifactRoot), realRoot)) {
  throw new Error('Package staging root must be a contained directory.');
}
const stage = path.join(artifactRoot, 'public-pack-' + randomUUID());
await mkdir(stage);

try {
  const npm = await npmCli();
  const environment = {
    ...process.env,
    npm_config_cache: path.join(stage, 'npm-cache'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    COREPACK_ENABLE_NETWORK: '0'
  };
  const [preview] = await runNpm(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], root, environment);
  if (!preview || !Array.isArray(preview.files) || preview.files.length > 512
      || path.basename(preview.filename ?? '') !== preview.filename || !preview.filename.endsWith('.tgz')) {
    throw new Error('npm pack did not return a bounded local file inventory.');
  }
  const inputFiles = [];
  let inputBytes = 0;
  for (const file of preview.files) {
    const source = await containedFile(file.path);
    const bytes = await readFile(source);
    const reviewed = sourceFiles.get(file.path);
    if (!reviewed && !file.path.startsWith('dist/')) throw new Error('Package includes an unreviewed source file: ' + file.path);
    if (reviewed && (bytes.length !== reviewed.bytes || digest(bytes) !== reviewed.sha256)) {
      throw new Error('Source changed during packaging: ' + file.path);
    }
    inputBytes += bytes.length;
    if (inputBytes > 16 * 1024 * 1024) throw new Error('Package input exceeds 16 MiB.');
    const target = path.resolve(stage, file.path);
    if (!isWithin(target, stage)) throw new Error('Package file escapes its staging directory.');
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    inputFiles.push({ path: file.path, bytes: bytes.length, sha256: digest(bytes) });
  }
  for (const required of ['README.md', 'LICENSE', 'package.json', 'THIRD_PARTY_NOTICES.md', 'docs/licenses/three-MIT.txt']) {
    if (!inputFiles.some((file) => file.path === required)) throw new Error('Package inventory is missing ' + required);
  }
  const template = await readFile(path.join(root, 'docs', 'PACKAGE_README.md'));
  await writeFile(path.join(stage, 'README.md'), template);
  for (const file of inputFiles) {
    if (file.path !== 'README.md' && digest(await readFile(path.join(stage, file.path))) !== file.sha256) {
      throw new Error('Staging changed a package input: ' + file.path);
    }
  }
  await mkdir(output, { recursive: true });
  if (isWithin(await realpath(output), realRoot)) throw new Error('Package output resolves inside the source directory.');
  const archive = path.join(output, preview.filename);
  const receipt = archive + '.receipt.json';
  if (await exists(archive) || await exists(receipt)) throw new Error('Refusing to overwrite an existing package or receipt.');
  const [packed] = await runNpm(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', output], stage, environment);
  if (packed?.filename !== preview.filename) throw new Error('The staged package filename changed.');
  if (JSON.stringify(packed.files?.map((file) => file.path).sort()) !== JSON.stringify(inputFiles.map((file) => file.path).sort())) {
    throw new Error('Staged npm pack changed the selected package file set.');
  }
  const archiveBytes = await readFile(archive);
  const ancestry = JSON.parse(await readFile(path.join(root, 'public-source.json'), 'utf8'));
  await writeFile(receipt, JSON.stringify({
    schema: 'public-library-package-receipt/v1',
    project: 'tsl-smooth-graph',
    package: packed.name,
    version: packed.version,
    source_fingerprint_sha256: sourceManifest.source_fingerprint_sha256,
    source_manifest_sha256: digest(sourceManifestBytes),
    upstream_revision: ancestry.upstream_revision,
    archive: preview.filename,
    archive_bytes: archiveBytes.length,
    archive_sha256: digest(archiveBytes),
    transformation: {
      path: 'README.md',
      template: 'docs/PACKAGE_README.md',
      source_sha256: inputFiles.find((file) => file.path === 'README.md').sha256,
      packaged_sha256: digest(template)
    },
    unchanged_input_files: inputFiles.filter((file) => file.path !== 'README.md'),
    package_files: packed.files
  }, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ archive, receipt, sha256: digest(archiveBytes), bytes: archiveBytes.length }, null, 2));
} finally {
  const resolved = path.resolve(stage);
  if (path.dirname(resolved) !== path.resolve(artifactRoot) || !path.basename(resolved).startsWith('public-pack-')) {
    throw new Error('Unsafe package staging cleanup path.');
  }
  await rm(resolved, { recursive: true, force: true });
}

async function verifySourceInventory(excludedRoots) {
  const ordinaryFiles = new Set();
  const visit = async (directory, prefix = '', depth = 0) => {
    if (depth > 64) throw new Error('Source inventory exceeds its directory depth bound.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (!portablePath(relative)) throw new Error('Source inventory contains a nonportable path.');
      if (relative === '.git') continue;
      const item = await lstat(path.join(directory, entry.name));
      if (excludedRoots.has(relative)) {
        if (!item.isDirectory() && !item.isSymbolicLink()) throw new Error('A verification exclusion is not a directory.');
        continue;
      }
      if (item.isSymbolicLink()) throw new Error('Source inventory contains a symbolic link: ' + relative);
      if (item.isDirectory()) await visit(path.join(directory, entry.name), relative + '/', depth + 1);
      else if (item.isFile()) {
        if (relative === 'PUBLIC_MANIFEST.json') continue;
        if (!sourceFiles.has(relative)) throw new Error('Source inventory includes an unreviewed file: ' + relative);
        ordinaryFiles.add(relative);
      } else throw new Error('Source inventory includes an unsupported entry: ' + relative);
    }
  };
  await visit(root);
  if (ordinaryFiles.size !== sourceFiles.size) throw new Error('Source inventory is missing a reviewed file.');
}

async function containedFile(relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || path.isAbsolute(relative)) throw new Error('Invalid package/source path.');
  const candidate = path.resolve(root, relative);
  if (!isWithin(candidate, root)) throw new Error('Package/source path escapes its root.');
  const resolved = await realpath(candidate);
  if (!isWithin(resolved, realRoot)) throw new Error('Package/source symlink escapes its root.');
  if (!(await lstat(resolved)).isFile()) throw new Error('Package/source input must be a file.');
  return resolved;
}

async function npmCli() {
  const candidates = [process.env.PROJECT_NPM, process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const candidate of candidates) {
    if (candidate && path.basename(candidate) === 'npm-cli.js' && await exists(candidate)) return candidate;
  }
  throw new Error('Run with npm run pack:release, or set PROJECT_NPM to the installed npm-cli.js.');
}

function runNpm(cli, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let diagnostic = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Local npm pack timed out.')); }, 60_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 1024 * 1024) { child.kill(); reject(new Error('npm pack output exceeds its bound.')); }
    });
    child.stderr.on('data', (chunk) => { if (diagnostic.length < 16_384) diagnostic += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Local npm pack failed: ' + diagnostic.slice(0, 16_384)));
      else { try { resolve(JSON.parse(output)); } catch { reject(new Error('npm pack returned invalid JSON.')); } }
    });
  });
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function portablePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !/^[\\/]|[\\<>:"|?*!\x00-\x1f\x7f]/.test(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
