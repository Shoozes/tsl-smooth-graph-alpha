import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleTests = [
  'camera-timing.test.mjs',
  'corpus-framing.test.mjs',
  'corpus-navigation.test.mjs',
  'dynamic-routes.test.mjs',
  'node-spawn-motion.test.mjs',
  'responsive-framing.test.mjs',
  'search-scan-prefab.test.mjs',
  'search-scan.test.mjs',
  'static-server.test.mjs'
].map((name) => `tests/browser/${name}`);
const toolingTests = ['tests/tooling/task-menu.test.mjs', 'tests/tooling/package-readme.test.mjs', 'tests/tooling/package-review.test.mjs', 'tests/tooling/pages-build.test.mjs'];
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--examples')) {
  throw new Error('Use node scripts/run-tests.mjs [--examples].');
}

if (args[0] !== '--examples') {
  const directory = '.artifacts/test-dist/tests/product';
  const files = (await readdir(path.join(root, directory)))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => `${directory}/${name}`);
  if (files.length === 0) throw new Error('No compiled product tests found. Run pnpm run test.');
  await runNode(files);
}
await runNode([...exampleTests, ...toolingTests]);

async function runNode(files) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) process.exit(code);
}
