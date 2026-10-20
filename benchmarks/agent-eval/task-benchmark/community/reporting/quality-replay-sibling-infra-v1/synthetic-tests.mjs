import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from '../public-results-infra-v1/synthetic-fixture.mjs';
import { RESOURCES } from '../public-results-infra-v1/common.mjs';
import { exportPackage } from './export.mjs';
import { sha, bytes, objectHash, prediction, report, verifyPackage } from './core.mjs';
import { compareCaptured, prepare, materializeAssets } from './replay.mjs';
import { GOLD_REPRESENTATION, SWE_REPRESENTATION, packageAssets } from './assets.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Source-faithful report boundary checks; this mode needs only Node and does not
// construct/export a fixture or invoke Python, images, upstream code or graders.
function checkReportContract() {
  const coverage = { file: 0.25, symbol: 0.5, span: 0.75, line: 1 };
  const context = { kind: 'context', instance_id: 'synthetic', officialResult: { instance_id: 'synthetic', num_steps: 2,
    final: Object.fromEntries(['file', 'symbol', 'span', 'line'].map(k => [k, { coverage: 0.5, precision: 0.25 }])),
    trajectory: { steps: [{ step: 1, coverage }, { step: 2, coverage: { ...coverage, line: 0.5 } }], auc_coverage: coverage, redundancy: coverage } },
    sourceIdentity: { privateRoot: 'C:/PRIVATE_FIXTURE/root' }, official: { config: { authorization: 'AUTH_CANARY' } } };
  const before = JSON.stringify(context), projected = report('context', context, 'synthetic');
  assert.deepEqual(projected.officialResult, context.officialResult);
  assert.equal(JSON.stringify(context), before); assert.equal(JSON.stringify(projected).includes('AUTH_CANARY'), false);
  assert.equal(JSON.stringify(projected).includes('PRIVATE_FIXTURE'), false);
  for (const mutate of [x => { x.officialResult.num_steps = 1; }, x => { x.officialResult.trajectory.steps = {}; },
    x => { x.officialResult.trajectory.steps[1].step = 1; }, x => { delete x.officialResult.trajectory.steps[0].coverage.line; },
    x => { x.officialResult.trajectory.steps[0].coverage.file = '0.25'; }, x => { x.officialResult.trajectory.steps[0].coverage.line = NaN; }]) {
    const bad = structuredClone(context); mutate(bad); assert.throws(() => report('context', bad, 'synthetic'), /Context official/);
  }
  const empty = structuredClone(context); empty.officialResult.num_steps = 0; empty.officialResult.trajectory.steps = [];
  assert.deepEqual(report('context', empty, 'synthetic').officialResult.trajectory.steps, []);
  const swe = { synthetic: { patch_is_None: false, patch_exists: true, patch_successfully_applied: true, resolved: false, infra_failure: false,
    tests_status: { FAIL_TO_PASS: { success: ['tests/test_source.py::test_api_key_literal_/home/source'], failure: ['tests/test_source.py::test_patch'] } } } };
  assert.deepEqual(report('swe', swe, 'synthetic'), swe);
  const trueFlag = structuredClone(swe); trueFlag.synthetic.patch_is_None = true;
  assert.equal(report('swe', trueFlag, 'synthetic').synthetic.patch_is_None, true);
  for (const value of [undefined, null, 0, 'false']) {
    const bad = structuredClone(swe); bad.synthetic.patch_is_None = value;
    assert.throws(() => report('swe', bad, 'synthetic'), /patch_is_None boolean/);
  }
  assert.notDeepEqual(report('swe', trueFlag, 'synthetic'), report('swe', swe, 'synthetic'));
  return { sourceShape: 'Context num_steps/ordered steps, SWE patch_is_None; input immutability and private-field exclusion', invalidCases: 10 };
}
const reportContract = checkReportContract();
if (process.argv.includes('--report-contract-only')) { console.log(JSON.stringify({ status: 'passed', ...reportContract })); process.exit(0); }
if (process.argv[2] === '--runtime-contract-only') {
  const [approvalPath, approvalSha256] = process.argv.slice(3);
  assert.ok(approvalPath && path.isAbsolute(approvalPath) && /^[a-f0-9]{64}$/.test(approvalSha256), 'Pass absolute ROOT approval and raw SHA');
  const read = ref => { const raw = fs.readFileSync(ref.path); assert.equal(sha(raw), ref.sha256); return raw; };
  const approval = JSON.parse(read({ path: approvalPath, sha256: approvalSha256 }));
  assert.equal(approval.status, 'root-approved'); assert.equal(approval.approvedBy, 'root'); assert.equal(approval.campaigns.length, 8);
  const input = JSON.parse(read(approval.publicAssets));
  const frozenPins = new Set(approval.campaigns.flatMap(c => JSON.parse(read(c.freeze)).pins.map(p => p.sha256)));
  const recipes = Object.fromEntries(Object.entries(input.runtimeRecipes).map(([cohort, ref]) => [cohort, JSON.parse(read(ref))]));
  assert.ok(Object.values(recipes).every(r => !frozenPins.has(r.requirementsSha256)), 'Actual eight freezes have zero reconstruction-requirement membership');
  const put = raw => ({ path: `artifacts/${sha(raw)}.json`, sha256: sha(raw) });
  const options = { read, put, frozenPins, selectionSha256: approval.inputs.selection.sha256 };
  assert.deepEqual(Object.keys(packageAssets(input, options).runtimeRecipes).sort(), ['context', 'swe']);
  function changedRecipe(mutate) {
    const changed = structuredClone(input), value = structuredClone(recipes.context); mutate(value);
    const raw = bytes(value), ref = { path: 'synthetic-runtime-recipe', sha256: sha(raw) }; changed.runtimeRecipes.context = ref;
    return () => packageAssets(changed, { ...options, read: r => r.path === ref.path ? (assert.equal(sha(raw), r.sha256), raw) : read(r) });
  }
  assert.throws(changedRecipe(r => { r.cohort = 'swe'; }), /Runtime recipe cohort differs/);
  assert.throws(changedRecipe(r => { r.requirements += 'changed==1.0\n'; }), /Runtime requirements source pin differs/);
  console.log(JSON.stringify({ status: 'passed', frozenCampaigns: 8, runtimeRequirementMembership: 0, rawRecipesPinned: 2,
    negativeCases: ['cohort mismatch', 'embedded requirements hash mismatch'], action: 'static asset lineage only; no export or runtime invocation' }));
  process.exit(0);
}
const PYTHON = process.env.QUALITY_BRIDGE_PYTHON, OFFICIAL = process.env.QUALITY_CONTEXT_OFFICIAL_ROOT, COMMUNITY = process.env.QUALITY_BRIDGE_COMMUNITY_SOURCE;
assert.ok(PYTHON && OFFICIAL && COMMUNITY, 'Set QUALITY_BRIDGE_PYTHON, QUALITY_CONTEXT_OFFICIAL_ROOT, QUALITY_BRIDGE_COMMUNITY_SOURCE; requires real PyArrow/frozen loader and source-only helper files');
const root = fs.mkdtempSync(path.join(HERE, 'synthetic-run-'));
const inputs = path.join(root, 'PRIVATE_FIXTURE'); fs.mkdirSync(inputs);
const write = (name, value, raw = false) => {
  const content = raw ? Buffer.from(value) : bytes(value), filename = path.join(inputs, name);
  fs.writeFileSync(filename, content); return { path: filename, sha256: sha(content) };
};
const producerPath = path.resolve(HERE, '../final-aggregate-generator-infra-v2/aggregate.mjs');
const producer = await import(pathToFileURL(producerPath).href), source = fixture(producer);
// Use the existing approved all-model-terminal fixture shape, keeping source
// production and full288 validation paths unchanged.
const recovered = source.summary.models[0].campaigns[0].attempts.find(r => r.status === 'infrastructure-failed');
Object.assign(recovered, { status: 'attempt-completed', gradeStatus: 'completed', usageAvailability: 'exact-provider-turn-usage', outcome: 'completed', receiptStatus: 'attempt-completed',
  providerCallSucceeded: true, generationCutoff: false, nativeAdopted: false, resolved: null, error: null,
  knownUsageLowerBound: { totalTokens: 0, inputTokens: 0, outputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  metrics: { localization: Object.fromEntries(['file', 'symbol', 'span', 'line'].map(level => [level, { coverage: 0, precision: 0 }])) } });
for (const key of RESOURCES) recovered[key] = 0;
const sweRows = source.summary.models[0].campaigns[1].attempts;
for (const [index, status] of [[8, 'timed-out'], [9, 'missing-report'], [10, 'invalid-report']]) Object.assign(sweRows[index], { gradeStatus: status, resolved: null });
const contextRows = source.summary.models[0].campaigns[0].attempts;
Object.assign(contextRows[15], { gradeStatus: 'missing-final-declaration', metrics: null });
const sourceFiles = ['official.py', 'grade.mjs', 'grade-campaign.mjs', 'trace.mjs'].map(role => {
  const filename = path.resolve(COMMUNITY, role);
  return { role, path: filename, sha256: sha(fs.readFileSync(filename)) };
});
const blob = write('acquisition-blob.json', { synthetic: true });
const canonical = (kind, ref) => ({ kind, repository: 'https://example.invalid/synthetic-only', revision: 'a'.repeat(40), path: `${kind}.blob`, sha256: ref.sha256 });
const helperFiles = ['official.py', 'export-fixed-selection.py', 'prepare-context-bases.py'].map(role => {
  const filename = path.resolve(COMMUNITY, role); return { role, path: filename, sha256: sha(fs.readFileSync(filename)) };
});
assert.equal(helperFiles[1].sha256, 'd1d8ee5136600d871d2e80cb86b938705f52a9e15ec7d7d9e03afac006270e89');
assert.equal(helperFiles[2].sha256, 'c0f5c170c4d3a466b75616092e6f5829d9b1ad63cd9216018734cbfe16ccda4c');
const fixtureSelection = write('pre-parquet-selection.json', source.selection), assetDir = path.join(inputs, 'tiny-assets');
const generated = spawnSync(PYTHON, ['-B', path.join(HERE, 'synthetic-assets.py'), '--selection', fixtureSelection.path, '--out', assetDir,
  '--official-root', OFFICIAL, '--adapter', helperFiles[0].path], { encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const tiny = JSON.parse(fs.readFileSync(path.join(assetDir, 'FIXTURE-ASSETS.json')));
assert.notEqual(tiny.gradingCommit, tiny.wrongGradingCommit);
const datasets = { context: { ref: tiny.context }, swe: { ref: tiny.sweCanonical } };
source.selection.datasets = ['context', 'swe'].map(cohort => ({ dataset: cohort, revision: 'a'.repeat(40), path: `${cohort}.parquet`, sha256: datasets[cohort].ref.sha256 }));
const summaryRef = write('summary.json', source.summary);
const acceptedReport = producer.buildReport(source.summary, { mode: 'full288', inputSha256: summaryRef.sha256 });
const approval = { schemaVersion: 1, kind: 'closed-full288-quality-replay-approval', status: 'root-approved', approvedBy: 'root', acceptedNumericManifestSha256: '9'.repeat(64),
  inputs: { summary: summaryRef, report: write('accepted-report.json', acceptedReport), selection: write('selection.json', source.selection),
    producer: { path: producerPath, sha256: sha(fs.readFileSync(producerPath)) } }, metadataAudits: [], campaigns: [], tasks: [], cells: [] };
const manifestBindings = [], manifestOriginals = [], environment = write('synthetic-environment.json', { scope: 'reduced-synthetic-PyArrow-runtime-only' });
for (const selected of source.selection.selections.filter(t => t.dataset === 'contextbench')) {
  const m = { schemaVersion: 1, dataset: 'contextbench', instanceId: selected.id, repo: selected.repo, baseCommit: selected.base_commit,
    archiveSha256: tiny.archive.sha256, entries: tiny.entries, digest: objectHash(tiny.entries) };
  const original = write(`${selected.id}-manifest.json`, { ...m, sourceRepresentation: { privateRoot: 'C:/PRIVATE_FIXTURE/auth', authorization: 'AUTH_CANARY' } });
  manifestOriginals.push(original); manifestBindings.push({ original, publicSha256: sha(bytes(m)), gradingCommit: tiny.gradingCommit, archive: { ...canonical('source', tiny.archive), revision: selected.base_commit } });
}
const runtimeRecipes = Object.fromEntries(['context', 'swe'].map(cohort => [cohort, write(`${cohort}-runtime-recipe.json`, { cohort, pythonVersion: tiny.pythonVersion,
  requirements: tiny.requirementsText, requirementsSha256: tiny.requirements.sha256, environmentPinsSha256: environment.sha256,
  upstream: { repository: 'https://example.invalid/synthetic-only', revision: 'a'.repeat(40) }, identity: 'version-pinned-reconstruction', packageArtifactHashes: 'not-recorded', historicalRootIdentity: 'unverified' })]));
const imageRows = source.selection.selections.filter(t => t.dataset === 'swebench_multilingual').map(t => ({ instanceId: t.id, officialTag: 'official/synthetic:fixed',
  indexDigest: `sha256:${'1'.repeat(64)}`, platformManifestDigest: `sha256:${'2'.repeat(64)}`, configDigest: `sha256:${'3'.repeat(64)}`, platform: 'linux/amd64', provenanceSha256: blob.sha256 }));
approval.publicAssets = write('public-assets.json', { schemaVersion: 1, kind: 'fixed24-public-acquisition-bridge', selection: approval.inputs.selection, helpers: helperFiles,
  runtimeRecipes, contextManifests: manifestBindings,
  datasets: { context: { canonical: { ...canonical('dataset', tiny.context), path: 'context.parquet' } }, swe: { canonical: { ...canonical('dataset', tiny.sweCanonical), path: 'swe.parquet' }, derivedSha256: tiny.sweGrader.sha256 } },
  imageAcquisitions: write('images.json', imageRows), attribution: write('attribution.json', { notices: [{ kind: 'SWE-bench-MIT', sourceSha256: blob.sha256, text: 'Synthetic attribution only; real source notices remain required.' }] }) });
for (const selected of source.selection.selections) {
  const cohort = selected.dataset === 'contextbench' ? 'context' : 'swe';
  const taskId = source.summary.models[0].campaigns.find(c => c.attempts[0].cohort === cohort).attempts.find(r => r.instanceId === selected.id).taskId;
  const manifest = manifestBindings.find(m => JSON.parse(fs.readFileSync(m.original.path)).instanceId === selected.id);
  approval.tasks.push({ cohort, taskId, acquisitions: [{ ...canonical('dataset', datasets[cohort].ref), path: `${cohort}.parquet` }, ...(cohort === 'context' ? [{ ...canonical('source', tiny.archive), revision: selected.base_commit }] : [])],
    datasetInput: { canonicalSha256: datasets[cohort].ref.sha256, canonicalFormat: 'parquet', graderSha256: cohort === 'context' ? tiny.context.sha256 : tiny.sweGrader.sha256,
      graderFormat: cohort === 'context' ? 'parquet' : 'jsonl', recordRepresentation: cohort === 'context' ? GOLD_REPRESENTATION : SWE_REPRESENTATION,
      recordSha256: cohort === 'context' ? tiny.contextRecordHashes[selected.id] : tiny.sweRecordHashes[selected.id] },
    baseline: { policy: cohort === 'context' ? 'archive-identical-synthetic-baseline' : 'official-prebuilt-image', upstreamBaseCommit: selected.base_commit,
      gradingCommit: cohort === 'context' ? tiny.gradingCommit : null,
      ...(cohort === 'context' ? { sourceManifestSha256: manifest.original.sha256, archiveSha256: tiny.archive.sha256 } : {}) },
    gradingOptions: { timeoutMs: 1800000, timeoutSeconds: 1800, maxWorkers: 1, openFileLimit: 4096, split: 'test' },
  });
}
const audit = { status: 'metadata-audit-passed-awaiting-root-review', errors: [], cells: [], inputHashes: {} };
let count = 0, rawReportCell = null, projectedReportCell = null;
const patch = "diff --git a/src/example.py b/src/example.py\n--- a/src/example.py\n+++ b/src/example.py\n@@ -1 +1 @@\n-before\n+api_key = 'source-literal'; root = '/home/example/literal'\n";
for (const model of source.summary.models) for (const campaign of model.campaigns) {
  const frozen = { schemaVersion: 1, campaignId: campaign.campaignId, manifest: { campaignId: campaign.campaignId, unrelatedConfig: { api_key: 'AUTH_CANARY', home: 'C:/PRIVATE_FIXTURE/session' } },
    pins: [...sourceFiles, ...helperFiles, ...manifestOriginals].map(({ path, sha256 }) => ({ path, sha256 })), schedule: campaign.attempts.map(r => ({ id: r.slotId, taskId: r.taskId, cohort: r.cohort, arm: r.arm })) };
  frozen.manifestHash = objectHash(frozen.manifest);
  approval.campaigns.push({ campaignId: campaign.campaignId, freeze: write(`${campaign.campaignId}-freeze.json`, frozen), sources: sourceFiles,
    upstream: [canonical('upstream-tree', blob)] });
  for (const row of campaign.attempts) {
    count++;
    const binding = { id: `${campaign.campaignId}/${row.slotId}` }, contextual = row.cohort === 'context';
    const pred = contextual ? { instance_id: row.instanceId, repo_url: '/home/PRIVATE_FIXTURE/private-baseline', commit: tiny.gradingCommit, model_patch: '',
      traj_data: { pred_steps: [{ files: ['src/example.py'], spans: { 'src/example.py': [{ start: 1, end: 3 }] } }], pred_files: ['src/example.py'], pred_spans: { 'src/example.py': [{ start: 2, end: 3 }] } } } :
      { instance_id: row.instanceId, model_name_or_path: `${campaign.campaignId}-${row.arm}`, model_patch: row.gradeStatus === 'missing-report' ? '' : patch };
    const diag = contextual ? { declarationStatus: row.gradeStatus.startsWith('invalid-final') || row.gradeStatus === 'missing-final-declaration' ? row.gradeStatus : 'valid',
      requests: 1, responses: 1, failedResponses: 0, locatorOnlyResponses: 0, declarationRationale: 'AUTH_CANARY',
      unmapped: [{ file: 'C:/PRIVATE_FIXTURE/session', text: 'AUTH_CANARY' }], calls: [{ headers: { authorization: 'AUTH_CANARY' } }], unmappedByReason: {} } : null;
    binding.prediction = write(`${count}-prediction.json`, [pred]);
    if (contextual) binding.diagnostics = write(`${count}-diagnostics.json`, diag);
    const grade = { status: row.gradeStatus, resolved: row.resolved, metrics: row.metrics,
      provenance: { freezeHash: objectHash(frozen), configHash: '4'.repeat(64), inputHash: objectHash({ prediction: pred, diagnostics: diag, modelAttemptStatus: row.status }) } };
    if (!['timed-out', 'missing-report', 'missing-final-declaration', 'invalid-final-json'].includes(row.gradeStatus)) {
      const rawReport = contextual ? { kind: 'context', instance_id: row.instanceId,
        officialResult: { instance_id: row.instanceId, num_steps: 1, final: row.metrics.localization, trajectory: { steps: [{ step: 1, coverage: { file: 0.5, symbol: 0.4, span: 0.3, line: 0.6 } }], auc_coverage: { file: 0.5, line: 0.6 }, redundancy: { file: 0.1, line: 0.2 } } },
        sourceIdentity: { privateClone: 'C:/PRIVATE_FIXTURE/baseline' }, official: { config: { authorization: 'AUTH_CANARY' } } } :
        { [row.instanceId]: { instance_id: row.instanceId, resolved: row.resolved ?? false, infra_failure: row.gradeStatus === 'failed', patch_successfully_applied: true, patch_is_None: false,
          tests_status: { FAIL_TO_PASS: { success: ['tests/test_x.py::test_patch'], failure: [] }, PASS_TO_PASS: { success: ['tests/test_x.py::test_old'], failure: [] } } } };
      if (!contextual && !projectedReportCell && row.gradeStatus === 'completed') {
        rawReport[row.instanceId].arbitrary_error = 'AUTH_CANARY C:/PRIVATE_FIXTURE/session'; projectedReportCell = binding.id;
      } else if (!contextual && !rawReportCell && row.gradeStatus === 'completed') rawReportCell = binding.id;
      binding.report = row.gradeStatus === 'invalid-report' ? write(`${count}-result.json`, '{invalid', true) : write(`${count}-result.json`, rawReport);
      grade.receipt = { resultSha256: binding.report.sha256, resultPath: binding.report.path };
    }
    const meta = { slot: frozen.schedule.find(s => s.id === row.slotId), freezeHash: objectHash(frozen),
      ...Object.fromEntries(['taskId', 'cohort', 'split', 'language', 'status'].map(k => [k, row[k]])), grade,
      providerReceipt: { headers: { authorization: 'AUTH_CANARY' }, privatePath: 'C:/PRIVATE_FIXTURE/session' } };
    binding.meta = write(`${count}-meta.json`, meta);
    audit.cells.push({ id: binding.id, metaPath: binding.meta.path }); audit.inputHashes[binding.meta.path] = binding.meta.sha256;
    approval.cells.push(binding);
  }
}
approval.metadataAudits.push(write('closed-audit.json', audit));
const approvalRef = write('root-approval.json', approval);
const options = { approvalPath: approvalRef.path, approvalSha256: approvalRef.sha256, output: path.join(root, 'package') };
const exported = await exportPackage(options), manifestPath = path.join(exported.output, 'manifest.json');
const data = JSON.parse(fs.readFileSync(path.join(exported.output, 'cells.json')));
assert.equal(data.cells.length, 288); assert.ok(exported.prerequisitesRequired > 250);
for (const status of ['completed', 'failed', 'timed-out', 'missing-report', 'invalid-report', 'invalid-final-json', 'missing-final-declaration']) assert.ok(data.cells.some(c => c.gradeStatus === status), status);
assert.ok(data.cells.some(c => c.status === 'task-failed' && c.gradeStatus === 'completed' && c.resolved === true));
assert.ok(data.cells.some(c => c.gradeStatus === 'failed' && c.resolved === null));
assert.ok(data.cells.every(c => c.datasetInput && c.runtimeRecipe && Array.isArray(c.provenanceGaps)));
const readArtifact = ref => fs.readFileSync(path.join(exported.output, ref.path), 'utf8');
const sweCell = data.cells.find(c => c.id === rawReportCell), projectedCell = data.cells.find(c => c.id === projectedReportCell);
assert.equal(sweCell.imageExecution, null); assert.ok(sweCell.provenanceGaps.includes('historical-cell-image-binding-unavailable')); assert.equal(sweCell.gaps.length, 0);
assert.equal(JSON.parse(readArtifact(sweCell.prediction))[0].model_patch, patch);
assert.ok(readArtifact(sweCell.rawReport).includes('tests/test_x.py::test_patch'));
assert.equal(sweCell.rawReport.sha256, sweCell.provenance.originalArtifactHashes.report);
assert.equal(projectedCell.rawReport, null); assert.ok(projectedCell.gaps.includes('raw-report-public-projection-required'));
const context = data.cells.find(c => c.cohort === 'context' && !c.gaps.length), pred = JSON.parse(readArtifact(context.prediction))[0];
assert.deepEqual(pred.traj_data.pred_spans, { 'src/example.py': [{ start: 2, end: 3 }] });
assert.equal(pred.traj_data.pred_steps[0].spans['src/example.py'][0].end, 3);
assert.notEqual(context.prediction.sha256, context.provenance.originalArtifactHashes.prediction);
for (const name of ['cells.json', ...Object.keys(JSON.parse(fs.readFileSync(manifestPath)).files).filter(n => n.startsWith('artifacts/') && n.endsWith('.json'))]) {
  const text = fs.readFileSync(path.join(exported.output, name), 'utf8'); assert.ok(!text.includes('AUTH_CANARY') && !text.includes('PRIVATE_FIXTURE'), `Canary in ${name}`);
}
let negativeCount = 0;
async function negative(label, mutate, pattern) {
  const a = structuredClone(approval); mutate(a); const ref = write(`negative-${++negativeCount}.json`, a);
  await assert.rejects(exportPackage({ approvalPath: ref.path, approvalSha256: ref.sha256, output: path.join(root, `rejected-${negativeCount}`) }), pattern, label);
}
await negative('missing membership', a => a.cells.pop(), /288/);
await negative('wrong prediction pin', a => { a.cells[0].prediction.sha256 = '0'.repeat(64); }, /SHA-256/);
await negative('missing prediction artifact', a => { a.cells[0].prediction.path += '.missing'; }, /ENOENT/);
await negative('report pin tamper', a => { a.cells.find(c => c.report).report.sha256 = '0'.repeat(64); }, /SHA-256/);
await negative('missing report pin', a => { delete a.cells.find(c => c.report).report.sha256; }, /explicit raw pin/);
await negative('frozen source pin tamper', a => { a.campaigns[0].sources[0].sha256 = '0'.repeat(64); }, /absent from freeze/);
await negative('audit metadata pin tamper', a => { a.cells[0].meta.sha256 = '0'.repeat(64); }, /closed audit/);
await negative('inputHash mismatch', a => { a.cells[0].prediction = a.cells[3].prediction; }, /inputHash/);
await negative('mandatory bridge omitted', a => { delete a.publicAssets; }, /explicit raw pin/);
await negative('historical helper omitted', a => { const b = JSON.parse(fs.readFileSync(a.publicAssets.path)); b.helpers.pop(); a.publicAssets = write('missing-bridge-helper.json', b); }, /Three exact preparation helpers/);
await negative('public manifest pin wrong', a => { const b = JSON.parse(fs.readFileSync(a.publicAssets.path)); b.contextManifests[0].publicSha256 = '0'.repeat(64); a.publicAssets = write('wrong-public-manifest.json', b); }, /Public scoring manifest/);
await negative('canonical pin confused with derived', a => { a.tasks.find(t => t.cohort === 'swe').datasetInput.canonicalSha256 = tiny.sweGrader.sha256; }, /Canonical dataset/);
assert.throws(() => prediction('context', { ...pred, traj_data: { ...pred.traj_data, pred_files: ['../escape.py'] } }, pred.instance_id), /Unsafe/);
assert.throws(() => prediction('swe', { instance_id: 'x', model_name_or_path: 'synthetic', model_patch: '--- /home/private.py\n' }, 'x'), /Unsafe/);
// A patch-body line which happens to resemble a path/header is scoring content.
assert.equal(prediction('swe', { instance_id: 'x', model_name_or_path: 'synthetic', model_patch: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+++ /home/source-literal\n' }, 'x').model_patch.endsWith('+++ /home/source-literal\n'), true);
assert.equal(compareCaptured({ manifestPath, manifestSha256: exported.packageSha256, cellId: context.id, observedGradeStatus: 'completed', resultPath: path.join(exported.output, context.expected.path) }).status, 'matched-captured-official-result');
const missing = data.cells.find(c => c.gradeStatus === 'missing-report');
assert.equal(compareCaptured({ manifestPath, manifestSha256: exported.packageSha256, cellId: missing.id, observedGradeStatus: 'missing-report' }).quality, null);
assert.throws(() => compareCaptured({ manifestPath, manifestSha256: exported.packageSha256, cellId: missing.id, observedGradeStatus: 'completed' }), /status differs/);
const changed = JSON.parse(readArtifact(context.expected)); changed.officialResult.final.line.coverage += 0.01;
const changedRef = write('changed-official.json', changed);
assert.throws(() => compareCaptured({ manifestPath, manifestSha256: exported.packageSha256, cellId: context.id, observedGradeStatus: 'completed', resultPath: changedRef.path }), /result differs/);
const changedStep = JSON.parse(readArtifact(context.expected)); changedStep.officialResult.trajectory.steps[0].coverage.line += 0.01;
const changedStepRef = write('changed-official-step.json', changedStep);
assert.throws(() => compareCaptured({ manifestPath, manifestSha256: exported.packageSha256, cellId: context.id, observedGradeStatus: 'completed', resultPath: changedStepRef.path }), /result differs/);
const relocated = path.join(root, 'relocated-bridge-package'); fs.cpSync(exported.output, relocated, { recursive: true });
const relocatedManifest = path.join(relocated, 'manifest.json'), layout = path.join(root, 'materialized-bridge');
materializeAssets({ manifestPath: relocatedManifest, manifestSha256: exported.packageSha256, output: layout });
assert.equal(fs.readFileSync(path.join(layout, 'helpers/export-fixed-selection.py')).compare(fs.readFileSync(helperFiles[1].path)), 0);
assert.equal(fs.readFileSync(path.join(layout, 'helpers/prepare-context-bases.py')).compare(fs.readFileSync(helperFiles[2].path)), 0);
assert.ok(JSON.parse(fs.readFileSync(path.join(layout, 'bridge-plan.json'))).tasks.every(t => t.datasetInput));
const mapping = { cohort: 'swe', assetLayout: layout, officialRoot: OFFICIAL, datasetPath: tiny.sweGrader.path, python: PYTHON,
  assets: { [blob.sha256]: blob.path, [tiny.sweCanonical.sha256]: tiny.sweCanonical.path, [tiny.context.sha256]: tiny.context.path, [tiny.archive.sha256]: tiny.archive.path } };
const mappingRef = write('mapping.json', mapping);
const prepared = prepare({ manifestPath: relocatedManifest, manifestSha256: exported.packageSha256, cellId: sweCell.id, mappingPath: mappingRef.path, output: path.join(root, 'prepared') });
assert.equal(prepared.status, 'prepared-not-executed'); assert.equal(prepared.historicalEnvironmentEquality, 'unverified');
assert.ok(prepared.provenanceGaps.includes('historical-cell-image-binding-unavailable'));
assert.deepEqual(sweCell.baseline, { policy: 'official-prebuilt-image', upstreamBaseCommit: sweCell.task.base_commit, gradingCommit: null });
assert.equal(sweCell.imageExecution, null);
const runner = fs.readFileSync(path.join(root, 'prepared/run.mjs'), 'utf8');
assert.ok(runner.indexOf('verify-image') < runner.indexOf('await runOfficialGrade('));
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'prepared/replay-image.json'))).platformManifestDigest, sweCell.imageAcquisition.platformManifestDigest);
assert.equal(sha(fs.readFileSync(path.join(root, 'prepared/official.py'))), sweCell.sources.find(s => s.role === 'official.py').sha256);
assert.equal(sha(fs.readFileSync(path.join(root, 'prepared/grade.mjs'))), sweCell.sources.find(s => s.role === 'grade.mjs').sha256);
// Execute the production runner's rejection branch in an isolated copy only.
// Node rejects Python's -B flag: this explicitly mocks an image-check failure.
// A test-only sentinel normalizer proves no official grading call is reached.
const rejectedRun = path.join(root, 'prepared-image-rejected'); fs.cpSync(path.join(root, 'prepared'), rejectedRun, { recursive: true });
const gateOptions = JSON.parse(fs.readFileSync(path.join(rejectedRun, 'run-options.json'))); gateOptions.python = process.execPath;
fs.writeFileSync(path.join(rejectedRun, 'run-options.json'), bytes(gateOptions));
const unexpectedGrade = path.join(rejectedRun, 'unexpected-official-call');
fs.writeFileSync(path.join(rejectedRun, 'grade.mjs'), `import fs from 'node:fs';\nexport async function runOfficialGrade(){fs.writeFileSync(${JSON.stringify(unexpectedGrade)},'unexpected');throw new Error('unexpected official grade call');}\n`);
const rejectedImageRun = spawnSync(process.execPath, [path.join(rejectedRun, 'run.mjs')], { encoding: 'utf8', windowsHide: true });
assert.notEqual(rejectedImageRun.status, 0); assert.match(rejectedImageRun.stderr, /Current fixed-image inspection rejected; official grader was not started/);
assert.equal(fs.existsSync(unexpectedGrade), false);
const injectedReceipt = write('synthetic-image-receipt.json', { status: 'verified-current-local-image', evidence: 'injected-client-inspection-not-Docker-proof',
  officialTag: sweCell.imageAcquisition.officialTag, platformManifestDigest: sweCell.imageAcquisition.platformManifestDigest,
  configDigest: sweCell.imageAcquisition.configDigest, localImageId: sweCell.imageAcquisition.configDigest,
  tagImageId: sweCell.imageAcquisition.configDigest, digestImageId: sweCell.imageAcquisition.configDigest, platform: 'linux/amd64' });
const compared = compareCaptured({ manifestPath: relocatedManifest, manifestSha256: exported.packageSha256, cellId: sweCell.id, observedGradeStatus: 'completed',
  resultPath: path.join(relocated, sweCell.expected.path), environmentReceiptPath: injectedReceipt.path });
assert.equal(compared.currentEnvironmentVerification, 'synthetic-client-inspection-only'); assert.equal(compared.historicalEnvironmentEquality, 'unverified');
assert.ok(compared.provenanceGaps.includes('historical-cell-image-binding-unavailable'));
const changedPatchFlag = JSON.parse(readArtifact(sweCell.expected)); changedPatchFlag[sweCell.instanceId].patch_is_None = !changedPatchFlag[sweCell.instanceId].patch_is_None;
const changedPatchFlagRef = write('changed-official-patch-is-none.json', changedPatchFlag);
assert.throws(() => compareCaptured({ manifestPath: relocatedManifest, manifestSha256: exported.packageSha256, cellId: sweCell.id, observedGradeStatus: 'completed',
  resultPath: changedPatchFlagRef.path, environmentReceiptPath: injectedReceipt.path }), /result differs/);
const wrongImageReceipt = write('wrong-image-receipt.json', { ...JSON.parse(fs.readFileSync(injectedReceipt.path)), configDigest: `sha256:${'0'.repeat(64)}` });
assert.throws(() => compareCaptured({ manifestPath: relocatedManifest, manifestSha256: exported.packageSha256, cellId: sweCell.id, observedGradeStatus: 'completed',
  resultPath: path.join(relocated, sweCell.expected.path), environmentReceiptPath: wrongImageReceipt.path }), /environment receipt differs/);
const contextMapping = { ...mapping, cohort: 'context', datasetPath: tiny.context.path, repoRoot: tiny.repoRoot, repoCache: path.join(root, 'fresh-cache') };
const contextMappingRef = write('context-mapping.json', contextMapping);
assert.equal(prepare({ manifestPath: relocatedManifest, manifestSha256: exported.packageSha256, cellId: context.id, mappingPath: contextMappingRef.path, output: path.join(root, 'prepared-context') }).status, 'prepared-not-executed');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'prepared-context/predictions.json')))[0].commit, tiny.gradingCommit);
let prepNegatives = 0;
function rejectedPreparation(label, map, pattern) {
  const ref = write(`rejected-prep-${++prepNegatives}.json`, map);
  assert.throws(() => prepare({ manifestPath: relocatedManifest, manifestSha256: exported.packageSha256, cellId: map.cohort === 'swe' ? sweCell.id : context.id, mappingPath: ref.path, output: path.join(root, `rejected-prep-output-${prepNegatives}`) }), pattern, label);
}
rejectedPreparation('wrong canonical raw bytes', { ...mapping, assets: { ...mapping.assets, [tiny.sweCanonical.sha256]: blob.path } }, /Acquired prerequisite/);
rejectedPreparation('wrong derived grader raw pin', { ...mapping, datasetPath: tiny.sweCanonical.path }, /verify-dataset/);
rejectedPreparation('wrong captured HEAD', { ...contextMapping, repoRoot: tiny.wrongRepoRoot }, /verify-base/);
for (const [filename, pattern] of [['helpers/export-fixed-selection.py', /helper checksum/], ['helpers/selection-fixed-24.json', /selection checksum/], [`sources/contextbench/${context.instanceId}/manifest.json`, /manifest checksum/]]) {
  const file = path.join(layout, filename), original = fs.readFileSync(file); fs.appendFileSync(file, ' ');
  rejectedPreparation(filename, contextMapping, pattern); fs.writeFileSync(file, original);
}
const badRecordApproval = structuredClone(approval); badRecordApproval.tasks.find(t => t.taskId === sweCell.taskId && t.cohort === 'swe').datasetInput.recordSha256 = '0'.repeat(64);
const badRecordRef = write('bad-record-approval.json', badRecordApproval);
const badRecordPackage = await exportPackage({ approvalPath: badRecordRef.path, approvalSha256: badRecordRef.sha256, output: path.join(root, 'bad-record-package') });
const badRecordLayout = path.join(root, 'bad-record-layout'); materializeAssets({ manifestPath: path.join(badRecordPackage.output, 'manifest.json'), manifestSha256: badRecordPackage.packageSha256, output: badRecordLayout });
const badRecordMapping = write('bad-record-mapping.json', { ...mapping, assetLayout: badRecordLayout });
assert.throws(() => prepare({ manifestPath: path.join(badRecordPackage.output, 'manifest.json'), manifestSha256: badRecordPackage.packageSha256, cellId: sweCell.id, mappingPath: badRecordMapping.path, output: path.join(root, 'bad-record-run') }), /verify-dataset/);
assert.throws(() => prepare({ manifestPath, manifestSha256: exported.packageSha256, cellId: projectedCell.id, mappingPath: mappingRef.path, output: path.join(root, 'not-prepared') }), /unavailable/);
// Signed pre-model infrastructure is an explicitly closed ungraded cell. Build
// its existing closure receipt/ledger contract, not an alternate closure policy.
const signedApproval = structuredClone(approval), signedSummary = structuredClone(source.summary);
const signedRow = signedSummary.models[0].campaigns[0].attempts.find(r => r.slotId === recovered.slotId);
Object.assign(signedRow, { status: 'infrastructure-failed', gradeStatus: 'pending', usageAvailability: 'unavailable', slotWallMs: 5, error: null, outcome: null, patchPath: null });
for (const k of [...RESOURCES.filter(k => k !== 'slotWallMs'), 'metrics', 'resolved', 'knownUsageLowerBound', 'nativeAdopted', 'providerCallSucceeded', 'generationCutoff', 'receiptStatus']) signedRow[k] = null;
const signedId = `a-context/${signedRow.slotId}`, signedBinding = signedApproval.cells.find(c => c.id === signedId);
const signedMeta = JSON.parse(fs.readFileSync(signedBinding.meta.path));
signedMeta.status = 'infrastructure-failed'; signedMeta.grade = { status: 'pending', resolved: null, metrics: null };
signedBinding.meta = write('signed-infra-meta.json', signedMeta);
delete signedBinding.prediction; delete signedBinding.diagnostics; delete signedBinding.report;
const costs = [2, 3, 5].map((slotWallMs, i) => ({ phase: `failed-phase-${i}`, metadataPath: i === 2 ? signedBinding.meta.path : `C:/PRIVATE_FIXTURE/archive-${i}/meta.json`,
  metadataSha256: i === 2 ? signedBinding.meta.sha256 : String(i + 1).repeat(64), slotWallMs }));
const ledger = { schemaVersion: 1, suiteId: source.summary.suiteId, status: 'root-approved', approvedBy: 'root', suiteFreezeSha256: 'f'.repeat(64), supplementSha256: 'e'.repeat(64),
  knownInfraCells: [{ id: signedId, metadataSha256: signedBinding.meta.sha256, canonicalMetadataPath: signedBinding.meta.path, reason: 'native-init-failed-before-model', noModelRequest: true,
    recoveryClosed: true, tokens: null, resolved: null, failureEvidence: [{ path: 'C:/PRIVATE_FIXTURE/log', sha256: 'a'.repeat(64) }], costRefs: costs }] };
const signedSummaryRef = write('signed-summary.json', signedSummary), ledgerBytes = bytes(ledger);
const closureReceipt = { schemaVersion: 1, kind: 'closed-summary-root-approval', status: 'root-approved', approvedBy: 'root', suiteId: source.summary.suiteId, mode: 'full288',
  inputSummarySha256: signedSummaryRef.sha256, approvedLedgerSha256: sha(ledgerBytes), suiteFreezeSha256: ledger.suiteFreezeSha256, supplementSha256: ledger.supplementSha256,
  metadataAuditSha256: approval.metadataAudits[0].sha256, selectedInfrastructure: [{ id: signedId, metadataSha256: signedBinding.meta.sha256 }] };
const closureBytes = bytes(closureReceipt);
signedApproval.inputs.summary = signedSummaryRef;
signedApproval.inputs.report = write('signed-report.json', producer.buildReport(signedSummary, { mode: 'full288', inputSha256: signedSummaryRef.sha256,
  closure: { closureBytes, ledgerBytes, expectedClosureSha256: sha(closureBytes), expectedLedgerSha256: sha(ledgerBytes) } }));
const signedApprovalRef = write('signed-approval.json', signedApproval);
const signedExport = await exportPackage({ approvalPath: signedApprovalRef.path, approvalSha256: signedApprovalRef.sha256, output: path.join(root, 'signed-package') });
const signedCell = JSON.parse(fs.readFileSync(path.join(signedExport.output, 'cells.json'))).cells.find(c => c.id === signedId);
assert.equal(signedCell.status, 'infrastructure-failed'); assert.equal(signedCell.gradeStatus, 'pending'); assert.equal(signedCell.resolved, null);
assert.equal(signedCell.prediction, null); assert.equal(signedCell.expected, null); assert.equal(signedCell.replayAvailability, 'unavailable');
const withheldApproval = structuredClone(approval), withheldBinding = withheldApproval.cells.find(c => c.id === rawReportCell);
withheldBinding.withheld = { reason: 'root-withheld-sensitive-scoring-content', reportSha256: withheldBinding.report.sha256 }; delete withheldBinding.report;
const withheldRef = write('withheld-approval.json', withheldApproval);
const withheld = await exportPackage({ approvalPath: withheldRef.path, approvalSha256: withheldRef.sha256, output: path.join(root, 'withheld-package') });
assert.equal(JSON.parse(fs.readFileSync(path.join(withheld.output, 'cells.json'))).cells.find(c => c.id === rawReportCell).provenance.originalArtifactHashes.report, sweCell.provenance.originalArtifactHashes.report);
const moved = path.join(root, 'relocated'); fs.cpSync(exported.output, moved, { recursive: true });
const offline = spawnSync(process.execPath, [path.join(moved, 'verify.mjs'), path.join(moved, 'manifest.json'), exported.packageSha256],
  { cwd: moved, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
assert.equal(offline.status, 0, offline.stderr); assert.equal(JSON.parse(offline.stdout).cells, 288);
const tamper = path.join(moved, sweCell.rawReport.path); fs.appendFileSync(tamper, ' ');
assert.throws(() => verifyPackage(path.join(moved, 'manifest.json'), exported.packageSha256), /pin mismatch/);
const result = { status: 'passed', scope: 'synthetic-only-no-models-no-grading-no-network-no-docker', root, negativeCount, cells: data.cells.length,
  gradeStatuses: Object.fromEntries([...new Set(data.cells.map(c => c.gradeStatus))].map(s => [s, data.cells.filter(c => c.gradeStatus === s).length])),
  manifestSha256: exported.packageSha256, prerequisitesRequired: exported.prerequisitesRequired, unavailable: exported.unavailable,
  signedInfrastructure: { cells: 288, ungraded: 1, manifestSha256: signedExport.packageSha256 }, withheldSensitiveReport: 'passed' };
result.bridge = { path: 'packageAssets/export/verifyPackage/materializeAssets/prepare', relocated: true, preparationNegatives: prepNegatives + 1,
  contextLoader: 'real frozen GoldLoader on 12 tiny synthetic Parquet rows', runtime: 'reduced actual interpreter/PyArrow version checks; not full historical runtime',
  imageGateRejectedBeforeOfficialCall: true,
  image: 'prepared pre-grader inspection rejection executes with explicit failing command; no official call; Docker mock tests separate', derivation: tiny.limitations[0], officialGradesRun: 0 };
fs.writeFileSync(path.join(root, 'VALIDATION.json'), bytes(result)); console.log(JSON.stringify(result, null, 2));
