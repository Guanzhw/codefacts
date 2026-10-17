import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash, writeJson } from '../rpc.mjs';
import { runOfficialGrade } from './grade.mjs';
import { createSlotGrader, gradeCampaign, toLinuxPath, cleanupOfficialSweContainer } from './grade-campaign.mjs';

function fixture(t, cohort = 'context', modelStatus = 'attempt-completed') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grade-campaign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
  const body = 'const visible = 1;\nconst unseen = 2;\n'; fs.writeFileSync(path.join(sourceRoot, 'x.js'), body);
  const entries = [{ path: 'x.js', bytes: Buffer.byteLength(body), sha256: hash(body) }];
  const task = { id: 'task', cohort, instanceId: 'org__repo-1', repo: 'org/repo', baseCommit: 'a'.repeat(40),
    sourceRoot, manifestFile: path.join(root, 'source.json'), language: 'javascript', split: 'pilot' };
  writeJson(task.manifestFile, { entries, digest: hash(entries), repo: task.repo, instanceId: task.instanceId, baseCommit: task.baseCommit });
  const slot = { id: 'task-ordinary', ordinal: 1, taskId: task.id, arm: 'ordinary', cohort };
  const manifestPath = path.join(root, 'manifest.json'), configPath = path.join(root, 'operator.json');
  const manifest = { campaignId: 'fixture-only', evidenceDir: root, runtime: { wsl: 'C:/Windows/System32/wsl.exe', wslDistro: 'Ubuntu' }, tasks: [task] };
  const config = { grading: { context: { python: '/tmp/context/bin/python', officialRoot: '/tmp/ContextBench',
    datasetPath: 'D:/data/context.parquet', repoCache: '/tmp/context-cache' },
    swe: { python: '/tmp/swe/bin/python', officialRoot: '/tmp/SWE-bench', datasetPath: 'D:/data/swe.jsonl' } },
    contextBases: { task: { repoRoot: path.join(root, 'private-base'), gradingCommit: 'b'.repeat(40), sourceManifestPath: task.manifestFile } } };
  writeJson(manifestPath, manifest); writeJson(configPath, config);
  const pins = [manifestPath, configPath].map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) }));
  const frozen = { manifestPath, manifestHash: hash(manifest), pins, schedule: [slot] }; writeJson(path.join(root, 'freeze.json'), frozen);
  const dir = path.join(root, 'attempts', slot.id); fs.mkdirSync(path.join(dir, 'bridge'), { recursive: true });
  writeJson(path.join(dir, 'bridge', '0001-request.json'), { name: 'source_read', arguments: { file_path: 'x.js' } });
  writeJson(path.join(dir, 'bridge', '0001-response.json'), { content: [{ type: 'text', text: '1\tconst visible = 1;' }] });
  const receipt = { answer: JSON.stringify({ regions: [{ file_path: 'x.js', start_line: 1, end_line: 1 }], rationale: 'visible line' }) };
  const meta = { slot, status: modelStatus, freezeHash: hash(frozen), audit: { infrastructureValid: true, taskCompleted: modelStatus === 'attempt-completed' },
    bridgeEvidenceDir: path.join(dir, 'bridge'), receiptPath: path.join(dir, 'receipt.json'), patchPath: path.join(dir, 'model.patch'), grade: { status: 'pending' } };
  fs.writeFileSync(meta.patchPath, 'actual model diff\n'); writeJson(meta.receiptPath, receipt); writeJson(path.join(dir, 'slot-meta.json'), meta);
  const calls = [];
  const dependencies = { pinCollector: () => pins.map(pin => ({ ...pin, sha256: hash(fs.readFileSync(pin.path)) })),
    runGraderDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
    runOfficialGrade: async options => {
      calls.push(options);
      const report = cohort === 'swe' ? { [task.instanceId]: { resolved: false } } : { kind: 'context', instance_id: task.instanceId,
        officialResult: { instance_id: task.instanceId, final: { line: { coverage: 0.5 } }, trajectory: { auc_coverage: { line: 0.5 }, redundancy: { line: 0 } } }, semantics: { editloc: 'unavailable-readonly-protocol' } };
      // Run a real child and the real report parser; this fixture writes no
      // claimed official metrics beyond its explicitly artificial report.
      return runOfficialGrade({ ...options, command: process.execPath, args: ['-e',
        `require('node:fs').writeFileSync(${JSON.stringify(options.resultPath)}, ${JSON.stringify(JSON.stringify(report))})`] });
    } };
  return { root, manifestPath, configPath, manifest, frozen, config, dependencies, task, slot, dir, meta, receipt, calls,
    grader: () => createSlotGrader({ manifest, frozen, config, configPath, dependencies }),
    input: () => ({ task, slot, dir, meta, receipt }) };
}

test('path boundary: translates all supported grading path forms', () => {
  assert.equal(toLinuxPath('D:\\Data Space\\report.json'), '/mnt/d/Data Space/report.json');
  assert.equal(toLinuxPath('/tmp/env/bin/python'), '/tmp/env/bin/python');
  assert.throws(() => toLinuxPath('relative/file'), /Absolute/);
});

test('integration fixture: actual bridge exposure and final declaration reach the WSL grader separately', async t => {
  const f = fixture(t), grade = await f.grader()(f.input());
  assert.equal(grade.status, 'completed'); assert.equal(grade.metrics.localization.line.coverage, 0.5);
  const prediction = JSON.parse(fs.readFileSync(grade.predictionsPath))[0];
  assert.deepEqual(prediction.traj_data.pred_steps, [{ files: ['x.js'], spans: { 'x.js': [{ start: 1, end: 1 }] } }]);
  assert.deepEqual(prediction.traj_data.pred_spans, { 'x.js': [{ start: 1, end: 1 }] });
  assert.equal(prediction.commit, 'b'.repeat(40)); assert.equal(prediction.repo_url, toLinuxPath(f.config.contextBases.task.repoRoot));
  const options = f.calls[0], officialConfig = JSON.parse(fs.readFileSync(path.join(grade.outputDir, 'official-config.json')));
  assert.equal(options.command, f.manifest.runtime.wsl);
  assert.deepEqual(options.args.slice(0, 6), ['-d', 'Ubuntu', '-u', 'root', '--exec', '/tmp/context/bin/python']);
  assert.equal(officialConfig.datasetPath, '/mnt/d/data/context.parquet');
  assert.equal(officialConfig.sourceManifestPath, toLinuxPath(f.task.manifestFile));
  assert.equal(officialConfig.predictionsPath, toLinuxPath(grade.predictionsPath));
  assert.equal(officialConfig.outputDir, toLinuxPath(grade.outputDir));
});

test('integration fixture: failed model Context attempt keeps missing declaration and null metrics', async t => {
  const f = fixture(t, 'context', 'task-failed'); f.receipt.answer = '';
  const grade = await f.grader()(f.input());
  assert.equal(grade.status, 'missing-final-declaration'); assert.equal(grade.modelTaskCompleted, false);
  assert.equal(grade.metrics, null); assert.equal(grade.resolved, null); assert.equal(f.calls.length, 0);
  assert.equal(grade.missingFinalDeclaration, true);
  const diagnostics = JSON.parse(fs.readFileSync(path.join(grade.outputDir, 'trace-diagnostics.json')));
  assert.equal(diagnostics.requests, 1); assert.equal(diagnostics.declarationStatus, 'missing-final-declaration');
});

test('integration fixture: failed partial SWE model patch is scored without changing model outcome', async t => {
  const f = fixture(t, 'swe', 'task-failed'), grade = await f.grader()(f.input());
  assert.equal(grade.status, 'completed'); assert.equal(grade.resolved, false);
  assert.equal(grade.modelTaskCompleted, false); assert.equal(grade.modelAttemptStatus, 'task-failed');
  assert.equal(JSON.parse(fs.readFileSync(grade.predictionsPath))[0].model_patch, 'actual model diff\n');
});

test('integration fixture: empty SWE submission preserves official missing-report and null resolved', async t => {
  const f = fixture(t, 'swe', 'task-failed'); fs.writeFileSync(f.meta.patchPath, '');
  f.dependencies.runOfficialGrade = options => runOfficialGrade({ ...options, command: process.execPath, args: ['-e', 'process.exit(0)'] });
  const grade = await f.grader()(f.input());
  assert.equal(grade.status, 'missing-report'); assert.equal(grade.resolved, null); assert.equal(grade.emptyModelPatch, true);
  assert.equal(grade.modelTaskCompleted, false);
});

test('frozen input boundary: operator config edits stop grading before child execution', async t => {
  const f = fixture(t), grader = f.grader();
  writeJson(f.configPath, { ...f.config, injected: true });
  await assert.rejects(grader(f.input()), /drifted|frozen campaign input/); assert.equal(f.calls.length, 0);
});

test('source boundary: the selected pristine source is checked before trace extraction or official grading', async t => {
  const f = fixture(t), grader = f.grader(); fs.writeFileSync(path.join(f.task.sourceRoot, 'x.js'), 'changed\n');
  fs.writeFileSync(path.join(f.dir, 'bridge', '0001-response.json'), 'invalid trace JSON');
  await assert.rejects(grader(f.input()), /Source byte drift/); assert.equal(f.calls.length, 0);
  assert.equal(fs.readdirSync(f.dir).some(name => name.startsWith('grade-run-')), false);
});

test('resume boundary: completed grade reuses only identical provenance and report bytes', async t => {
  const f = fixture(t), grader = f.grader(); f.meta.grade = await grader(f.input());
  assert.deepEqual(await grader(f.input()), f.meta.grade); assert.equal(f.calls.length, 1);
  fs.writeFileSync(f.meta.grade.receipt.resultPath, '{}');
  await assert.rejects(grader(f.input()), /report is missing or changed/);
});

test('resume boundary: changed actual bridge evidence cannot reuse a completed score', async t => {
  const f = fixture(t), grader = f.grader(); f.meta.grade = await grader(f.input());
  writeJson(path.join(f.dir, 'bridge', '0001-response.json'), { content: [{ type: 'text', text: '2\tconst unseen = 2;' }] });
  await assert.rejects(grader(f.input()), /provenance differs/); assert.equal(f.calls.length, 1);
});

test('source boundary: attempt and frozen source trees cannot become private grading clones', async t => {
  const f = fixture(t); f.config.contextBases.task.repoRoot = f.task.sourceRoot;
  writeJson(f.configPath, f.config);
  f.frozen.pins.find(pin => pin.path === f.configPath).sha256 = hash(fs.readFileSync(f.configPath));
  f.meta.freezeHash = hash(f.frozen);
  await assert.rejects(f.grader()(f.input()), /dedicated private baseline/); assert.equal(f.calls.length, 0);
});

test('retry boundary: failed grade requires explicit retry and gets fresh evidence directory', async t => {
  const f = fixture(t, 'context', 'task-failed'); f.receipt.answer = '';
  const grader = f.grader(); f.meta.grade = await grader(f.input());
  await assert.rejects(grader(f.input()), /use --retry/);
  const retry = createSlotGrader({ ...f, retry: true });
  const second = await retry(f.input()); assert.notEqual(second.outputDir, f.meta.grade.outputDir);
  assert.ok(fs.existsSync(path.join(f.meta.grade.outputDir, 'grade.json')));
});

test('retry boundary: grader startup exception becomes a preserved failed grade', async t => {
  const f = fixture(t, 'swe'); f.dependencies.runOfficialGrade = async () => { throw new Error('fixture startup failure'); };
  f.meta.grade = await f.grader()(f.input());
  assert.equal(f.meta.grade.status, 'failed'); assert.equal(f.meta.grade.resolved, null);
  assert.match(f.meta.grade.error, /fixture startup failure/);
  assert.ok(fs.existsSync(path.join(f.meta.grade.outputDir, 'grade.json')));
  await assert.rejects(f.grader()(f.input()), /use --retry/);
});

test('campaign integration: task failures remain in denominator and slot metadata status is preserved', async t => {
  const f = fixture(t, 'swe', 'task-failed');
  const result = await gradeCampaign(f.manifestPath, f.configPath, { split: 'pilot', dependencies: f.dependencies });
  assert.equal(result.slots, 1); assert.equal(result.grades[0].resolved, false);
  const meta = JSON.parse(fs.readFileSync(path.join(f.dir, 'slot-meta.json')));
  assert.equal(meta.status, 'task-failed'); assert.equal(meta.grade.status, 'completed');
  assert.equal(fs.existsSync(path.join(f.root, 'dispatch.lock')), false);
});

function cleanupFixture(t, responses) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-cleanup-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const calls = [], id = 'a'.repeat(64), name = 'sweb.eval.org__repo-1.unique-run';
  return { id, name, calls, outputDir, options: { runtime: { wsl: 'wsl.exe', wslDistro: 'Ubuntu' }, instanceId: 'ORG__REPO-1', runId: 'unique-run', outputDir },
    run: async (command, args) => { calls.push({ command, args }); const next = responses.shift(); assert.ok(next, 'unexpected cleanup command'); return { code: 0, stdout: '', stderr: '', ...next }; } };
}

test('official cleanup: already-removed container requires successful zero-match queries and no rm', async t => {
  const f = cleanupFixture(t, [{}, {}]), receipt = await cleanupOfficialSweContainer(f.options, f.run);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.absent, true); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.args[6] === 'ps'));
  assert.ok(f.calls[0].args.includes('name=^/sweb\\.eval\\.org__repo-1\\.unique-run$'));
});

test('official cleanup: captures exact container identity, removes its volumes, and verifies absence', async t => {
  const id = 'a'.repeat(64), name = 'sweb.eval.org__repo-1.unique-run', volume = 'b'.repeat(64);
  const f = cleanupFixture(t, [{ stdout: `${id}\t${name}\n` },
    { stdout: JSON.stringify([{ Id: id, Name: `/${name}`, Mounts: [{ Type: 'volume', Name: volume }] }]) }, {}, {}, {}]);
  const receipt = await cleanupOfficialSweContainer(f.options, f.run);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.absent, true);
  assert.deepEqual(f.calls[2].args.slice(6), ['rm', '-fv', id]);
  assert.deepEqual(f.calls[4].args.slice(6), ['volume', 'ls', '--filter', `name=${volume}`, '--format', '{{.Name}}']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.outputDir, 'official-container-cleanup.json'))).container.Id, id);
});

test('official cleanup: failed Docker query is unavailable cleanup, never successful absence', async t => {
  const f = cleanupFixture(t, [{ code: 1, stderr: 'daemon unavailable' }]);
  const receipt = await cleanupOfficialSweContainer(f.options, f.run);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.absent, false); assert.equal(f.calls.length, 1);
});

test('official cleanup: mismatched identity is preserved without removing another container', async t => {
  const f = cleanupFixture(t, [{ stdout: `${'a'.repeat(64)}\tunrelated-container\n` }]);
  const receipt = await cleanupOfficialSweContainer(f.options, f.run);
  assert.equal(receipt.status, 'failed'); assert.match(receipt.error, /ownership query mismatch/); assert.equal(f.calls.length, 1);
});

test('official cleanup: nonzero rm and retained volumes both remain explicit failures', async t => {
  for (const failure of ['rm', 'volume']) {
    const id = 'a'.repeat(64), name = 'sweb.eval.org__repo-1.unique-run', volume = 'b'.repeat(64);
    const responses = [{ stdout: `${id}\t${name}\n` }, { stdout: JSON.stringify([{ Id: id, Name: `/${name}`, Mounts: [{ Type: 'volume', Name: volume }] }]) },
      failure === 'rm' ? { code: 1, stderr: 'rm failed' } : {}, {}, { stdout: `${volume}\n` }];
    const f = cleanupFixture(t, responses), receipt = await cleanupOfficialSweContainer(f.options, f.run);
    assert.equal(receipt.status, 'failed'); assert.match(receipt.error, failure === 'rm' ? /command failed/ : /volume remains/);
  }
});

test('SWE grader finally: timeout outcome still receives verified container cleanup', async t => {
  const f = fixture(t, 'swe'), operations = [];
  f.dependencies.runOfficialGrade = async () => ({ status: 'timed-out', resolved: null, metrics: null, receipt: { timedOut: true } });
  f.dependencies.runGraderDocker = async (_, args) => { operations.push(args); return { code: 0, stdout: '', stderr: '' }; };
  const grade = await f.grader()(f.input());
  assert.equal(grade.status, 'timed-out'); assert.equal(grade.resolved, null);
  assert.equal(grade.cleanup.status, 'completed'); assert.equal(operations.length, 2);
});

test('SWE grader finally: cleanup failure clears success while preserving actual grader/report', async t => {
  const f = fixture(t, 'swe');
  f.dependencies.runOfficialGrade = options => runOfficialGrade({ ...options, command: process.execPath, args: ['-e',
    `require('node:fs').writeFileSync(${JSON.stringify(options.resultPath)}, ${JSON.stringify(JSON.stringify({ [f.task.instanceId]: { resolved: true } }))})`] });
  f.dependencies.runGraderDocker = async () => ({ code: 1, stdout: '', stderr: 'daemon unavailable' });
  const grade = await f.grader()(f.input());
  assert.equal(grade.status, 'failed'); assert.equal(grade.resolved, null);
  assert.equal(grade.graderResult.status, 'completed'); assert.equal(grade.graderResult.resolved, true);
  assert.equal(JSON.parse(fs.readFileSync(grade.receipt.resultPath))[f.task.instanceId].resolved, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(grade.outputDir, 'grader-receipt.json'))).resolved, true);
});
