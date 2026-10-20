import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, validateManifest, buildSchedule, freezeCampaign, executeCampaign, collectPins, assertFrozen } from './campaign.mjs';
import { createSlotGrader, toLinuxPath } from './grade-campaign.mjs';
import { loadSummary } from './summary.mjs';
import { hash, writeJson } from '../rpc.mjs';

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const absolute = (value, key) => { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${key} must be absolute`); return value; };
const identity = (value, key) => { if (typeof value !== 'string' || !/^[\w.-]+$/.test(value)) throw new Error(`Invalid ${key}`); };
const same = (a, b) => hash(a) === hash(b);
const equalPath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a) === path.resolve(b);
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const freezePath = suite => path.join(suite.evidenceDir, 'suite-freeze.json');
const metaPath = (manifest, slotId) => path.join(manifest.evidenceDir, 'attempts', slotId, 'slot-meta.json');
const terminal = meta => ['attempt-completed', 'task-failed'].includes(meta.status) && meta.audit?.infrastructureValid === true;
const exclusive = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

function manifests(suite, dependencies) {
  return new Map(suite.campaigns.map(campaign => [campaign.campaignId,
    (dependencies.validateManifest ?? validateManifest)((dependencies.readJson ?? json)(campaign.manifestPath))]));
}

function gradingPolicy(config, cohort) {
  const settings = config.grading?.[cohort];
  if (!settings) throw new Error(`Missing ${cohort} official grader configuration`);
  const policy = {
    officialEntry: toLinuxPath(config.grading.officialEntry ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'official.py')),
    python: toLinuxPath(settings.python), officialRoot: toLinuxPath(settings.officialRoot), datasetPath: toLinuxPath(settings.datasetPath),
    timeoutMs: settings.timeoutMs ?? 30 * 60 * 1000,
  };
  // These defaults are the values consumed by official.py. Private Context
  // baselines and caches are allocation paths, separate from scoring policy.
  if (cohort === 'swe') for (const [key, fallback] of Object.entries({ timeoutSeconds: 1800, maxWorkers: 1, openFileLimit: 4096, split: 'test' })) policy[key] = settings[key] === undefined ? fallback : settings[key];
  return policy;
}

/** Check the complete suite before allocating any model attempt. */
export function validateSuite(suite, dependencies = {}) {
  if (suite.schemaVersion !== 1) throw new Error('Require suite schemaVersion=1');
  identity(suite.suiteId, 'suiteId');
  absolute(suite.evidenceDir, 'evidenceDir'); absolute(suite.lockFile, 'lockFile');
  if (!Array.isArray(suite.inputFiles)) throw new Error('inputFiles must be an array');
  suite.inputFiles.forEach(file => absolute(file, 'inputFiles'));
  if (!Array.isArray(suite.models) || suite.models.length !== 4 || new Set(suite.models.map(row => row.family)).size !== 4) throw new Error('Require four distinct model families');
  if (new Set(suite.models.map(row => row.id)).size !== suite.models.length) throw new Error('Duplicate model id');
  for (const row of suite.models) {
    identity(row.id, 'model id'); identity(row.family, 'model family'); absolute(row.capabilityReceipt, 'capabilityReceipt');
    for (const key of ['provider', 'id', 'reasoningEffort']) if (typeof row.model?.[key] !== 'string' || !row.model[key].trim()) throw new Error(`model.${key} required`);
  }
  if (new Set(suite.models.map(row => JSON.stringify([row.model.provider, row.model.id]))).size !== suite.models.length) throw new Error('Duplicate provider/model identity');
  if (!Array.isArray(suite.campaigns) || suite.campaigns.length !== suite.models.length * 2) throw new Error('Require one campaign per model and cohort');
  if (new Set(suite.campaigns.map(row => row.campaignId)).size !== suite.campaigns.length) throw new Error('Duplicate campaign id');
  const loaded = manifests(suite, dependencies), evidence = [];
  for (const model of suite.models) for (const cohort of ['context', 'swe']) {
    if (suite.campaigns.filter(row => row.modelId === model.id && row.cohort === cohort).length !== 1) throw new Error(`Missing or duplicate ${model.id}/${cohort}`);
  }
  for (const campaign of suite.campaigns) {
    identity(campaign.campaignId, 'campaignId'); absolute(campaign.manifestPath, 'manifestPath'); absolute(campaign.gradingConfigPath, 'gradingConfigPath');
    const manifest = loaded.get(campaign.campaignId), model = suite.models.find(row => row.id === campaign.modelId);
    if (!model || !['context', 'swe'].includes(campaign.cohort) || manifest.campaignId !== campaign.campaignId || !same(manifest.model, model.model)) throw new Error('Campaign/model identity mismatch');
    if (manifest.tasks.length !== 12 || manifest.tasks.some(task => task.cohort !== campaign.cohort) || !same(manifest.arms.map(arm => arm.id), ARMS)) throw new Error('Require 12 tasks in one cohort and three fixed arms');
    if (!manifest.evaluation.inputFiles.some(file => equalPath(file, campaign.gradingConfigPath))) throw new Error('Grading config must be a frozen campaign input');
    if (inside(manifest.evidenceDir, suite.lockFile)) throw new Error('Suite lock must be independent of campaign namespaces');
    if (evidence.some(dir => inside(dir, manifest.evidenceDir) || inside(manifest.evidenceDir, dir))) throw new Error('Campaign evidence namespaces overlap');
    evidence.push(manifest.evidenceDir);
  }
  for (const cohort of ['context', 'swe']) {
    const campaigns = suite.campaigns.filter(row => row.cohort === cohort), group = campaigns.map(row => loaded.get(row.campaignId));
    // Model-specific operator inputs and private grading roots may differ. The
    // complete model-visible task, source, native arm and runtime contracts may not.
    const contract = manifest => ({ tasks: manifest.tasks, runtime: manifest.runtime, arms: manifest.arms,
      concurrency: manifest.concurrency, timeoutMs: manifest.timeoutMs, maxOutputTokens: manifest.maxOutputTokens, selectionFile: manifest.selectionFile });
    if (group.some(manifest => !same(contract(manifest), contract(group[0])))) throw new Error(`Cross-model ${cohort} task/runtime contract differs`);
    const policies = campaigns.map(campaign => gradingPolicy((dependencies.readJson ?? json)(campaign.gradingConfigPath), cohort));
    if (policies.some(policy => !same(policy, policies[0]))) throw new Error(`Cross-model ${cohort} grading policy differs`);
  }
  const runtime = [...loaded.values()].map(manifest => manifest.runtime);
  if (runtime.some(value => !same(value, runtime[0]))) throw new Error('Suite runtime paths and configuration must match');
  return suite;
}

/** Rotate model order per task block; retain each campaign's complete arm order. */
export function buildSuiteSchedule(suite, dependencies = {}) {
  validateSuite(suite, dependencies);
  const loaded = manifests(suite, dependencies), schedule = [];
  for (const cohort of ['context', 'swe']) {
    const campaigns = suite.models.map(model => suite.campaigns.find(row => row.modelId === model.id && row.cohort === cohort));
    const schedules = campaigns.map(campaign => buildSchedule(loaded.get(campaign.campaignId).tasks));
    for (let offset = 0; offset < schedules[0].length; offset += ARMS.length) {
      const taskIndex = offset / ARMS.length;
      for (let position = 0; position < campaigns.length; position++) {
        const modelIndex = (taskIndex + position) % campaigns.length;
        const campaign = campaigns[modelIndex], model = suite.models[modelIndex], manifest = loaded.get(campaign.campaignId);
        for (const slot of schedules[modelIndex].slice(offset, offset + ARMS.length)) {
          schedule.push({ ordinal: schedule.length + 1, id: `${campaign.campaignId}/${slot.id}`, campaignId: campaign.campaignId,
            modelId: model.id, family: model.family, cohort, split: manifest.tasks.find(task => task.id === slot.taskId).split,
            taskId: slot.taskId, arm: slot.arm, slotId: slot.id, slotOrdinal: slot.ordinal });
        }
      }
    }
  }
  return schedule;
}

function suitePins(suite, suitePath, loaded) {
  const files = new Set([suitePath, ...suite.inputFiles, ...suite.models.map(model => model.capabilityReceipt)]);
  for (const model of suite.models) for (const file of json(model.capabilityReceipt).evidenceFiles ?? []) files.add(absolute(file, 'capability evidence'));
  for (const campaign of suite.campaigns) for (const file of [campaign.manifestPath, campaign.gradingConfigPath, path.join(loaded.get(campaign.campaignId).evidenceDir, 'freeze.json')]) files.add(file);
  return [...files].sort().map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) }));
}
function checkCapabilities(suite, loaded, dependencies) {
  if (dependencies.checkCapabilities) return dependencies.checkCapabilities(suite, loaded);
  for (const model of suite.models) {
    const receipt = json(model.capabilityReceipt);
    if (receipt.status !== 'qualified' || !same(receipt.model, model.model) ||
      !['contextMenus', 'sweMenus', 'readEditExecDelete', 'nativeCalls', 'independentSessions'].every(key => receipt.checks?.[key] === true) ||
      !Array.isArray(receipt.evidenceFiles) || !receipt.evidenceFiles.length) throw new Error(`Missing qualified pinned capability: ${model.id}`);
    for (const file of receipt.evidenceFiles) if (!fs.statSync(absolute(file, 'capability evidence')).isFile()) throw new Error('Capability evidence must be a file');
  }
}
function verifySuite(suite, suitePath, dependencies) {
  validateSuite(suite, dependencies);
  const loaded = manifests(suite, dependencies), frozen = json(freezePath(suite));
  if (!same(frozen.suite, suite) || !same(frozen.pins, suitePins(suite, suitePath, loaded)) || !same(frozen.schedule, buildSuiteSchedule(suite, dependencies))) throw new Error('Frozen suite inputs drifted');
  for (const campaign of suite.campaigns) {
    const manifest = loaded.get(campaign.campaignId), campaignFrozen = json(path.join(manifest.evidenceDir, 'freeze.json'));
    (dependencies.assertFrozen ?? assertFrozen)(manifest, campaignFrozen, (dependencies.pinCollector ?? collectPins)(manifest, campaign.manifestPath));
    if (!same(campaignFrozen.manifest, manifest) || !same(campaignFrozen.schedule, buildSchedule(manifest.tasks))) throw new Error('Frozen campaign manifest or schedule differs');
  }
  checkCapabilities(suite, loaded, dependencies);
  return { loaded, frozen };
}
async function locked(suite, callback) {
  fs.mkdirSync(path.dirname(suite.lockFile), { recursive: true });
  const fd = fs.openSync(suite.lockFile, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify({ suiteId: suite.suiteId, pid: process.pid, at: new Date().toISOString() })); return await callback(); }
  finally { fs.closeSync(fd); fs.unlinkSync(suite.lockFile); }
}

export async function freezeSuite(suitePath, dependencies = {}) {
  absolute(suitePath, 'suite'); const suite = validateSuite(json(suitePath), dependencies);
  return await locked(suite, async () => {
    const loaded = manifests(suite, dependencies);
    checkCapabilities(suite, loaded, dependencies);
    if (fs.existsSync(freezePath(suite))) return verifySuite(suite, suitePath, dependencies).frozen;
    for (const campaign of suite.campaigns) await (dependencies.freezeCampaign ?? freezeCampaign)(campaign.manifestPath, dependencies);
    const frozen = { schemaVersion: 1, suiteId: suite.suiteId, suitePath, suite,
      pins: suitePins(suite, suitePath, loaded), schedule: buildSuiteSchedule(suite, dependencies) };
    fs.mkdirSync(suite.evidenceDir, { recursive: true }); exclusive(freezePath(suite), frozen);
    return verifySuite(suite, suitePath, dependencies).frozen;
  });
}

/** Accept completed grades and the graders' explicit model-output outcomes. */
function acceptedGrade(meta, cohort) {
  const grade = meta.grade;
  if (grade?.cleanup?.status === 'failed' || grade?.cleanupError) return false;
  if (grade?.status === 'completed') return true;
  if (cohort === 'context' && grade?.missingFinalDeclaration === true &&
    ['missing-final-declaration', 'invalid-final-json', 'invalid-final-schema', 'invalid-final-region'].includes(grade.status)) return true;
  return cohort === 'swe' && grade?.emptyModelPatch === true && grade?.status === 'missing-report' &&
    grade.receipt?.processExit?.code === 0 && grade.receipt.timedOut === false && grade.receipt.processError === null &&
    !grade.receipt.officialInfrastructureFailure && grade.cleanup?.status === 'completed';
}

function auditProducedCells(suite, loaded, schedule) {
  const seen = { session: new Set(), home: new Set(), source: new Set(), attempt: new Set() }, cells = [];
  const freezes = new Map([...loaded].map(([id, manifest]) => [id, json(path.join(manifest.evidenceDir, 'freeze.json'))]));
  for (const cell of schedule) {
    const manifest = loaded.get(cell.campaignId), file = metaPath(manifest, cell.slotId);
    if (!fs.existsSync(file)) continue;
    const meta = json(file), dir = path.dirname(file), dsh = path.join(dir, 'dsh'), requestFile = path.join(dsh, 'request.json');
    if (meta.grade?.status === 'completed') {
      const result = meta.grade.receipt?.resultPath;
      if (!result || !fs.existsSync(result) || hash(fs.readFileSync(result)) !== meta.grade.receipt.resultSha256) throw new Error(`Prior completed official report is missing or changed: ${cell.id}`);
    }
    const frozen = freezes.get(cell.campaignId), slot = frozen.schedule.find(row => row.id === cell.slotId);
    if (meta.freezeHash !== hash(frozen) || !same(meta.slot, slot)) throw new Error(`Cell frozen identity mismatch: ${cell.id}`);
    if (!equalPath(meta.receiptPath, path.join(dsh, 'receipt.json'))) throw new Error(`Foreign receipt namespace: ${cell.id}`);
    const receipt = json(meta.receiptPath), request = json(requestFile), bridge = json(path.join(dir, 'bridge-config.json'));
    const source = path.join(dir, 'source'), home = path.join(dsh, 'home');
    if (!receipt.sessionId || receipt.sessionId !== request.sessionId || !equalPath(meta.sourceRoot, source) || !equalPath(receipt.initialization?.cwd, source) ||
      !equalPath(request.initialization?.cwd, source) || !equalPath(request.environment?.DSH_HOME, home) || !equalPath(bridge.root, source)) throw new Error(`Independent cell namespace mismatch: ${cell.id}`);
    for (const key of ['provider', 'reasoningEffort']) if (request.initialization[key] !== manifest.model[key] || receipt.initialization[key] !== manifest.model[key]) throw new Error(`Cell model mismatch: ${cell.id}`);
    if (request.initialization.model !== manifest.model.id || receipt.initialization.model !== manifest.model.id) throw new Error(`Cell model mismatch: ${cell.id}`);
    if (cell.arm !== 'ordinary' && !equalPath(bridge.native?.cwd, source)) throw new Error(`Foreign native source: ${cell.id}`);
    const args = bridge.native?.args ?? [];
    if (cell.arm === 'codefacts022' && (!equalPath(args[args.indexOf('--root') + 1], source) || !equalPath(args[args.indexOf('--state') + 1], path.join(dir, 'state.sqlite')))) throw new Error(`Foreign native index: ${cell.id}`);
    if (cell.arm === 'codegraph' && !equalPath(args[args.indexOf('--path') + 1], source)) throw new Error(`Foreign native index: ${cell.id}`);
    for (const [key, value] of Object.entries({ session: receipt.sessionId, home, source, attempt: dsh })) {
      if (seen[key].has(value)) throw new Error(`Duplicate ${key} across suite cells`);
      seen[key].add(value);
    }
    cells.push({ ...cell, meta, metadataHash: hash(fs.readFileSync(file)), receiptHash: hash(fs.readFileSync(meta.receiptPath)), requestHash: hash(fs.readFileSync(requestFile)) });
  }
  return cells;
}

function pilotCandidate(suite, frozen, loaded, cohort) {
  if (!['context', 'swe'].includes(cohort)) throw new Error('Pilot review requires a cohort');
  const expected = frozen.schedule.filter(cell => cell.cohort === cohort && cell.split === 'pilot');
  const produced = auditProducedCells(suite, loaded, frozen.schedule);
  const cells = expected.map(cell => {
    const found = produced.find(row => row.id === cell.id);
    if (!found || !terminal(found.meta) || !acceptedGrade(found.meta, cohort)) throw new Error(`Pilot incomplete or infrastructure-invalid: ${cell.id}`);
    return { id: cell.id, campaignId: cell.campaignId, modelId: cell.modelId, slotId: cell.slotId,
      metadataHash: found.metadataHash, receiptHash: found.receiptHash, requestHash: found.requestHash };
  });
  return { schemaVersion: 1, suiteId: suite.suiteId, suiteFreezeHash: hash(frozen), cohort,
    status: 'pending-root-review', approvedBy: null, cells };
}

export function buildPilotReviewCandidate(suitePath, cohort, dependencies = {}) {
  const suite = json(absolute(suitePath, 'suite')), { loaded, frozen } = verifySuite(suite, suitePath, dependencies);
  return pilotCandidate(suite, frozen, loaded, cohort);
}

export async function runSuite(suitePath, { cohort, split, pilotReviewPath = null } = {}, dependencies = {}) {
  absolute(suitePath, 'suite');
  if (!['context', 'swe'].includes(cohort) || !['pilot', 'confirmation_holdout'].includes(split)) throw new Error('Run requires explicit cohort and split');
  const suite = validateSuite(json(suitePath), dependencies);
  return await locked(suite, async () => {
    const { loaded, frozen } = verifySuite(suite, suitePath, dependencies);
    if (split === 'confirmation_holdout') {
      const candidate = pilotCandidate(suite, frozen, loaded, cohort), review = json(absolute(pilotReviewPath, 'pilotReviewPath'));
      const binding = value => Object.fromEntries(['schemaVersion', 'suiteId', 'suiteFreezeHash', 'cohort', 'cells'].map(key => [key, value[key]]));
      if (review.status !== 'root-reviewed-pilot' || review.approvedBy !== 'root' || !same(binding(candidate), binding(review))) throw new Error('Holdout requires root-reviewed pilot for every model and unchanged pilot evidence');
    }
    auditProducedCells(suite, loaded, frozen.schedule);
    const selected = frozen.schedule.filter(cell => cell.cohort === cohort && cell.split === split);
    for (const cell of selected) {
      const campaign = suite.campaigns.find(row => row.campaignId === cell.campaignId), manifest = loaded.get(cell.campaignId), file = metaPath(manifest, cell.slotId);
      if (!fs.existsSync(file)) {
        const campaignFrozen = json(path.join(manifest.evidenceDir, 'freeze.json'));
        const grade = (dependencies.createSlotGrader ?? createSlotGrader)({ manifest, frozen: campaignFrozen,
          config: json(campaign.gradingConfigPath), configPath: campaign.gradingConfigPath, dependencies });
        await (dependencies.executeCampaign ?? executeCampaign)(campaign.manifestPath, 'run', cell.slotId, { ...dependencies, grade }, split);
      }
      // A terminal attempt with a grader failure is retained for manual regrade;
      // resuming this suite never sends the prompt a second time.
      const meta = json(file);
      if (!terminal(meta) || !acceptedGrade(meta, cohort)) throw new Error(`Cell requires infrastructure repair or manual regrade: ${cell.id}`);
      auditProducedCells(suite, loaded, frozen.schedule);
    }
    const summaries = suite.campaigns.map(campaign => (dependencies.loadSummary ?? loadSummary)(loaded.get(campaign.campaignId).evidenceDir));
    const summarize = dependencies.summarizeSuite ?? (await import('./suite-summary.mjs')).summarizeSuite;
    const summary = summarize(suite, summaries);
    writeJson(path.join(suite.evidenceDir, 'suite-summary.json'), summary);
    return { status: 'suite-phase-completed', suiteId: suite.suiteId, cohort, split, cells: selected.length, summary };
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--suite', '--mode', '--cohort', '--split', '--pilot-review'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: --suite ABS --mode plan|freeze|run [--cohort context|swe --split pilot|confirmation_holdout --pilot-review ABS]');
    if (args[argv[i]]) throw new Error(`Duplicate option: ${argv[i]}`);
    args[argv[i]] = argv[i + 1];
  }
  const suitePath = absolute(args['--suite'], 'suite'), mode = args['--mode'];
  if (mode === 'plan') {
    const suite = validateSuite(json(suitePath));
    const cohort = args['--cohort'], split = args['--split'];
    if (cohort && !['context', 'swe'].includes(cohort)) throw new Error('cohort must be context or swe');
    if (split && !['pilot', 'confirmation_holdout'].includes(split)) throw new Error('split must be pilot or confirmation_holdout');
    return { status: 'suite-planned', suiteId: suite.suiteId,
      schedule: buildSuiteSchedule(suite).filter(cell => (!cohort || cell.cohort === cohort) && (!split || cell.split === split)) };
  }
  if (mode === 'freeze') return await freezeSuite(suitePath);
  if (mode === 'run') return await runSuite(suitePath, { cohort: args['--cohort'], split: args['--split'], pilotReviewPath: args['--pilot-review'] });
  throw new Error('mode must be plan, freeze or run');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.stack); process.exitCode = 1; });
