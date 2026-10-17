import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runOfficialGrade } from './grade.mjs';

function fixture(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-grade-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  return { outputDir, resultPath: path.join(outputDir, 'result.json'), command: process.execPath };
}
const writer = (resultPath, report, extra = '') => ['-e',
  `require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, ${JSON.stringify(JSON.stringify(report))});${extra}`];

test('unit fixture: official boolean false is a completed unsuccessful repair', async t => {
  const options = fixture(t);
  const result = await runOfficialGrade({ ...options, kind: 'swe', instanceId: 'repo__name-1',
    args: writer(options.resultPath, { 'repo__name-1': { resolved: false } }, 'console.log("fixture only");') });
  assert.equal(result.status, 'completed'); assert.equal(result.resolved, false);
  assert.equal(result.metrics, null);
  assert.match(fs.readFileSync(result.receipt.stdoutPath, 'utf8'), /fixture only/);
  assert.match(result.receipt.resultSha256, /^[a-f0-9]{64}$/);
});

test('unit fixture: true requires the correct per-instance official report field', async t => {
  const options = fixture(t);
  const result = await runOfficialGrade({ ...options, kind: 'swe',
    args: writer(options.resultPath, { instance: { resolved: true } }) });
  assert.equal(result.status, 'completed'); assert.equal(result.resolved, true);
});

test('unit fixture: official infrastructure faults leave repair success unavailable', async t => {
  const options = fixture(t);
  const result = await runOfficialGrade({ ...options, kind: 'swe',
    args: writer(options.resultPath, { instance: { resolved: false, infra_failure: true, infra_failure_reason: 'missing compiler' } }) });
  assert.equal(result.status, 'failed'); assert.equal(result.resolved, null);
  assert.equal(result.receipt.officialInfrastructureFailure, 'missing compiler');
});

for (const report of [{ resolved: true }, { instance: { resolved: 'true' } }, { other: { resolved: true } }]) {
  test(`unit fixture: rejects fabricated/coerced success ${JSON.stringify(report)}`, async t => {
    const options = fixture(t);
    const result = await runOfficialGrade({ ...options, kind: 'swe', instanceId: 'instance', args: writer(options.resultPath, report) });
    assert.equal(result.status, 'invalid-report'); assert.equal(result.resolved, null);
  });
}

test('unit fixture: a nonzero evaluator exit cannot claim success from an existing report', async t => {
  const options = fixture(t);
  const result = await runOfficialGrade({ ...options, kind: 'swe',
    args: writer(options.resultPath, { instance: { resolved: true } }, 'console.error("broken fixture");process.exit(7);') });
  assert.equal(result.status, 'failed'); assert.equal(result.resolved, null);
  assert.equal(result.receipt.processExit.code, 7);
  assert.match(fs.readFileSync(result.receipt.stderrPath, 'utf8'), /broken fixture/);
});

test('unit fixture: missing and malformed reports remain explicit', async t => {
  const options = fixture(t);
  const result = await runOfficialGrade({ ...options, kind: 'swe', args: ['-e', 'process.exit(0)'] });
  assert.equal(result.status, 'missing-report'); assert.equal(result.resolved, null);
  const malformed = fixture(t);
  const invalid = await runOfficialGrade({ ...malformed, kind: 'swe',
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(malformed.resultPath)}, '{broken')`] });
  assert.equal(invalid.status, 'invalid-report'); assert.equal(invalid.resolved, null);
});

test('unit fixture: process startup failure is recorded', async t => {
  const options = fixture(t);
  const result = await runOfficialGrade({ ...options, kind: 'swe', command: path.join(options.outputDir, 'does-not-exist') });
  assert.equal(result.status, 'failed'); assert.equal(result.resolved, null);
  assert.match(result.receipt.processError, /ENOENT/);
});

test('unit fixture: timeout is recorded and terminates the evaluator', async t => {
  const options = fixture(t);
  const result = await runOfficialGrade({ ...options, kind: 'swe', args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 });
  assert.equal(result.status, 'timed-out'); assert.equal(result.receipt.timedOut, true);
  assert.equal(result.resolved, null);
});

test('unit fixture: refuses stale official results before starting a process', async t => {
  const options = fixture(t);
  fs.writeFileSync(options.resultPath, '{}');
  await assert.rejects(runOfficialGrade({ ...options, kind: 'swe', args: ['-e', 'throw Error("must not run")'] }), /existing official result/);
});

test('unit fixture: distinguishes declared localization from explored trajectory', async t => {
  const options = fixture(t);
  const explored = { instance_id: 'i', num_steps: 1, final: { line: { coverage: 0.5, precision: 1 } },
    trajectory: { auc_coverage: { line: 0.5 }, redundancy: { line: 0 } } };
  const report = { kind: 'context', instance_id: 'i', officialResult: explored,
    semantics: { editloc: 'unavailable-readonly-protocol', referencePatchFallback: 'disabled-on-a-copy-of-gold' } };
  const result = await runOfficialGrade({ ...options, kind: 'context', args: writer(options.resultPath, report) });
  assert.equal(result.status, 'completed'); assert.equal(result.resolved, null);
  assert.deepEqual(result.metrics.localization, explored.final);
  assert.deepEqual(result.metrics.explored, explored.trajectory); assert.equal(result.metrics.editloc, null);
});

test('unit fixture: context evaluator errors cannot become metrics', async t => {
  const options = fixture(t);
  const result = await runOfficialGrade({ ...options, kind: 'context', args: writer(options.resultPath,
    { kind: 'context', instance_id: 'i', officialResult: { instance_id: 'i', error: 'no_context_extracted' }, semantics: {} }) });
  assert.equal(result.status, 'invalid-report'); assert.equal(result.metrics, null);
});

test('Python boundary: reference-patch fallback is removed from a copy of gold', () => {
  const script = fileURLToPath(new URL('./official.py', import.meta.url));
  const source = `import runpy,types,json\nm=runpy.run_path(${JSON.stringify(script)})\ngold=types.SimpleNamespace(_data={'patch':'REFERENCE','test_patch':'TEST','gold_ctx':[{'file':'x.py'}]})\ncopy=m['without_reference_patch'](gold)\nassert gold._data['patch']=='REFERENCE'\nassert 'patch' not in copy._data\nassert copy._data['test_patch']=='TEST'\nassert copy is not gold\nprint('reference fallback disabled; original preserved')`;
  const result = spawnSync(process.env.COMMUNITY_PYTHON ?? 'python', ['-B', '-c', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr ?? result.error?.message);
  assert.match(result.stdout, /original preserved/);
});

test('Python boundary: mismatched official source fails before importing grader dependencies', () => {
  const script = fileURLToPath(new URL('./official.py', import.meta.url));
  const source = `import runpy,tempfile,pathlib\nm=runpy.run_path(${JSON.stringify(script)})\nwith tempfile.TemporaryDirectory() as d:\n root=pathlib.Path(d)\n p=root/'contextbench/evaluate.py'\n p.parent.mkdir()\n p.write_text('# changed')\n try:\n  m['check_source']('context',root)\n except ValueError as e:\n  assert 'hash mismatch' in str(e)\n else:\n  raise AssertionError('unverified source accepted')\nprint('source mismatch rejected')`;
  const result = spawnSync(process.env.COMMUNITY_PYTHON ?? 'python', ['-B', '-c', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr ?? result.error?.message);
  assert.match(result.stdout, /source mismatch rejected/);
});
