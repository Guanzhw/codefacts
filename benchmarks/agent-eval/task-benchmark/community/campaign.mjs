import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runDshAttempt } from './dsh.mjs';
import { hash, writeJson } from '../rpc.mjs';
import { verifyCommunitySource as verifySource } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARMS = ['ordinary', 'codefacts022', 'codegraph'];
export const COMMON = ['source_list', 'source_read', 'source_search'];
export const REPAIR = ['source_edit', 'source_delete', 'source_exec', 'source_poll'];
const MENUS = { ordinary: [], codefacts022: ['codefacts_explore', 'codefacts_expand', 'codefacts_impact'], codegraph: ['codegraph_explore'] };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exclusive = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const absolute = (value, key) => { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${key} must be absolute`); return value; };

export function validateManifest(input) {
  if (input.schemaVersion !== 1 || !/^[\w.-]+$/.test(input.campaignId ?? '')) throw new Error('Invalid community manifest identity');
  for (const key of ['evidenceDir', 'selectionFile']) absolute(input[key], key);
  for (const key of ['dshRoot', 'node', 'sdkRoot', 'rg']) absolute(input.runtime?.[key], `runtime.${key}`);
  for (const key of ['inputFiles', 'upstreamRoots', 'runtimeFiles']) {
    const entries = input.evaluation?.[key];
    if (!Array.isArray(entries) || !entries.length) throw new Error(`evaluation.${key} must be a nonempty array`);
    for (const file of entries) {
      absolute(file, `evaluation.${key}`);
      const stat = fs.statSync(file);
      if (key === 'upstreamRoots' ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Invalid evaluation.${key} path: ${file}`);
    }
  }
  if (input.concurrency !== 1 || input.timeoutMs !== 1200000 || input.maxOutputTokens !== 32768) throw new Error('Require serial concurrency=1, timeoutMs=1200000, maxOutputTokens=32768');
  if (input.model?.provider !== 'opencode-go' || input.model?.id !== 'deepseek-v4.1-flash' || input.model?.reasoningEffort !== 'high') throw new Error('Unexpected preregistered model');
  if (JSON.stringify(input.arms?.map(row => row.id)) !== JSON.stringify(ARMS)) throw new Error('Three ordered arms required');
  for (const arm of input.arms) {
    if (arm.id === 'codefacts022') absolute(arm.executable, 'arm.executable');
    if (arm.id === 'codegraph') { absolute(arm.node, 'arm.node'); absolute(arm.cli, 'arm.cli'); }
    if (arm.id !== 'ordinary' && typeof arm.version !== 'string') throw new Error('Native arm version required');
  }
  if (!Array.isArray(input.tasks) || ![12, 24].includes(input.tasks.length) || new Set(input.tasks.map(row => row.id)).size !== input.tasks.length) throw new Error('Require 12 tasks per selected cohort (12 or 24 unique tasks)');
  for (const task of input.tasks) {
    if (!/^[\w.-]+$/.test(task.id) || !['context', 'swe'].includes(task.cohort) || typeof task.instanceId !== 'string' || !task.instanceId ||
      !['go', 'rust', 'javascript', 'typescript'].includes(task.language) || !['pilot', 'confirmation_holdout'].includes(task.split) ||
      typeof task.prompt !== 'string' || !task.prompt.trim() || typeof task.repo !== 'string' || !/^[a-f0-9]{40}$/i.test(task.baseCommit)) throw new Error(`Invalid task: ${task.id}`);
    absolute(task.sourceRoot, 'task.sourceRoot'); absolute(task.manifestFile, 'task.manifestFile');
    if (task.cohort === 'swe') {
      absolute(input.runtime.wsl, 'runtime.wsl');
      if (!/^sha256:[a-f0-9]{64}$/.test(task.sandbox?.image ?? '') || task.sandbox?.workspaceVerified !== true) throw new Error(`SWE task requires a verified sanitized immutable sandbox image: ${task.id}`);
    }
  }
  for (const cohort of new Set(input.tasks.map(task => task.cohort))) for (const language of ['go', 'rust', 'javascript', 'typescript']) {
    const rows = input.tasks.filter(task => task.cohort === cohort && task.language === language);
    if (rows.length !== 3 || rows.filter(task => task.split === 'pilot').length !== 2) throw new Error(`Require 2 pilot + 1 holdout per ${cohort}/${language}`);
  }
  return input;
}

export function buildSchedule(tasks) {
  const rows = [];
  const ordered = [...tasks.filter(task => task.split === 'pilot'), ...tasks.filter(task => task.split === 'confirmation_holdout')];
  ordered.forEach((task, index) => ARMS.forEach((_, position) => {
    const arm = ARMS[(index + position) % ARMS.length];
    rows.push({ ordinal: rows.length + 1, id: `${task.id}-${arm}`, taskId: task.id, cohort: task.cohort, arm, position: position + 1 });
  }));
  return rows;
}

export function buildPrompt(task) {
  const shared = 'Choose ordinary source tools or provided code-navigation tools whenever useful. Native navigation is optional. Use only the tools exposed in this session. Repository paths are relative to the supplied snapshot.';
  return task.cohort === 'context'
    ? `${shared}\nThis is an adapted ContextBench read-only localization task. Inspect the issue and identify the source regions needed to resolve it. Return a final JSON object only: {"regions":[{"file_path":"relative/path","start_line":1,"end_line":1}],"rationale":"explanation"}. Use inclusive, positive line numbers and only source regions you inspected.\n\nIssue:\n${task.prompt}`
    : `${shared}\nResolve the issue by editing the supplied repository. You may run tests using source_exec and source_poll in the isolated sandbox. Submit your actual source changes; the evaluator collects the Git diff including new files. End with a concise description of the fix and tests run.\n\nIssue:\n${task.prompt}`;
}

function walkFiles(root, accept, target, excludedDirectories = new Set()) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) walkFiles(file, accept, target, excludedDirectories);
    else if (entry.isFile() && accept(file)) target.add(file);
  }
}
function packageRoot(file) {
  let dir = path.dirname(file);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir); if (parent === dir) throw new Error(`Package identity unavailable: ${file}`); dir = parent;
  }
  return dir;
}
export function collectPins(manifest, manifestPath) {
  const files = new Set([manifestPath, manifest.selectionFile, manifest.runtime.node, manifest.runtime.rg]);
  // Pin every executable/runtime source in the framework, SDK, and DSH installation,
  // including transitive provider packages. No evaluator or source is exposed to DSH.
  walkFiles(path.dirname(HERE), file => /\.(?:mjs|py)$/.test(file), files);
  const ignored = new Set(['.git', '__pycache__']);
  walkFiles(manifest.runtime.dshRoot, () => true, files, ignored);
  walkFiles(manifest.runtime.sdkRoot, () => true, files, ignored);
  if (manifest.runtime.wsl) files.add(manifest.runtime.wsl);
  for (const arm of manifest.arms) {
    for (const file of [arm.executable, arm.node, arm.cli].filter(Boolean)) files.add(file);
    if (arm.cli) walkFiles(packageRoot(arm.cli), () => true, files, ignored);
  }
  for (const root of manifest.evaluation.upstreamRoots) walkFiles(root, () => true, files, ignored);
  for (const file of [...manifest.evaluation.inputFiles, ...manifest.evaluation.runtimeFiles]) files.add(file);
  for (const task of manifest.tasks) files.add(task.manifestFile);
  return [...files].sort().map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) }));
}

function sourceEntries(task) {
  const manifest = json(task.manifestFile);
  if (!Array.isArray(manifest.entries) || manifest.repo !== task.repo || manifest.baseCommit !== task.baseCommit || manifest.instanceId !== task.instanceId || manifest.digest !== hash(manifest.entries)) throw new Error(`Invalid source identity: ${task.id}`);
  if (fs.existsSync(path.join(task.sourceRoot, '.git'))) throw new Error(`Frozen source must not contain Git history: ${task.id}`);
  return manifest.entries;
}
function verifySelections(manifest) {
  const selections = json(manifest.selectionFile).selections;
  const cohorts = new Set(manifest.tasks.map(task => task.cohort === 'context' ? 'contextbench' : 'swebench_multilingual'));
  if (!Array.isArray(selections) || selections.filter(row => cohorts.has(row.dataset)).length !== manifest.tasks.length) throw new Error('Selection/task count mismatch for selected cohorts');
  for (const task of manifest.tasks) {
    const row = selections.find(row => row.id === task.instanceId && row.dataset === (task.cohort === 'context' ? 'contextbench' : 'swebench_multilingual'));
    if (!row || row.repo !== task.repo || row.base_commit !== task.baseCommit || row.language !== task.language || row.split !== task.split) throw new Error(`Task differs from preregistered selection: ${task.id}`);
  }
}
export function assertFrozen(manifest, frozen, pins) {
  if (hash(manifest) !== frozen.manifestHash || JSON.stringify(pins) !== JSON.stringify(frozen.pins)) throw new Error('Frozen campaign inputs drifted');
}
export function freezeCampaign(manifestPath, { pinCollector = collectPins } = {}) {
  const manifest = validateManifest(json(absolute(manifestPath, 'manifest')));
  verifySelections(manifest);
  const sources = manifest.tasks.map(task => { const entries = sourceEntries(task); verifySource(task.sourceRoot, entries, { exact: true }); return { taskId: task.id, digest: hash(entries), files: entries.length, manifestFile: task.manifestFile }; });
  const pins = pinCollector(manifest, manifestPath), destination = path.join(manifest.evidenceDir, 'freeze.json');
  if (fs.existsSync(destination)) { const frozen = json(destination); assertFrozen(manifest, frozen, pins); return frozen; }
  const frozen = { schemaVersion: 1, campaignId: manifest.campaignId, at: new Date().toISOString(), manifestPath, manifestHash: hash(manifest), manifest, pins, sources, schedule: buildSchedule(manifest.tasks) };
  fs.mkdirSync(manifest.evidenceDir, { recursive: true }); exclusive(destination, frozen); return frozen;
}

export function auditAttempt(receipt, slot) {
  const expected = [...COMMON, ...(slot.cohort === 'swe' ? REPAIR : []), ...MENUS[slot.arm]].map(name => `mcp__repo__${name}`).sort();
  const catalogValid = Boolean(receipt.catalogs?.length) && receipt.catalogs.every(menu => JSON.stringify(menu.map(tool => tool.name).sort()) === JSON.stringify(expected));
  const calls = receipt.toolCalls ?? [];
  const nativeCalls = calls.filter(call => MENUS[slot.arm].some(name => call.name === `mcp__repo__${name}`)).length;
  const infrastructureReasons = [];
  // A failed provider call may have no request header/catalog at all. Preserve it
  // as an attempt outcome, while a received wrong menu is an infrastructure fault.
  if ((receipt.catalogs?.length && !catalogValid) || (receipt.actualRequestHeaders?.length && !receipt.headerAudit)) infrastructureReasons.push('Model identity or tool catalog mismatch');
  if (receipt.didInitialize === false || receipt.protocolError) infrastructureReasons.push('DSH initialization or transport failure');
  const completed = receipt.status === 'attempt-completed';
  return { infrastructureValid: infrastructureReasons.length === 0, infrastructureReasons, catalogValid,
    actualToolCalls: calls.length, nativeCalls, nativeAdopted: nativeCalls > 0,
    taskCompleted: completed, outcome: completed ? 'completed' : receipt.generationCutoff ? 'generation-cutoff' : receipt.timedOut ? 'timed-out' : 'provider-or-task-failed' };
}

async function command(command, args, timeoutMs = 120000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
function linuxPath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value)) return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\', '/')}`;
  throw new Error('Docker bind source must be an absolute Windows drive path');
}
export async function startSandbox(manifest, task, root, slot, dir, run = command) {
  const name = `cf-community-${hash(`${manifest.campaignId}/${slot.id}`).slice(0, 24)}`;
  const prefix = ['-d', manifest.runtime.wslDistro ?? 'Ubuntu', '-u', 'root', '--exec', 'docker'];
  const execute = args => run(manifest.runtime.wsl, [...prefix, ...args]);
  const cleanup = async () => {
    const removed = await execute(['rm', '-f', name]);
    const present = await execute(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
    const receipt = { name, removed, verification: present, absent: present.code === 0 && !present.stdout.trim() };
    writeJson(path.join(dir, 'sandbox-cleanup.json'), receipt);
    if (!receipt.absent) throw new Error(`Owned sandbox still exists: ${name}`);
    return receipt;
  };
  const started = await execute(['run', '-d', '--pull', 'never', '--name', name, '--network', 'none', '--memory', '6g', '--cpus', '4', '--pids-limit', '512',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=bind,source=${linuxPath(root)},target=/testbed`,
    // Host Git later collects the patch. Its private configuration, hooks, index,
    // and objects must remain outside the model's writable command boundary.
    '--mount', `type=bind,source=${linuxPath(path.join(root, '.git'))},target=/testbed/.git,readonly`,
    '--env', 'GIT_OPTIONAL_LOCKS=0', '--workdir', '/testbed', task.sandbox.image, 'sleep', 'infinity']);
  writeJson(path.join(dir, 'sandbox-start.json'), { name, image: task.sandbox.image, result: started });
  if (started.code !== 0) { await cleanup(); throw new Error(`Sandbox startup failed: ${started.stderr}`); }
  return { config: { command: manifest.runtime.wsl, argsPrefix: [...prefix, 'exec', '--workdir', '/testbed', name, 'bash', '-lc'], cwd: root }, cleanup };
}

export async function runSlot(manifest, frozen, slot, dependencies = {}) {
  const dir = path.join(manifest.evidenceDir, 'attempts', slot.id), metaPath = path.join(dir, 'slot-meta.json');
  if (fs.existsSync(dir)) {
    if (!fs.existsSync(metaPath)) throw new Error(`Incomplete allocated slot: ${slot.id}`);
    const meta = json(metaPath);
    if (meta.freezeHash !== hash(frozen) || JSON.stringify(meta.slot) !== JSON.stringify(slot) || !['attempt-completed', 'task-failed'].includes(meta.status)) throw new Error(`Prior incomplete or failed infrastructure slot: ${slot.id}`);
    if (!fs.existsSync(meta.receiptPath)) throw new Error(`Missing prior receipt: ${slot.id}`);
    return meta;
  }
  fs.mkdirSync(dir, { recursive: true });
  const task = manifest.tasks.find(task => task.id === slot.taskId), arm = manifest.arms.find(arm => arm.id === slot.arm);
  const meta = { schemaVersion: 1, slot, taskId: task.id, cohort: task.cohort, language: task.language, split: task.split, freezeHash: hash(frozen), status: 'allocated', receiptPath: path.join(dir, 'dsh', 'receipt.json'), grade: { status: 'pending', resolved: null, metrics: null } };
  exclusive(metaPath, meta);
  let sandbox;
  const started = performance.now();
  try {
    const prepare = dependencies.prepareCommunitySlot ?? (await import('./prepare.mjs')).prepareCommunitySlot;
    const prepared = await prepare({ task, arm, runtime: manifest.runtime, dir, timeoutMs: manifest.timeoutMs });
    const innerConfig = prepared.bridgeConfig;
    let bridgeConfig = prepared.bridgeConfig, bridgeEntry = path.join(HERE, '..', 'bridge.mjs');
    if (task.cohort === 'swe') {
      sandbox = await (dependencies.startSandbox ?? startSandbox)(manifest, task, prepared.root, slot, dir);
      bridgeEntry = path.join(HERE, 'bridge.mjs');
      bridgeConfig = path.join(dir, 'outer-config.json');
      writeJson(bridgeConfig, { root: prepared.root, evidenceDir: path.join(dir, 'bridge'), sdkRoot: manifest.runtime.sdkRoot, nodeCommand: manifest.runtime.node,
        innerBridgeEntry: path.join(HERE, '..', 'bridge.mjs'), innerConfig, sandbox: sandbox.config });
    }
    Object.assign(meta, { status: 'prepared', sourceRoot: prepared.root, sourceHash: prepared.sourceHash,
      bridgeEvidenceDir: task.cohort === 'context' ? path.join(dir, 'inner-bridge') : path.join(dir, 'bridge'),
      setup: prepared.setup, prompt: buildPrompt(task), preparationAndSandboxMs: performance.now() - started }); writeJson(metaPath, meta);
    const receipt = await (dependencies.runDshAttempt ?? runDshAttempt)({ installRoot: manifest.runtime.dshRoot, nodeCommand: manifest.runtime.node, attemptDir: path.join(dir, 'dsh'), root: prepared.root,
      provider: manifest.model.provider, model: manifest.model.id, reasoningEffort: manifest.model.reasoningEffort,
      bridgeEntry, bridgeConfig, prompt: meta.prompt, timeoutMs: manifest.timeoutMs, maxOutputTokens: manifest.maxOutputTokens });
    // Test adapters may return a receipt without writing it; production DSH writes
    // this exact object itself. Persist all outcomes before patching/grading.
    if (!fs.existsSync(meta.receiptPath)) { fs.mkdirSync(path.dirname(meta.receiptPath), { recursive: true }); exclusive(meta.receiptPath, receipt); }
    meta.audit = auditAttempt(receipt, slot);
    verifySource(task.sourceRoot, sourceEntries(task), { exact: true });
    if (task.cohort === 'context') verifySource(prepared.root, prepared.entries, { exact: true });
    else {
      // Stop every command in the owned sandbox before collecting a stable diff.
      meta.sandboxCleanup = await sandbox.cleanup(); sandbox = null;
      const collect = dependencies.collectPatch ?? (await import('./prepare.mjs')).collectPatch;
      const journal = path.join(dir, 'bridge', 'edits.jsonl');
      const createdPaths = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(row => row.operation === 'create').map(row => row.file_path) : [];
      const patch = await collect(prepared.root, { createdPaths }); meta.patchPath = path.join(dir, 'model.patch'); fs.writeFileSync(meta.patchPath, patch);
    }
    meta.status = !meta.audit.infrastructureValid ? 'infrastructure-failed' : meta.audit.taskCompleted ? 'attempt-completed' : 'task-failed';
    if (dependencies.grade && meta.audit.infrastructureValid) {
      try { assertFrozen(manifest, frozen, (dependencies.pinCollector ?? collectPins)(manifest, frozen.manifestPath)); }
      catch (error) { meta.grade = { status: 'blocked-input-drift', resolved: null, metrics: null, error: error.message }; throw error; }
      try { meta.grade = await dependencies.grade({ task, slot, dir, meta, receipt }); }
      catch (error) { meta.grade = { status: 'failed', resolved: null, metrics: null, error: error.stack ?? error.message }; }
    }
    writeJson(metaPath, meta);
    if (!meta.audit.infrastructureValid) throw new Error(meta.audit.infrastructureReasons.join('; '));
    return meta;
  } catch (error) { if (!['attempt-completed', 'task-failed'].includes(meta.status)) meta.status = 'infrastructure-failed'; meta.error = error.stack ?? error.message; writeJson(metaPath, meta); throw error; }
  finally {
    try { if (sandbox) meta.sandboxCleanup = await sandbox.cleanup(); }
    catch (error) { meta.status = 'infrastructure-failed'; meta.cleanupError = error.message; throw error; }
    finally { meta.slotWallMs = performance.now() - started; writeJson(metaPath, meta); }
  }
}

export async function executeCampaign(manifestPath, mode, onlySlot = null, dependencies = {}, split = null) {
  if (mode === 'freeze') return freezeCampaign(manifestPath, dependencies);
  if (mode !== 'run') throw new Error('mode must be freeze or run');
  if (split !== null && !['pilot', 'confirmation_holdout'].includes(split)) throw new Error('split must be pilot or confirmation_holdout');
  const manifest = validateManifest(json(absolute(manifestPath, 'manifest'))), frozen = json(path.join(manifest.evidenceDir, 'freeze.json'));
  assertFrozen(manifest, frozen, (dependencies.pinCollector ?? collectPins)(manifest, manifestPath));
  if (onlySlot && !frozen.schedule.some(slot => slot.id === onlySlot || String(slot.ordinal) === String(onlySlot))) throw new Error(`Unknown slot: ${onlySlot}`);
  // A process lock makes serial execution an enforced timing property.
  const lock = path.join(manifest.evidenceDir, 'dispatch.lock'); const fd = fs.openSync(lock, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const completed = [];
    for (const slot of frozen.schedule) {
      if (onlySlot && slot.id !== onlySlot && String(slot.ordinal) !== String(onlySlot)) continue;
      if (split && manifest.tasks.find(task => task.id === slot.taskId).split !== split) continue;
      console.log(JSON.stringify({ event: 'begin', slot: slot.id }));
      const timer = setInterval(() => console.log(JSON.stringify({ event: 'heartbeat', slot: slot.id, at: new Date().toISOString() })), 30000);
      try { completed.push(await runSlot(manifest, frozen, slot, dependencies)); } finally { clearInterval(timer); }
    }
    return { status: 'dispatch-completed', slots: completed.length };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) { if (!['--manifest', '--mode', '--slot', '--split'].includes(argv[index]) || !argv[index + 1]) throw new Error('Usage: --manifest ABS --mode freeze|run [--slot ID] [--split pilot|confirmation_holdout]'); args[argv[index].slice(2)] = argv[index + 1]; }
  if (args.mode === 'run' && !args.split && !args.slot) throw new Error('Run requires --split or --slot so holdout dispatch is explicit');
  console.log(JSON.stringify(await executeCampaign(args.manifest, args.mode, args.slot, {}, args.split ?? null)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
