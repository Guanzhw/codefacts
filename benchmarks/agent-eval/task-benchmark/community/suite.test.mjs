import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSuite, buildSuiteSchedule, freezeSuite, runSuite, buildPilotReviewCandidate } from './suite.mjs';
import { buildSchedule } from './campaign.mjs';
import { parseDeclaration } from './trace.mjs';
import { hash, writeJson } from '../rpc.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); writeJson(file, value); return file; };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'community-suite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const common = put(path.join(root, 'runtime.json'), { revision: 'fixed' });
  const runtime = { node: common, dshRoot: root, sdkRoot: root, rg: common };
  const suite = { schemaVersion: 1, suiteId: 'fixture', evidenceDir: path.join(root, 'evidence'), lockFile: path.join(root, 'suite.lock'), models: [], campaigns: [], inputFiles: [common] };
  const taskIds = Array.from({ length: 12 }, (_, i) => `task-${i}`);
  for (const [index, family] of ['DeepSeek', 'Qwen', 'GPT6Luna', 'Haiku'].entries()) {
    const id = `model-${index}`, model = { provider: 'fixture', id, reasoningEffort: index === 2 ? 'medium' : 'high' };
    const capabilityReceipt = put(path.join(root, `${id}-capability.json`), { status: 'qualified', model,
      checks: { contextMenus: true, sweMenus: true, readEditExecDelete: true, nativeCalls: true, independentSessions: true }, evidenceFiles: [common], backendRevision: null });
    suite.models.push({ id, family, model, capabilityReceipt });
    for (const cohort of ['context', 'swe']) {
      const campaignId = `${id}-${cohort}`, gradingConfigPath = put(path.join(root, campaignId, 'grading.json'), {
        grading: { officialEntry: common, [cohort]: { python: common, officialRoot: root, datasetPath: common, repoCache: path.join(root, campaignId, 'private-cache') } },
      });
      const manifest = { schemaVersion: 1, campaignId, evidenceDir: path.join(root, campaignId, 'campaign'), model, runtime,
        concurrency: 1, timeoutMs: 1200000, maxOutputTokens: 32768, selectionFile: common,
        arms: [{ id: 'ordinary' }, { id: 'codefacts022', version: '0.2.2' }, { id: 'codegraph', version: '1.6.2' }],
        tasks: taskIds.map((id, i) => ({ id, cohort, split: i < 8 ? 'pilot' : 'confirmation_holdout', prompt: `${cohort}/${id}`, sourceRoot: path.join(root, 'sources', cohort, id), baseCommit: 'a'.repeat(40) })),
        evaluation: { inputFiles: [gradingConfigPath] } };
      const manifestPath = put(path.join(root, campaignId, 'manifest.json'), manifest);
      suite.campaigns.push({ campaignId, modelId: id, cohort, manifestPath, gradingConfigPath });
    }
  }
  const suitePath = put(path.join(root, 'suite.json'), suite), calls = [];
  const pins = manifest => [manifest.evaluation.inputFiles[0], common].map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) }));
  const deps = {
    // These tests isolate the suite. Campaign/parser/source invariants have their
    // own real-contract tests; no provider, Docker or WSL is started here.
    validateManifest: value => value, pinCollector: pins,
    freezeCampaign: manifestPath => {
      const manifest = read(manifestPath), frozen = { manifestPath, manifest, manifestHash: hash(manifest), pins: pins(manifest), schedule: buildSchedule(manifest.tasks) };
      put(path.join(manifest.evidenceDir, 'freeze.json'), frozen); return frozen;
    },
    createSlotGrader: () => async () => ({ status: 'completed' }),
    executeCampaign: async (file, mode, slotId, dependencies, split) => { calls.push({ file, mode, slotId, split }); makeAttempt(file, slotId); },
    loadSummary: dir => ({ campaignId: path.basename(path.dirname(dir)) }), summarizeSuite: (_, summaries) => ({ campaigns: summaries.length }),
  };
  function makeAttempt(file, slotId, options = {}) {
    const manifest = read(file), frozen = read(path.join(manifest.evidenceDir, 'freeze.json')), slot = frozen.schedule.find(row => row.id === slotId);
    const dir = path.join(manifest.evidenceDir, 'attempts', slotId), sourceRoot = path.join(dir, 'source'), dsh = path.join(dir, 'dsh');
    const initialization = { cwd: sourceRoot, provider: manifest.model.provider, model: manifest.model.id, reasoningEffort: manifest.model.reasoningEffort };
    const sessionId = options.sessionId ?? randomUUID(), receiptPath = put(path.join(dsh, 'receipt.json'), { sessionId, initialization });
    put(path.join(dsh, 'request.json'), { sessionId, initialization, environment: { DSH_HOME: path.join(dsh, 'home') } });
    put(path.join(dir, 'bridge-config.json'), { root: sourceRoot, native: slot.arm === 'ordinary' ? null : { cwd: sourceRoot,
      args: slot.arm === 'codefacts022' ? ['mcp', '--root', sourceRoot, '--state', path.join(dir, 'state.sqlite')] : ['serve', '--path', sourceRoot] } });
    let grade = options.grade ?? { status: 'completed', metrics: null };
    if (grade.status === 'completed') {
      const resultPath = put(path.join(dir, 'grade-run-0001', 'result.json'), { instanceId: slot.taskId, resolved: false });
      grade = { provenance: { freezeHash: hash(frozen), configHash: hash(read(manifest.evaluation.inputFiles[0])), inputHash: hash(slot) },
        ...grade, receipt: { resultPath, resultSha256: hash(fs.readFileSync(resultPath)), ...grade.receipt } };
    }
    put(path.join(dir, 'slot-meta.json'), { slot, freezeHash: hash(frozen), sourceRoot, receiptPath,
      status: options.status ?? 'attempt-completed', audit: { infrastructureValid: options.infrastructureValid ?? true }, grade });
  }
  return { root, suite, suitePath, deps, calls, makeAttempt };
}

test('288 deterministic unique cells rotate model blocks and preserve every full campaign schedule', t => {
  const f = fixture(t), schedule = buildSuiteSchedule(f.suite, f.deps);
  assert.equal(schedule.length, 288); assert.equal(new Set(schedule.map(row => row.id)).size, 288);
  assert.deepEqual(schedule, buildSuiteSchedule(f.suite, f.deps));
  assert.deepEqual(schedule.slice(0, 12).filter(row => row.slotOrdinal === 1).map(row => row.modelId), ['model-0', 'model-1', 'model-2', 'model-3']);
  assert.deepEqual(schedule.slice(12, 24).filter(row => row.slotOrdinal === 4).map(row => row.modelId), ['model-1', 'model-2', 'model-3', 'model-0']);
  for (const campaign of f.suite.campaigns) assert.deepEqual(schedule.filter(row => row.campaignId === campaign.campaignId).map(row => row.slotId), buildSchedule(read(campaign.manifestPath).tasks).map(row => row.id));
});

test('cross-model task, runtime and evidence namespace drift is rejected', t => {
  const f = fixture(t), campaign = f.suite.campaigns[2], original = read(campaign.manifestPath);
  put(campaign.manifestPath, { ...original, tasks: original.tasks.map((task, i) => i === 0 ? { ...task, prompt: 'drift' } : task) });
  assert.throws(() => validateSuite(f.suite, f.deps), /contract differs/);
  put(campaign.manifestPath, { ...original, evidenceDir: read(f.suite.campaigns[0].manifestPath).evidenceDir });
  assert.throws(() => validateSuite(f.suite, f.deps), /overlap/);
  put(campaign.manifestPath, { ...original, runtime: { ...original.runtime, revision: 'other' } });
  assert.throws(() => validateSuite(f.suite, f.deps), /contract differs/);
});

test('duplicate provider/model is rejected before loading campaigns even with different family and effort', async t => {
  const f = fixture(t);
  f.suite.models[1].model = { ...f.suite.models[0].model, reasoningEffort: 'other-effort' };
  put(f.suitePath, f.suite);
  const dependencies = { ...f.deps, readJson: () => { throw new Error('Campaign loaded before model identity validation'); } };
  assert.throws(() => validateSuite(f.suite, dependencies), /Duplicate provider\/model identity/);
  assert.throws(() => buildSuiteSchedule(f.suite, dependencies), /Duplicate provider\/model identity/);
  await assert.rejects(freezeSuite(f.suitePath, dependencies), /Duplicate provider\/model identity/);
  await assert.rejects(runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, dependencies), /Duplicate provider\/model identity/);
  assert.equal(f.calls.length, 0);
});

test('effective grading policy rejects scorer, dataset and timeout drift while allowing private Context paths', async t => {
  const f = fixture(t), context = f.suite.campaigns.find(row => row.modelId === 'model-1' && row.cohort === 'context');
  const contextConfig = read(context.gradingConfigPath);
  put(context.gradingConfigPath, { ...contextConfig, contextBases: { 'task-0': { repoRoot: path.join(f.root, 'other-private-baseline'), gradingCommit: 'b'.repeat(40), sourceManifestPath: path.join(f.root, 'private-source-manifest.json') } },
    grading: { ...contextConfig.grading, context: { ...contextConfig.grading.context, repoCache: '/other/private/cache', timeoutMs: 1800000 } } });
  assert.doesNotThrow(() => validateSuite(f.suite, f.deps));
  const swe = f.suite.campaigns.find(row => row.modelId === 'model-1' && row.cohort === 'swe'), original = read(swe.gradingConfigPath);
  const defaults = { timeoutMs: 1800000, timeoutSeconds: 1800, maxWorkers: 1, openFileLimit: 4096, split: 'test' };
  put(swe.gradingConfigPath, { ...original, grading: { ...original.grading, swe: { ...original.grading.swe, ...defaults } } });
  assert.doesNotThrow(() => validateSuite(f.suite, f.deps)); // Explicit defaults equal omitted defaults.
  for (const [key, value] of Object.entries({ python: '/different/python', officialRoot: '/different/scorer', datasetPath: '/different/dataset', timeoutMs: 1800001,
    timeoutSeconds: 1801, maxWorkers: 2, openFileLimit: 4097, split: 'train' })) {
    put(swe.gradingConfigPath, { ...original, grading: { ...original.grading, swe: { ...original.grading.swe, [key]: value } } });
    assert.throws(() => validateSuite(f.suite, f.deps), /grading policy differs/, key);
    await assert.rejects(freezeSuite(f.suitePath, f.deps), /grading policy differs/, key);
  }
  put(swe.gradingConfigPath, { ...original, grading: { ...original.grading, officialEntry: '/different/official.py' } });
  assert.throws(() => validateSuite(f.suite, f.deps), /grading policy differs/);
  assert.equal(f.calls.length, 0);
});

test('completed official report drift or missing receipt blocks resume and pilot review before any new attempt', async t => {
  for (const mutation of ['changed-report', 'missing-report', 'missing-receipt']) {
    const f = fixture(t); await freezeSuite(f.suitePath, f.deps);
    const campaign = f.suite.campaigns[0], manifest = read(campaign.manifestPath), slot = buildSchedule(manifest.tasks)[0];
    f.makeAttempt(campaign.manifestPath, slot.id);
    const file = path.join(manifest.evidenceDir, 'attempts', slot.id, 'slot-meta.json'), meta = read(file);
    if (mutation === 'changed-report') put(meta.grade.receipt.resultPath, { altered: true });
    if (mutation === 'missing-report') fs.unlinkSync(meta.grade.receipt.resultPath);
    if (mutation === 'missing-receipt') { delete meta.grade.receipt; put(file, meta); }
    await assert.rejects(runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, f.deps), /Prior completed official report is missing or changed/);
    assert.throws(() => buildPilotReviewCandidate(f.suitePath, 'context', f.deps), /Prior completed official report is missing or changed/);
    assert.equal(f.calls.length, 0);
  }
});

test('freeze requires qualified capability, binds raw inputs and refuses changed input pins', async t => {
  const f = fixture(t), capability = f.suite.models[0].capabilityReceipt, receipt = read(capability);
  put(capability, { ...receipt, status: 'placeholder' });
  await assert.rejects(freezeSuite(f.suitePath, f.deps), /qualified/);
  put(capability, receipt); const frozen = await freezeSuite(f.suitePath, f.deps);
  assert.equal(frozen.schedule.length, 288);
  assert.deepEqual(await freezeSuite(f.suitePath, f.deps), frozen);
  fs.appendFileSync(f.suite.inputFiles[0], ' ');
  await assert.rejects(runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, f.deps), /drifted/);
  assert.equal(f.calls.length, 0);
});

test('global lock covers model execution, grading gaps and concurrent phases', async t => {
  const f = fixture(t); await freezeSuite(f.suitePath, f.deps);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const execute = f.deps.executeCampaign;
  f.deps.createSlotGrader = () => async () => { if (f.calls.length === 1) { entered(); await gate; } };
  f.deps.executeCampaign = async (...args) => { await execute(...args); await args[3].grade({}); };
  const running = runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, f.deps);
  await started;
  assert.equal(f.calls.length, 1); // The model returned; its grader is still pending.
  assert.equal(fs.existsSync(f.suite.lockFile), true);
  await assert.rejects(runSuite(f.suitePath, { cohort: 'swe', split: 'pilot' }, f.deps), /EEXIST/);
  await assert.rejects(freezeSuite(f.suitePath, f.deps), /EEXIST/);
  release(); const result = await running;
  assert.equal(result.cells, 96); assert.equal(fs.existsSync(f.suite.lockFile), false);
});

test('terminal resume does not rerun any model and task failures continue', async t => {
  const f = fixture(t); await freezeSuite(f.suitePath, f.deps);
  f.deps.executeCampaign = async (file, mode, slotId) => {
    f.calls.push(slotId); f.makeAttempt(file, slotId, { status: 'task-failed' });
  };
  await runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, f.deps);
  assert.equal(f.calls.length, 96);
  await runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, f.deps);
  assert.equal(f.calls.length, 96);
});

test('all four owning Context declaration failures continue and qualify for the pilot gate with null quality', async t => {
  const f = fixture(t); await freezeSuite(f.suitePath, f.deps);
  const declarations = ['', 'not json', '{}', JSON.stringify({ regions: [{ file_path: 'missing.mjs', start_line: 1, end_line: 1 }], rationale: 'bad region' })];
  const expected = ['missing-final-declaration', 'invalid-final-json', 'invalid-final-schema', 'invalid-final-region'];
  const grades = declarations.map((answer, index) => {
    const { reason } = parseDeclaration(answer, f.root); assert.equal(reason, expected[index]);
    return { status: reason, missingFinalDeclaration: true, resolved: null, metrics: null };
  });
  f.deps.executeCampaign = async (file, _, slotId) => {
    const grade = grades[f.calls.length % grades.length]; f.calls.push(slotId);
    f.makeAttempt(file, slotId, { status: 'task-failed', grade });
  };
  await runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, f.deps);
  assert.equal(f.calls.length, 96);
  const candidate = buildPilotReviewCandidate(f.suitePath, 'context', f.deps);
  assert.equal(candidate.cells.length, 96);
  for (const cell of candidate.cells) {
    const campaign = f.suite.campaigns.find(row => row.campaignId === cell.campaignId);
    const grade = read(path.join(read(campaign.manifestPath).evidenceDir, 'attempts', cell.slotId, 'slot-meta.json')).grade;
    assert.equal(grade.metrics, null); assert.equal(grade.resolved, null);
  }
});

test('Context declaration outcomes require the owning flag and exact status and never mask cleanup failure', async t => {
  for (const grade of [{ status: 'missing-final-declaration', missingFinalDeclaration: false },
    { status: 'failed', missingFinalDeclaration: true },
    { status: 'invalid-final-declaration', missingFinalDeclaration: true },
    { status: 'invalid-final-json', missingFinalDeclaration: true, cleanup: { status: 'failed' } },
    { status: 'invalid-final-region', missingFinalDeclaration: true, cleanupError: 'container remains' }]) {
    const f = fixture(t); await freezeSuite(f.suitePath, f.deps);
    f.deps.executeCampaign = async (file, _, slotId) => { f.calls.push(slotId); f.makeAttempt(file, slotId, { status: 'task-failed', grade }); };
    await assert.rejects(runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, f.deps), /manual regrade/);
    assert.equal(f.calls.length, 1);
    assert.throws(() => buildPilotReviewCandidate(f.suitePath, 'context', f.deps), /Pilot incomplete/);
  }
});

test('infrastructure or grader cleanup failure stops before the next cell and resume preserves attempt', async t => {
  for (const bad of [{ infrastructureValid: false }, { grade: { status: 'failed', cleanupError: 'container remains' } }, { grade: { status: 'completed', cleanup: { status: 'failed' } } }]) {
    const f = fixture(t); await freezeSuite(f.suitePath, f.deps);
    f.deps.executeCampaign = async (file, _, slotId) => { f.calls.push(slotId); f.makeAttempt(file, slotId, bad); };
    await assert.rejects(runSuite(f.suitePath, { cohort: 'swe', split: 'pilot' }, f.deps), /manual regrade/);
    assert.equal(f.calls.length, 1);
    await assert.rejects(runSuite(f.suitePath, { cohort: 'swe', split: 'pilot' }, f.deps), /manual regrade/);
    assert.equal(f.calls.length, 1);
    assert.equal(fs.existsSync(f.suite.lockFile), false);
  }
});

test('empty patch missing report follows completed official process and cleanup contract', async t => {
  const f = fixture(t); await freezeSuite(f.suitePath, f.deps);
  f.deps.executeCampaign = async (file, _, slotId) => {
    f.calls.push(slotId); f.makeAttempt(file, slotId, { grade: { status: 'missing-report', emptyModelPatch: true,
      receipt: { processExit: { code: 0 }, timedOut: false, processError: null }, cleanup: { status: 'completed' } } });
  };
  await runSuite(f.suitePath, { cohort: 'swe', split: 'pilot' }, f.deps);
  assert.equal(f.calls.length, 96);
});

test('pilot gate binds all models and all pilot hashes; holdout requires separate root approval', async t => {
  const f = fixture(t); await freezeSuite(f.suitePath, f.deps);
  assert.throws(() => buildPilotReviewCandidate(f.suitePath, 'context', f.deps), /Pilot incomplete/);
  await runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, f.deps);
  const candidate = buildPilotReviewCandidate(f.suitePath, 'context', f.deps);
  assert.equal(candidate.cells.length, 96); assert.equal(new Set(candidate.cells.map(row => row.modelId)).size, 4);
  const reviewPath = put(path.join(f.root, 'pilot-review.json'), candidate);
  await assert.rejects(runSuite(f.suitePath, { cohort: 'context', split: 'confirmation_holdout', pilotReviewPath: reviewPath }, f.deps), /root-reviewed/);
  const review = { ...candidate, status: 'root-reviewed-pilot', approvedBy: 'root' };
  put(reviewPath, { ...review, cells: review.cells.slice(0, 24) });
  await assert.rejects(runSuite(f.suitePath, { cohort: 'context', split: 'confirmation_holdout', pilotReviewPath: reviewPath }, f.deps), /root-reviewed/);
  put(reviewPath, review);
  const first = f.suite.campaigns[0], metaFile = path.join(read(first.manifestPath).evidenceDir, 'attempts', review.cells[0].slotId, 'slot-meta.json');
  const original = fs.readFileSync(metaFile); fs.appendFileSync(metaFile, ' ');
  await assert.rejects(runSuite(f.suitePath, { cohort: 'context', split: 'confirmation_holdout', pilotReviewPath: reviewPath }, f.deps), /unchanged/);
  fs.writeFileSync(metaFile, original);
  const result = await runSuite(f.suitePath, { cohort: 'context', split: 'confirmation_holdout', pilotReviewPath: reviewPath }, f.deps);
  assert.equal(result.cells, 48); assert.equal(f.calls.length, 144);
});

test('duplicate sessions and foreign source/index state are rejected across model cells', async t => {
  for (const mutation of ['session', 'source', 'index']) {
    const f = fixture(t); await freezeSuite(f.suitePath, f.deps);
    f.deps.executeCampaign = async (file, _, slotId) => {
      f.calls.push(slotId); f.makeAttempt(file, slotId, mutation === 'session' ? { sessionId: 'shared-session' } : {});
      const manifest = read(file), dir = path.join(manifest.evidenceDir, 'attempts', slotId);
      if (mutation === 'source') { const file = path.join(dir, 'slot-meta.json'); put(file, { ...read(file), sourceRoot: f.root }); }
      if (mutation === 'index' && slotId.endsWith('codefacts022')) {
        const file = path.join(dir, 'bridge-config.json'), bridge = read(file); bridge.native.args[4] = f.root; put(file, bridge);
      }
    };
    await assert.rejects(runSuite(f.suitePath, { cohort: 'context', split: 'pilot' }, f.deps), /Duplicate session|namespace mismatch|Foreign native index/);
    assert.ok(f.calls.length <= 2);
  }
});
