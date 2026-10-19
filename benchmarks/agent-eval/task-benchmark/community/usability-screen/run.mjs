import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runDshAttempt } from '../dsh.mjs';
import { prepareCommunitySlot, verifyCommunitySource } from '../prepare.mjs';
import { collectPins, auditAttempt } from '../campaign.mjs';
import { parseDeclaration } from '../trace.mjs';
import { startWorker, workerDeadlineMs } from './worker-process.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARMS = ['ordinary', 'codefacts022', 'candidate', 'codegraph'];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const save = (file, value, exclusive = false) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });

export function validate(manifest) {
  if (manifest.templateOnly === true) throw new Error('Template-only manifest must be copied and configured before planning or execution');
  if (manifest.schemaVersion !== 1 || manifest.models.length !== 3 || manifest.tasks.length !== 4 || JSON.stringify(manifest.arms.map(x => x.id)) !== JSON.stringify(ARMS)) throw new Error('Require frozen 3 models x 4 tasks x 4 arms');
  if (manifest.concurrency !== 4 || manifest.timeoutMs !== 360000 || manifest.maxOutputTokens !== 16384) throw new Error('Invalid screen resource contract');
  if (manifest.runtime.contextSourceMode === 'hardlink' || manifest.runtime.contextGitMode !== 'boundary-only') throw new Error('Require independent source copies and private Git boundary');
  for (const model of manifest.models) if (!model.key || model.provider !== 'opencode-go' || !model.id || model.reasoningEffort !== 'high') throw new Error('Invalid pinned model');
  for (const task of manifest.tasks) {
    if (!/^[a-f0-9]{40}$/.test(task.baseCommit) || task.cohort !== 'context' || !task.prompt || task.gates.length < 3 || new Set(task.gates.map(g => g.file)).size < 2) throw new Error(`Invalid cross-file task ${task.id}`);
    if (!path.isAbsolute(task.sourceRoot) || !path.isAbsolute(task.manifestFile)) throw new Error('Absolute source paths required');
  }
  if (!path.isAbsolute(manifest.evidenceDir)) throw new Error('Absolute evidenceDir required');
  return manifest;
}

/** Hash ordering is a reproducible randomization, fixed before any outcomes. */
export function schedule(manifest) {
  return manifest.tasks.flatMap(task => manifest.models.flatMap(model => ARMS.map(arm => ({
    id: `${task.id}-${model.key}-${arm}`, taskId: task.id, modelKey: model.key, arm,
  })))).sort((a, b) => digest(`${manifest.seed}\n${a.id}`).localeCompare(digest(`${manifest.seed}\n${b.id}`))).map((cell, i) => ({ ...cell, ordinal: i + 1 }));
}

export function buildPrompt(task) {
  return 'Investigate this real community issue against the supplied source snapshot. Choose ordinary source tools or available native navigation whenever useful; native use is optional. First determine whether the reported issue is present in this snapshot. Explain the current cross-file behavior and evidence. If a gap exists, explain its concrete cause and necessary change; if the requested behavior is already supported, explain the existing path and whether unchanged code is appropriate. Identify regression cases either conclusion must preserve. Inspect implementation and relevant tests; do not edit source. Return only JSON: {"regions":[{"file_path":"relative/path","start_line":1,"end_line":1}],"rationale":"source-grounded diagnosis and regression plan"}. Use inclusive actual source lines you inspected. Repository paths are relative to this snapshot.\n\nIssue and investigation question:\n' + task.prompt;
}

function sources(manifest, verify = false) {
  return manifest.tasks.map(task => {
    const source = read(task.manifestFile);
    if (source.repo !== task.repo || source.baseCommit !== task.baseCommit || source.instanceId !== task.instanceId || source.digest !== digest(source.entries) || source.digest !== task.sourceDigest) throw new Error(`Source identity drift ${task.id}`);
    if (verify) verifyCommunitySource(task.sourceRoot, source.entries, { exact: true });
    for (const gate of task.gates) {
      const file = path.join(task.sourceRoot, gate.file), lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      if (gate.start < 1 || gate.end > lines.length || gate.end < gate.start) throw new Error(`Invalid gate range ${task.id}/${gate.id}`);
      if (gate.sha256 !== digest(fs.readFileSync(file))) throw new Error(`Gate source drift ${task.id}/${gate.id}`);
    }
    return { taskId: task.id, commit: task.baseCommit, digest: source.digest, manifestSha256: digest(fs.readFileSync(task.manifestFile)), files: source.entries.length };
  });
}

export function plan(manifest) {
  validate(manifest);
  const required = [manifest.selectionFile ?? path.join(HERE, 'PROTOCOL.md'), manifest.runtime.node, manifest.runtime.rg, path.join(manifest.runtime.dshRoot, 'lib/bin.js'), path.join(manifest.runtime.sdkRoot, 'package.json'), ...manifest.arms.flatMap(arm => [arm.executable, arm.node, arm.cli].filter(Boolean)), ...(manifest.evaluation?.runtimeFiles ?? [])];
  const missing = required.filter(file => !fs.existsSync(file));
  return { modelCallsStarted: 0, cells: schedule(manifest), sourcePins: sources(manifest), missing, readyToFreezeRuntime: missing.length === 0, credentialValuesRead: false };
}

function pins(manifest, manifestPath) {
  return collectPins({ ...manifest, selectionFile: manifest.selectionFile ?? path.join(HERE, 'PROTOCOL.md'), evaluation: { inputFiles: [path.join(path.dirname(manifestPath), 'tasks.json')], upstreamRoots: [], runtimeFiles: manifest.evaluation?.runtimeFiles ?? [] } }, manifestPath);
}

export function freeze(manifestPath) {
  const manifest = validate(read(manifestPath)), prepared = plan(manifest);
  if (prepared.missing.length) throw new Error(`Runtime inputs missing: ${prepared.missing.join(', ')}`);
  const frozen = { schemaVersion: 1, at: new Date().toISOString(), manifestPath, manifestHash: digest(manifest), pins: pins(manifest, manifestPath), sourcePins: sources(manifest, true), schedule: schedule(manifest) };
  fs.mkdirSync(manifest.evidenceDir, { recursive: true });
  save(path.join(manifest.evidenceDir, 'freeze.json'), frozen, true);
  return frozen;
}

export function assertFrozen(manifest, frozen) {
  if (digest(manifest) !== frozen.manifestHash || digest(pins(manifest, frozen.manifestPath)) !== digest(frozen.pins)) throw new Error('Frozen runtime or protocol drift; create a new screen identity');
}

export function reviewEvidence(task, answer, root) {
  const parsed = parseDeclaration(answer, root);
  return { declarationStatus: parsed.reason ?? 'valid', semanticReviewStatus: 'pending-independent-source-review',
    // Overlap is only a locator aid. It is never semantic correctness or official resolved.
    locatorGates: task.gates.map(g => ({ id: g.id, criterion: g.criterion, reference: `${g.file}:${g.start}-${g.end}`,
      declaredOverlap: (parsed.declaration?.spans[g.file] ?? []).some(s => s.start <= g.end && s.end >= g.start) })),
    requiredReview: 'Check every criterion against source, visible trace and rationale; record pass/fail/unknown with evidence. Alternate valid loci are allowed with explicit source reasoning. No automatic task-quality pass.' };
}

function resource(manifest) {
  const freeMemory = os.freemem(), disk = fs.statfsSync(manifest.evidenceDir), freeDisk = Number(disk.bavail) * Number(disk.bsize);
  const minimumMemory = manifest.concurrency === 4 ? 8 * 1024 ** 3 : 4 * 1024 ** 3;
  const value = { at: new Date().toISOString(), freeMemory, freeDisk, concurrency: manifest.concurrency, minimumMemory, minimumDisk: 12 * 1024 ** 3 };
  if (freeMemory < minimumMemory || freeDisk < value.minimumDisk) throw new Error(`Screen resource admission failed: ${JSON.stringify(value)}`);
  return value;
}

export async function runCell(manifest, frozen, cell, dependencies = {}) {
  const started = performance.now();
  const task = manifest.tasks.find(x => x.id === cell.taskId), model = manifest.models.find(x => x.key === cell.modelKey), selected = manifest.arms.find(x => x.id === cell.arm);
  // Candidate is an independently pinned executable with exactly the same three-tool bridge contract.
  const arm = { ...selected, id: cell.arm === 'candidate' ? 'codefacts022' : cell.arm };
  const dir = path.join(manifest.evidenceDir, 'attempts', cell.id);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, 'cell.json');
  if (fs.existsSync(metaPath)) throw new Error(`Allocated cell already exists: ${cell.id}; retain it, do not overwrite/retry silently`);
  const meta = { cell, model, freezeHash: digest(frozen), status: 'allocated', grade: { status: 'pending', resolved: null } };
  save(metaPath, meta, true);
  try {
    const prepared = await (dependencies.prepare ?? prepareCommunitySlot)({ task, arm, runtime: manifest.runtime, dir, timeoutMs: manifest.timeoutMs });
    const receipt = await (dependencies.attempt ?? runDshAttempt)({ installRoot: manifest.runtime.dshRoot, nodeCommand: manifest.runtime.node, attemptDir: path.join(dir, 'dsh'), root: prepared.root,
      provider: model.provider, model: model.id, reasoningEffort: model.reasoningEffort, bridgeEntry: path.join(HERE, '..', '..', 'bridge.mjs'), bridgeConfig: prepared.bridgeConfig,
      prompt: buildPrompt(task), timeoutMs: manifest.timeoutMs, maxOutputTokens: manifest.maxOutputTokens });
    const audit = auditAttempt(receipt, { ...cell, arm: arm.id, cohort: 'context' });
    const unchanged = (dependencies.verify ?? verifyCommunitySource)(prepared.root, prepared.entries);
    const { promptedAtMs, turnEndedAtMs } = receipt.timings ?? {};
    const modelDurationMs = Number.isFinite(promptedAtMs) && Number.isFinite(turnEndedAtMs) ? turnEndedAtMs - promptedAtMs : null;
    Object.assign(meta, { status: receipt.status, audit, sourceUnchanged: unchanged, setup: prepared.setup, timings: receipt.timings, modelDurationMs,
      sdkProcessDurationMs: Number.isFinite(receipt.durationMs) ? receipt.durationMs : null,
      tokenUsage: { exact: receipt.exactTurnUsage ?? null, knownLowerBound: receipt.knownUsageLowerBound ?? null, availability: receipt.usageAvailability },
      review: reviewEvidence(task, receipt.answer, prepared.root) });
  } catch (error) { Object.assign(meta, { status: 'infrastructure-or-attempt-failed', error: error.message }); }
  meta.totalDurationMs = performance.now() - started;
  save(metaPath, meta); return meta;
}

export async function runIsolatedCell(manifestPath, manifest, cell) {
  const workerDir = path.join(manifest.evidenceDir, 'workers', cell.id);
  const cellFile = path.join(manifest.evidenceDir, 'attempts', cell.id, 'cell.json');
  let worker;
  try {
    worker = await startWorker({ node: manifest.runtime.node, script: path.join(HERE, 'cell-worker.mjs'),
      args: [manifestPath, cell.id], out: workerDir, deadlineMs: workerDeadlineMs(manifest.timeoutMs) });
    if (worker.code !== 0 || worker.signal !== null || worker.spawnError || worker.timedOut || worker.bookkeepingError) throw new Error('Cell worker failed; inspect retained worker exit.json');
    return { ...read(cellFile), worker: { receipt: path.join(workerDir, 'exit.json'), pid: worker.pid } };
  } catch (error) {
    // Keep partial cell evidence in place. The dispatch summary records the
    // controller failure separately; no allocated cell is rewritten or retried.
    let partial = { cell, grade: { status: 'pending', resolved: null } }, cellReadError = null;
    try { partial = read(cellFile); }
    catch (readError) { cellReadError = { path: cellFile, error: readError.message }; }
    return { ...partial, status: 'infrastructure-or-attempt-failed', error: error.message,
      ...(cellReadError ? { cellReadError } : {}),
      worker: { receipt: fs.existsSync(path.join(workerDir, 'exit.json')) ? path.join(workerDir, 'exit.json') : null, pid: worker?.pid ?? null } };
  }
}

export async function run(manifestPath) {
  const manifest = validate(read(manifestPath)), frozen = read(path.join(manifest.evidenceDir, 'freeze.json'));
  assertFrozen(manifest, frozen); sources(manifest, true);
  const lock = path.join(manifest.evidenceDir, 'dispatch.lock'), fd = fs.openSync(lock, 'wx');
  const output = [];
  try {
    fs.mkdirSync(path.join(manifest.evidenceDir, 'workers'));
    // A barrier between waves prevents resource admission racing concurrent source/index preparation.
    for (let i = 0; i < frozen.schedule.length; i += manifest.concurrency) {
      save(path.join(manifest.evidenceDir, `resources-${i}.json`), resource(manifest), true);
      const wave = await Promise.all(frozen.schedule.slice(i, i + manifest.concurrency).map(cell => runIsolatedCell(manifestPath, manifest, cell)));
      output.push(...wave); save(path.join(manifest.evidenceDir, 'dispatch-summary.json'), output);
      if (wave.some(x => x.status === 'infrastructure-or-attempt-failed' || x.audit?.infrastructureValid === false)) throw new Error('Stop after infrastructure failure; preserve all cells and investigate before new campaign');
    }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  return { cells: output.length, quality: 'pending-independent-review', evidenceDir: manifest.evidenceDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, manifestPath] = process.argv.slice(2);
  if (!['plan', 'freeze', 'run'].includes(action) || !manifestPath || !path.isAbsolute(manifestPath)) throw new Error('Usage: node run.mjs plan|freeze|run ABS_MANIFEST');
  console.log(JSON.stringify(action === 'plan' ? plan(read(manifestPath)) : action === 'freeze' ? freeze(manifestPath) : await run(manifestPath), null, 2));
}
