import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = 'forcegraph_pages_v1';
const webExtensions = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.woff2']);
const threeModules = ['three.core.js', 'three.module.js', 'three.tsl.js', 'three.webgpu.js'];
const addons = ['controls/OrbitControls.js', 'tsl/display/BloomNode.js'];

/** Build a relocatable, local-only showcase from explicitly installed inputs. */
export async function buildPages({ repositoryRoot: root = repositoryRoot, outputDirectory = '.artifacts/pages' } = {}) {
  root = await realpath(root);
  const artifacts = path.join(root, '.artifacts');
  const output = path.resolve(root, outputDirectory);
  if (path.dirname(output) !== artifacts) throw new Error('Pages output must be a direct child of .artifacts.');
  await mkdir(artifacts, { recursive: true });
  if (await realpath(artifacts) !== artifacts) throw new Error('Pages artifacts directory must not be a symbolic link.');
  const previous = await lstat(output).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (previous) {
    if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error('Pages output must be a generated directory.');
    const marker = await readFile(path.join(output, 'pages-manifest.json'), 'utf8').catch(() => 'null');
    if (JSON.parse(marker)?.schema !== schema) throw new Error('Refusing to replace an output without a Pages manifest.');
  }

  async function projectInput(file) {
    const info = await lstat(file);
    const canonical = await realpath(file);
    const relative = path.relative(root, canonical);
    if (info.isSymbolicLink() || canonical !== file || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Pages project inputs must not contain symbolic links or escape the repository: ${file}`);
    }
    return info;
  }
  await projectInput(path.join(root, 'package.json'));
  await projectInput(path.join(root, 'pnpm-lock.yaml'));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const three = path.join(root, 'node_modules', 'three');
  const installedThree = JSON.parse(await readFile(path.join(three, 'package.json'), 'utf8'));
  if (installedThree.version !== packageJson.devDependencies.three) throw new Error('Installed Three must match the pinned development dependency.');
  const stage = await mkdtemp(path.join(artifacts, '.pages-build-'));
  const files = [];
  async function emit(relative, bytes) {
    const destination = path.join(stage, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    files.push({ path: relative.split(path.sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) });
  }
  async function copy(file, relative, installedDependency = false) {
    const info = installedDependency ? await lstat(file) : await projectInput(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Pages input must be a regular file: ${file}`);
    await emit(relative, await readFile(file));
  }
  async function tree(source, destination, accept) {
    const directory = await projectInput(source);
    if (!directory.isDirectory()) throw new Error(`Pages input must be a directory: ${source}`);
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw new Error(`Pages inputs must not contain symbolic links: ${entry.name}`);
      if (entry.isDirectory()) await tree(path.join(source, entry.name), path.join(destination, entry.name), accept);
      else if (entry.isFile() && accept(entry.name)) await copy(path.join(source, entry.name), path.join(destination, entry.name));
    }
  }

  try {
    // These checks make missing build/setup fail before replacing the last usable output.
    await lstat(path.join(root, 'dist', 'index.js'));
    await lstat(path.join(root, 'dist', 'worker', 'force-worker-entry.js'));
    for (const name of ['theme', 'showcase', 'corpus']) {
      await tree(path.join(root, 'examples', name), name, name => webExtensions.has(path.extname(name)));
    }
    await tree(path.join(root, 'dist'), 'dist', name => name.endsWith('.js') || name.endsWith('.js.map'));
    await tree(path.join(root, 'source'), 'source', name => name.endsWith('.ts'));
    // pnpm's installed Three root may be a symlink; project inputs may not.
    for (const name of threeModules) await copy(path.join(three, 'build', name), path.join('vendor', name), true);
    for (const name of addons) await copy(path.join(three, 'examples', 'jsm', name), path.join('addons', name), true);
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/licenses/three-MIT.txt']) await copy(path.join(root, name), name);
    for (const directory of ['vendor', 'addons']) await copy(path.join(three, 'LICENSE'), path.join(directory, 'LICENSE'), true);
    await emit('index.html', Buffer.from('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0; url=./showcase/index.html"><title>ForceGraph TSL demos</title></head><body><h1>ForceGraph TSL demos</h1><p><a href="./showcase/index.html">Open the gallery</a></p><p><a href="./showcase/examples/search-scan/index.html">Open Search scan</a> (includes a Canvas2D fallback).</p></body></html>\n'));
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest = {
      schema,
      package: { name: packageJson.name, version: packageJson.version, packageManager: packageJson.packageManager, three: installedThree.version },
      lockfileSha256: sha256(await readFile(path.join(root, 'pnpm-lock.yaml'))),
      fingerprint: sha256(JSON.stringify(files)),
      files
    };
    await writeFile(path.join(stage, 'pages-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (previous) await rm(output, { recursive: true });
    await rename(stage, output);
    return { outputDirectory: output, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/build-pages.mjs [--output .artifacts/pages]');
  const result = await buildPages(args.length ? { outputDirectory: args[1] } : {});
  console.log(`Pages export: ${result.outputDirectory}`);
  console.log(`${result.manifest.files.length} files; SHA-256 ${result.manifest.fingerprint}`);
}
