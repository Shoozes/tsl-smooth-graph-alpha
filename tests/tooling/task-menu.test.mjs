import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateTaskManifest } from '../../run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const registry = (tasks) => ({ schema: 'gknome_task_registry_v1', project: 'Fixture', tasks });
const row = (id, spec, extra = {}) => ({ id, label: id, description: 'Fixture', spec, ...extra });
const command = (program, args) => ({ kind: 'process', program, args, working_directory: '.' });

test('noninteractive menu lists from an unrelated cwd without starting setup or builds', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'run.mjs')], {
    cwd: path.dirname(root), encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[forcegraph.showcase\]/);
  assert.match(result.stdout, /\[forcegraph.check\]/);
  assert.match(result.stdout, /\[forcegraph.setup\].*explicit setup/);
  assert.doesNotMatch(result.stdout, /"program"/);
});

test('explicit setup dry-run displays install flags without installing', () => {
  const result = spawnSync(process.execPath, ['run.mjs', '--task', 'setup', '--dry-run'], {
    cwd: root, encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"args":\["install","--frozen-lockfile","--ignore-scripts"\]/);
});

test('menu rejects escaped directories, unsafe arguments, and recursive sequences', () => {
  assert.throws(() => validateTaskManifest(registry([row('run', {
    ...command('node.exe', []), working_directory: '../'
  })])), /escapes/);
  assert.throws(() => validateTaskManifest(registry([row('run', command('pnpm.cmd', ['run', 'test&echo']))])), /shell-unsafe/);
  const spec = { kind: 'sequence', tasks: [] };
  spec.tasks.push(spec);
  assert.throws(() => validateTaskManifest(registry([row('run', spec)])), /nesting/);
});

test('unknown task fails from an unrelated cwd', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'run.mjs'), '--task', 'missing'], {
    cwd: path.dirname(root), encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown task/);
});

test('PowerShell app entry delegates the single product registry to Node', async () => {
  const source = await readFile(path.join(root, 'scripts/app.ps1'), 'utf8');
  assert.match(source, /#Requires -Version 5\.1/);
  assert.match(source, /Get-Command -Name node -CommandType Application/);
  assert.match(source, /'run\.mjs'/);
  assert.match(source, /exit \$LASTEXITCODE/);
  assert.doesNotMatch(source, /Invoke-Expression|Start-Process|Import-Module/);
});

test('run cannot hide dependency setup inside an inline sequence', async () => {
  await fixture('hidden setup', registry([row('run', {
    kind: 'sequence', tasks: [command('pnpm.cmd', ['install', '--ignore-scripts'])]
  })]), [], async (directory) => {
    const result = invoke(directory, ['--task', 'run', '--dry-run']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Setup must be selected explicitly/);
    assert.doesNotMatch(result.stdout, /"program"/);
  });
});

test('a failed process preserves its exit code and prevents later sequence work', async () => {
  await fixture('failure', registry([row('run', {
    kind: 'sequence', tasks: [command('node.exe', ['failure.mjs']), command('node.exe', ['--version'])]
  })]), [['failure.mjs', 'process.exit(7);\n']], async (directory) => {
    const result = invoke(directory, ['--task', 'run']);
    assert.equal(result.status, 7, result.stderr);
    assert.equal((result.stdout.match(/"program"/g) ?? []).length, 1);
  });
});

test('a project path with spaces executes literal arguments from an unrelated cwd', async () => {
  await fixture('path with spaces', registry([row('run', command('node.exe', ['echo.mjs', 'one argument with spaces']))]), [
    ['echo.mjs', 'console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv[2]}));\n']
  ], async (directory) => {
    const result = invoke(directory, ['--task', 'run'], path.dirname(directory));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /one argument with spaces/);
    assert.ok(result.stdout.includes(JSON.stringify(directory).slice(1, -1)));
  });
});

test('a missing pinned pnpm version fails without provisioning a toolchain', async () => {
  await fixture('pnpm preflight', registry([row('run', command('pnpm.cmd', ['run', 'build']))]), [
    ['package.json', JSON.stringify({ packageManager: 'pnpm@11.19.0' })],
    ['fake-pnpm.cjs', 'console.log("10.0.0");\n']
  ], async (directory) => {
    const result = spawnSync(process.execPath, [path.join(directory, 'run.mjs'), '--task', 'run'], {
      cwd: path.dirname(directory), env: { ...process.env, PROJECT_PNPM: path.join(directory, 'fake-pnpm.cjs') },
      encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Install pnpm 11\.19\.0 explicitly first; no toolchain download/);
  });
});

function invoke(directory, args, cwd = directory) {
  return spawnSync(process.execPath, [path.join(directory, 'run.mjs'), ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
}

async function fixture(label, manifest, files, check) {
  const temporaryRoot = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'forcegraph ' + label + '-'));
  try {
    await copyFile(path.join(root, 'run.mjs'), path.join(directory, 'run.mjs'));
    await writeFile(path.join(directory, 'project.tasks.json'), JSON.stringify(manifest), 'utf8');
    for (const [name, content] of files) await writeFile(path.join(directory, name), content, 'utf8');
    await check(directory);
  } finally {
    const relative = path.relative(temporaryRoot, path.resolve(directory));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
        || !path.basename(directory).startsWith('forcegraph ')) throw new Error('Unsafe fixture cleanup path.');
    await rm(directory, { recursive: true, force: true });
  }
}
