import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRolling, selectNext } from './scheduler.mjs';
import { startWorker } from './worker-process.mjs';
import { assertPolicy, assertCapacity, assertAdmission, assertNamespaces, assertAllocatedInventory, assertPins, assertClosedLifecycle, sha, read } from './receipts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), FIXTURES = path.join(HERE, 'synthetic-fixtures');
fs.mkdirSync(FIXTURES, { recursive: true });
const stub = `import fs from 'node:fs'; import path from 'node:path';
const [dir, code] = process.argv.slice(2);
fs.mkdirSync(path.join(dir, 'home')); fs.mkdirSync(path.join(dir, 'source')); fs.writeFileSync(path.join(dir, 'index.stub'), dir);
fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ accepted: true, pid: process.pid }));
fs.writeFileSync(path.join(dir, 'ready'), String(process.pid));
const timer = setInterval(() => { if (fs.existsSync(path.join(dir, 'allow-close'))) {
 clearInterval(timer); fs.writeFileSync(path.join(dir, 'cleanup-completed'), 'yes'); process.exitCode = Number(code);
} }, 5);
setTimeout(() => { clearInterval(timer); process.exitCode = 9; }, 8000).unref();`;
function fixture() {
  const out = fs.mkdtempSync(path.join(FIXTURES, 'case-')), script = path.join(out, 'stub.mjs'); fs.writeFileSync(script, stub);
  const dir = id => { const value = path.join(out, id); fs.mkdirSync(value); return value; };
  return { out, script, dir };
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const release = dir => fs.writeFileSync(path.join(dir, 'allow-close'), 'yes');
const ready = dir => fs.existsSync(path.join(dir, 'ready'));
const cell = (id, campaignId = id, ordinal = 1) => ({ id, campaignId, ordinal });

test('real children: fast close replenishes immediately while slow peer lives; campaign excludes overlap; early result never frees slot', async () => {
  const f = fixture(), cells = [cell('a1', 'a', 1), cell('a2', 'a', 2), cell('b1', 'b', 3), cell('c1', 'c', 4)], dirs = new Map(cells.map(row => [row.id, f.dir(row.id)]));
  const seen = [], lock = path.join(f.out, 'host.lock'); fs.writeFileSync(lock, 'synthetic-parent'); let returned = false;
  const running = runRolling(cells, {
    start: job => { seen.push(job.cell.id); return startWorker({ node: process.execPath, script: f.script, args: [dirs.get(job.cell.id), '0'], out: f.out, label: job.jobId }); },
    closed: (job, result) => { assert.equal(result.status, 'fulfilled'); assert.equal(result.value.pid, read(path.join(f.out, job.jobId + '-start.json')).pid); assert.equal(fs.existsSync(path.join(dirs.get(job.cell.id), 'cleanup-completed')), true); assert.equal(fs.existsSync(lock), true); }
  }).then(result => { returned = true; fs.unlinkSync(lock); return result; });
  await until(() => ready(dirs.get('a1')) && ready(dirs.get('b1')), 'first two ready');
  assert.deepEqual(seen, ['a1', 'b1']);
  assert.equal(fs.existsSync(path.join(dirs.get('a1'), 'result.json')), true);
  await new Promise(resolve => setTimeout(resolve, 70)); assert.deepEqual(seen, ['a1', 'b1']);
  release(dirs.get('a1'));
  await until(() => ready(dirs.get('a2')), 'same campaign replenished after own close');
  assert.equal(fs.existsSync(path.join(dirs.get('b1'), 'cleanup-completed')), false); assert.equal(returned, false);
  release(dirs.get('a2')); await until(() => ready(dirs.get('c1')), 'third campaign admission while peer alive');
  release(dirs.get('b1')); release(dirs.get('c1'));
  const result = await running; assert.equal(result.failed, false); assert.equal(result.accepted.length, 4); assert.equal(fs.existsSync(lock), false);
  const intervals = result.admitted.map(job => ({ campaign: job.cell.campaignId, ...read(path.join(f.out, job.jobId + '-exit.json')) }));
  assert.ok(Date.parse(intervals[1].startedAt) < Date.parse(intervals[0].finishedAt));
  const a2 = intervals[2]; assert.ok(Date.parse(a2.startedAt) >= Date.parse(intervals[0].finishedAt));
  for (const interval of intervals) assert.ok(interval.code === 0 && interval.signal === null);
});

for (const boundary of ['admission', 'close-validation', 'stop', 'stop-validation', 'stopped-bookkeeping', 'allclosed-bookkeeping']) {
  test('real child drain retains lock across ' + boundary + ' failure/stop', async () => {
    const f = fixture(), a = f.dir('a'), b = f.dir('b'), dirs = { a, b }, seen = [], events = [], lock = path.join(f.out, 'host.lock');
    fs.writeFileSync(lock, 'parent'); let stop = false, returned = false;
    const running = runRolling([cell('a'), cell('b'), cell('c')], {
      shouldStop: () => { if (stop && boundary === 'stop-validation') throw new Error('bad stop binding'); return stop; },
      start: job => { seen.push(job.cell.id); if (job.cell.id === 'c') throw new Error('admission source/capacity pin failure'); return startWorker({ node: process.execPath, script: f.script, args: [dirs[job.cell.id], '0'], out: f.out, label: job.jobId }); },
      closed: (job, outcome) => { events.push('closed:' + job.cell.id); assert.equal(fs.existsSync(lock), true); assert.equal(outcome.status, 'fulfilled'); if (job.cell.id === 'a' && boundary === 'close-validation') throw new Error('result pin mismatch'); },
      stopped: () => { if (boundary === 'stopped-bookkeeping') throw new Error('journal unavailable'); },
      allClosed: () => { events.push('allclosed'); if (boundary === 'allclosed-bookkeeping') throw new Error('final audit unavailable'); }
    }).then(result => { returned = true; fs.unlinkSync(lock); return result; });
    await until(() => ready(a) && ready(b), 'two active children');
    if (['stop', 'stop-validation', 'stopped-bookkeeping'].includes(boundary)) stop = true;
    release(a); await until(() => events.includes('closed:a'), 'first child closed');
    await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(returned, false); assert.equal(fs.existsSync(lock), true);
    release(b); const result = await running;
    assert.deepEqual(events, ['closed:a', 'closed:b', 'allclosed']); assert.equal(fs.existsSync(lock), false);
    assert.equal(result.failed, boundary !== 'stop');
    if (!['admission', 'allclosed-bookkeeping'].includes(boundary)) assert.deepEqual(seen, ['a', 'b']);
  });
}

test('real child bookkeeping failure and spawn failure drain active peer without replacement', async () => {
  for (const mode of ['bookkeeping', 'spawn', 'exit-bookkeeping', 'worker-exit']) {
    const f = fixture(), a = f.dir('a'), b = f.dir('b'), seen = []; let returned = false;
    if (mode === 'bookkeeping') fs.writeFileSync(path.join(f.out, 'job-0002-start.json'), 'collision');
    if (mode === 'exit-bookkeeping') fs.writeFileSync(path.join(f.out, 'job-0002-exit.json'), 'collision');
    const running = runRolling([cell('a'), cell('b'), cell('c')], {
      start: job => { seen.push(job.cell.id); return startWorker({ node: job.cell.id === 'b' && mode === 'spawn' ? path.join(f.out, 'missing-node') : process.execPath,
        script: f.script, args: [job.cell.id === 'a' ? a : b, mode === 'worker-exit' && job.cell.id === 'b' ? '3' : '0'], out: f.out, label: job.jobId }); },
      closed: () => {}
    }).then(result => { returned = true; return result; });
    await until(() => ready(a), 'peer alive');
    if (mode !== 'spawn') { await until(() => ready(b), 'failing worker alive'); release(b); }
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(returned, false); assert.deepEqual(seen, ['a', 'b']);
    release(a); const result = await running; assert.equal(result.failed, true); assert.equal(result.admitted.length, 2); assert.equal(fs.existsSync(path.join(a, 'cleanup-completed')), true);
  }
});

test('simultaneous settlements still select earliest frozen eligible and cap campaigns/max2', async () => {
  const cells = [cell('a1', 'a'), cell('a2', 'a'), cell('b1', 'b'), cell('b2', 'b'), cell('c1', 'c')], active = new Set(), seen = [];
  const result = await runRolling(cells, { start: job => { assert.ok(active.size < 2); assert.equal(active.has(job.cell.campaignId), false); active.add(job.cell.campaignId); seen.push(job.cell.id); return Promise.resolve(job.cell.id); },
    closed: job => { active.delete(job.cell.campaignId); } });
  assert.equal(result.failed, false); assert.deepEqual(seen, ['a1', 'b1', 'a2', 'b2', 'c1']);
  assert.equal(selectNext(cells, [], [{ cellId: 'b1', campaignId: 'b' }, { cellId: 'c1', campaignId: 'c' }]), null);
});
test('simultaneous success and peer failure never launch a replacement before consuming the failed close', async () => {
  for (const mode of ['worker-rejection', 'result-validation']) {
    const seen = [], closed = [];
    const result = await runRolling([cell('a'), cell('b'), cell('c')], {
      start: job => { seen.push(job.cell.id); return mode === 'worker-rejection' && job.cell.id === 'b' ? Promise.reject(new Error('peer failure')) : Promise.resolve(job.cell.id); },
      closed: job => { closed.push(job.cell.id); if (mode === 'result-validation' && job.cell.id === 'b') throw new Error('peer result invalid'); }
    });
    assert.deepEqual(seen, ['a', 'b']); assert.deepEqual(closed, ['a', 'b']); assert.equal(result.failed, true); assert.equal(result.admitted.length, 2);
  }
});

function policyFixture() {
  const selected = Array.from({ length: 48 }, (_, index) => cell('cell' + index, 'campaign' + index % 4, index));
  const decision = { schemaVersion: 3, cohort: 'swe', split: 'confirmation_holdout', maxConcurrency: 2, maxActivePerCampaign: 1,
    schedulingPolicy: 'frozen-order-distinct-campaign-rolling', timingRegime: 'parallel-rolling-user-amended', freshPhaseOnly: true, automaticRetry: false,
    selectedCellIds: selected.map(row => row.id), selectedCells: selected.map(row => ({ cellId: row.id, campaignId: row.campaignId, frozenOrdinal: row.ordinal })) };
  return { selected, decision };
}
test('fresh phase, exact source pins, capacity and inherited regime policy reject negative cases', () => {
  const { selected, decision } = policyFixture(); assertPolicy(decision, selected);
  for (const change of [{ split: 'pilot' }, { freshPhaseOnly: false }, { automaticRetry: true }, { timingRegime: 'serial-original' }, { maxConcurrency: 3 }, { maxActivePerCampaign: 2 }, { selectedCellIds: [...decision.selectedCellIds].reverse() }]) assert.throws(() => assertPolicy({ ...decision, ...change }, selected));
  assert.throws(() => assertPolicy(decision, selected.slice(1)));
  const capacity = { status: 'root-approved', approvedBy: 'root', cohort: 'swe', split: 'confirmation_holdout', maxConcurrency: 2, cMinimumBytes: 20 * 1024 ** 3, dMinimumBytes: 36 * 1024 ** 3 };
  assertCapacity(capacity, decision);
  for (const change of [{ status: 'draft' }, { maxConcurrency: 3 }, { cMinimumBytes: capacity.cMinimumBytes - 1 }, { dMinimumBytes: capacity.dMinimumBytes - 1 }]) assert.throws(() => assertCapacity({ ...capacity, ...change }, decision));
  const f = fixture(), source = path.join(f.out, 'source-pin'); fs.writeFileSync(source, 'approved'); const pins = [{ path: source, sha256: sha(source) }]; assertPins(pins);
  fs.writeFileSync(source, 'changed'); assert.throws(() => assertPins(pins), /pin differs/);
});
test('admission binds exact owner, decision, active reservation, ordinal and earliest frozen eligible', () => {
  const { selected } = policyFixture(), owner = { nonce: 'owner', pid: 42 }, decisionSha256 = 'decision';
  const admission = { schemaVersion: 3, controllerNonce: owner.nonce, controllerPid: owner.pid, decisionSha256, issuanceOrdinal: 3,
    acceptedClosed: [{ jobId: 'job-0001', cellId: 'cell0' }], acceptedCellIds: ['cell0'], activeReservations: [{ jobId: 'job-0002', cellId: 'cell1', campaignId: 'campaign1' }] };
  const reservation = { schemaVersion: 3, jobId: 'job-0003', issuanceOrdinal: 3, controllerNonce: owner.nonce, controllerPid: owner.pid, decisionSha256,
    cellId: 'cell2', campaignId: 'campaign2', frozenOrdinal: 2, activeAtAdmission: ['job-0002'] };
  assertAdmission(admission, reservation, selected, owner, decisionSha256);
  for (const change of [{ cellId: 'cell3', campaignId: 'campaign3', frozenOrdinal: 3 }, { cellId: 'cell1', campaignId: 'campaign1', frozenOrdinal: 1 }, { controllerNonce: 'foreign' }, { controllerPid: 43 }, { decisionSha256: 'changed' }, { activeAtAdmission: [] }, { issuanceOrdinal: 4 }]) assert.throws(() => assertAdmission(admission, { ...reservation, ...change }, selected, owner, decisionSha256));
  for (const change of [{ acceptedCellIds: [] }, { acceptedClosed: [] }, { activeReservations: [] }, { activeReservations: [{ jobId: 'job-0002', cellId: 'cell1', campaignId: 'campaign3' }] },
    { acceptedClosed: [{ jobId: 'job-0002', cellId: 'cell0' }] }]) assert.throws(() => assertAdmission({ ...admission, ...change }, reservation, selected, owner, decisionSha256));
});
test('registered active partial is allowed without reading it; unknown allocation, duplicate closed namespaces and changed closed evidence reject', () => {
  const f = fixture(), cells = [cell('closed'), cell('active'), cell('unknown')], dir = row => path.join(f.out, row.id);
  fs.mkdirSync(dir(cells[0])); fs.mkdirSync(dir(cells[1])); fs.writeFileSync(path.join(dir(cells[1]), 'slot-meta.json'), 'intentionally partial invalid JSON');
  assertAllocatedInventory(cells, dir, ['closed', 'active']); fs.mkdirSync(dir(cells[2])); assert.throws(() => assertAllocatedInventory(cells, dir, ['closed', 'active']), /unknown/);
  const rows = [{ namespace: { session: 's1', home: 'h1', source: 'r1', attempt: 'a1' } }, { namespace: { session: 's2', home: 'h2', source: 'r2', attempt: 'a2' } }]; assertNamespaces(rows);
  for (const key of ['session', 'home', 'source', 'attempt']) assert.throws(() => assertNamespaces([rows[0], { namespace: { ...rows[1].namespace, [key]: rows[0].namespace[key] } }]), /namespace/);
});
test('closed lifecycle rejects forged start, exit, reservation and observed process timestamps', () => {
  const f = fixture(), refs = { reservationPath: path.join(f.out, 'reservation.json'), reservationSha256: 'reservation' }, owner = { pid: 42 }, node = process.execPath;
  const observed = { pid: 43, startedAt: '2026-10-18T00:00:00.000Z', finishedAt: '2026-10-18T00:00:01.000Z' }, start = { pid: 43, controllerPid: 42, node, ...refs, startedAt: observed.startedAt },
    exit = { code: 0, signal: null, spawnError: null, bookkeepingError: null, ...observed };
  assertClosedLifecycle(start, exit, observed, refs, owner, node);
  for (const change of [{ pid: 44 }, { controllerPid: 1 }, { reservationSha256: 'forged' }, { startedAt: '2026-10-18T00:00:00.001Z' }]) assert.throws(() => assertClosedLifecycle({ ...start, ...change }, exit, observed, refs, owner, node));
  for (const change of [{ pid: 44 }, { code: 1 }, { signal: 'SIGTERM' }, { finishedAt: '2026-10-18T00:00:02.000Z' }, { bookkeepingError: 'failed' }]) assert.throws(() => assertClosedLifecycle(start, { ...exit, ...change }, observed, refs, owner, node));
});
