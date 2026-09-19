#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  cp,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCodex, runOne } from '../runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, '..', 'runner.mjs');
const CAMPAIGN = fileURLToPath(import.meta.url);
const ARMS = ['ordinary', 'codefacts', 'codegraph'];
const EXPECTED_CODEFACTS_TOOLS = ['expand', 'map', 'outline', 'path', 'search'];
const EXPECTED_CODEGRAPH_TOOLS = ['codegraph_explore'];
const DEFAULT_TIMEOUT_MS = 240_000;
const EXECUTION = { mode: 'readonly', model: 'gpt-5.6-luna', reasoningEffort: 'medium' };
const COMMON_GUIDANCE = 'Aim to finish within 16 combined MCP and shell calls. This is an audit threshold, not a hard cap; preserve correctness if more evidence is needed.';
const ARM_GUIDANCE = {
  ordinary: '',
  codefacts: 'Before any other repository inspection, call at least one relevant CodeFacts MCP tool. Then freely use ordinary shell reads and other available tools as needed.',
  codegraph: 'Before any other repository inspection, call codegraph_explore at least once with a query relevant to the task. Then freely use ordinary shell reads and other available tools as needed.',
};

function usage() {
  return `Usage: node campaign.mjs COMMAND --config PATH [--tasks PATH] [options]

Commands:
  prepare                 Build and measure frozen CodeFacts/CodeGraph indexes; never starts Codex
  freeze                  Freeze six tasks, inputs, hashes, blind labels, and the 36-attempt order
  readonly                Recheck every frozen input and prepared index hash
  readiness --arm ARM     Run one arm on the independent toy fixture
  run [--max-attempts N]  Run remaining formal attempts sequentially (default: all)
  status                  Print preparation/readiness/formal progress without mutation
  summarize [--grades P] [--tool-audit P]
                          Write summary.json plus blind grading and tool-audit exports

Required machine config (kept under ignored target/, never committed):
  { "workRoot": "...", "sourceRoot": "...", "codexBin": "...",
    "sessionsDir": "...", "codefactsBin": "...",
    "codegraph": { "nodeBin": "...", "entryJs": "..." },
    "sourceRevision": "543e874..." }

The tasks file defaults to ./tasks.json. readiness and run are the only commands
that start Codex. The harness never retries, replaces, or tunes an attempt.
`;
}

function parseArgs(argv) {
  const out = { tasks: join(HERE, 'tasks.json'), timeoutMs: DEFAULT_TIMEOUT_MS, grades: null, toolAudit: null, maxAttempts: Infinity };
  if (!argv.length || argv[0].startsWith('-')) return { ...out, help: true };
  out.command = argv[0];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...out, help: true };
    const key = { '--config': 'config', '--tasks': 'tasks', '--arm': 'arm', '--grades': 'grades', '--tool-audit': 'toolAudit', '--timeout-ms': 'timeoutMs', '--max-attempts': 'maxAttempts' }[arg];
    if (!key) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    out[key] = value;
  }
  out.timeoutMs = Number(out.timeoutMs);
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1) throw new Error('--timeout-ms must be a positive integer');
  if (out.maxAttempts !== Infinity) {
    out.maxAttempts = Number(out.maxAttempts);
    if (!Number.isInteger(out.maxAttempts) || out.maxAttempts < 1) throw new Error('--max-attempts must be a positive integer');
  }
  if (!out.config) throw new Error('--config is required');
  return out;
}

function shaBuffer(value) { return createHash('sha256').update(value).digest('hex'); }
async function shaFile(path) { return shaBuffer(await readFile(path)); }
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function posix(value) { return value.replaceAll('\\', '/'); }
function quote(value) { return JSON.stringify(posix(value)); }

async function inventory(root, { exclude = [] } = {}) {
  const rows = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = posix(relative(root, path));
      if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        rows.push({ path: rel, bytes: info.size, sha256: await shaFile(path) });
      }
    }
  }
  await walk(root);
  return { files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), digest: shaBuffer(JSON.stringify(rows)), entries: rows };
}

async function treeDigest(root) {
  if (!existsSync(root)) return null;
  return inventory(root);
}

function validateAbsoluteFile(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || !existsSync(value)) throw new Error(`${name} must be an existing absolute path: ${value}`);
}

async function loadContext(options) {
  const configPath = resolve(options.config);
  const config = await readJson(configPath);
  for (const [name, value] of [['workRoot', config.workRoot], ['sourceRoot', config.sourceRoot], ['codexBin', config.codexBin], ['codefactsBin', config.codefactsBin], ['codegraph.nodeBin', config.codegraph?.nodeBin], ['codegraph.entryJs', config.codegraph?.entryJs]]) {
    if (name.endsWith('Root')) {
      if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${name} must be absolute`);
    } else validateAbsoluteFile(value, name);
  }
  if (!config.sourceRevision || typeof config.sourceRevision !== 'string') throw new Error('sourceRevision is required');
  const workRoot = resolve(config.workRoot);
  const sourceRoot = resolve(config.sourceRoot);
  if (sourceRoot === workRoot || !sourceRoot.startsWith(`${workRoot}\\`) && !sourceRoot.startsWith(`${workRoot}/`)) throw new Error('sourceRoot must be a child of workRoot');
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error(`sourceRoot is not a directory: ${sourceRoot}`);
  await mkdir(workRoot, { recursive: true });
  return {
    configPath,
    config,
    workRoot,
    sourceRoot,
    paths: {
      prepared: join(workRoot, 'prepared.json'),
      freeze: join(workRoot, 'freeze.json'),
      readiness: join(workRoot, 'readiness'),
      formal: join(workRoot, 'formal'),
      progress: join(workRoot, 'progress.json'),
      summary: join(workRoot, 'summary.json'),
      blind: join(workRoot, 'grading-blind'),
      codefactsMaster: join(workRoot, 'indexes', 'codefacts-master.sqlite'),
      codegraphMaster: join(workRoot, 'indexes', 'codegraph-master'),
      toyRoot: join(workRoot, 'readiness-fixture'),
      toyCodefactsMaster: join(workRoot, 'indexes', 'toy-codefacts-master.sqlite'),
      toyCodegraphMaster: join(workRoot, 'indexes', 'toy-codegraph-master'),
    },
  };
}

function isolatedEnv(workRoot) {
  return {
    ...process.env,
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    CODEGRAPH_NO_DOWNLOAD: '1',
    GIT_CEILING_DIRECTORIES: workRoot,
  };
}

function runNative(command, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  const start = performance.now();
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    durationMs: performance.now() - start,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function mcpSession(command, args, { cwd, env, calls }) {
  const started = performance.now();
  const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const records = [];
  const pending = new Map();
  let stderr = '';
  let sequence = 0;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  child.once('error', (error) => {
    for (const pendingCall of pending.values()) pendingCall.reject(error);
    pending.clear();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { records.push({ nonJson: line }); return; }
    records.push(message);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolveCall, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60_000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const output = { records, stderr, calls: [], startedAt: new Date().toISOString() };
  try {
    output.initialize = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codefacts-luna-campaign-prepare', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    output.schema = await call('tools/list', {});
    for (const request of calls) {
      const callStart = performance.now();
      const result = await call('tools/call', request);
      output.calls.push({ request, durationMs: performance.now() - callStart, result });
    }
    output.ok = true;
  } finally {
    child.stdin.end();
    let timer;
    let exit = await Promise.race([closed, new Promise((resolveWait) => { timer = setTimeout(() => resolveWait(null), 5_000); })]);
    clearTimeout(timer);
    if (!exit) { child.kill(); exit = await closed; output.forcedTermination = true; }
    output.exit = exit;
    output.durationMs = performance.now() - started;
    output.stderr = stderr;
  }
  return output;
}

function toolNames(session) {
  return (session.schema?.tools || []).map((tool) => tool.name).sort();
}

function assertToolSchema(actual, expected, arm) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${arm} tool schema mismatch: ${JSON.stringify(actual)}`);
}

function codegraphArgs(config, tail) {
  return ['--liftoff-only', '--disable-warning=ExperimentalWarning', config.codegraph.entryJs, ...tail];
}

async function findPackageJson(entryJs) {
  let cursor = dirname(resolve(entryJs));
  for (;;) {
    const candidate = join(cursor, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`No package.json found above ${entryJs}`);
    cursor = parent;
  }
}

async function codegraphImplementation(config) {
  const packageJson = config.codegraph.packageJson ? resolve(config.codegraph.packageJson) : await findPackageJson(config.codegraph.entryJs);
  validateAbsoluteFile(packageJson, 'codegraph.packageJson');
  const packageRoot = dirname(packageJson);
  const distRoot = existsSync(join(packageRoot, 'dist')) ? join(packageRoot, 'dist') : join(packageRoot, 'lib', 'dist');
  if (!existsSync(distRoot)) throw new Error(`CodeGraph lib/dist missing: ${distRoot}`);
  return {
    packageJson,
    packageJsonSha256: await shaFile(packageJson),
    package: await readJson(packageJson),
    distRoot,
    dist: await inventory(distRoot),
  };
}

async function assertNoOuterGit(sourceRoot, workRoot, env) {
  const check = runNative('git.exe', ['-C', sourceRoot, 'rev-parse', '--is-inside-work-tree'], { cwd: workRoot, env, timeoutMs: 10_000 });
  if (check.status === 0) throw new Error(`Refusing CodeGraph init: source resolves to a Git worktree: ${check.stdout.trim()}`);
  return check;
}

async function createToyFixture(root) {
  const files = {
    'src/math.ts': 'export function double(value: number): number {\n  return value * 2;\n}\n',
    'src/use.ts': "import { double } from './math.js';\nexport const answer = double(21);\n",
    'README.md': '# Readiness fixture\n\n`answer` is produced by calling `double`.\n',
  };
  if (existsSync(root)) {
    const actual = await inventory(root, { exclude: ['.codegraph'] });
    const expectedRows = Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: shaBuffer(content) })).sort((a, b) => a.path.localeCompare(b.path));
    const expected = { files: expectedRows.length, bytes: expectedRows.reduce((sum, row) => sum + row.bytes, 0), digest: shaBuffer(JSON.stringify(expectedRows)) };
    if (actual.files !== expected.files || actual.bytes !== expected.bytes || actual.digest !== expected.digest) throw new Error(`Refusing to reuse changed readiness fixture: ${root}`);
    return;
  }
  await mkdir(join(root, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content, 'utf8');
}

async function prepareOneRoot(ctx, root, statePath, label) {
  const env = isolatedEnv(ctx.workRoot);
  const sourceBefore = await inventory(root, { exclude: ['.codegraph'] });
  const cf = await mcpSession(ctx.config.codefactsBin, ['mcp', '--root', root, '--state', statePath], {
    cwd: root,
    env,
    calls: [{ name: 'map', arguments: {} }],
  });
  assertToolSchema(toolNames(cf), EXPECTED_CODEFACTS_TOOLS, `${label} CodeFacts`);
  if (cf.calls[0]?.result?.isError) throw new Error(`${label} CodeFacts map failed`);
  const cfMapBefore = JSON.parse(cf.calls[0].result.content.find((item) => item.type === 'text')?.text || '{}');
  const gitBoundary = await assertNoOuterGit(root, ctx.workRoot, env);
  const cgInit = runNative(ctx.config.codegraph.nodeBin, codegraphArgs(ctx.config, ['init', '--yes', root]), { cwd: root, env, timeoutMs: 180_000 });
  if (cgInit.status !== 0) throw new Error(`${label} CodeGraph init failed: ${cgInit.stderr || cgInit.stdout}`);
  const sourceAfterInit = await inventory(root, { exclude: ['.codegraph'] });
  if (sourceBefore.digest !== sourceAfterInit.digest) throw new Error(`${label} CodeGraph init changed source files`);
  const cg = await mcpSession(ctx.config.codegraph.nodeBin, codegraphArgs(ctx.config, ['serve', '--mcp']), { cwd: root, env, calls: [] });
  assertToolSchema(toolNames(cg), EXPECTED_CODEGRAPH_TOOLS, `${label} CodeGraph`);
  const cfAfter = await mcpSession(ctx.config.codefactsBin, ['mcp', '--root', root, '--state', statePath], {
    cwd: root,
    env,
    calls: [{ name: 'map', arguments: {} }],
  });
  const cfMapAfter = JSON.parse(cfAfter.calls[0].result.content.find((item) => item.type === 'text')?.text || '{}');
  if (cfMapAfter.indexed_files !== cfMapBefore.indexed_files || cfMapAfter.files_indexed_this_refresh !== 0) {
    throw new Error(`${label} CodeFacts indexed generated .codegraph content or otherwise changed after CodeGraph init`);
  }
  return {
    label,
    source: sourceBefore,
    gitBoundary: { status: gitBoundary.status, stdout: gitBoundary.stdout, stderr: gitBoundary.stderr },
    codefacts: {
      durationMs: cf.durationMs,
      tools: toolNames(cf),
      mapBefore: cfMapBefore,
      mapAfter: cfMapAfter,
      state: await inventory(dirname(statePath), { exclude: label === 'source' ? [] : [] }),
      stateFile: { path: statePath, bytes: (await stat(statePath)).size, sha256: await shaFile(statePath) },
    },
    codegraph: {
      init: cgInit,
      tools: toolNames(cg),
      index: await inventory(join(root, '.codegraph')),
    },
  };
}

async function commandPrepare(ctx) {
  if (existsSync(ctx.paths.prepared)) throw new Error(`Preparation already exists: ${ctx.paths.prepared}`);
  if (existsSync(join(ctx.sourceRoot, '.codegraph'))) throw new Error('Refusing to reuse a source snapshot with an existing .codegraph index');
  await mkdir(join(ctx.workRoot, 'indexes'), { recursive: true });
  await createToyFixture(ctx.paths.toyRoot);
  const sourceBefore = await inventory(ctx.sourceRoot, { exclude: ['.codegraph'] });
  const codegraphImpl = await codegraphImplementation(ctx.config);
  const receipt = {
    schemaVersion: 1,
    status: 'preparing',
    preparedAt: new Date().toISOString(),
    sourceRevision: ctx.config.sourceRevision,
    sourceRoot: ctx.sourceRoot,
    binaries: {
      codex: { path: ctx.config.codexBin, sha256: await shaFile(ctx.config.codexBin), version: runNative(ctx.config.codexBin, ['--version'], { cwd: ctx.workRoot, env: isolatedEnv(ctx.workRoot), timeoutMs: 10_000 }) },
      codefacts: { path: ctx.config.codefactsBin, sha256: await shaFile(ctx.config.codefactsBin), version: runNative(ctx.config.codefactsBin, ['--version'], { cwd: ctx.workRoot, env: isolatedEnv(ctx.workRoot), timeoutMs: 10_000 }) },
      codegraphNode: { path: ctx.config.codegraph.nodeBin, sha256: await shaFile(ctx.config.codegraph.nodeBin), version: runNative(ctx.config.codegraph.nodeBin, ['--version'], { cwd: ctx.workRoot, env: isolatedEnv(ctx.workRoot), timeoutMs: 10_000 }) },
      codegraphImplementation: codegraphImpl,
    },
  };
  receipt.source = await prepareOneRoot(ctx, ctx.sourceRoot, ctx.paths.codefactsMaster, 'source');
  receipt.toy = await prepareOneRoot(ctx, ctx.paths.toyRoot, ctx.paths.toyCodefactsMaster, 'toy');
  const sourceAfter = await inventory(ctx.sourceRoot, { exclude: ['.codegraph'] });
  if (sourceAfter.digest !== sourceBefore.digest) throw new Error('Preparation changed frozen source files');
  receipt.status = 'prepared';
  receipt.completedAt = new Date().toISOString();
  await writeJson(ctx.paths.prepared, receipt);
  process.stdout.write(`${JSON.stringify({ status: receipt.status, sourceFiles: sourceAfter.files, codefactsMs: receipt.source.codefacts.durationMs, codefactsBytes: receipt.source.codefacts.stateFile.bytes, codegraphMs: receipt.source.codegraph.init.durationMs, codegraphBytes: receipt.source.codegraph.index.bytes })}\n`);
}

function parseLineSpec(value, context) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${context} has an empty lines value`);
  const ranges = value.split(',').map((part) => part.trim()).map((part) => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error(`${context} has invalid lines syntax: ${value}`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < start) throw new Error(`${context} has invalid line range: ${part}`);
    return { start, end };
  });
  return ranges;
}

async function loadTasks(path, sourceRoot, expectedRevision) {
  const raw = await readJson(resolve(path));
  const tasks = Array.isArray(raw) ? raw : raw.tasks;
  if (!Array.isArray(tasks) || tasks.length !== 6) throw new Error('tasks.json must contain exactly six tasks');
  if (!Array.isArray(raw)) {
    if (raw.snapshot?.commit !== expectedRevision) throw new Error(`tasks snapshot commit does not match machine config: ${raw.snapshot?.commit}`);
    if (raw.mode !== 'readonly' || raw.model !== EXECUTION.model || raw.reasoningEffort !== EXECUTION.reasoningEffort) throw new Error('tasks execution settings do not match the frozen campaign');
  }
  const ids = new Set();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || typeof task.prompt !== 'string' || !task.prompt.trim()) throw new Error(`Invalid task: ${JSON.stringify(task)}`);
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!Array.isArray(task.criteria) || !task.criteria.length) throw new Error(`${task.id} has no grading criteria`);
    for (const criterion of task.criteria) {
      if (!Array.isArray(criterion.evidence) || !criterion.evidence.length) throw new Error(`${task.id}/${criterion.id} has no evidence`);
      for (const evidence of criterion.evidence) {
        if (typeof evidence.path !== 'string' || isAbsolute(evidence.path) || evidence.path.split(/[\\/]/).includes('..')) throw new Error(`${task.id}/${criterion.id} has unsafe evidence path: ${evidence.path}`);
        const absolute = resolve(sourceRoot, evidence.path);
        if (!existsSync(absolute)) throw new Error(`${task.id}/${criterion.id} evidence path missing: ${evidence.path}`);
        const actualHash = await shaFile(absolute);
        if (actualHash !== evidence.sha256) throw new Error(`${task.id}/${criterion.id} evidence hash mismatch for ${evidence.path}: expected ${evidence.sha256}, got ${actualHash}`);
        const text = await readFile(absolute, 'utf8');
        const lineCount = text.endsWith('\n') ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length;
        for (const range of parseLineSpec(evidence.lines, `${task.id}/${criterion.id}/${evidence.path}`)) {
          if (range.end > lineCount) throw new Error(`${task.id}/${criterion.id} evidence line ${range.end} exceeds ${evidence.path} line count ${lineCount}`);
        }
      }
    }
  }
  return tasks.map(({ id, prompt }) => ({ id, prompt }));
}

export function buildSchedule(tasks, labels = null) {
  const schedule = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const rotation = ARMS.map((_, offset) => ARMS[(index + offset) % ARMS.length]);
    const rounds = [rotation, [...rotation].reverse()];
    for (let round = 0; round < rounds.length; round += 1) {
      for (let position = 0; position < rounds[round].length; position += 1) {
        const arm = rounds[round][position];
        const key = `${tasks[index].id}:${arm}:${round + 1}`;
        schedule.push({ ordinal: schedule.length + 1, taskId: tasks[index].id, taskIndex: index, arm, run: round + 1, round: round + 1, position: position + 1, label: labels?.[key] || null });
      }
    }
  }
  return schedule;
}

function makeLabels(tasks) {
  const labels = {};
  for (const task of tasks) for (const arm of ARMS) for (const run of [1, 2]) labels[`${task.id}:${arm}:${run}`] = `response-${randomBytes(8).toString('hex')}`;
  return labels;
}

async function currentFrozenInputs(ctx, tasksPath, { includeLiveCodegraphIndex = false } = {}) {
  const packageInfo = await codegraphImplementation(ctx.config);
  const inputs = {
    source: await inventory(ctx.sourceRoot, { exclude: ['.codegraph'] }),
    toySource: await inventory(ctx.paths.toyRoot, { exclude: ['.codegraph'] }),
    codegraphMaster: await inventory(ctx.paths.codegraphMaster),
    toyCodegraphMaster: await inventory(ctx.paths.toyCodegraphMaster),
    codefactsMaster: { bytes: (await stat(ctx.paths.codefactsMaster)).size, sha256: await shaFile(ctx.paths.codefactsMaster) },
    tasksSha256: await shaFile(resolve(tasksPath)),
    rubricSha256: await shaFile(join(HERE, 'RUBRIC.md')),
    provenanceSha256: await shaFile(join(HERE, 'PROVENANCE.md')),
    readmeSha256: await shaFile(join(HERE, 'README.md')),
    preparedSha256: await shaFile(ctx.paths.prepared),
    runnerSha256: await shaFile(RUNNER),
    campaignSha256: await shaFile(CAMPAIGN),
    configSha256: await shaFile(ctx.configPath),
    codexSha256: await shaFile(ctx.config.codexBin),
    codefactsSha256: await shaFile(ctx.config.codefactsBin),
    codegraphNodeSha256: await shaFile(ctx.config.codegraph.nodeBin),
    codegraphPackageSha256: packageInfo.packageJsonSha256,
    codegraphDistDigest: packageInfo.dist.digest,
  };
  if (includeLiveCodegraphIndex) inputs.codegraphIndex = await inventory(join(ctx.sourceRoot, '.codegraph'));
  return inputs;
}

async function commandFreeze(ctx, options) {
  if (!existsSync(ctx.paths.prepared)) throw new Error('Run prepare first');
  if (existsSync(ctx.paths.freeze)) throw new Error(`Freeze already exists: ${ctx.paths.freeze}`);
  const prepared = await readJson(ctx.paths.prepared);
  if (prepared.status !== 'prepared') throw new Error('Preparation is incomplete');
  for (const [source, destination] of [[join(ctx.sourceRoot, '.codegraph'), ctx.paths.codegraphMaster], [join(ctx.paths.toyRoot, '.codegraph'), ctx.paths.toyCodegraphMaster]]) {
    if (existsSync(destination)) throw new Error(`Refusing to replace existing CodeGraph master: ${destination}`);
    await cp(source, destination, { recursive: true, errorOnExist: true });
    const sourceDigest = await inventory(source);
    const masterDigest = await inventory(destination);
    if (sourceDigest.digest !== masterDigest.digest) throw new Error(`CodeGraph master copy mismatch: ${destination}`);
  }
  const tasks = await loadTasks(options.tasks, ctx.sourceRoot, ctx.config.sourceRevision);
  const labels = makeLabels(tasks);
  const freeze = {
    schemaVersion: 1,
    frozenAt: new Date().toISOString(),
    sourceRevision: ctx.config.sourceRevision,
    execution: { ...EXECUTION, timeoutMs: options.timeoutMs, approvalPolicy: 'never', windowsSandbox: 'elevated', projectDocMaxBytes: 0, plugins: 'disabled' },
    callAuditThreshold: 16,
    arms: ARMS,
    repetitions: 2,
    tasks,
    schedule: buildSchedule(tasks, labels),
    labels,
    inputs: await currentFrozenInputs(ctx, options.tasks, { includeLiveCodegraphIndex: true }),
    tasksPath: resolve(options.tasks),
    preparationPath: ctx.paths.prepared,
  };
  await writeJson(ctx.paths.freeze, freeze);
  await writeJson(ctx.paths.progress, { schemaVersion: 1, status: 'frozen', attempts: [], stopped: null });
  process.stdout.write(`${JSON.stringify({ status: 'frozen', attempts: freeze.schedule.length, order: freeze.schedule.map(({ taskId, arm, run }) => ({ taskId, arm, run })) }, null, 2)}\n`);
}

function comparableInputs(inputs) {
  return {
    source: { files: inputs.source.files, bytes: inputs.source.bytes, digest: inputs.source.digest },
    toySource: { files: inputs.toySource.files, bytes: inputs.toySource.bytes, digest: inputs.toySource.digest },
    codefactsMaster: inputs.codefactsMaster,
    codegraphMaster: { files: inputs.codegraphMaster.files, bytes: inputs.codegraphMaster.bytes, digest: inputs.codegraphMaster.digest },
    toyCodegraphMaster: { files: inputs.toyCodegraphMaster.files, bytes: inputs.toyCodegraphMaster.bytes, digest: inputs.toyCodegraphMaster.digest },
    tasksSha256: inputs.tasksSha256,
    rubricSha256: inputs.rubricSha256,
    provenanceSha256: inputs.provenanceSha256,
    readmeSha256: inputs.readmeSha256,
    preparedSha256: inputs.preparedSha256,
    runnerSha256: inputs.runnerSha256,
    campaignSha256: inputs.campaignSha256,
    configSha256: inputs.configSha256,
    codexSha256: inputs.codexSha256,
    codefactsSha256: inputs.codefactsSha256,
    codegraphNodeSha256: inputs.codegraphNodeSha256,
    codegraphPackageSha256: inputs.codegraphPackageSha256,
    codegraphDistDigest: inputs.codegraphDistDigest,
  };
}

async function verifyFrozen(ctx) {
  const freeze = await readJson(ctx.paths.freeze);
  const current = await currentFrozenInputs(ctx, freeze.tasksPath);
  const expected = comparableInputs(freeze.inputs);
  const actual = comparableInputs(current);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const error = new Error('Frozen input hash mismatch; campaign cannot continue');
    error.details = { expected, actual };
    throw error;
  }
  return freeze;
}

async function commandReadonly(ctx) {
  const freeze = await verifyFrozen(ctx);
  process.stdout.write(`${JSON.stringify({ status: 'readonly-ready', frozenAt: freeze.frozenAt, sourceDigest: freeze.inputs.source.digest, codegraphIndexDigest: freeze.inputs.codegraphIndex.digest })}\n`);
}

export function armFor(ctx, armId, root, codefactsState) {
  const common = ['windows.sandbox="elevated"'];
  if (armId === 'ordinary') return { id: armId, configOverrides: common };
  if (armId === 'codefacts') return {
    id: armId,
    configOverrides: [
      `mcp_servers.codefacts.command=${quote(ctx.config.codefactsBin)}`,
      `mcp_servers.codefacts.args=["mcp","--root",${quote(root)},"--state",${quote(codefactsState)}]`,
      'mcp_servers.codefacts.required=true',
      'mcp_servers.codefacts.startup_timeout_sec=30',
      'mcp_servers.codefacts.enabled_tools=["map","search","outline","expand","path"]',
      'mcp_servers.codefacts.tools.map.approval_mode="approve"',
      'mcp_servers.codefacts.tools.search.approval_mode="approve"',
      'mcp_servers.codefacts.tools.outline.approval_mode="approve"',
      'mcp_servers.codefacts.tools.expand.approval_mode="approve"',
      'mcp_servers.codefacts.tools.path.approval_mode="approve"',
      ...common,
    ],
  };
  if (armId === 'codegraph') return {
    id: armId,
    configOverrides: [
      `mcp_servers.codegraph.command=${quote(ctx.config.codegraph.nodeBin)}`,
      `mcp_servers.codegraph.args=["--liftoff-only","--disable-warning=ExperimentalWarning",${quote(ctx.config.codegraph.entryJs)},"serve","--mcp"]`,
      `mcp_servers.codegraph.cwd=${quote(root)}`,
      `mcp_servers.codegraph.env={CODEGRAPH_NO_DAEMON="1",CODEGRAPH_TELEMETRY="0",DO_NOT_TRACK="1",CODEGRAPH_NO_DOWNLOAD="1",GIT_CEILING_DIRECTORIES=${quote(ctx.workRoot)}}`,
      'mcp_servers.codegraph.required=true',
      'mcp_servers.codegraph.startup_timeout_sec=30',
      'mcp_servers.codegraph.enabled_tools=["codegraph_explore"]',
      'mcp_servers.codegraph.tools.codegraph_explore.approval_mode="approve"',
      ...common,
    ],
  };
  throw new Error(`Unknown arm: ${armId}`);
}

function relevantMcpCalls(metrics, arm) {
  const needle = arm === 'codefacts' ? 'codefacts/' : arm === 'codegraph' ? 'codegraph/' : null;
  if (!needle) return 0;
  const byName = metrics.rolloutToolCalls?.byName || metrics.stdoutToolCalls?.byName || {};
  return Object.entries(byName).filter(([name]) => name.toLowerCase().includes(needle)).reduce((sum, [, count]) => sum + count, 0);
}

function substantiveReadinessCalls(metrics, arm) {
  const byName = metrics.rolloutToolCalls?.byName || metrics.stdoutToolCalls?.byName || {};
  const accepted = arm === 'codefacts'
    ? ['codefacts/search', 'codefacts/outline', 'codefacts/expand', 'codefacts/path']
    : arm === 'codegraph' ? ['codegraph/codegraph_explore'] : [];
  return Object.entries(byName)
    .filter(([name]) => accepted.some((tool) => name.toLowerCase().includes(tool)))
    .reduce((sum, [, count]) => sum + count, 0);
}

export function classifyFaults(result, { mcpTransportError = false } = {}) {
  const faultReasons = [];
  if (!result.executionCompleted || result.timedOut || result.spawnError || result.exitCode !== 0) faultReasons.push('runtime');
  if (result.startupErrors?.length) faultReasons.push('startup');
  if (result.approvalRejections?.length || result.blockedToolFailures?.length) faultReasons.push('policy');
  if (result.usageConflict || result.parseErrors?.length) faultReasons.push('environment');
  if (result.evaluationValidity === 'invalid_environment') faultReasons.push('environment');
  if (result.policy?.forbiddenCliContamination
    || result.policy?.forbiddenExternalAgentUse
    || result.policy?.forbiddenEvalArtifactAccess
    || result.policy?.forbiddenUserConfigAccess) faultReasons.push('contamination');
  if (mcpTransportError) faultReasons.push('mcp-transport');
  return [...new Set(faultReasons)];
}

async function auditResult(result, arm) {
  const timing = await readJson(join(result.resultDir, 'timing.json'));
  const transcript = await readJson(join(result.resultDir, 'transcript-tools.json'));
  const relevant = relevantMcpCalls(result, arm);
  const substantiveReadiness = substantiveReadinessCalls(result, arm);
  const combinedCalls = (result.rolloutToolCalls?.command?.calls ?? result.stdoutToolCalls?.command?.calls ?? 0) + (result.rolloutToolCalls?.mcp?.calls ?? result.stdoutToolCalls?.mcp?.calls ?? 0);
  const toolOutputBytes = result.rolloutToolCalls?.wrapperOutputBytes
    ?? ((result.stdoutToolCalls?.command?.outputBytes || 0) + (result.stdoutToolCalls?.mcp?.outputBytes || 0));
  const applicationMcpErrors = arm === 'ordinary' ? 0 : (transcript.nestedCalls || []).filter((call) => call.type === 'mcp_tool_call' && /(?:"isError"\s*:\s*true|"is_error"\s*:\s*true)/i.test(call.outputText || '')).length;
  const mcpTransportError = arm !== 'ordinary' && (transcript.nestedCalls || []).some((call) => call.type === 'mcp_tool_call' && /(?:server disconnected|connection (?:closed|reset)|transport error|failed to start mcp|mcp server[^\r\n]*(?:unavailable|terminated))/i.test(call.outputText || ''));
  const faultReasons = classifyFaults(result, { mcpTransportError });
  return {
    status: result.status,
    evaluationValidity: result.evaluationValidity,
    tokenEligible: result.tokenEligible,
    policy: result.policy,
    resultDir: result.resultDir,
    executionCompleted: result.executionCompleted,
    usage: result.usage,
    totalTokens: result.total_tokens,
    finalContextInputTokens: result.finalContextInputTokens,
    durationMs: timing.durationMs,
    relevantMcpCalls: relevant,
    actualMcpCalls: relevant,
    applicationMcpErrors,
    substantiveReadinessCalls: substantiveReadiness,
    nonUse: arm !== 'ordinary' && relevant === 0,
    useRelevance: null,
    evidenceUsed: null,
    combinedCalls,
    toolOutputBytes,
    callAuditThreshold: 16,
    overCallAuditThreshold: combinedCalls > 16,
    transcriptAvailable: result.transcriptAvailable,
    environmentFault: faultReasons.length > 0,
    faultReasons,
    raw: {
      metrics: join(result.resultDir, 'metrics.json'),
      timing: join(result.resultDir, 'timing.json'),
      transcript: join(result.resultDir, 'transcript-tools.json'),
      stdout: join(result.resultDir, 'stdout.jsonl'),
      stderr: join(result.resultDir, 'stderr'),
      answer: join(result.resultDir, 'answer.md'),
      request: join(result.resultDir, 'request.json'),
    },
  };
}

async function copyState(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, 1);
}

function assertWithinWorkRoot(ctx, path, label) {
  const absolute = resolve(path);
  if (absolute === ctx.workRoot || !absolute.startsWith(`${ctx.workRoot}\\`) && !absolute.startsWith(`${ctx.workRoot}/`)) throw new Error(`${label} must stay under workRoot: ${absolute}`);
  return absolute;
}

async function restoreCodegraphIndex(ctx, root, master, slot) {
  const target = assertWithinWorkRoot(ctx, resolve(root, '.codegraph'), 'CodeGraph target');
  if (basename(target) !== '.codegraph') throw new Error(`Unexpected CodeGraph target: ${target}`);
  const snapshotRoot = assertWithinWorkRoot(ctx, join(ctx.workRoot, 'index-snapshots'), 'snapshot root');
  const quarantine = assertWithinWorkRoot(ctx, join(snapshotRoot, `${slot}-before`), 'quarantine');
  const staging = assertWithinWorkRoot(ctx, join(snapshotRoot, `${slot}-master-staging`), 'staging');
  if (existsSync(quarantine) || existsSync(staging)) throw new Error(`CodeGraph index slot already exists: ${slot}`);
  await mkdir(snapshotRoot, { recursive: true });
  const started = performance.now();
  const before = await inventory(target);
  await cp(master, staging, { recursive: true, errorOnExist: true });
  const staged = await inventory(staging);
  const expected = await inventory(master);
  if (staged.digest !== expected.digest) throw new Error(`CodeGraph staged master hash mismatch: ${slot}`);
  await rename(target, quarantine);
  try { await rename(staging, target); } catch (error) {
    error.message = `${error.message}; previous index preserved at ${quarantine}`;
    throw error;
  }
  return { slot, target, quarantine, master, before, restored: staged, restoreDurationMs: performance.now() - started };
}

async function runShared(ctx, { root, task, armId, runNumber, outputDir, stateSource, stateDestination, timeoutMs, codegraphMaster, codegraphSlot }) {
  const setupStarted = performance.now();
  if (armId === 'codefacts') await copyState(stateSource, stateDestination);
  const codegraphIndex = armId === 'codegraph' ? await restoreCodegraphIndex(ctx, root, codegraphMaster, codegraphSlot) : null;
  const setupMs = performance.now() - setupStarted;
  const arm = armFor(ctx, armId, root, stateDestination);
  const guidance = [COMMON_GUIDANCE, ARM_GUIDANCE[armId]].filter(Boolean).join('\n');
  const result = await runOne({
    task: { id: task.id, root, prompt: task.prompt },
    arm,
    runNumber,
    outputDir,
    timeoutMs,
    codex: discoverCodex(ctx.config.codexBin),
    sessionsDir: ctx.config.sessionsDir || null,
    guidance,
    execution: EXECUTION,
  });
  const audit = await auditResult(result, armId);
  audit.setupMs = setupMs;
  if (codegraphIndex) audit.codegraphIndex = { ...codegraphIndex, after: await inventory(join(root, '.codegraph')) };
  return audit;
}

function runBase(outputDir, taskId, armId, runNumber) {
  const slug = (value) => String(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '_').slice(0, 100) || '_';
  return join(outputDir, slug(taskId), slug(armId), `run-${String(runNumber).padStart(3, '0')}`);
}

export function assertRunSlotOpen(outputDir, taskId, armId, runNumber) {
  const path = runBase(outputDir, taskId, armId, runNumber);
  if (existsSync(path)) throw new Error(`Orphaned or already-recorded run directory blocks rerun: ${path}`);
  return path;
}

async function readinessFiles(ctx) {
  if (!existsSync(ctx.paths.readiness)) return [];
  const entries = await readdir(ctx.paths.readiness);
  return Promise.all(entries.filter((name) => name.endsWith('.json')).map((name) => readJson(join(ctx.paths.readiness, name))));
}

async function commandReadiness(ctx, options) {
  if (!ARMS.includes(options.arm)) throw new Error('--arm must be ordinary, codefacts, or codegraph');
  const freeze = await verifyFrozen(ctx);
  await mkdir(ctx.paths.readiness, { recursive: true });
  const receiptPath = join(ctx.paths.readiness, `${options.arm}.json`);
  if (existsSync(receiptPath)) throw new Error(`Readiness attempt already recorded; no rerun allowed: ${receiptPath}`);
  const existing = await readinessFiles(ctx);
  if (existing.some((item) => item.status !== 'passed')) throw new Error('A prior readiness arm failed; diagnose without rerunning');
  const task = { id: `readiness-${options.arm}`, prompt: 'Identify the function that computes `answer`, explain the returned value, and cite the defining and calling source files.' };
  assertRunSlotOpen(join(ctx.paths.readiness, 'raw'), task.id, options.arm, 1);
  let audit;
  try {
    audit = await runShared(ctx, {
      root: ctx.paths.toyRoot,
      task,
      armId: options.arm,
      runNumber: 1,
      outputDir: join(ctx.paths.readiness, 'raw'),
      stateSource: ctx.paths.toyCodefactsMaster,
      stateDestination: join(ctx.paths.readiness, 'states', 'codefacts.sqlite'),
      timeoutMs: freeze.execution.timeoutMs,
      codegraphMaster: ctx.paths.toyCodegraphMaster,
      codegraphSlot: `readiness-${options.arm}`,
    });
  } catch (error) {
    await writeJson(receiptPath, { schemaVersion: 1, arm: options.arm, at: new Date().toISOString(), status: 'failed', preparationError: error.stack || error.message });
    throw error;
  }
  try { await verifyFrozen(ctx); } catch (error) {
    audit.environmentFault = true;
    audit.faultReasons.push('frozen-input-drift');
    audit.inputDrift = error.details || error.message;
  }
  const passed = !audit.environmentFault && audit.executionCompleted && (options.arm === 'ordinary' || audit.substantiveReadinessCalls >= 1);
  const receipt = { schemaVersion: 1, arm: options.arm, at: new Date().toISOString(), status: passed ? 'passed' : 'failed', audit };
  await writeJson(receiptPath, receipt);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!passed) process.exitCode = 2;
}

async function requireReadiness(ctx) {
  const rows = await readinessFiles(ctx);
  for (const arm of ARMS) {
    const row = rows.find((item) => item.arm === arm);
    if (!row || row.status !== 'passed') throw new Error(`Readiness has not passed for ${arm}`);
  }
}

async function commandRun(ctx, options) {
  const freeze = await verifyFrozen(ctx);
  await requireReadiness(ctx);
  const progress = await readJson(ctx.paths.progress);
  if (progress.stopped) throw new Error(`Campaign stopped after an environment fault: ${JSON.stringify(progress.stopped)}`);
  const completed = new Set(progress.attempts.map((item) => item.ordinal));
  const tasks = new Map(freeze.tasks.map((task) => [task.id, task]));
  let launched = 0;
  for (const item of freeze.schedule) {
    if (completed.has(item.ordinal)) continue;
    if (launched >= options.maxAttempts) break;
    await verifyFrozen(ctx);
    try {
      assertRunSlotOpen(ctx.paths.formal, item.taskId, item.arm, item.run);
    } catch (error) {
      progress.status = 'stopped-orphan-run-directory';
      progress.stopped = { ordinal: item.ordinal, taskId: item.taskId, arm: item.arm, reason: error.message };
      await writeJson(ctx.paths.progress, progress);
      throw error;
    }
    const stateDestination = join(ctx.workRoot, 'states', `attempt-${String(item.ordinal).padStart(2, '0')}`, 'codefacts.sqlite');
    let audit;
    try {
      audit = await runShared(ctx, {
        root: ctx.sourceRoot,
        task: tasks.get(item.taskId),
        armId: item.arm,
        runNumber: item.run,
        outputDir: ctx.paths.formal,
        stateSource: ctx.paths.codefactsMaster,
        stateDestination,
        timeoutMs: freeze.execution.timeoutMs,
        codegraphMaster: ctx.paths.codegraphMaster,
        codegraphSlot: `attempt-${String(item.ordinal).padStart(2, '0')}`,
      });
    } catch (error) {
      progress.status = 'stopped-preparation-fault';
      progress.stopped = { ordinal: item.ordinal, taskId: item.taskId, arm: item.arm, reason: error.stack || error.message };
      await writeJson(ctx.paths.progress, progress);
      throw error;
    }
    try { await verifyFrozen(ctx); } catch (error) {
      audit.environmentFault = true;
      audit.faultReasons.push('frozen-input-drift');
      audit.inputDrift = error.details || error.message;
    }
    const row = { ...item, completedAt: new Date().toISOString(), audit };
    progress.attempts.push(row);
    launched += 1;
    if (audit.environmentFault) {
      progress.status = 'stopped-environment-fault';
      progress.stopped = { ordinal: item.ordinal, taskId: item.taskId, arm: item.arm, faultReasons: audit.faultReasons };
    } else progress.status = progress.attempts.length === freeze.schedule.length ? 'attempts-complete' : 'running';
    await writeJson(ctx.paths.progress, progress);
    process.stdout.write(`${JSON.stringify({ ordinal: item.ordinal, taskId: item.taskId, arm: item.arm, run: item.run, resultDir: audit.resultDir, environmentFault: audit.environmentFault, nonUse: audit.nonUse, totalTokens: audit.totalTokens, durationMs: audit.durationMs })}\n`);
    if (audit.environmentFault) break;
  }
}

async function commandStatus(ctx) {
  const prepared = existsSync(ctx.paths.prepared) ? await readJson(ctx.paths.prepared) : null;
  const freeze = existsSync(ctx.paths.freeze) ? await readJson(ctx.paths.freeze) : null;
  const readiness = await readinessFiles(ctx);
  const progress = existsSync(ctx.paths.progress) ? await readJson(ctx.paths.progress) : null;
  process.stdout.write(`${JSON.stringify({ prepared: prepared?.status || 'missing', frozen: Boolean(freeze), readiness: Object.fromEntries(readiness.map((item) => [item.arm, item.status])), formal: { status: progress?.status || 'not-started', completed: progress?.attempts?.length || 0, expected: freeze?.schedule?.length || 36, stopped: progress?.stopped || null } }, null, 2)}\n`);
}

function gradeMap(raw) {
  if (!raw) return new Map();
  const source = raw.labels || raw;
  return new Map(Object.entries(source).map(([label, value]) => [label, typeof value === 'boolean' ? { correct: value } : value]));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function metric(row, name) {
  const usage = row.audit.usage || {};
  if (name === 'totalTokens') return Number.isFinite(row.audit.totalTokens) ? row.audit.totalTokens : null;
  if (name === 'uncachedInputTokens') return Number.isFinite(usage.input_tokens) && Number.isFinite(usage.cached_input_tokens) ? usage.input_tokens - usage.cached_input_tokens : null;
  if (name === 'outputTokens') return Number.isFinite(usage.output_tokens) ? usage.output_tokens : null;
  if (name === 'durationMs') return Number.isFinite(row.audit.durationMs) ? row.audit.durationMs : null;
  return null;
}

export function summarizeRows(schedule, attempts, grades, evaluationAudits = new Map()) {
  const byOrdinal = new Map(attempts.map((row) => [row.ordinal, row]));
  const all = schedule.map((planned) => {
    const row = byOrdinal.get(planned.ordinal) || { ...planned, audit: {} };
    const grade = grades.get(planned.label) || null;
    return { ...row, grade, correct: grade?.correct === true };
  });
  const allGradesPresent = all.every((row) => row.grade && typeof row.grade.correct === 'boolean');
  const allEvaluationAuditsPresent = all.every((row) => typeof evaluationAudits.get(row.label)?.evaluationValid === 'boolean');
  const allEvaluationValid = allEvaluationAuditsPresent && all.every((row) => evaluationAudits.get(row.label).evaluationValid === true);
  const analysisEligible = allGradesPresent && allEvaluationValid;
  const primary = {};
  for (const arm of ARMS) {
    const rows = all.filter((row) => row.arm === arm);
    const correct = rows.filter((row) => row.correct).length;
    const metrics = {};
    for (const name of ['totalTokens', 'uncachedInputTokens', 'outputTokens', 'durationMs']) {
      const values = rows.map((row) => metric(row, name));
      const complete = values.every(Number.isFinite);
      metrics[`${name}AllAttempts`] = { value: complete ? values.reduce((sum, value) => sum + value, 0) : null, observed: values.filter(Number.isFinite).length, expected: rows.length };
      metrics[`${name}PerCorrectCompletion`] = { value: complete && analysisEligible && correct > 0 ? values.reduce((sum, value) => sum + value, 0) / correct : null, denominatorCorrect: analysisEligible ? correct : null, complete: complete && analysisEligible };
    }
    primary[arm] = {
      correctCompletions: allGradesPresent ? correct : null,
      allAttempts: rows.length,
      correctnessRate: allGradesPresent && rows.length ? correct / rows.length : null,
      gradesPresent: rows.filter((row) => typeof row.grade?.correct === 'boolean').length,
      attemptsPresent: rows.filter((row) => row.audit?.resultDir).length,
      nonUse: rows.filter((row) => row.audit?.nonUse).length,
      overCallAuditThreshold: rows.filter((row) => row.audit?.overCallAuditThreshold).length,
      metrics,
    };
  }
  const secondary = {};
  for (const [left, right] of [['codefacts', 'ordinary'], ['codegraph', 'ordinary'], ['codefacts', 'codegraph']]) {
    const key = `${left}_vs_${right}`;
    secondary[key] = {};
    for (const name of ['totalTokens', 'uncachedInputTokens', 'outputTokens', 'durationMs']) {
      const taskDiffs = [];
      for (const taskId of [...new Set(schedule.map((row) => row.taskId))]) {
        const ratios = [];
        for (const run of [1, 2]) {
          const a = all.find((row) => row.taskId === taskId && row.arm === left && row.run === run);
          const b = all.find((row) => row.taskId === taskId && row.arm === right && row.run === run);
          const av = a ? metric(a, name) : null;
          const bv = b ? metric(b, name) : null;
          if (analysisEligible && a?.correct && b?.correct && Number.isFinite(av) && Number.isFinite(bv) && bv !== 0) ratios.push((av - bv) / bv * 100);
        }
        if (ratios.length) taskDiffs.push({ taskId, matchedRepetitions: ratios.length, percentDifference: ratios.reduce((sum, value) => sum + value, 0) / ratios.length });
      }
      secondary[key][name] = { medianTaskPercentDifference: median(taskDiffs.map((row) => row.percentDifference)), tasks: taskDiffs };
    }
  }
  return { all, primary, secondary, allGradesPresent, allEvaluationAuditsPresent, allEvaluationValid, analysisEligible };
}

async function commandSummarize(ctx, options) {
  const freeze = await verifyFrozen(ctx);
  const progress = await readJson(ctx.paths.progress);
  const gradesRaw = options.grades ? await readJson(resolve(options.grades)) : null;
  const grades = gradeMap(gradesRaw);
  const toolAudit = gradeMap(options.toolAudit ? await readJson(resolve(options.toolAudit)) : null);
  const gradedCount = freeze.schedule.filter((item) => typeof grades.get(item.label)?.correct === 'boolean').length;
  const summaryRows = summarizeRows(freeze.schedule, progress.attempts, grades, toolAudit);
  const prepared = await readJson(ctx.paths.prepared);
  await mkdir(ctx.paths.blind, { recursive: true });
  const blindIndex = [];
  for (const item of [...freeze.schedule].sort((a, b) => a.label.localeCompare(b.label))) {
    const attempt = progress.attempts.find((row) => row.ordinal === item.ordinal);
    const destination = join(ctx.paths.blind, `${item.label}.md`);
    if (attempt?.audit?.raw?.answer && existsSync(attempt.audit.raw.answer)) await copyFile(attempt.audit.raw.answer, destination);
    blindIndex.push({ label: item.label, taskId: item.taskId, answer: existsSync(destination) ? destination : null });
  }
  await writeJson(join(ctx.paths.blind, 'index.json'), { schemaVersion: 1, note: 'No arm, repetition, timing, token, or tool-use mapping is included.', answers: blindIndex });
  await writeJson(join(ctx.paths.blind, 'grades.template.json'), { labels: Object.fromEntries(blindIndex.map(({ label }) => [label, { correct: null, notes: '' }])) });
  const toolAuditTemplate = join(ctx.workRoot, 'tool-audit.template.json');
  await writeJson(toolAuditTemplate, { labels: Object.fromEntries(freeze.schedule.map((item) => {
    const attempt = progress.attempts.find((row) => row.ordinal === item.ordinal);
    return [item.label, { taskId: item.taskId, arm: item.arm, run: item.run, transcript: attempt?.audit?.raw?.transcript || null, answer: attempt?.audit?.raw?.answer || null, actualMcpCalls: attempt?.audit?.actualMcpCalls ?? null, applicationMcpErrors: attempt?.audit?.applicationMcpErrors ?? null, detectedPolicy: attempt?.audit?.policy || null, runnerEvaluationValidity: attempt?.audit?.evaluationValidity || null, evaluationValid: null, useRelevance: null, evidenceUsed: null, notes: '' }];
  })) });
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    campaignStatus: progress.stopped ? 'stopped-environment-fault' : progress.attempts.length === freeze.schedule.length ? 'complete-awaiting-or-with-grades' : 'incomplete',
    expectedAttempts: freeze.schedule.length,
    recordedAttempts: progress.attempts.length,
    missingAttempts: freeze.schedule.length - progress.attempts.length,
    gradesPresent: gradedCount,
    allGradesPresent: summaryRows.allGradesPresent,
    evaluationAuditsPresent: freeze.schedule.filter((item) => typeof toolAudit.get(item.label)?.evaluationValid === 'boolean').length,
    allEvaluationAuditsPresent: summaryRows.allEvaluationAuditsPresent,
    allEvaluationValid: summaryRows.allEvaluationValid,
    analysisEligible: summaryRows.analysisEligible,
    preparation: {
      receipt: ctx.paths.prepared,
      codefacts: { durationMs: prepared.source.codefacts.durationMs, bytes: prepared.source.codefacts.stateFile.bytes },
      codegraph: { durationMs: prepared.source.codegraph.init.durationMs, bytes: prepared.source.codegraph.index.bytes },
    },
    readiness: Object.fromEntries((await readinessFiles(ctx)).map((item) => [item.arm, item])),
    primary: summaryRows.primary,
    secondaryMatchedCorrect: summaryRows.secondary,
    attempts: summaryRows.all.map((row) => ({
      ordinal: row.ordinal, taskId: row.taskId, arm: row.arm, run: row.run, label: row.label,
      correct: row.grade ? row.correct : null,
      useRelevance: toolAudit.get(row.label)?.useRelevance ?? null,
      evidenceUsed: toolAudit.get(row.label)?.evidenceUsed ?? null,
      evaluationValid: toolAudit.get(row.label)?.evaluationValid ?? null,
      usage: row.audit?.usage || null,
      totalTokens: row.audit?.totalTokens ?? null,
      durationMs: row.audit?.durationMs ?? null,
      setupMs: row.audit?.setupMs ?? null,
      actualMcpCalls: row.audit?.actualMcpCalls ?? null,
      applicationMcpErrors: row.audit?.applicationMcpErrors ?? null,
      nonUse: row.audit?.nonUse ?? null,
      combinedCalls: row.audit?.combinedCalls ?? null,
      toolOutputBytes: row.audit?.toolOutputBytes ?? null,
      finalContextInputTokens: row.audit?.finalContextInputTokens ?? null,
      overCallAuditThreshold: row.audit?.overCallAuditThreshold ?? null,
      environmentFault: row.audit?.environmentFault ?? null,
      faultReasons: row.audit?.faultReasons || [],
      runnerEvaluationValidity: row.audit?.evaluationValidity ?? null,
      runnerTokenEligible: row.audit?.tokenEligible ?? null,
      detectedPolicy: row.audit?.policy ?? null,
      raw: row.audit?.raw || null,
    })),
    interpretation: {
      target: 'At least 20% lower task tokens or time without correctness regression, treated only as a local workflow screen.',
      aggregation: 'Raw costs include every attempt. Cost per correct completion and secondary matched-correct differences are emitted only after every correctness grade and every independent evaluationValid audit is present and true; matched differences average repetitions within task, then take the median across tasks.',
      limits: 'Six tasks and two repetitions do not support external product or universal productivity claims. Missing attempts and metrics remain explicit.',
    },
  };
  await writeJson(ctx.paths.summary, summary);
  process.stdout.write(`${JSON.stringify({ summary: ctx.paths.summary, blindIndex: join(ctx.paths.blind, 'index.json'), toolAuditTemplate, campaignStatus: summary.campaignStatus, expectedAttempts: summary.expectedAttempts, recordedAttempts: summary.recordedAttempts, missingAttempts: summary.missingAttempts, gradesPresent: summary.gradesPresent }, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage()); return; }
  const ctx = await loadContext(options);
  const commands = {
    prepare: commandPrepare,
    freeze: (value) => commandFreeze(value, options),
    readonly: commandReadonly,
    readiness: (value) => commandReadiness(value, options),
    run: (value) => commandRun(value, options),
    status: commandStatus,
    summarize: (value) => commandSummarize(value, options),
  };
  if (!commands[options.command]) throw new Error(`Unknown command: ${options.command}`);
  await commands[options.command](ctx);
}

export {
  ARMS,
  COMMON_GUIDANCE,
  EXECUTION,
  comparableInputs,
  median,
  substantiveReadinessCalls,
};

if (process.argv[1] && resolve(process.argv[1]) === CAMPAIGN) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    if (error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  });
}
