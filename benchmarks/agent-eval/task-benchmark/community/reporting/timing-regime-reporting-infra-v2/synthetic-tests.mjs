// Only synthetic objects and helper source. No formal campaign IO.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as producer from '../final-aggregate-generator-infra-v2/aggregate.mjs';
import { fixture } from '../public-results-infra-v1/synthetic-fixture.mjs';
import { deriveCore, projectInputs } from '../public-results-infra-v1/export.mjs';
import { recompute, validateData } from '../public-results-infra-v1/statistics.mjs';
import { digest, jsonBytes } from '../public-results-infra-v1/common.mjs';
import { adapt, deriveTiming, omitTimes, verifyAdapted, TIMES, observedOverlap } from './adapter.mjs';
import { rollingFixture } from './rolling-fixture.mjs';
import { derive as deriveCold } from '../cold-disk-appendix-infra-v2/appendix.mjs';
import { assembleMap } from './provenance.mjs';
import { exportPackage } from './export.mjs';
import { verifyPackage } from './verify.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const run = path.join(ROOT, 'runs', `synthetic-${crypto.randomUUID()}`);
fs.mkdirSync(run, { recursive: true });
const source = fixture(producer), { data, expected } = projectInputs(source.report, source.summary, source.selection);
const producerPath = path.resolve(ROOT, '../final-aggregate-generator-infra-v2/aggregate.mjs');
const coreSource = deriveCore(fs.readFileSync(producerPath, 'utf8'));
const core = await import(`data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`);
const checks = []; let serial = 0;
function test(name, action) { action(); checks.push({ name, status: 'passed' }); }
function write(name, value, jsonl = false) { const file = path.join(run, name), bytes = jsonl ? Buffer.from(value.map(row => JSON.stringify(row)).join('\n') + '\n') : jsonBytes(value); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' }); return { path: file, sha256: digest(bytes) }; }
const closure = write('historical-context-closure.json', { suiteId: data.suiteId, status: 'root-approved' });
const inventory = { schemaVersion: 1, kind: 'closed-timing-source-inventory', suiteId: data.suiteId, status: 'root-approved', approvedBy: 'root', summarySha256: source.inputSha256,
  suiteFreezeSha256: 'f'.repeat(64), originSerialConditionId: 'serial-original', serialGroups: [{ conditionId: 'serial-original', cohort: 'context', split: null, closure }], executions: [] };
for (const split of ['pilot', 'confirmation_holdout']) {
  const selected = data.rows.filter(row => row.cohort === 'swe' && row.split === split);
  const prior = split === 'pilot' ? selected.slice(0, 46) : [];
  const cellId = row => `${row.campaignId}/${row.slotId}`, phaseIds = selected.map(cellId);
  const prefix = split === 'pilot' ? 'pilot' : 'confirmation', conditionId = `parallel-${prefix}`;
  const amendment = write(`${prefix}-amendment.json`, { schemaVersion: 2, status: 'root-approved', suiteFreezeSha256: inventory.suiteFreezeSha256, timingRegime: 'parallel-user-amended', selectedCellIds: phaseIds, serialOriginalCellIds: prior.map(cellId) });
  const decision = write(`${prefix}-decision.json`, { schemaVersion: 2, status: 'root-approved', suiteFreezeSha256: inventory.suiteFreezeSha256, artifacts: { controllerSha256: 'a'.repeat(64) }, amendmentSha256: amendment.sha256, maxConcurrency: 2, maxActivePerCampaign: 1, schedulingPolicy: 'frozen-order-distinct-campaign-waves', cohort: 'swe', split, selectedCellIds: phaseIds });
  const ownerObject = { schemaVersion: 2, controllerSha256: 'a'.repeat(64), nonce: `synthetic-${prefix}`, pid: 123, at: '2026-01-01T00:00:00.000Z', decisionSha256: decision.sha256 };
  const execution = { id: prefix, conditionId, decision, amendment,
    origin: write(`${prefix}-origin.json`, { schemaVersion: 1, amendmentSha256: amendment.sha256, priorTimingRegime: 'serial-original', newTimingRegime: 'parallel-user-amended', priorSelectedCellIds: prior.map(cellId) }),
    owner: write(`${prefix}-owner.json`, ownerObject),
    exit: write(`${prefix}-exit.json`, { schemaVersion: 2, pid: 123, cohort: 'swe', split, status: 'phase-accounted-closure-with-infrastructure', failure: null, allAdmittedChildrenClosedBeforeRelease: true, at: '2026-01-01T00:10:00.000Z' }), waves: [] };
  let pending = selected.slice(prior.length), number = 0;
  while (pending.length) {
    const wave = [], campaigns = new Set();
    for (const row of pending) if (!campaigns.has(row.campaignId) && wave.length < 2) { wave.push(row); campaigns.add(row.campaignId); }
    const waveId = `wave-${String(++number).padStart(3, '0')}`, ids = wave.map(cellId);
    const drain = write(`${prefix}-${waveId}-drain.json`, { schemaVersion: 2, waveId, at: '2026-01-01T00:09:00.000Z', plannedCellIds: ids, admittedCellIds: ids, admissionError: null, results: ids.map(cellId => ({ cellId, status: 'fulfilled', value: { exitCode: 0 } })) });
    const jobs = wave.map((row, index) => {
      const cell = cellId(row), frozenOrdinal = ++serial, name = `${prefix}-${waveId}-${index}`;
      return {
        reservation: write(`${name}-reservation.json`, { schemaVersion: 2, jobId: `${waveId}-slot-${String(index + 1).padStart(3, '0')}`, waveId, cellId: cell, waveCellIds: ids, frozenOrdinal, controllerNonce: ownerObject.nonce, controllerPid: ownerObject.pid, decisionSha256: decision.sha256 }),
        timing: write(`${name}-timing.json`, { schemaVersion: 1, cellId: cell, frozenOrdinal, timingRegime: 'parallel-user-amended', maxConcurrency: 2, maxActivePerCampaign: 1, waveId, waveCellIds: ids, amendmentSha256: amendment.sha256, startedAt: '2026-01-01T00:00:01.000Z' }),
        result: write(`${name}-result.json`, { schemaVersion: 2, cellId: cell, accepted: true, completedAt: '2026-01-01T00:08:00.000Z' }) };
    });
    execution.waves.push({ drain, jobs }); pending = pending.filter(row => !ids.includes(cellId(row)));
  }
  inventory.executions.push(execution);
}
const map = assembleMap(data, inventory), adapted = adapt(data, expected, map, recompute, core);
test('full288 closed shape preserves 287 model + one signed infrastructure', () => { assert.equal(verifyAdapted(adapted, validateData, recompute, core).status, 'passed'); assert.equal(adapted.nonTimingExpected.overallExecution.actualModelTerminal, 287); assert.equal(adapted.nonTimingExpected.overallExecution.signedInfrastructure, 1); });
test('historical Context144 and SWE pilot46 serial; confirmation48 parallel', () => { assert.equal(adapted.timing.rows.filter(row => row.cohort === 'context' && row.timingRegime === 'serial-original').length, 144); assert.equal(adapted.timing.rows.filter(row => row.cohort === 'swe' && row.split === 'pilot' && row.timingRegime === 'serial-original').length, 46); assert.equal(adapted.timing.rows.filter(row => row.cohort === 'swe' && row.split === 'confirmation_holdout' && row.timingRegime === 'parallel-user-amended').length, 48); });
test('every raw time including null and failed wall is retained exactly', () => { for (const row of data.rows) assert.deepStrictEqual(adapted.timing.rows.find(r => r.cellId === `${row.campaignId}/${row.slotId}`).clocks, Object.fromEntries(TIMES.map(metric => [metric, row[metric]]))); });
test('all non-time accepted quality/tokens/cache/lower-bound/allocation/cost values unchanged', () => assert.deepStrictEqual(omitTimes(adapted.nonTimingExpected), omitTimes(expected)));
test('cross transition ordinary serial CF/CG parallel keeps raw clocks, null ratios', () => { const crossing = adapted.timing.pairs.filter(pair => !pair.sameTimingCondition); assert(crossing.length >= 2); for (const pair of crossing) for (const clock of Object.values(pair.clocks)) { assert.equal(clock.ratio, null); assert.equal(clock.reason, 'cross-timing-condition'); assert.notEqual(clock.ordinary, null); assert.notEqual(clock.treatment, null); } });
test('matched time ratio exact and no legacy nonnull time ratio survives', () => { const matched = adapted.timing.pairs.find(pair => pair.exclusion === null && pair.clocks.modelTurnMs.reason === null); assert.equal(matched.clocks.modelTurnMs.ratio, matched.clocks.modelTurnMs.treatment / matched.clocks.modelTurnMs.ordinary); assert(adapted.nonTimingData.rows.every(row => TIMES.every(metric => row[metric] === null))); for (const panel of adapted.nonTimingExpected.equalModelMacro) for (const pair of panel.paired) for (const metric of TIMES) assert.equal(pair.resourceRatios[metric].mean, null); });
test('single tails remain separate from admitted two-cell waves', () => { const sizes = new Set(adapted.timing.rows.filter(row => row.timingRegime === 'parallel-user-amended').map(row => row.admittedConcurrency)); assert(sizes.has(1) && sizes.has(2)); });
test('failure costs retain canonical overlap and exclude infrastructure time ratios', () => { assert.deepStrictEqual(adapted.timing.infrastructureCosts, data.infrastructure); const pair = adapted.timing.pairs.find(pair => pair.exclusion === 'signed-infrastructure-before-model'); assert(pair); assert(Object.values(pair.clocks).every(clock => clock.ratio === null)); });
test('missing paired clock withholds whole same-condition stratum ratio', () => { const changed = structuredClone(data), pair = adapted.timing.pairs.find(pair => pair.exclusion === null && pair.sameTimingCondition); const row = changed.rows.find(row => `${row.campaignId}/${row.slotId}` === pair.treatmentCellId); row.modelTurnMs = null; const result = deriveTiming(changed, map); const group = result.groups.find(group => group.modelId === pair.modelId && group.cohort === pair.cohort && group.split === pair.split && group.comparisonKey === pair.ordinaryComparisonKey); assert.equal(group.paired.find(p => p.arm === pair.arm).clocks.modelTurnMs.ratio, null); });
test('zero baseline yields explicit unknown ratio', () => { const changed = structuredClone(data), pair = adapted.timing.pairs.find(pair => pair.exclusion === null); changed.rows.find(row => `${row.campaignId}/${row.slotId}` === pair.ordinaryCellId).modelTurnMs = 0; const result = deriveTiming(changed, map).pairs.find(p => p.ordinaryCellId === pair.ordinaryCellId && p.arm === pair.arm); assert.equal(result.clocks.modelTurnMs.ratio, null); assert.equal(result.clocks.modelTurnMs.reason, 'zero-baseline'); });
test('missing/duplicate/regime-relabel map refuses', () => { for (const mutate of [m => m.cells.pop(), m => m.cells.push(m.cells[0]), m => m.cells.find(c => c.timingReceiptSha256 !== null).conditionId = 'serial-original']) { const changed = structuredClone(map); mutate(changed); assert.throws(() => deriveTiming(data, changed)); } });
test('receipt mismatch refuses', () => { const bad = structuredClone(inventory); bad.executions[0].waves[0].jobs[0].timing.sha256 = '0'.repeat(64); assert.throws(() => assembleMap(data, bad), /SHA-256/); });
test('all-serial relabel refuses frozen46 and confirmation policy', () => { const bad = structuredClone(map); bad.cells = bad.cells.map(cell => ({ ...cell, conditionId: 'serial-original', waveId: null, admittedWaveCellIds: null, timingReceiptSha256: null })); assert.throws(() => deriveTiming(data, bad), /exactly46/); });
test('confirmation serial relabel refuses', () => { const bad = structuredClone(map), selected = new Set(data.rows.filter(row => row.split === 'confirmation_holdout' && row.cohort === 'swe').map(row => `${row.campaignId}/${row.slotId}`)); bad.cells = bad.cells.map(cell => selected.has(cell.cellId) ? { ...cell, conditionId: 'serial-original', waveId: null, admittedWaveCellIds: null, timingReceiptSha256: null } : cell); assert.throws(() => deriveTiming(data, bad), /confirmation/); });
test('foreign controller exit rejects', () => { const bad = structuredClone(inventory), receipt = JSON.parse(fs.readFileSync(bad.executions[0].exit.path)); receipt.pid = 999; bad.executions[0].exit = write('wrong-owner-exit.json', receipt); assert.throws(() => assembleMap(data, bad), /ownership/); });
test('job beyond controller closed interval rejects', () => { const bad = structuredClone(inventory), receipt = JSON.parse(fs.readFileSync(bad.executions[0].waves[0].jobs[0].result.path)); receipt.completedAt = '2026-01-02T00:00:00.000Z'; bad.executions[0].waves[0].jobs[0].result = write('outside-interval-result.json', receipt); assert.throws(() => assembleMap(data, bad), /outside/); });
test('SWE signed infra with absent controller timing provenance rejects explicitly', () => { const changed = structuredClone(data); changed.infrastructure.push({ id: `${data.rows.find(row => row.cohort === 'swe').campaignId}/${data.rows.find(row => row.cohort === 'swe').slotId}` }); assert.throws(() => assembleMap(changed, inventory), /Unsupported SWE signed-infrastructure/); });
test('omitted admitted job refuses', () => { const bad = structuredClone(inventory); bad.executions[0].waves[0].jobs.pop(); assert.throws(() => assembleMap(data, bad)); });
test('omitted full-confirmation execution refuses complete mapping', () => { const bad = structuredClone(inventory); bad.executions.pop(); assert.throws(() => assembleMap(data, bad), /One explicit timing entry/); });
test('timing numeric tampering refuses arithmetic reproduction', () => { const bad = structuredClone(adapted); bad.timing.pairs.find(pair => pair.clocks.modelTurnMs.ratio !== null).clocks.modelTurnMs.ratio += 1; assert.throws(() => verifyAdapted(bad, validateData, recompute, core)); });
test('quality/token tampering refuses arithmetic reproduction', () => { const bad = structuredClone(adapted); bad.nonTimingExpected.models[0].panels[0].primary.arms.ordinary.resources.totalTokens.knownTotal += 1; assert.throws(() => verifyAdapted(bad, validateData, recompute, core)); });
const inventoryRef = write('closed-inventory.json', inventory), args = { producer: producerPath, 'producer-sha256': digest(fs.readFileSync(producerPath)), 'timing-inventory': inventoryRef.path, 'timing-inventory-sha256': inventoryRef.sha256, output: path.join(run, 'public') };
for (const [name, value] of Object.entries({ report: source.report, summary: source.summary, selection: source.selection })) { const ref = write(`${name}.json`, value); args[name] = ref.path; args[`${name}-sha256`] = ref.sha256; }
const exported = await exportPackage(args);
const receipt = await verifyPackage(path.join(exported.output, 'manifest.json'), exported.manifestSha256);
assert.equal(receipt.status, 'passed'); checks.push({ name: 'portable public export and manifest verification', status: 'passed' });
const standalone = spawnSync(process.execPath, [path.join(exported.output, 'verify.mjs'), '--manifest', path.join(exported.output, 'manifest.json'), '--sha256', exported.manifestSha256], { encoding: 'utf8', cwd: exported.output });
assert.equal(standalone.status, 0, standalone.stderr); checks.push({ name: 'standalone subprocess offline verifier with bundle-only imports', status: 'passed' });
await assert.rejects(exportPackage(args), /EEXIST/); checks.push({ name: 'exclusive package overwrite refusal', status: 'passed' });
const second = await exportPackage({ ...args, output: path.join(run, 'public-repeat') });
assert.equal(second.manifestSha256, exported.manifestSha256); checks.push({ name: 'identical explicit inputs produce deterministic manifest/report/render', status: 'passed' });
const markdown = fs.readFileSync(path.join(exported.output, 'PRIMARY.zh-CN.md'), 'utf8');
assert(markdown.includes('跨条件') && markdown.includes('serial-original') && markdown.includes('parallel-pilot') && !markdown.includes('共享主机串行 elapsed'));
checks.push({ name: 'Chinese raw timing and regime labels visible, serial-only claim absent', status: 'passed' });
const publicText = fs.readFileSync(path.join(exported.output, 'adapted.json'), 'utf8'); assert(!publicText.includes('PRIVATE_FIXTURE') && !publicText.includes(run.replaceAll('\\', '\\\\')));
checks.push({ name: 'public result contains no synthetic private receipt paths', status: 'passed' });
for (const [name, mutate] of [['unsupported-claim', m => m.claim = 'causally-proven-speedup'], ['unsupported-producer', m => m.sources.producer = '0'.repeat(64)], ['missing-source', m => delete m.sources['timing-inventory']]]) {
  const output = path.join(run, name); fs.cpSync(exported.output, output, { recursive: true });
  const filename = path.join(output, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(filename)); mutate(manifest); const bytes = jsonBytes(manifest); fs.writeFileSync(filename, bytes);
  await assert.rejects(verifyPackage(filename, digest(bytes))); checks.push({ name: `portable ${name} refuses despite freshly matching manifest hash`, status: 'passed' });
}
const rollingInventory = rollingFixture(data, inventory, write, ref => JSON.parse(fs.readFileSync(ref.path)));
const rollingMap = assembleMap(data, rollingInventory), rollingAdapted = adapt(data, expected, rollingMap, recompute, core);
const rollingExecution = rollingInventory.executions.at(-1);
test('mixed fake288 original serial46, old pilot waves, fresh rolling48 complete', () => {
  assert.equal(verifyAdapted(rollingAdapted, validateData, recompute, core).status, 'passed');
  assert.equal(rollingAdapted.timing.rows.filter(row => row.timingRegime === 'parallel-rolling-user-amended').length, 48);
  assert.equal(rollingAdapted.timing.rows.filter(row => row.cohort === 'swe' && row.split === 'pilot' && row.timingRegime === 'parallel-user-amended').length, 50);
  assert.deepStrictEqual(omitTimes(rollingAdapted.nonTimingExpected), omitTimes(expected));
});
test('old historical wave rows/pairs unchanged in mixed fixture', () => {
  const prior = value => value.filter(row => row.cohort !== 'swe' || row.split !== 'confirmation_holdout');
  assert.deepStrictEqual(prior(rollingAdapted.timing.rows), prior(adapted.timing.rows));
  assert.deepStrictEqual(prior(rollingAdapted.timing.pairs), prior(adapted.timing.pairs));
});
test('rolling actual overlap peak2 differs from sequential peer count; singleton tails peak1', () => {
  const rolling = rollingAdapted.timing.rows.filter(row => row.timingRegime === 'parallel-rolling-user-amended');
  const long = rolling.find(row => row.jobId === 'job-0001'); assert(long.overlapPeerCellIds.length > 2); assert.equal(long.actualOverlapConcurrency, 2);
  const tail = rolling.filter(row => row.actualOverlapConcurrency === 1); assert(tail.length > 0); assert(tail.every(row => row.configuredMaxConcurrency === 2 && row.concurrencyBasis === 'actual-owned-worker-overlap-peak'));
});
test('positive interval overlap excludes touching endpoints', () => {
  const result = observedOverlap([{ cellId: 'a', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z' }, { cellId: 'b', startedAt: '2026-01-01T00:00:01Z', completedAt: '2026-01-01T00:00:02Z' }]);
  assert.equal(result.get('a').actualOverlapConcurrency, 1); assert.deepStrictEqual(result.get('b').overlapPeerCellIds, []);
});
test('activeAtAdmission preserved separately from actual overlap', () => {
  const row = rollingAdapted.timing.rows.find(row => row.jobId === 'job-0001'); assert.deepStrictEqual(row.activeAtAdmission, []); assert.equal(row.actualOverlapConcurrency, 2);
});
test('rolling cross-overlap pairs retain raw clocks and null ratios', () => {
  const pairs = rollingAdapted.timing.pairs.filter(pair => pair.cohort === 'swe' && pair.split === 'confirmation_holdout' && !pair.sameTimingCondition); assert(pairs.length > 0);
  assert(pairs.every(pair => pair.clocks.modelTurnMs.ratio === null && pair.clocks.modelTurnMs.reason === 'cross-timing-condition' && pair.clocks.modelTurnMs.ordinary !== null));
});
test('rolling unpaired arms stay visible without filling timing denominator', () => {
  const singleton = rollingAdapted.timing.groups.find(group => group.timingRegime === 'parallel-rolling-user-amended' && group.actualOverlapConcurrency === 1); assert(singleton);
  for (const pair of singleton.paired) for (const clock of Object.values(pair.clocks)) if (clock.plannedSameConditionPairs === 0) assert.equal(clock.ratio, null);
});
test('controller makespan owner-to-exit independent of summed overlapping clocks', () => {
  const interval = rollingAdapted.timing.executionIntervals.find(interval => interval.id === rollingExecution.id);
  const owner = JSON.parse(fs.readFileSync(rollingExecution.owner.path)), exit = JSON.parse(fs.readFileSync(rollingExecution.exit.path));
  assert.equal(interval.elapsedMs, Date.parse(exit.at) - Date.parse(owner.at));
  assert.notEqual(interval.elapsedMs, rollingAdapted.timing.rows.filter(row => row.executionId === rollingExecution.id).reduce((sum, row) => sum + Date.parse(row.workerClosedAt) - Date.parse(row.workerStartedAt), 0));
});
let mutation = 0;
function changedReceipt(select, change, jsonl = false) {
  const bad = structuredClone(rollingInventory), parent = select(bad.executions.at(-1));
  const value = jsonl ? fs.readFileSync(parent.ref.path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : JSON.parse(fs.readFileSync(parent.ref.path)); change(value);
  parent.set(write(`negative-${++mutation}.json`, value, jsonl)); return bad;
}
const executionRef = name => execution => ({ ref: execution[name], set: ref => execution[name] = ref });
const jobRef = name => execution => ({ ref: execution.jobs[0][name], set: ref => execution.jobs[0][name] = ref });
for (const [name, select, mutate] of [
  ['midpilot/provenance', executionRef('decision'), value => value.split = 'pilot'],
  ['resume/provenance', executionRef('decision'), value => value.freshPhaseOnly = false],
  ['foreign owner', executionRef('owner'), value => value.nonce = 'foreign'],
  ['failed/unclosed exit', executionRef('exit'), value => value.allAdmittedChildrenClosedBeforeRelease = false],
  ['final phase omission', executionRef('verifyEnd'), value => value.exactlyAddedSelectedCellIds.pop()],
  ['initial phase nonfresh', executionRef('initialBoundary'), value => value.selected.unvisited = 47],
  ['admission ordering', jobRef('admission'), value => value.issuanceOrdinal += 1],
  ['reservation ownership', jobRef('reservation'), value => value.controllerPid = 999],
  ['worker start ownership', jobRef('start'), value => value.controllerPid = 999],
  ['worker close failure', jobRef('exit'), value => value.code = 1],
  ['worker lifecycle PID mismatch', jobRef('exit'), value => value.pid += 1],
  ['result before closure binding', jobRef('result'), value => value.accepted = false],
  ['accepted wrong result', jobRef('accepted'), value => value.resultSha256 = '0'.repeat(64)],
  ['artifact approval mismatch', executionRef('decision'), value => value.artifacts[0].sha256 = '0'.repeat(64)],
  ['disk capacity binding', executionRef('capacity'), value => value.dMinimumBytes = 20 * 1024 ** 3],
  ['origin inherited relabel', executionRef('origin'), value => value.priorEvidencePolicy = 'serial-original']
]) test(`rolling ${name} rejects at receipt boundary`, () => assert.throws(() => assembleMap(data, changedReceipt(select, mutate))));
test('rolling omitted/duplicate jobs reject', () => { for (const action of [e => e.jobs.pop(), e => e.jobs[0] = e.jobs[1]]) { const bad = structuredClone(rollingInventory); action(bad.executions.at(-1)); assert.throws(() => assembleMap(data, bad)); } });
test('rolling journal reorder and accepted-before-close reject', () => { for (const action of [j => [j[0], j[1]] = [j[1], j[0]], j => j.find(event => event.event === 'worker-closed').event = 'result-accepted']) assert.throws(() => assembleMap(data, changedReceipt(executionRef('receiptJournal'), action, true))); });
test('rolling actual peak3 and campaign overlap reject in public boundary', () => {
  const bad = structuredClone(rollingMap), rolling = bad.cells.filter(cell => cell.executionId === rollingExecution.id);
  for (const cell of rolling.slice(0, 3)) { cell.workerStartedAt = '2026-02-01T00:00:00.001Z'; cell.workerClosedAt = '2026-02-01T00:00:00.005Z'; }
  assert.throws(() => deriveTiming(data, bad), /capacity|campaign/);
});
test('rolling and wave condition identity cannot merge or relabel serial', () => {
  for (const conditionId of ['parallel-pilot', 'serial-original']) { const bad = structuredClone(rollingMap); bad.cells.find(cell => cell.executionId === rollingExecution.id).conditionId = conditionId; assert.throws(() => deriveTiming(data, bad)); }
});
test('cold appendix schema1 adapter compatibility preserves totals and overlap strata', () => {
  const old = deriveCold(adapted), result = deriveCold(rollingAdapted); assert.deepStrictEqual(result.retainedBuckets, old.retainedBuckets);
  assert(result.panels.some(panel => panel.conditionId === rollingExecution.conditionId && panel.admittedConcurrency === 1));
  assert(result.panels.some(panel => panel.conditionId === rollingExecution.conditionId && panel.admittedConcurrency === 2));
});
const mixedRef = write('mixed-closed-inventory.json', rollingInventory);
const mixed = await exportPackage({ ...args, 'timing-inventory': mixedRef.path, 'timing-inventory-sha256': mixedRef.sha256, output: path.join(run, 'mixed-public') });
const relocated = path.join(run, 'relocated-offline'); fs.cpSync(mixed.output, relocated, { recursive: true });
const mixedStandalone = spawnSync(process.execPath, [path.join(relocated, 'verify.mjs'), '--manifest', path.join(relocated, 'manifest.json'), '--sha256', mixed.manifestSha256], { encoding: 'utf8', cwd: relocated, env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' } });
assert.equal(mixedStandalone.status, 0, mixedStandalone.stderr); checks.push({ name: 'mixed fake288 independent relocated offline verifier public9files plus manifest', status: 'passed' });
assert.equal(fs.readdirSync(relocated).length, 10);
const mixedPublic = fs.readFileSync(path.join(mixed.output, 'adapted.json'), 'utf8'); assert(!mixedPublic.includes(run.replaceAll('\\', '\\\\'))); checks.push({ name: 'mixed public contains no private receipt paths', status: 'passed' });
const sourceNames = ['adapter.mjs', 'provenance.mjs', 'rolling-provenance.mjs', 'rolling-fixture.mjs', 'export.mjs', 'verify.mjs', 'formatter.mjs', 'synthetic-tests.mjs', 'METHODS.md', 'README.md'];
const validation = { schemaVersion: 1, kind: 'synthetic-only-timing-regime-validation', at: new Date().toISOString(), node: process.version, run, status: 'passed', checks,
  hashes: Object.fromEntries(sourceNames.map(name => [name, digest(fs.readFileSync(path.join(ROOT, name)))])), publicManifestSha256: exported.manifestSha256, mixedPublicManifestSha256: mixed.manifestSha256,
  actualIntegration: 'pending; no formal campaign/model payload was read or executed' };
fs.writeFileSync(path.join(run, 'VALIDATION.json'), jsonBytes(validation), { flag: 'wx' }); console.log(JSON.stringify({ run, status: validation.status, passed: checks.length, manifestSha256: exported.manifestSha256 }, null, 2));
