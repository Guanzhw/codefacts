import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFrozen, collectPins } from './campaign.mjs';
import { extractTrace } from './trace.mjs';
import { runOfficialGrade } from './grade.mjs';
import { hash, writeJson } from '../rpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exclusive = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

export function toLinuxPath(value) {
  if (typeof value !== 'string') throw new Error('Absolute grading path required');
  if (/^[A-Za-z]:[\\/]/.test(value)) return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\', '/')}`;
  if (value.startsWith('/')) return value;
  throw new Error(`Absolute Windows drive or Linux grading path required: ${value}`);
}

function requireFrozenConfig(frozen, configPath, config) {
  const pin = frozen.pins.find(row => path.resolve(row.path) === path.resolve(configPath));
  if (!pin || hash(fs.readFileSync(configPath)) !== pin.sha256 || hash(json(configPath)) !== hash(config)) {
    throw new Error('Grading operator config must be a frozen campaign input');
  }
}

function allocate(dir) {
  for (let index = 1; ; index++) {
    const outputDir = path.join(dir, `grade-run-${String(index).padStart(4, '0')}`);
    try { fs.mkdirSync(outputDir); return { outputDir, index }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

/** A runSlot grade callback. It uses pristine baseline bytes for trace mapping. */
export function createSlotGrader({ manifest, frozen, config, configPath, retry = false, dependencies = {} }) {
  requireFrozenConfig(frozen, configPath, config);
  return async ({ task, slot, dir, meta, receipt }) => {
    assertFrozen(manifest, frozen, (dependencies.pinCollector ?? collectPins)(manifest, frozen.manifestPath));
    requireFrozenConfig(frozen, configPath, config);
    if (meta.freezeHash !== hash(frozen)) throw new Error('Attempt freeze identity differs from grading campaign');
    if (!meta.audit?.infrastructureValid) throw new Error('Infrastructure-invalid attempts cannot be scored');
    const settings = config.grading?.[task.cohort];
    if (!settings) throw new Error(`Missing ${task.cohort} official grader configuration`);
    let prediction, diagnostics = null;
    if (task.cohort === 'context') {
      const base = config.contextBases?.[task.id];
      if (!base || !/^[a-f0-9]{40}$/i.test(base.gradingCommit)) throw new Error(`Missing private Context baseline: ${task.id}`);
      // The official grader writes Git worktree metadata: keep that operation
      // outside both the model attempt and the frozen archive tree.
      const root = path.resolve(base.repoRoot), attempt = path.resolve(dir);
      if (root === path.resolve(task.sourceRoot) || root === attempt || root.startsWith(attempt + path.sep)) {
        throw new Error('Context grading requires a dedicated private baseline');
      }
      if (typeof meta.bridgeEvidenceDir !== 'string' || !path.isAbsolute(meta.bridgeEvidenceDir)) {
        throw new Error('Context attempt must record its actual bridge evidence directory');
      }
      const trace = extractTrace({ root: task.sourceRoot, bridgeDir: meta.bridgeEvidenceDir,
        task: { instanceId: task.instanceId, repo: task.repo, baseCommit: task.baseCommit }, answer: receipt.answer });
      prediction = trace.prediction;
      prediction.repo_url = toLinuxPath(base.repoRoot);
      prediction.commit = base.gradingCommit;
      diagnostics = trace.diagnostics;
    } else {
      prediction = { instance_id: task.instanceId, model_name_or_path: `${manifest.campaignId}-${slot.arm}`,
        model_patch: fs.readFileSync(meta.patchPath, 'utf8') };
    }
    const provenance = { freezeHash: hash(frozen), configHash: hash(config),
      inputHash: hash({ prediction, diagnostics, modelAttemptStatus: meta.status }) };
    const previous = meta.grade;
    if (previous && previous.status !== 'pending') {
      if (previous.provenance && hash(previous.provenance) !== hash(provenance)) throw new Error('Prior grade provenance differs from frozen attempt');
      if (previous.status === 'completed') {
        if (!previous.provenance) throw new Error('Prior completed grade has no verifiable provenance');
        const result = previous.receipt?.resultPath;
        if (!result || !fs.existsSync(result) || hash(fs.readFileSync(result)) !== previous.receipt.resultSha256) {
          throw new Error('Prior completed official report is missing or changed');
        }
        return previous;
      }
      if (!retry) throw new Error(`Prior grade ${previous.status}; use --retry for a fresh grader namespace`);
    }
    const { outputDir, index } = allocate(dir);
    const predictionsPath = path.join(outputDir, 'predictions.json');
    exclusive(predictionsPath, [prediction]);
    if (diagnostics) exclusive(path.join(outputDir, 'trace-diagnostics.json'), diagnostics);
    const common = { provenance, outputDir, predictionsPath, modelAttemptStatus: meta.status,
      modelTaskCompleted: meta.audit.taskCompleted, emptyModelPatch: task.cohort === 'swe' ? !prediction.model_patch.trim() : null };
    if (diagnostics && diagnostics.declarationStatus !== 'valid') {
      const grade = { ...common, status: diagnostics.declarationStatus, resolved: null, metrics: null,
        missingFinalDeclaration: true };
      exclusive(path.join(outputDir, 'grade.json'), grade);
      return grade;
    }
    const officialConfig = { officialRoot: toLinuxPath(settings.officialRoot), datasetPath: toLinuxPath(settings.datasetPath),
      predictionsPath: toLinuxPath(predictionsPath), outputDir: toLinuxPath(outputDir),
      runId: `cf-${hash(`${manifest.campaignId}/${slot.id}`).slice(0, 24)}-${index}` };
    if (task.cohort === 'context') {
      officialConfig.repoCache = toLinuxPath(settings.repoCache);
      officialConfig.sourceManifestPath = toLinuxPath(config.contextBases[task.id].sourceManifestPath);
    } else {
      for (const key of ['timeoutSeconds', 'maxWorkers', 'openFileLimit', 'split']) {
        if (settings[key] !== undefined) officialConfig[key] = settings[key];
      }
    }
    const officialConfigPath = path.join(outputDir, 'official-config.json');
    exclusive(officialConfigPath, officialConfig);
    const officialEntry = config.grading.officialEntry ?? path.join(HERE, 'official.py');
    let result;
    try {
      result = await (dependencies.runOfficialGrade ?? runOfficialGrade)({ kind: task.cohort,
        command: manifest.runtime.wsl,
        args: ['-d', manifest.runtime.wslDistro ?? manifest.runtime.distribution ?? 'Ubuntu', '-u', 'root', '--exec',
          toLinuxPath(settings.python), '-B', toLinuxPath(officialEntry), '--kind', task.cohort, '--config', toLinuxPath(officialConfigPath)],
        outputDir, resultPath: path.join(outputDir, 'result.json'), instanceId: task.instanceId,
        timeoutMs: settings.timeoutMs ?? 30 * 60 * 1000 });
    } catch (error) {
      result = { status: 'failed', resolved: null, metrics: null, error: error.stack ?? error.message };
    }
    const grade = { ...result, ...common };
    exclusive(path.join(outputDir, 'grade.json'), grade);
    return grade;
  };
}

export async function gradeCampaign(manifestPath, configPath, { slot: onlySlot = null, split = null, retry = false, dependencies = {} } = {}) {
  if (!path.isAbsolute(manifestPath) || !path.isAbsolute(configPath)) throw new Error('Absolute manifest and config paths required');
  if (split !== null && !['pilot', 'confirmation_holdout'].includes(split)) throw new Error('Unknown grading split');
  const manifest = json(manifestPath), frozen = json(path.join(manifest.evidenceDir, 'freeze.json'));
  const grade = createSlotGrader({ manifest, frozen, config: json(configPath), configPath, retry, dependencies });
  if (onlySlot && !frozen.schedule.some(slot => slot.id === onlySlot || String(slot.ordinal) === String(onlySlot))) throw new Error(`Unknown slot: ${onlySlot}`);
  const lock = path.join(manifest.evidenceDir, 'dispatch.lock'), fd = fs.openSync(lock, 'wx');
  const grades = [];
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, purpose: 'official-grading', at: new Date().toISOString() }));
    for (const slot of frozen.schedule) {
      if (onlySlot && slot.id !== onlySlot && String(slot.ordinal) !== String(onlySlot)) continue;
      const task = manifest.tasks.find(task => task.id === slot.taskId);
      if (split && task.split !== split) continue;
      const dir = path.join(manifest.evidenceDir, 'attempts', slot.id), metaPath = path.join(dir, 'slot-meta.json');
      if (!fs.existsSync(metaPath)) continue;
      const meta = json(metaPath);
      if (!['attempt-completed', 'task-failed'].includes(meta.status)) throw new Error(`Attempt is not terminal and infrastructure-valid: ${slot.id}`);
      if (hash(meta.slot) !== hash(slot)) throw new Error(`Attempt slot identity differs: ${slot.id}`);
      meta.grade = await grade({ task, slot, dir, meta, receipt: json(meta.receiptPath) });
      writeJson(metaPath, meta);
      grades.push({ slot: slot.id, status: meta.grade.status, resolved: meta.grade.resolved });
    }
    return { status: 'grading-completed', slots: grades.length, grades };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--retry') { options.retry = true; continue; }
    if (!['--manifest', '--config', '--slot', '--split'].includes(key) || !argv[index + 1]) {
      throw new Error('Usage: --manifest ABS --config ABS [--slot ID] [--split pilot|confirmation_holdout] [--retry]');
    }
    options[key.slice(2)] = argv[++index];
  }
  console.log(JSON.stringify(await gradeCampaign(options.manifest, options.config, options)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
