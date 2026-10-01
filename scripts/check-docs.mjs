import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', 'node_modules', 'dist', '.artifacts', 'release', 'coverage']);
const markdown = [];
await collect(root);
const failures = [];
let links = 0;
for (const file of markdown) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let destination = match[1].trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(destination)) continue;
    destination = destination.split(/[?#]/)[0];
    if (!destination) continue;
    links += 1;
    // The consumer template is copied to the package root as README.md.
    const base = path.relative(root, file).split(path.sep).join('/') === 'docs/PACKAGE_README.md'
      ? root : path.dirname(file);
    const target = path.resolve(base, decodeURIComponent(destination));
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !existsSync(target)) {
      failures.push(`${path.relative(root, file).split(path.sep).join('/')}: ${destination}`);
    }
  }
}
if (failures.length) {
  console.error(`Missing or escaped documentation destinations:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation links passed: ${markdown.length} Markdown files, ${links} local links.`);
}

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (entry.isFile() && entry.name.endsWith('.md')) markdown.push(file);
  }
}
