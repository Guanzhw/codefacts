import './fixtures/source-dependencies.mjs';
import test, { after } from 'node:test';
import os from 'node:os';
import { makeFixture } from './fixtures/manifest.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { runIsolatedCell, schedule, validate } = await import('./run.mjs');

assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Portable worker tests require Node.js 24 or newer');
assert.ok(['win32', 'linux'].includes(process.platform), 'Controlled worker fixtures support Windows and Linux; do not silently skip another platform');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = makeFixture();
const originalManifest = fixture.manifest;
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-worker-integration-'));
console.log(`Evidence: ${evidence}`);
const hook = pathToFileURL(path.join(HERE, 'fixtures', 'source-dependencies.mjs')).href;
after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

test('candidate retains frozen schedule, four-way resource contract and all arms/models', () => {
  validate(originalManifest);
  assert.equal(schedule(originalManifest).length, 48);
  assert.deepEqual(originalManifest.arms.map(x => x.id), ['ordinary', 'codefacts022', 'candidate', 'codegraph']);
  const frozen = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'schedule.json'), 'utf8'));
  assert.deepEqual(schedule(originalManifest), frozen.schedule);
});

test('real worker entry calls runCell and preserves failed attempt/null metrics; no overwrite', async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ''} --import=${hook}`.trim();
  try {
    const manifest = { ...originalManifest, evidenceDir: evidence };
    fs.mkdirSync(path.join(evidence, 'workers'));
    const cell = { id: 'fixture-cell', taskId: originalManifest.tasks[0].id, modelKey: originalManifest.models[0].key, arm: 'ordinary', ordinal: 1 };
    const manifestPath = path.join(evidence, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(evidence, 'freeze.json'), JSON.stringify({ schedule: [cell] }));
    const result = await runIsolatedCell(manifestPath, manifest, cell);
    assert.equal(result.status, 'attempt-failed');
    assert.equal(result.modelDurationMs, null); assert.equal(result.sdkProcessDurationMs, null);
    assert.equal(result.tokenUsage.exact, null); assert.equal(result.tokenUsage.knownLowerBound.totalTokens, 3);
    assert.equal(result.grade.resolved, null);
    const original = fs.readFileSync(path.join(evidence, 'attempts/fixture-cell/cell.json'));
    const duplicate = await runIsolatedCell(manifestPath, manifest, cell);
    assert.equal(duplicate.status, 'infrastructure-or-attempt-failed');
    assert.match(duplicate.error, /EEXIST/);
    assert.deepEqual(fs.readFileSync(path.join(evidence, 'attempts/fixture-cell/cell.json')), original);
    const receipt = JSON.parse(fs.readFileSync(result.worker.receipt));
    assert.equal(receipt.code, 0); assert.equal(receipt.timedOut, false); assert.ok(receipt.closedAt);
    assert.deepEqual(receipt.frames.map(x => x.frame.type), ['ready', 'result']);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
});

test('runCell preparation failure remains explicit through a normally closed worker', async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ''} --import=${hook}`.trim();
  try {
    const dir = path.join(evidence, 'preparation-failure'); fs.mkdirSync(dir);
    const task = { ...originalManifest.tasks[0], id: 'fixture-prepare-failure' };
    const cell = { id: 'fixture-failure-cell', taskId: task.id, modelKey: originalManifest.models[0].key, arm: 'ordinary', ordinal: 1 };
    const manifest = { ...originalManifest, evidenceDir: dir, tasks: [task] };
    fs.mkdirSync(path.join(dir, 'workers'));
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'freeze.json'), JSON.stringify({ schedule: [cell] }));
    const result = await runIsolatedCell(manifestPath, manifest, cell);
    assert.equal(result.status, 'infrastructure-or-attempt-failed');
    assert.equal(result.error, 'deliberate source fixture failure');
    assert.equal(result.grade.resolved, null);
    const receipt = JSON.parse(fs.readFileSync(result.worker.receipt));
    assert.equal(receipt.code, 0); assert.ok(receipt.closedAt);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
});

test('a truncated cell exit7 preserves its bytes and drains an admitted slow sibling', async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ''} --import=${hook}`.trim();
  try {
    const dir = path.join(evidence, 'truncated-wave'); fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'workers'));
    const tasks = ['fixture-truncated-cell', 'fixture-slow-sibling'].map(id => ({ ...originalManifest.tasks[0], id }));
    const cells = tasks.map((task, i) => ({ id: task.id, taskId: task.id, modelKey: originalManifest.models[0].key, arm: 'ordinary', ordinal: i + 1 }));
    const manifest = { ...originalManifest, evidenceDir: dir, tasks };
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'freeze.json'), JSON.stringify({ schedule: cells }));
    // This is the production wave barrier with actual admitted Node workers.
    const fast = runIsolatedCell(manifestPath, manifest, cells[0]);
    const slow = runIsolatedCell(manifestPath, manifest, cells[1]);
    let waveSettled = false;
    const wave = Promise.all([fast, slow]).then(value => { waveSettled = true; return value; });
    const fastResult = await fast;
    assert.equal(fastResult.status, 'infrastructure-or-attempt-failed');
    assert.match(fastResult.error, /Cell worker failed/);
    assert.match(fastResult.cellReadError.error, /JSON|property|Unexpected|position/);
    assert.equal(fastResult.cellReadError.path, path.join(dir, 'attempts', cells[0].id, 'cell.json'));
    assert.equal(fs.readFileSync(fastResult.cellReadError.path, 'utf8'), '{');
    assert.equal(waveSettled, false, 'fast corruption cannot release the wave while the admitted sibling is live');
    const slowStart = JSON.parse(fs.readFileSync(path.join(dir, 'workers', cells[1].id, 'start.json')));
    assert.doesNotThrow(() => process.kill(slowStart.pid, 0));
    const results = await wave, settledAt = Date.now();
    const receipts = results.map(result => JSON.parse(fs.readFileSync(result.worker.receipt)));
    assert.equal(receipts[0].code, 7); assert.equal(receipts[1].code, 0);
    for (const receipt of receipts) { assert.ok(receipt.closedAt); assert.ok(Date.parse(receipt.closedAt) <= settledAt); }
    assert.ok(Date.parse(receipts[1].closedAt) - Date.parse(receipts[0].closedAt) > 800);
    assert.equal(fs.readFileSync(fastResult.cellReadError.path, 'utf8'), '{');
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
});
