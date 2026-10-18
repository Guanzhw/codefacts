import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { audit, acceptedGrade, verifyLedger, verifyInfraCell, ADMITTED_ID, writeArtifact } from './audit.mjs';
import { acceptedGrade as strictAcceptedGrade } from './test-reference-policy.mjs';
import { audit as previousAudit, acceptedGrade as previousGrade, verifyLedger as previousLedger, verifyInfraCell as previousInfra } from './test-reference-v2.mjs';
const sha = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output-dir' || !path.isAbsolute(args[1])) throw new Error('Require --output-dir ABS_TEST_OUTPUT');
const outputDir = args[1];
const root = path.join(outputDir, 'virtual-suite'), files = new Map(), headers = new Map(), dirs = new Set();
const put = (p, value) => { const b = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); files.set(p, b); return sha(b); };
const readFile = p => { if (!files.has(p)) throw new Error('Synthetic ENOENT: ' + p); return files.get(p); };
const exists = p => files.has(p) || dirs.has(p);
const models = ['deepseek', 'qwen', 'gpt', 'claude'].map(id => ({ id, family: id, model: { provider: 'fixture-provider', id: id + '-model', reasoningEffort: 'high' } }));
const arms = ['ordinary', 'codefacts022', 'codegraph'], campaigns = [], freezes = new Map(), manifests = new Map(), config = { fixtureGradingConfig: true }, schedule = [];
for (const cohort of ['context', 'swe']) for (const model of models) {
  const campaignId = `${model.id}-${cohort}`, evidenceDir = path.join(root, campaignId), manifestPath = path.join(evidenceDir, 'manifest.json'), gradingConfigPath = path.join(evidenceDir, 'grading.json');
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: cohort === 'context' && i === 11 ? 'ctx-mui__material-ui-34229' : `${cohort}-task-${i}`, instanceId: `fixture-${cohort}-${i}`, cohort, split: i < 8 ? 'pilot' : 'confirmation_holdout', repo: 'fixture/repo', baseCommit: 'a'.repeat(40), manifestFile: path.join(root, 'sources', `${cohort}-${i}.json`) }));
  const manifest = { campaignId, evidenceDir, model: model.model, arms: arms.map(id => ({ id })), tasks };
  const slots = tasks.flatMap((t, i) => arms.map((arm, a) => ({ ordinal: i * 3 + a + 1, id: `${t.id}-${arm}`, taskId: t.id, cohort, arm, position: a + 1 })));
  const freeze = { manifest, schedule: slots, pins: [{ path: gradingConfigPath, sha256: put(gradingConfigPath, config) }], sources: tasks.map(t => ({ taskId: t.id, digest: 'fixture-source-digest' })) };
  campaigns.push({ campaignId, modelId: model.id, cohort, manifestPath, gradingConfigPath }); manifests.set(campaignId, manifest); freezes.set(campaignId, freeze);
  put(manifestPath, manifest); put(path.join(evidenceDir, 'freeze.json'), freeze);
  for (const slot of slots) schedule.push({ id: `${campaignId}/${slot.id}`, campaignId, modelId: model.id, family: model.family, cohort, split: tasks.find(t => t.id === slot.taskId).split, taskId: slot.taskId, arm: slot.arm, slotId: slot.id });
}
// Match current known boundary: special infrastructure cell is canonical ordinal142.
const special = schedule.splice(schedule.findIndex(c => c.id === ADMITTED_ID), 1)[0]; schedule.splice(141, 0, special); schedule.forEach((c, i) => c.ordinal = i + 1);
const suite = { schemaVersion: 1, suiteId: 'fixture-fixed288', models, campaigns }, frozen = { suiteId: suite.suiteId, suite, schedule };
put(path.join(root, 'suite.json'), suite); const suiteFreezeSha256 = put(path.join(root, 'evidence/suite-freeze.json'), frozen);
function metaPath(cell) { return path.join(manifests.get(cell.campaignId).evidenceDir, 'attempts', cell.slotId, 'slot-meta.json'); }
function makeModel(cell) {
  const manifest = manifests.get(cell.campaignId), freeze = freezes.get(cell.campaignId), task = manifest.tasks.find(t => t.id === cell.taskId), dir = path.dirname(metaPath(cell)), dsh = path.join(dir, 'dsh'), source = path.join(dir, 'source'), outputDir = path.join(dir, 'grade-run-0001');
  const diagnostics = { declarationStatus: 'missing-final-declaration' }, prediction = { instance_id: task.instanceId, model_patch: '' }, predictionsPath = path.join(outputDir, 'predictions.json');
  const grade = { status: 'missing-final-declaration', resolved: null, metrics: null, missingFinalDeclaration: true, outputDir, predictionsPath, provenance: { freezeHash: sha(freeze), configHash: sha(config), inputHash: sha({ prediction, diagnostics, modelAttemptStatus: 'attempt-completed' }) } };
  const meta = { status: 'attempt-completed', slot: freeze.schedule.find(s => s.id === cell.slotId), taskId: cell.taskId, cohort: cell.cohort, split: cell.split, freezeHash: sha(freeze), receiptPath: path.join(dsh, 'receipt.json'), grade, sourceRoot: source, bridgeEvidenceDir: path.join(dir, 'inner-bridge'), sourceHash: 'fixture-source-digest', setup: { sourceIdentity: { repo: task.repo, baseCommit: task.baseCommit, instanceId: task.instanceId, manifestFile: task.manifestFile, sourceHash: 'fixture-source-digest' } }, audit: { infrastructureValid: true, infrastructureReasons: [], nativeCalls: 0, outcome: 'completed' } };
  put(metaPath(cell), meta); put(predictionsPath, [prediction]); put(path.join(outputDir, 'grade.json'), grade); put(path.join(outputDir, 'trace-diagnostics.json'), diagnostics);
  const initialization = { cwd: source, provider: manifest.model.provider, model: manifest.model.id, reasoningEffort: 'high' }, sessionId = 'fixture-' + cell.id;
  put(path.join(dsh, 'request.json'), { sessionId, initialization, environment: { DSH_HOME: path.join(dsh, 'home') } });
  const receipt = { sessionId, initialization, status: 'attempt-completed', timedOut: false, protocolError: null, processExit: { code: 0 } };
  put(meta.receiptPath, receipt); headers.set(meta.receiptPath, Buffer.from(JSON.stringify(receipt).slice(0, -1) + ',\n  "actualRequestHeaders": []}'));
  const bridge = { root: source, evidenceDir: meta.bridgeEvidenceDir, arm: cell.arm };
  if (cell.arm !== 'ordinary') bridge.native = { cwd: source, args: cell.arm === 'codefacts022' ? ['--root', source, '--state', path.join(dir, 'state.sqlite')] : ['--path', source] };
  put(path.join(dir, 'bridge-config.json'), bridge);
  put(path.join(dsh, 'catalogs.json'), [['source_list', 'source_read', 'source_search', ...(cell.arm === 'codefacts022' ? ['codefacts_explore', 'codefacts_expand', 'codefacts_impact'] : cell.arm === 'codegraph' ? ['codegraph_explore'] : [])].map(n => ({ name: 'mcp__repo__' + n }))]);
  return meta;
}
for (const cell of schedule.filter(c => c.cohort === 'context')) makeModel(cell);
const specialPath = metaPath(special), specialModelBytes = readFile(specialPath), dir = path.dirname(specialPath), specialDsh = path.join(dir, 'dsh');
const specialFiles = [...files].filter(([p]) => p.startsWith(specialDsh + path.sep) || p.startsWith(path.join(dir, 'grade-run-0001') + path.sep));
for (const [p] of specialFiles) files.delete(p);
const infraMeta = { status: 'infrastructure-failed', slot: freezes.get(special.campaignId).schedule.find(s => s.id === special.slotId), taskId: special.taskId, cohort: special.cohort, split: special.split, freezeHash: sha(freezes.get(special.campaignId)), receiptPath: path.join(specialDsh, 'receipt.json'), grade: { status: 'pending', resolved: null, metrics: null }, slotWallMs: 140 };
const metadataSha256 = put(specialPath, infraMeta), supplementPath = path.join(root, 'supplement.md'), supplementSha256 = put(supplementPath, 'fixture-only ROOT decision');
const failurePath = path.join(root, 'failure.txt'), failureHash = put(failurePath, 'fixture prepare failure');
const costs = [120, 130].map((slotWallMs, i) => { const metadataPath = path.join(root, `retry-${i}/slot-meta.json`); return { phase: `prep-${i + 1}`, metadataPath, metadataSha256: put(metadataPath, { slotWallMs }), slotWallMs }; });
costs.push({ phase: 'canonical', metadataPath: specialPath, metadataSha256, slotWallMs: 140 });
const ledger = { schemaVersion: 1, suiteId: suite.suiteId, suiteFreezeSha256, status: 'root-approved', approvedBy: 'root', supplementPath, supplementSha256,
  knownInfraCells: [{ id: ADMITTED_ID, canonicalMetadataPath: specialPath, metadataSha256, reason: 'fixture prepare exhausted', noModelRequest: true, recoveryClosed: true, resolved: null, tokens: null, failureEvidence: [{ path: failurePath, sha256: failureHash }], costRefs: costs }] };
const ledgerPath = path.join(root, 'ledger.json'); let ledgerSha256 = put(ledgerPath, ledger);
const options = { cohort: 'context', split: 'confirmation_holdout', suiteRoot: root, readFile, exists, readReceiptHeader: p => headers.get(p) };
const run = (withLedger = true) => audit({ ...options, ...(withLedger ? { ledgerPath, ledgerSha256 } : {}) });
const tests = [], test = (name, fn) => { fn(); tests.push({ name, status: 'passed' }); };
const refused = result => assert.ok(['refused-incomplete-or-invalid-selection', 'failed'].includes(result.status), JSON.stringify(result.errors));
test('strict acceptedGrade implementation unchanged', () => assert.equal(acceptedGrade.toString(), strictAcceptedGrade.toString()));
test('strict default refuses infrastructure cell', () => refused(run(false)));
let positive;
test('signed single infrastructure positive closed48', () => { positive = run(); assert.deepEqual(positive.errors, []); assert.equal(positive.accounting.accounted, 48); assert.equal(positive.accounting.actualModelTerminal, 47); assert.equal(positive.accounting.infrastructureMissing, 1); assert.equal(positive.totals.explicitMissing, 47); });
test('strict model path still passes with synthetic original model evidence', () => { files.set(specialPath, specialModelBytes); for (const [p, b] of specialFiles) files.set(p, b); const result = run(false); assert.deepEqual(result.errors, []); for (const [p] of specialFiles) files.delete(p); put(specialPath, infraMeta); });
test('changed canonical meta rejected', () => { put(specialPath, { ...infraMeta, slotWallMs: 141 }); refused(run()); put(specialPath, infraMeta); });
test('forged raw ledger hash rejected', () => { const digest = ledgerSha256; ledgerSha256 = '0'.repeat(64); refused(run()); ledgerSha256 = digest; });
test('pending ROOT approval rejected even with matching digest', () => { ledgerSha256 = put(ledgerPath, { ...ledger, status: 'pending-root-review', approvedBy: null }); refused(run()); ledgerSha256 = put(ledgerPath, ledger); });
test('unbound suite freeze rejected', () => { ledgerSha256 = put(ledgerPath, { ...ledger, suiteFreezeSha256: '0'.repeat(64) }); refused(run()); ledgerSha256 = put(ledgerPath, ledger); });
test('extra unrecorded infrastructure rejected', () => { const other = schedule.find(c => c.split === 'confirmation_holdout' && c.id !== ADMITTED_ID && c.cohort === 'context'), p = metaPath(other), bytes = readFile(p); put(p, { ...JSON.parse(bytes), status: 'infrastructure-failed' }); refused(run()); files.set(p, bytes); });
test('DSH directory present rejected', () => { dirs.add(specialDsh); refused(run()); dirs.delete(specialDsh); });
test('DSH request present rejected', () => { const p = path.join(specialDsh, 'request.json'); put(p, {}); refused(run()); files.delete(p); });
test('grade invention rejected even with rebound ledger metadata hash', () => {
  const changed = { ...infraMeta, grade: { status: 'completed', resolved: false, metrics: null } }, hash = put(specialPath, changed), rebound = structuredClone(ledger);
  rebound.knownInfraCells[0].metadataSha256 = hash; rebound.knownInfraCells[0].costRefs[2].metadataSha256 = hash;
  ledgerSha256 = put(ledgerPath, rebound); refused(run()); put(specialPath, infraMeta); ledgerSha256 = put(ledgerPath, ledger);
});
test('current-boundary synthetic unfinished288 still refuses closure', () => {
  // Root-provided current boundary represented synthetically; no live metadata reads.
  const saved = new Map(); for (const cell of schedule.filter(c => c.ordinal > 142)) { const p = metaPath(cell); if (files.has(p)) saved.set(p, files.get(p)); files.delete(p); }
  const result = audit({ ...options, cohort: 'all', split: 'all', ledgerPath, ledgerSha256 });
  refused(result); assert.equal(result.accounting.planned, 288); assert.equal(result.accounting.accounted, 142); assert.equal(result.accounting.actualModelTerminal, 141); assert.equal(result.accounting.infrastructureMissing, 1); assert.equal(result.accounting.remainingPlanned, 146);
  for (const [p, bytes] of saved) files.set(p, bytes);
});
test('v2 grade and infrastructure exception functions unchanged', () => {
  assert.equal(acceptedGrade.toString(), previousGrade.toString());
  assert.equal(verifyLedger.toString(), previousLedger.toString());
  assert.equal(verifyInfraCell.toString(), previousInfra.toString());
});

function setHeader(p, receipt) {
  put(p, receipt);
  headers.set(p, Buffer.from(JSON.stringify(receipt).slice(0, -1) + ',\n  "actualRequestHeaders": []}'));
}
function makeSwe(cell) {
  const meta = makeModel(cell), dir = path.dirname(metaPath(cell)), dsh = path.join(dir, 'dsh');
  meta.bridgeEvidenceDir = path.join(dir, 'bridge');
  meta.sandboxCleanup = { removed: { code: 0 }, verification: { code: 0, stdout: '' }, absent: true };
  const prediction = { instance_id: manifests.get(cell.campaignId).tasks.find(t => t.id === cell.taskId).instanceId, model_patch: 'fixture retained patch' };
  const resultPath = path.join(meta.grade.outputDir, 'result.json'), resultSha256 = put(resultPath, { fixtureOfficial: true, resolved: false });
  meta.grade = { status: 'completed', resolved: false, metrics: { fixtureOfficial: true }, emptyModelPatch: false,
    outputDir: meta.grade.outputDir, predictionsPath: meta.grade.predictionsPath,
    receipt: { processExit: { code: 0 }, timedOut: false, processError: null, resultPath, resultSha256 },
    cleanup: { status: 'completed', absent: true, operations: [{ code: 0, timedOut: false }] },
    provenance: { freezeHash: sha(freezes.get(cell.campaignId)), configHash: sha(config), inputHash: sha({ prediction, diagnostics: null, modelAttemptStatus: meta.status }) } };
  put(metaPath(cell), meta); put(meta.grade.predictionsPath, [prediction]); put(path.join(meta.grade.outputDir, 'grade.json'), meta.grade);
  put(path.join(meta.grade.outputDir, 'grader-receipt.json'), { receipt: meta.grade.receipt, metrics: meta.grade.metrics, resolved: meta.grade.resolved, status: meta.grade.status });
  put(path.join(meta.grade.outputDir, 'official-container-cleanup.json'), meta.grade.cleanup); put(path.join(dir, 'sandbox-cleanup.json'), meta.sandboxCleanup);
  put(path.join(dsh, 'catalogs.json'), [['source_list', 'source_read', 'source_search', 'source_edit', 'source_delete', 'source_exec', 'source_poll', ...(cell.arm === 'codefacts022' ? ['codefacts_explore', 'codefacts_expand', 'codefacts_impact'] : cell.arm === 'codegraph' ? ['codegraph_explore'] : [])].map(n => ({ name: 'mcp__repo__' + n }))]);
}
for (const cell of schedule.filter(c => c.cohort === 'swe')) makeSwe(cell);
const sweOptions = { ...options, cohort: 'swe', split: 'pilot' }, sweRun = () => audit(sweOptions);
let swePositive;
test('full synthetic SWE pilot96 includes ordinary and both native arms', () => {
  swePositive = sweRun(); assert.deepEqual(swePositive.errors, []); assert.equal(swePositive.totals.officialCompleted, 96);
  assert.equal(swePositive.status, 'metadata-audit-passed-awaiting-root-review');
});
test('v2 rejects frozen SWE bridge shape independently of timeout', () => {
  const result = previousAudit(sweOptions); refused(result);
  assert.equal(result.errors.length, 192);
  assert.ok(result.errors.every(e => e.endsWith(': owned namespaces') || e.endsWith(': fixed bridge and DSH namespaces')));
});
function withFailure(cell, patch, callback) {
  const originalFiles = new Map(files), originalHeaders = new Map(headers);
  try {
    const meta = JSON.parse(readFile(metaPath(cell))), receipt = JSON.parse(readFile(meta.receiptPath));
    meta.status = patch.metaStatus ?? 'task-failed'; meta.audit.outcome = patch.receipt?.timedOut === false ? 'provider-or-task-failed' : 'timed-out';
    Object.assign(receipt, { status: 'attempt-failed', timedOut: true, providerCallSucceeded: false, didInitialize: true, didPrompt: true, turnEnd: null }, patch.receipt);
    if (patch.mutateMeta) patch.mutateMeta(meta);
    const prediction = JSON.parse(readFile(meta.grade.predictionsPath))[0];
    const diagnostics = cell.cohort === 'context' ? JSON.parse(readFile(path.join(meta.grade.outputDir, 'trace-diagnostics.json'))) : null;
    meta.grade.provenance.inputHash = sha({ prediction, diagnostics, modelAttemptStatus: meta.status });
    put(metaPath(cell), meta); put(path.join(meta.grade.outputDir, 'grade.json'), meta.grade); setHeader(meta.receiptPath, receipt);
    callback(meta, receipt);
  } finally { files.clear(); for (const [p,b] of originalFiles) files.set(p,b); headers.clear(); for (const [p,b] of originalHeaders) headers.set(p,b); }
}
for (const arm of arms) test(`SWE ${arm} outer timeout retained with official grade`, () => {
  const cell = schedule.find(c => c.cohort === 'swe' && c.split === 'pilot' && c.arm === arm);
  withFailure(cell, {}, (meta) => {
    const result = sweRun(); assert.deepEqual(result.errors, []); assert.equal(result.totals.officialCompleted, 96);
    const row = result.cells.find(c => c.id === cell.id);
    assert.equal(row.status, 'task-failed'); assert.equal(row.gradeStatus, 'completed'); assert.equal(row.outcome, 'timed-out');
    assert.deepEqual(row.receiptExecution, { receiptStatus: 'attempt-failed', timedOut: true, outerModelTimeout: true, category: 'outer-model-timeout', providerCallSucceeded: false });
    assert.equal(meta.grade.resolved, false); assert.deepEqual(meta.grade.metrics, { fixtureOfficial: true });
  });
});
const sweCell = schedule.find(c => c.cohort === 'swe' && c.split === 'pilot' && c.arm === 'ordinary');
for (const [name, patch, expected] of [
  ['completed metadata with timeout', { metaStatus: 'attempt-completed' }, 'receipt session and status'],
  ['completed receipt with timeout', { receipt: { status: 'attempt-completed' } }, 'receipt session and status'],
  ['completed metadata and receipt with timeout', { metaStatus: 'attempt-completed', receipt: { status: 'attempt-completed' } }, 'DSH transport'],
  ['protocol failure on timeout', { receipt: { protocolError: 'synthetic protocol failure' } }, 'DSH transport'],
  ['nonzero process on timeout', { receipt: { processExit: { code: 1 } } }, 'DSH transport'],
  ['null process on timeout', { receipt: { processExit: { code: null, signal: 'SIGTERM' } } }, 'DSH transport'],
  ['nonboolean timeout', { receipt: { timedOut: 1 } }, 'DSH transport'],
  ['foreign session on timeout', { receipt: { sessionId: 'foreign' } }, 'receipt session and status'],
  ['SWE metadata wrong inner bridge namespace', { mutateMeta: meta => { meta.bridgeEvidenceDir = path.join(path.dirname(metaPath(sweCell)), 'inner-bridge'); } }, 'owned namespaces'],
]) test(name + ' rejected', () => withFailure(sweCell, patch, () => {
  const result = sweRun(); refused(result); assert.ok(result.errors.includes(`${sweCell.id}: ${expected}`));
}));
test('SWE wrong inner config evidence directory rejected', () => {
  const p = path.join(path.dirname(metaPath(sweCell)), 'bridge-config.json'), bytes = readFile(p), bridge = JSON.parse(bytes);
  put(p, { ...bridge, evidenceDir: path.join(path.dirname(metaPath(sweCell)), 'bridge') });
  const result = sweRun(); refused(result); assert.ok(result.errors.includes(`${sweCell.id}: fixed bridge and DSH namespaces`)); files.set(p, bytes);
});
test('original-compatible non-timeout retained failure still passes', () => withFailure(sweCell, { receipt: { timedOut: false } }, () => {
  const result = sweRun(); assert.deepEqual(result.errors, []);
  assert.equal(result.cells.find(c => c.id === sweCell.id).receiptExecution.category, 'retained-model-failure');
}));
const contextCell = schedule.find(c => c.cohort === 'context' && c.split === 'confirmation_holdout' && c.id !== ADMITTED_ID);
test('Context timeout passes v3 and is rejected by v2 solely on timeout predicate', () => withFailure(contextCell, {}, () => {
  const result = run(); assert.deepEqual(result.errors, []);
  const prior = previousAudit({ ...options, ledgerPath, ledgerSha256 });
  assert.deepEqual(prior.errors, [`${contextCell.id}: DSH transport`]);
}));
test('Context original-compatible task-failed without timeout passes both versions', () => withFailure(contextCell, { receipt: { timedOut: false } }, () => {
  assert.deepEqual(run().errors, []);
  assert.deepEqual(previousAudit({ ...options, ledgerPath, ledgerSha256 }).errors, []);
}));
test('Context bridge remains inner namespace', () => {
  const p = metaPath(contextCell), bytes = readFile(p), meta = JSON.parse(bytes);
  meta.bridgeEvidenceDir = path.join(path.dirname(p), 'bridge'); put(p, meta);
  const result = run(); refused(result); assert.ok(result.errors.includes(`${contextCell.id}: owned namespaces`)); files.set(p, bytes);
});
const artifact = writeArtifact(outputDir, 'offline-fixture-results', { status: 'passed', tests, positive, swePositive, scope: 'All suite/cell/ledger/evidence inputs are in-memory synthetic. Only owned output files written. No formal corpus reads or runtime execution.' });
console.log(JSON.stringify({ status: 'passed', tests: tests.length, artifact }));
