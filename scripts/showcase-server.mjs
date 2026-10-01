import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticFixtureServer } from './browser/static-server.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildShowcaseRoutes({ repositoryRoot: root = repositoryRoot, basePath = '' } = {}) {
  const prefix = normalizeBasePath(basePath);
  const route = (suffix, routeRoot) => ({ prefix: `${prefix}${suffix}`, root: routeRoot });
  return [
    route('/theme', path.join(root, 'examples', 'theme')),
    route('/showcase', path.join(root, 'examples', 'showcase')),
    route('/corpus', path.join(root, 'examples', 'corpus')),
    route('/dist', path.join(root, 'dist')),
    route('/vendor', path.join(root, 'node_modules', 'three', 'build')),
    route('/addons', path.join(root, 'node_modules', 'three', 'examples', 'jsm'))
  ];
}

async function main() {
  const basePath = normalizeBasePath(process.env.FORCEGRAPH_BASE_PATH ?? '');
  const server = await createStaticFixtureServer(buildShowcaseRoutes({ basePath }));
  console.log(`ForceGraph showcase: ${server.url}${basePath}/showcase/index.html`);
  console.log(`Corpus Atlas: ${server.url}${basePath}/corpus/index.html`);
  console.log('Press Ctrl+C to stop the local showcase server.');
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await server.close();
}

function normalizeBasePath(value) {
  if (value === '') return '';
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(value)) {
    throw new Error('FORCEGRAPH_BASE_PATH must be empty or a slash-prefixed path without traversal.');
  }
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
