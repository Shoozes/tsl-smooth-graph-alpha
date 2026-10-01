import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const programs = new Set(['node', 'python', 'npm', 'pnpm']);
const environment = () => ({ ...process.env, COREPACK_ENABLE_NETWORK: '0', npm_config_manage_package_manager_versions: 'false' });

export function flattenSpecs(spec, depth = 0) {
  if (!spec || depth > 8) throw new Error('Task sequence nesting exceeds its bound.');
  if (spec.kind === 'sequence') {
    if (!Array.isArray(spec.tasks) || !spec.tasks.length || spec.tasks.length > 128) throw new Error('Invalid task sequence.');
    return spec.tasks.flatMap((child) => flattenSpecs(child, depth + 1));
  }
  const program = typeof spec.program === 'string' ? spec.program.replace(/\.(?:cmd|exe)$/i, '') : undefined;
  const cwd = spec.working_directory ?? '.';
  if (!['process', 'check'].includes(spec.kind) || !programs.has(program) || typeof cwd !== 'string'
      || path.isAbsolute(cwd) || !Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === 'string' && !/[\r\n\0]/.test(arg))) {
    throw new Error('Invalid process/check task declaration.');
  }
  if (['npm', 'pnpm'].includes(program) && spec.args.some((arg) => /[\s"&|<>^%!?]/.test(arg))) throw new Error('A package-manager argument is shell-unsafe.');
  if (!isWithin(path.resolve(root, cwd), root)) throw new Error('Task working directory escapes the project.');
  if (spec.timeout_ms !== undefined && (!Number.isInteger(spec.timeout_ms) || spec.timeout_ms < 1 || spec.timeout_ms > 600_000)) throw new Error('Invalid task timeout.');
  if (spec.max_output_bytes !== undefined && (!Number.isInteger(spec.max_output_bytes) || spec.max_output_bytes < 1 || spec.max_output_bytes > 16_777_216)) throw new Error('Invalid task output bound.');
  return [{ ...spec, program, working_directory: cwd }];
}

export function validateTaskManifest(manifest) {
  if (manifest?.schema !== 'gknome_task_registry_v1' || typeof manifest.project !== 'string'
      || !Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new Error('Invalid portable project task registry.');
  const tasks = new Map();
  for (const task of manifest.tasks) {
    if (!task || !/^[a-z][a-z0-9.:-]*$/.test(task.id ?? '') || tasks.has(task.id)
        || typeof task.label !== 'string' || typeof task.description !== 'string') throw new Error('Invalid or duplicate task ID/label.');
    for (const key of ['explicit_setup', 'menu']) {
      if (task[key] !== undefined && typeof task[key] !== 'boolean') throw new Error('Invalid task flag: ' + key);
    }
    if (task.alias !== undefined && (!/^[a-z][a-z0-9.:-]*$/.test(task.alias) || tasks.has(task.alias))) throw new Error('Invalid or duplicate task alias.');
    flattenSpecs(task.spec);
    tasks.set(task.id, task);
    if (task.alias) tasks.set(task.alias, task);
  }
  return tasks;
}

function commandFor(spec) {
  const override = spec.program === 'python' ? process.env.PROJECT_PYTHON : spec.program === 'pnpm' ? process.env.PROJECT_PNPM : undefined;
  if (override && /\.(?:cjs|mjs|js)$/i.test(override)) return { program: process.execPath, args: [override, ...spec.args] };
  if (override) {
    if (process.platform === 'win32' && /\.cmd$/i.test(override)) throw new Error('PROJECT_PNPM must point to pnpm.cjs or a native executable.');
    return { program: override, args: spec.args };
  }
  if (spec.program === 'node') return { program: process.execPath, args: spec.args };
  if (process.platform === 'win32' && ['npm', 'pnpm'].includes(spec.program)) return { program: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', [spec.program, ...spec.args].join(' ')] };
  return { program: spec.program, args: spec.args };
}

async function preflightPnpm(cwd) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Pinned pnpm requires Node 22.13 or newer.');
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const wanted = /^pnpm@([^+]+)(?:\+.*)?$/.exec(metadata.packageManager ?? '')?.[1];
  if (!wanted) throw new Error('package.json must pin pnpm.');
  const command = commandFor({ program: 'pnpm', args: ['--version'] });
  const output = await new Promise((resolve, reject) => {
    const child = spawn(command.program, command.args, { cwd, env: environment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('pnpm prerequisite check timed out.')); }, 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 4096) { child.kill(); reject(new Error('pnpm prerequisite output exceeded its bound.')); }
    });
    child.stderr.resume();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error('pnpm is unavailable.')); });
  });
  if (output !== wanted) throw new Error('Install pnpm ' + wanted + ' explicitly first; no toolchain download was attempted.');
}

function runProcess(spec, cwd) {
  const command = commandFor(spec);
  return new Promise((resolve, reject) => {
    const child = spawn(command.program, command.args, { cwd, env: environment(), stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
    let bytes = 0;
    let exceeded = false;
    const stop = (message) => { if (!exceeded) console.error(message); exceeded = true; child.kill(); };
    const timer = spec.timeout_ms === undefined ? undefined : setTimeout(() => stop('Task exceeded its time bound.'), spec.timeout_ms);
    const forward = (destination) => (chunk) => {
      bytes += chunk.length;
      if (spec.max_output_bytes !== undefined && bytes > spec.max_output_bytes) { stop('Task exceeded its output bound.'); return; }
      destination.write(chunk);
    };
    child.stdout.on('data', forward(process.stdout));
    child.stderr.on('data', forward(process.stderr));
    child.once('error', (error) => { clearTimeout(timer); reject(new Error('Cannot start the documented prerequisite.', { cause: error })); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve(exceeded ? 1 : code ?? (signal ? 130 : 1)); });
  });
}

async function executeTask(tasks, id, dryRun) {
  const task = tasks.get(id);
  if (!task) throw new Error('Unknown task: ' + id);
  const processes = flattenSpecs(task.spec);
  if (!task.explicit_setup && processes.some((spec) => ['npm', 'pnpm'].includes(spec.program) && ['install', 'ci', 'add', 'update'].includes(spec.args[0]))) {
    throw new Error('Setup must be selected explicitly; it cannot run through another task.');
  }
  const realRoot = await realpath(root);
  let pnpmChecked = false;
  for (const spec of processes) {
    const cwd = await realpath(path.resolve(root, spec.working_directory));
    if (!isWithin(cwd, realRoot)) throw new Error('Task working directory escapes the project.');
    console.log('\n' + task.label + ': ' + JSON.stringify(spec));
    if (dryRun) continue;
    if (spec.program === 'pnpm' && !pnpmChecked) { await preflightPnpm(cwd); pnpmChecked = true; }
    const code = await runProcess(spec, cwd);
    if (code !== 0) return code;
  }
  return 0;
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(root, 'project.tasks.json'), 'utf8'));
  const tasks = validateTaskManifest(manifest);
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const selection = args.filter((arg) => arg !== '--dry-run');
  let id;
  if (selection.length === 2 && ['--task', '-Task'].includes(selection[0])) id = selection[1];
  else if (selection.length === 1 && !selection[0].startsWith('-')) id = selection[0];
  else if (selection.length && !(selection.length === 1 && ['--help', '--list', '-h'].includes(selection[0]))) throw new Error('Use --task <id-or-alias>, --list, or --dry-run.');
  if (!id) {
    const menuTasks = selection[0] === '--list' ? manifest.tasks : manifest.tasks.filter((task) => task.menu !== false);
    console.log(manifest.project + '\n' + (manifest.description ?? '') + '\n');
    for (const [index, task] of menuTasks.entries()) console.log((index + 1) + '. ' + task.label + ' [' + task.id + ']' + (task.explicit_setup ? ' — explicit setup' : '') + '\n   ' + task.description);
    console.log('\nUse node run.mjs --task <id-or-alias>; add --dry-run to inspect commands.');
    if (selection.length || !process.stdin.isTTY || !process.stdout.isTTY) return;
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await input.question('\nSelect a task by number or ID (Enter to exit): ')).trim();
      if (!answer) return;
      id = /^\d+$/.test(answer) ? menuTasks[Number(answer) - 1]?.id : answer;
      if (!id) throw new Error('That menu selection is unavailable.');
    } finally { input.close(); }
  }
  process.exitCode = await executeTask(tasks, id, dryRun);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
