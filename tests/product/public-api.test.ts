import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

interface PublicApiBaseline {
  packageExports: Record<string, Record<string, string>>;
  runtimeExports: Record<string, string[]>;
  declarationExports: Record<string, string[]>;
  signatures: Array<{ file: string; text: string }>;
}

const packageJson = JSON.parse(
  await readFile(resolve('package.json'), 'utf8')
) as { exports: Record<string, Record<string, string>> };
const baseline = JSON.parse(
  await readFile(resolve('tests/package/public-api-baseline.json'), 'utf8')
) as PublicApiBaseline;

function declarationExportNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:class|function|const|interface|enum|type)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]!);
  }
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const entry of match[1]!.split(',')) {
      const name = entry.trim().split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

test('checked-in package export conditions and declaration/runtime surface stay frozen', async () => {
  assert.deepEqual(packageJson.exports, baseline.packageExports);
  const subpaths = Object.keys(baseline.packageExports);
  for (const subpath of subpaths) {
    const importPath = subpath === '.' ? './dist/index.js' : `./dist/${subpath.slice(2).replace('three', 'platform/three')}/index.js`;
    const module = await import(pathToFileURL(resolve(importPath)).href);
    assert.deepEqual(Object.keys(module).sort(), [...(baseline.runtimeExports[subpath] ?? [])].sort(), subpath);

    const declarationPath = subpath === '.'
      ? 'dist/index.d.ts'
      : subpath === './three'
        ? 'dist/platform/three/index.d.ts'
        : `dist/${subpath.slice(2)}/index.d.ts`;
    const declaration = await readFile(resolve(declarationPath), 'utf8');
    assert.deepEqual(declarationExportNames(declaration), [...(baseline.declarationExports[subpath] ?? [])].sort(), `${subpath} declarations`);
  }
  for (const signature of baseline.signatures) {
    const declaration = await readFile(resolve(signature.file), 'utf8');
    assert.ok(declaration.includes(signature.text), `${signature.file} is missing: ${signature.text}`);
  }
});

test('root factory exposes the interface contract without leaking GraphController', async () => {
  const root = await import('@ours/forcegraph-tsl');
  assert.equal(typeof root.createForceGraph3D, 'function');
  assert.equal('GraphController' in root, false);
});
