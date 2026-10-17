import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash } from '../rpc.mjs';
import { buildSchedule } from './campaign.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const selection = JSON.parse(fs.readFileSync(path.join(here, 'selection-fixed-24.json'), 'utf8')).selections;
const deepseek = { provider: 'opencode-go', id: 'deepseek-v4.1-flash', reasoningEffort: 'high' };
// Synthetic identifiers exercise configuration transport, not route availability.
const otherFamily = { provider: 'fixture-provider', id: 'fixture-other-family', reasoningEffort: 'off' };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-operator-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcesDir = path.join(dir, 'sources'), dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'public-tasks.jsonl'), selection.map(row => JSON.stringify({ ...row, problem_statement: `Investigate ${row.id}` })).join('\n') + '\n');
  const contextBases = {};
  for (const row of selection) {
    const sourceDir = path.join(sourcesDir, row.dataset, row.id);
    fs.mkdirSync(path.join(sourceDir, 'source'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({
      instanceId: row.id, repo: row.repo, baseCommit: row.base_commit, entries: [], digest: hash([]),
    }));
    if (row.dataset === 'contextbench') contextBases[`ctx-${row.id}`] = { fixture: true };
  }
  const gradingConfigFile = path.join(dir, 'grading.json');
  fs.writeFileSync(gradingConfigFile, JSON.stringify({ contextBases, grading: { context: { fixture: true }, swe: { fixture: true } } }));
  const config = {
    cohort: 'context', campaignId: 'context-fixture', dataDir, sourcesDir,
    sourceEvidenceDir: path.join(dir, 'source-evidence'), setupDir: path.join(dir, 'setup'), gradingConfigFile,
    model: deepseek,
    runtime: { dshRoot: dir, node: process.execPath, sdkRoot: dir, rg: process.execPath, wsl: process.execPath },
    arms: [
      { id: 'ordinary' },
      { id: 'codefacts022', version: '0.2.2', executable: process.execPath },
      { id: 'codegraph', version: '1.6.2', node: process.execPath, cli: process.execPath },
    ],
    inputFiles: [gradingConfigFile], upstreamRoots: [dir], runtimeFiles: [process.execPath],
    sandboxes: Object.fromEntries(selection.filter(row => row.dataset === 'swebench_multilingual').map(row => [row.id, { image: `sha256:${'1'.repeat(64)}`, workspaceVerified: true }])),
  };
  const configPath = path.join(dir, 'operator.json');
  const run = (value = config, execute = true) => {
    fs.writeFileSync(configPath, JSON.stringify(value));
    return spawnSync(process.execPath, [path.join(here, 'operator.mjs'), '--mode', 'manifest', '--config', configPath, ...(execute ? ['--execute'] : [])], {
      cwd: dir, encoding: 'utf8', timeout: 20000,
    });
  };
  return { dir, config, configPath, run };
}

test('operator preserves explicit model declarations and the full fixed three-arm cohort for each model', t => {
  const { dir, config, configPath, run } = fixture(t);
  for (const cohort of ['context', 'swe']) {
    const manifests = [];
    for (const [index, model] of [deepseek, otherFamily].entries()) {
      const current = { ...config, cohort, model, campaignId: `${cohort}-model-${index}`, setupDir: path.join(dir, `${cohort}-model-${index}`) };
      const result = run(current);
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(fs.readFileSync(path.join(current.setupDir, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.model, model);
      assert.equal(manifest.campaignId, current.campaignId);
      assert.equal(manifest.evidenceDir, path.join(current.setupDir, 'campaign'));
      assert.ok(manifest.evaluation.inputFiles.includes(configPath));
      assert.equal(manifest.concurrency, 1);
      assert.equal(manifest.timeoutMs, 1200000);
      assert.equal(manifest.maxOutputTokens, 32768);
      assert.deepEqual(manifest.runtime, config.runtime);
      assert.deepEqual(manifest.arms, config.arms);
      const selected = selection.filter(row => row.dataset === (cohort === 'context' ? 'contextbench' : 'swebench_multilingual'));
      assert.equal(manifest.tasks.length, 12);
      assert.deepEqual(manifest.tasks.map(task => task.instanceId), selected.map(row => row.id));
      assert.deepEqual(manifest.tasks.map(task => task.baseCommit), selected.map(row => row.base_commit));
      const schedule = buildSchedule(manifest.tasks);
      assert.equal(schedule.length, 36);
      for (const task of manifest.tasks) assert.deepEqual(schedule.filter(slot => slot.taskId === task.id).map(slot => slot.arm).sort(), ['codefacts022', 'codegraph', 'ordinary']);
      for (const arm of ['ordinary', 'codefacts022', 'codegraph']) for (let position = 1; position <= 3; position++) {
        assert.equal(schedule.filter(slot => slot.arm === arm && slot.position === position).length, 4);
      }
      manifests.push(manifest);
    }
    assert.deepEqual(manifests[0].tasks, manifests[1].tasks);
    assert.deepEqual(buildSchedule(manifests[0].tasks), buildSchedule(manifests[1].tasks));
  }
});

test('operator rejects missing or invalid explicit model fields before allocating campaign files', t => {
  const { config, run } = fixture(t);
  const invalid = [
    [undefined, 'provider'], [null, 'provider'], [{}, 'provider'],
    [{ ...otherFamily, provider: '' }, 'provider'],
    [{ ...otherFamily, id: undefined }, 'id'],
    [{ ...otherFamily, id: '  ' }, 'id'],
    [{ ...otherFamily, reasoningEffort: undefined }, 'reasoningEffort'],
    [{ ...otherFamily, reasoningEffort: 0 }, 'reasoningEffort'],
  ];
  for (const [model, field] of invalid) {
    const result = run({ ...config, model });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`model.${field} must be a nonempty string`));
    assert.equal(fs.existsSync(config.setupDir), false);
  }
});

test('operator plan validates the declared route without allocating a campaign', t => {
  const { config, run } = fixture(t);
  const result = run({ ...config, model: otherFamily }, false);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { mode: 'manifest', execute: false, status: 'manifest-validated', tasks: 12 });
  assert.equal(fs.existsSync(config.setupDir), false);
});

test('operator template includes an explicit DeepSeek model example', () => {
  const template = JSON.parse(fs.readFileSync(path.join(here, 'operator.template.json'), 'utf8'));
  assert.deepEqual(template.model, deepseek);
});
