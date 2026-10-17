import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash } from '../rpc.mjs';
import { ARMS, COMMON, REPAIR, validateManifest, buildSchedule, buildPrompt, freezeCampaign, assertFrozen, collectPins, auditAttempt, runSlot, startSandbox, executeCampaign } from './campaign.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-campaign-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tasks = [], selections = [];
  for (const cohort of ['context', 'swe']) for (const language of ['go', 'rust', 'javascript', 'typescript']) for (let i = 0; i < 3; i++) {
    const id = `${cohort}-${language}-${i}`, sourceRoot = path.join(dir, 'sources', id), manifestFile = path.join(dir, `${id}-source.json`);
    fs.mkdirSync(sourceRoot, { recursive: true }); fs.writeFileSync(path.join(sourceRoot, 'file.txt'), 'source\n');
    const entries = [{ path: 'file.txt', bytes: 7, sha256: hash('source\n'), mode: '100644' }];
    const task = { id, instanceId: id, cohort, language, split: i < 2 ? 'pilot' : 'confirmation_holdout', repo: 'owner/repo', baseCommit: 'a'.repeat(40), prompt: 'Fix the specific issue.', sourceRoot, manifestFile,
      ...(cohort === 'swe' ? { sandbox: { image: `sha256:${'1'.repeat(64)}`, workspaceVerified: true } } : {}) };
    fs.writeFileSync(manifestFile, JSON.stringify({ instanceId: id, repo: task.repo, baseCommit: task.baseCommit, entries, digest: hash(entries) }));
    tasks.push(task); selections.push({ id, dataset: cohort === 'context' ? 'contextbench' : 'swebench_multilingual', repo: task.repo, base_commit: task.baseCommit, language, split: task.split });
  }
  const selectionFile = path.join(dir, 'selection.json'); fs.writeFileSync(selectionFile, JSON.stringify({ selections }));
  const upstream = path.join(dir, 'upstream'), dsh = path.join(dir, 'dsh'), sdk = path.join(dir, 'sdk'), cg = path.join(dir, 'cg');
  for (const directory of [upstream, dsh, sdk, cg]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(upstream, 'primary.py'), 'primary'); fs.writeFileSync(path.join(upstream, 'nonprimary.py'), 'secondary');
  fs.writeFileSync(path.join(dsh, 'provider.cjs'), 'provider'); fs.writeFileSync(path.join(dsh, 'runtime.mjs'), 'runtime');
  fs.writeFileSync(path.join(cg, 'package.json'), '{}'); fs.writeFileSync(path.join(cg, 'cli.js'), 'cli'); fs.writeFileSync(path.join(cg, 'kernel.node'), 'native');
  const dataset = path.join(dir, 'dataset.parquet'); fs.writeFileSync(dataset, 'dataset');
  const manifest = { schemaVersion: 1, campaignId: 'community-test', evidenceDir: path.join(dir, 'evidence'), selectionFile,
    runtime: { dshRoot: dsh, node: process.execPath, sdkRoot: sdk, rg: process.execPath, wsl: process.execPath },
    evaluation: { inputFiles: [dataset], upstreamRoots: [upstream], runtimeFiles: [process.execPath] },
    model: { provider: 'opencode-go', id: 'deepseek-v4.1-flash', reasoningEffort: 'high' }, concurrency: 1, timeoutMs: 1200000, maxOutputTokens: 32768,
    arms: [{ id: 'ordinary' }, { id: 'codefacts022', executable: process.execPath, version: '0.2.2' }, { id: 'codegraph', node: process.execPath, cli: path.join(cg, 'cli.js'), version: '0.16.2' }], tasks };
  const file = path.join(dir, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(manifest));
  return { dir, manifest, file, task: tasks[0] };
}
const pins = (manifest, file) => [{ path: file, sha256: hash(fs.readFileSync(file)) }];
function receipt(slot, overrides = {}) {
  const native = slot.arm === 'codefacts022' ? ['codefacts_explore', 'codefacts_expand', 'codefacts_impact'] : slot.arm === 'codegraph' ? ['codegraph_explore'] : [];
  return { status: 'attempt-completed', providerCallSucceeded: true, didInitialize: true, didPrompt: true, protocolError: null, headerAudit: true,
    catalogs: [[...COMMON, ...(slot.cohort === 'swe' ? REPAIR : []), ...native].map(name => ({ name: `mcp__repo__${name}` }))],
    actualRequestHeaders: [{}], toolCalls: [{ name: 'mcp__repo__source_read' }], answer: 'done', ...overrides };
}
function fakePrepare() {
  return async ({ task, dir }) => {
    const root = path.join(dir, 'source'); fs.cpSync(task.sourceRoot, root, { recursive: true });
    const bridgeConfig = path.join(dir, 'bridge-config.json'); fs.writeFileSync(bridgeConfig, '{}');
    return { root, bridgeConfig, sourceHash: 'test', setup: { sourcePreparationMs: 1, indexDurationMs: 0 }, entries: JSON.parse(fs.readFileSync(task.manifestFile)).entries };
  };
}

test('manifest fixes 24 preregistered tasks and three arms; no total token budget', t => {
  const { manifest } = fixture(t); assert.equal(validateManifest(manifest), manifest);
  assert.throws(() => validateManifest({ ...manifest, concurrency: 2 }), /serial/);
  assert.throws(() => validateManifest({ ...manifest, maxOutputTokens: 100 }), /maxOutputTokens/);
  assert.throws(() => validateManifest({ ...manifest, tasks: manifest.tasks.slice(1) }), /24/);
});
test('a complete 12-task context cohort freezes independently of SWE sandbox readiness', t => {
  const { manifest, file } = fixture(t);
  manifest.tasks = manifest.tasks.filter(task => task.cohort === 'context'); delete manifest.runtime.wsl;
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.equal(freezeCampaign(file, { pinCollector: pins }).schedule.length, 36);
  assert.throws(() => validateManifest({ ...manifest, tasks: [...manifest.tasks.slice(0, 11), { ...manifest.tasks[11], language: 'go' }] }), /Require 2 pilot/);
});
test('schedule balances arm position with one attempt per task and arm', t => {
  const { manifest } = fixture(t), schedule = buildSchedule(manifest.tasks);
  assert.equal(schedule.length, 72); assert.equal(new Set(schedule.map(row => row.id)).size, 72);
  assert.ok(schedule.slice(0, 48).every(row => manifest.tasks.find(task => task.id === row.taskId).split === 'pilot'));
  for (const arm of ARMS) for (let position = 1; position <= 3; position++) assert.equal(schedule.filter(row => row.arm === arm && row.position === position).length, 8);
});
test('prompts share optional navigation and preserve cohort task contract', t => {
  const { manifest } = fixture(t), context = buildPrompt(manifest.tasks[0]), swe = buildPrompt(manifest.tasks[12]);
  assert.match(context, /Native navigation is optional/); assert.match(context, /final JSON object only/); assert.match(context, /"regions"/);
  assert.match(swe, /actual source changes/); assert.match(swe, /source_exec/); assert.doesNotMatch(swe, /final JSON object only/);
});
test('freeze is immutable and source/selection drift fails before dispatch', t => {
  const { manifest, file, task } = fixture(t), frozen = freezeCampaign(file, { pinCollector: pins });
  assert.deepEqual(freezeCampaign(file, { pinCollector: pins }), frozen);
  fs.writeFileSync(path.join(task.sourceRoot, 'file.txt'), 'changed');
  assert.throws(() => freezeCampaign(file, { pinCollector: pins }), /drift/);
  fs.writeFileSync(path.join(task.sourceRoot, 'file.txt'), 'source\n');
  const selection = JSON.parse(fs.readFileSync(manifest.selectionFile)); selection.selections[0].base_commit = 'b'.repeat(40); fs.writeFileSync(manifest.selectionFile, JSON.stringify(selection));
  assert.throws(() => freezeCampaign(file, { pinCollector: pins }), /preregistered/);
});
test('real preparation checks the selected source; unrelated drift waits until that task or explicit freeze', async t => {
  const { manifest, file } = fixture(t);
  manifest.runtime.contextGitMode = 'boundary-only';
  fs.writeFileSync(file, JSON.stringify(manifest));
  const frozen = freezeCampaign(file, { pinCollector: pins });
  const first = frozen.schedule.find(slot => slot.cohort === 'context' && slot.arm === 'ordinary');
  const second = frozen.schedule.find(slot => slot.cohort === 'context' && slot.arm === 'ordinary' && slot.taskId !== first.taskId);
  const unused = manifest.tasks.find(task => task.id === second.taskId);
  fs.writeFileSync(path.join(unused.sourceRoot, 'file.txt'), 'changed\n');
  let modelCalls = 0;
  const dependencies = { pinCollector: pins, runDshAttempt: async () => { modelCalls++; return receipt(first); } };
  assert.equal((await executeCampaign(file, 'run', first.id, dependencies)).slots, 1);
  assert.equal(modelCalls, 1);
  await assert.rejects(executeCampaign(file, 'run', second.id, dependencies), /Source byte drift/);
  assert.equal(modelCalls, 1);
  assert.throws(() => freezeCampaign(file, { pinCollector: pins }), /Source byte drift/);
});
test('freeze pins complete official/runtime trees and dataset bytes, including cjs/mjs/native modules', t => {
  const { manifest, file, dir } = fixture(t);
  // Other agent tests may edit framework files during the parallel suite. Exercise
  // the actual collector while isolating this mutation assertion to owned inputs.
  const ownedPins = (manifest, file) => collectPins(manifest, file).filter(pin => pin.path.startsWith(dir + path.sep) || pin.path === process.execPath);
  const frozen = freezeCampaign(file, { pinCollector: ownedPins });
  const targets = [path.join(manifest.evaluation.upstreamRoots[0], 'nonprimary.py'), manifest.evaluation.inputFiles[0],
    path.join(manifest.runtime.dshRoot, 'provider.cjs'), path.join(manifest.runtime.dshRoot, 'runtime.mjs'), path.join(path.dirname(manifest.arms[2].cli), 'kernel.node')];
  for (const target of targets) {
    assert.ok(frozen.pins.some(pin => pin.path === target));
    const original = fs.readFileSync(target); fs.appendFileSync(target, 'drift');
    assert.throws(() => assertFrozen(manifest, frozen, ownedPins(manifest, file)), /inputs drifted/);
    fs.writeFileSync(target, original);
  }
  assertFrozen(manifest, frozen, ownedPins(manifest, file));
});
test('unknown usage and provider/cutoff failures are task outcomes; catalog mismatch fails infrastructure', () => {
  const slot = { arm: 'ordinary', cohort: 'context' };
  assert.equal(auditAttempt(receipt(slot, { status: 'attempt-failed', generationCutoff: true }), slot).outcome, 'generation-cutoff');
  assert.equal(auditAttempt(receipt(slot, { status: 'attempt-failed', catalogs: [], actualRequestHeaders: [], headerAudit: false }), slot).infrastructureValid, true);
  assert.equal(auditAttempt(receipt(slot, { catalogs: [[{ name: 'bad' }]] }), slot).infrastructureValid, false);
});
test('read-only slot preserves failure receipt and pending grade without aborting provider failure', async t => {
  const { manifest, file } = fixture(t), frozen = freezeCampaign(file, { pinCollector: pins }), slot = frozen.schedule[0];
  let calls = 0;
  const meta = await runSlot(manifest, frozen, slot, { prepareCommunitySlot: fakePrepare(), runDshAttempt: async options => {
    calls++; assert.equal(options.maxOutputTokens, 32768); assert.match(options.bridgeConfig, /bridge-config.json$/);
    return receipt(slot, { status: 'attempt-failed', providerCallSucceeded: false, generationCutoff: true });
  } });
  assert.equal(calls, 1); assert.equal(meta.status, 'task-failed'); assert.equal(meta.grade.resolved, null);
  assert.equal(meta.bridgeEvidenceDir, path.join(manifest.evidenceDir, 'attempts', slot.id, 'inner-bridge'));
  await runSlot(manifest, frozen, slot, { runDshAttempt: () => { throw new Error('must reuse'); } });
  assert.equal(calls, 1);
});
test('SWE teardown runs before collecting new-file patch and also after DSH failure', async t => {
  const { manifest, file } = fixture(t), frozen = freezeCampaign(file, { pinCollector: pins }), slot = frozen.schedule.find(row => row.cohort === 'swe');
  const events = [];
  const dependencies = { prepareCommunitySlot: fakePrepare(), startSandbox: async () => ({ config: { command: process.execPath, argsPrefix: ['bash', '-lc'] }, cleanup: async () => { events.push('cleanup'); return { absent: true }; } }),
    runDshAttempt: async options => { events.push('model'); const config = JSON.parse(fs.readFileSync(options.bridgeConfig)); assert.ok(path.isAbsolute(config.innerConfig)); return receipt(slot); },
    collectPatch: async (root, { createdPaths }) => { events.push('patch'); assert.deepEqual(createdPaths, ['ignored/new.txt']); return 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n'; } };
  dependencies.runDshAttempt = async options => { events.push('model'); const config = JSON.parse(fs.readFileSync(options.bridgeConfig)); assert.ok(path.isAbsolute(config.innerConfig)); fs.mkdirSync(config.evidenceDir); fs.writeFileSync(path.join(config.evidenceDir, 'edits.jsonl'), JSON.stringify({ operation: 'create', file_path: 'ignored/new.txt' }) + '\n'); return receipt(slot); };
  const meta = await runSlot(manifest, frozen, slot, dependencies);
  assert.deepEqual(events, ['model', 'cleanup', 'patch']); assert.match(fs.readFileSync(meta.patchPath, 'utf8'), /new file mode/);
  const next = frozen.schedule.find(row => row.cohort === 'swe' && row.id !== slot.id); events.length = 0;
  await assert.rejects(runSlot(manifest, frozen, next, { ...dependencies, runDshAttempt: async () => { throw new Error('transport broken'); } }), /transport broken/);
  assert.deepEqual(events, ['cleanup']);
});
test('a failed pre-patch teardown preserves its error and runs once', async t => {
  const { manifest, file } = fixture(t), frozen = freezeCampaign(file, { pinCollector: pins });
  const slot = frozen.schedule.find(row => row.cohort === 'swe'); let cleanups = 0;
  await assert.rejects(runSlot(manifest, frozen, slot, {
    prepareCommunitySlot: fakePrepare(), runDshAttempt: async () => receipt(slot),
    startSandbox: async () => ({ config: {}, cleanup: async () => { cleanups++; throw new Error('owned removal failed'); } }),
    collectPatch: async () => { throw new Error('must not collect an unstable patch'); },
  }), /owned removal failed/);
  assert.equal(cleanups, 1);
  const meta = JSON.parse(fs.readFileSync(path.join(manifest.evidenceDir, 'attempts', slot.id, 'slot-meta.json')));
  assert.equal(meta.status, 'infrastructure-failed'); assert.match(meta.error, /owned removal failed/);
});
test('official grading failure remains distinct from a completed DSH attempt', async t => {
  const { manifest, file } = fixture(t), frozen = freezeCampaign(file, { pinCollector: pins }), slot = frozen.schedule[0];
  const meta = await runSlot(manifest, frozen, slot, { prepareCommunitySlot: fakePrepare(), runDshAttempt: async () => receipt(slot), pinCollector: pins, grade: async () => { throw new Error('grader missing'); } });
  assert.equal(meta.status, 'attempt-completed'); assert.equal(meta.grade.status, 'failed'); assert.equal(meta.grade.resolved, null);
});
test('evaluation drift after DSH blocks grading while retaining completed attempt receipt', async t => {
  const { manifest, file } = fixture(t), frozen = freezeCampaign(file), slot = frozen.schedule[0];
  let gradeCalled = false;
  await assert.rejects(runSlot(manifest, frozen, slot, { prepareCommunitySlot: fakePrepare(), runDshAttempt: async () => {
    fs.appendFileSync(manifest.evaluation.inputFiles[0], 'changed'); return receipt(slot);
  }, grade: async () => { gradeCalled = true; } }), /inputs drifted/);
  const meta = JSON.parse(fs.readFileSync(path.join(manifest.evidenceDir, 'attempts', slot.id, 'slot-meta.json')));
  assert.equal(gradeCalled, false); assert.equal(meta.status, 'attempt-completed'); assert.equal(meta.grade.status, 'blocked-input-drift');
  assert.equal(JSON.parse(fs.readFileSync(meta.receiptPath)).status, 'attempt-completed');
});
test('Docker sandbox uses no network/pull, constrained mount, fixed exec launcher and verified removal', async t => {
  const { manifest, dir } = fixture(t), calls = [], task = manifest.tasks[12];
  const sandbox = await startSandbox(manifest, task, 'D:\\attempt\\source', { id: 'slot' }, dir, async (command, args) => {
    calls.push({ command, args }); return { code: 0, stdout: '', stderr: '' };
  });
  await sandbox.cleanup();
  assert.deepEqual(calls[1].args.slice(6), ['rm', '-fv', JSON.parse(fs.readFileSync(path.join(dir, 'sandbox-start.json'))).name]);
  for (const call of calls) assert.deepEqual(call.args.slice(0, 6), ['-d', 'Ubuntu', '-u', 'root', '--exec', 'docker']);
  assert.deepEqual(sandbox.config.argsPrefix.slice(0, 6), ['-d', 'Ubuntu', '-u', 'root', '--exec', 'docker']);
  assert.ok(calls[0].args.includes('none')); assert.ok(calls[0].args.includes('never')); assert.ok(calls[0].args.includes('type=bind,source=/mnt/d/attempt/source,target=/testbed'));
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--cap-drop'), calls[0].args.indexOf('--cap-drop') + 4), ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true']);
  assert.ok(calls[0].args.includes('type=bind,source=/mnt/d/attempt/source/.git,target=/testbed/.git,readonly'));
  assert.ok(calls[0].args.includes('GIT_OPTIONAL_LOCKS=0'));
  assert.deepEqual(sandbox.config.argsPrefix.slice(-2), ['bash', '-lc']); assert.equal(calls.length, 3);
});


test('owned cleanup rejects removal failure, failed absence query, and a remaining container', async t => {
  for (const failure of ['remove', 'query', 'present']) {
    await t.test(failure, async t => {
      const { manifest, dir } = fixture(t), task = manifest.tasks[12];
      const sandbox = await startSandbox(manifest, task, 'D:/attempt/source', { id: `cleanup-${failure}` }, dir, async (command, args) => {
        const operation = args[6];
        if (operation === 'rm' && failure === 'remove') return { code: 1, stdout: '', stderr: 'fixture daemon failure' };
        if (operation === 'ps' && failure === 'query') return { code: 1, stdout: '', stderr: 'fixture WSL failure' };
        if (operation === 'ps' && failure === 'present') return { code: 0, stdout: 'owned-container\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      });
      await assert.rejects(sandbox.cleanup(), /Owned sandbox cleanup failed/);
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'sandbox-cleanup.json')));
      assert.equal(receipt.removed.code, failure === 'remove' ? 1 : 0);
      assert.equal(receipt.verification.code, failure === 'query' ? 1 : 0);
      assert.equal(receipt.absent, failure === 'remove');
    });
  }
});

test('failed startup retains the startup error when cleanup also fails', async t => {
  const { manifest, dir } = fixture(t);
  await assert.rejects(startSandbox(manifest, manifest.tasks[12], 'D:/attempt/source', { id: 'failed-start' }, dir,
    async (command, args) => args[6] === 'ps' ? { code: 0, stdout: '', stderr: '' }
      : { code: 1, stdout: '', stderr: args[6] === 'run' ? 'image is missing' : 'No such container' }),
  error => error instanceof AggregateError && /image is missing/.test(error.message)
    && error.errors.length === 2 && /Owned sandbox cleanup failed/.test(error.errors[1].message));
  assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'sandbox-start.json'))).result.stderr, /image is missing/);
});
