import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from './build-manifest.mjs';
import { plan, schedule, validate } from './run.mjs';

const TEMPLATE = new URL('./manifest.example.json', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const JSON_READ = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function configuredManifest(root) {
  const manifest = JSON_READ(TEMPLATE);
  manifest.templateOnly = false;
  manifest.campaignId = 'fixture-campaign';
  manifest.seed = 'codefacts-usability-screen-20261019-v1';
  manifest.evidenceDir = path.join(root, 'template-evidence');
  manifest.runtime = { ...manifest.runtime, dshRoot: path.join(root, 'runtime', 'dsh'), node: path.join(root, 'runtime', 'node.exe'),
    sdkRoot: path.join(root, 'runtime', 'sdk'), rg: path.join(root, 'runtime', 'rg.exe'), wsl: path.join(root, 'runtime', 'wsl.exe'), wslDistro: 'FixtureLinux' };
  manifest.arms.find(arm => arm.id === 'codefacts022').executable = path.join(root, 'baseline', 'codefacts-022.exe');
  manifest.arms.find(arm => arm.id === 'codegraph').node = path.join(root, 'runtime', 'codegraph-node.exe');
  manifest.arms.find(arm => arm.id === 'codegraph').cli = path.join(root, 'runtime', 'codegraph.js');
  manifest.tasks.forEach(task => {
    const taskRoot = path.join(root, 'sources', task.instanceId), sourceRoot = path.join(taskRoot, 'source');
    fs.mkdirSync(sourceRoot, { recursive: true });
    task.sourceRoot = sourceRoot; task.manifestFile = path.join(taskRoot, 'manifest.json');
    if (task.instanceId === 'cli__cli-3608') task.gates.push({ id: 'trailing-blank-counterexample', file: 'fixture/trailing-blank.txt', start: 1, end: 2,
      criterion: 'Count the final blank source line using the runner line convention.', sha256: '' });
    const maximum = new Map();
    for (const gate of task.gates) maximum.set(gate.file, Math.max(maximum.get(gate.file) ?? 0, gate.end));
    const files = [...maximum.keys()].sort();
    const entries = files.map(file => {
      const count = maximum.get(file);
      const content = file === 'fixture/trailing-blank.txt' ? 'fixture line\n\n' : `${Array.from({ length: count }, (_, i) => `fixture ${i + 1}`).join('\n')}\n`;
      fs.mkdirSync(path.dirname(path.join(sourceRoot, file)), { recursive: true }); fs.writeFileSync(path.join(sourceRoot, file), content);
      return { path: file, bytes: Buffer.byteLength(content), sha256: digest(Buffer.from(content)) };
    });
    for (const gate of task.gates) gate.sha256 = entries.find(entry => entry.path === gate.file).sha256;
    const source = { repo: task.repo, baseCommit: task.baseCommit, instanceId: task.instanceId, entries };
    source.digest = digest(JSON.stringify(entries));
    task.sourceDigest = source.digest;
    fs.writeFileSync(task.manifestFile, JSON.stringify(source, null, 2) + '\n');
  });
  return manifest;
}

function buildArgs(root, manifestFile, { name, campaignId, seed }) {
  return ['--source-manifest', manifestFile, '--sources-root', path.join(root, 'sources'),
    '--candidate-exe', path.join(root, 'candidate', 'codefacts.exe'), '--evidence-dir', path.join(root, name, 'evidence'),
    '--output-dir', path.join(root, name, 'output'), '--campaign-id', campaignId, '--seed', seed];
}

function copyValidationTree(source, destination, relative = '') {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const entryRelative = path.join(relative, entry.name);
    if (entryRelative === path.join('community', 'usability-screen', 'tasks.json')) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyValidationTree(from, to, entryRelative);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

test('public template blocks use; builder preserves the fixed screen contract and refuses overwrites', () => {
  const rawTemplate = JSON_READ(TEMPLATE);
  assert.throws(() => plan(rawTemplate), /Template-only manifest/);
  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-screen-template-block-'));
  try {
    assert.throws(() => build(['--source-manifest', fileURLToPath(TEMPLATE), '--sources-root', blockedRoot,
      '--candidate-exe', path.join(blockedRoot, 'candidate.exe'), '--evidence-dir', path.join(blockedRoot, 'evidence'),
      '--output-dir', path.join(blockedRoot, 'output'), '--campaign-id', 'blocked-fixture', '--seed', 'blocked-seed']), /Template-only manifest/);
  } finally { fs.rmSync(blockedRoot, { recursive: true, force: true }); }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-screen-builder-'));
  try {
    const sourceManifest = configuredManifest(root), sourceFile = path.join(root, 'source-manifest.json');
    fs.writeFileSync(sourceFile, JSON.stringify(sourceManifest, null, 2) + '\n');
    const priorSchedule = schedule(sourceManifest);
    const sameArgs = buildArgs(root, sourceFile, { name: 'same', campaignId: 'fixture-same-seed', seed: sourceManifest.seed });
    build(sameArgs);
    const same = JSON_READ(path.join(root, 'same', 'output', 'manifest.json'));
    validate(same);
    const planned = plan(same);
    assert.equal(planned.modelCallsStarted, 0); assert.equal(planned.credentialValuesRead, false);
    assert.equal(planned.cells.length, 48); assert.equal(planned.sourcePins.length, 4);
    assert.ok(planned.missing.includes(same.arms.find(arm => arm.id === 'candidate').executable));
    assert.equal(same.campaignId, 'fixture-same-seed');
    assert.equal(same.seed, sourceManifest.seed);
    assert.equal(same.evidenceDir, path.join(root, 'same', 'evidence'));
    assert.deepEqual(schedule(same), priorSchedule);
    assert.deepEqual(same.models.map(({ key, id }) => [key, id]), sourceManifest.models.map(({ key, id }) => [key, id]));
    assert.deepEqual(same.tasks.map(({ id, instanceId, baseCommit, prompt, sourceDigest, gates }) => ({ id, instanceId, baseCommit, prompt, sourceDigest, gates })),
      sourceManifest.tasks.map(({ id, instanceId, baseCommit, prompt, sourceDigest, gates }) => ({ id, instanceId, baseCommit, prompt, sourceDigest, gates })));
    assert.equal(same.concurrency, 4); assert.equal(same.timeoutMs, 360000); assert.equal(same.maxOutputTokens, 16384);
    assert.equal(same.arms.find(arm => arm.id === 'candidate').executable, path.join(root, 'candidate', 'codefacts.exe'));
    const trailingGate = same.tasks[0].gates.find(gate => gate.id === 'trailing-blank-counterexample');
    assert.equal(trailingGate.end, 2);

    const newSeed = 'fixture-new-seed';
    const newArgs = buildArgs(root, sourceFile, { name: 'new-seed', campaignId: 'fixture-new-seed', seed: newSeed });
    build(newArgs);
    const changed = JSON_READ(path.join(root, 'new-seed', 'output', 'manifest.json'));
    assert.equal(changed.seed, newSeed);
    assert.notDeepEqual(schedule(changed), priorSchedule);
    assert.deepEqual(schedule(changed), schedule(changed));
    assert.deepEqual(schedule(changed).map(({ taskId, modelKey, arm }) => `${taskId}/${modelKey}/${arm}`).sort(),
      priorSchedule.map(({ taskId, modelKey, arm }) => `${taskId}/${modelKey}/${arm}`).sort());
    assert.throws(() => build(sameArgs), /already exists|EEXIST/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('builder output pins its configured protocol, external SDK dependency and adjacent tasks without module-local tasks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-screen-freeze-bootstrap-'));
  try {
    const sourceBenchmarkRoot = fileURLToPath(new URL('../../', import.meta.url));
    const copiedBenchmarkRoot = path.join(root, 'framework', 'benchmarks', 'agent-eval', 'task-benchmark');
    copyValidationTree(sourceBenchmarkRoot, copiedBenchmarkRoot);
    const screenDir = path.join(copiedBenchmarkRoot, 'community', 'usability-screen');
    const moduleTasks = path.join(screenDir, 'tasks.json');
    assert.equal(fs.existsSync(moduleTasks), false);
    const { build: buildCopied } = await import(pathToFileURL(path.join(screenDir, 'build-manifest.mjs')).href);
    const { assertFrozen: assertFrozenCopied, freeze: freezeCopied } = await import(pathToFileURL(path.join(screenDir, 'run.mjs')).href);

    const sourceManifest = configuredManifest(root), sourceFile = path.join(root, 'source-manifest.json');
    const externalDependency = path.join(root, 'shared-sdk-dependency', 'index.js');
    const externalProtocol = path.join(root, 'external-protocol', 'PROTOCOL.md');
    sourceManifest.selectionFile = externalProtocol;
    sourceManifest.evaluation = { runtimeFiles: [externalDependency] };
    fs.writeFileSync(sourceFile, JSON.stringify(sourceManifest, null, 2) + '\n');
    assert.ok(plan(sourceManifest).missing.includes(externalDependency));
    assert.ok(plan(sourceManifest).missing.includes(externalProtocol));
    const runtimeFiles = [externalProtocol, externalDependency, sourceManifest.runtime.node, sourceManifest.runtime.rg, sourceManifest.runtime.wsl,
      path.join(sourceManifest.runtime.dshRoot, 'lib', 'bin.js'), path.join(sourceManifest.runtime.sdkRoot, 'package.json'),
      path.join(root, 'runtime', 'package.json'),
      sourceManifest.arms.find(arm => arm.id === 'codefacts022').executable,
      sourceManifest.arms.find(arm => arm.id === 'codegraph').node,
      sourceManifest.arms.find(arm => arm.id === 'codegraph').cli,
      path.join(root, 'candidate', 'codefacts.exe')];
    for (const file of runtimeFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'synthetic runtime fixture');
    }

    const args = buildArgs(root, sourceFile, { name: 'external', campaignId: 'freeze-bootstrap', seed: 'freeze-bootstrap-seed' });
    buildCopied(args);
    const outputDir = path.join(root, 'external', 'output');
    const manifestPath = path.join(outputDir, 'manifest.json');
    const tasksPath = path.join(outputDir, 'tasks.json');
    assert.equal(fs.existsSync(tasksPath), true);
    assert.equal(fs.existsSync(moduleTasks), false);

    const manifest = JSON_READ(manifestPath), frozen = freezeCopied(manifestPath);
    assert.equal(manifest.selectionFile, externalProtocol);
    assert.ok(frozen.pins.some(pin => pin.path === externalProtocol && pin.sha256 === digest(fs.readFileSync(externalProtocol))));
    assert.ok(frozen.pins.some(pin => pin.path === tasksPath));
    assert.ok(frozen.pins.some(pin => pin.path === externalDependency && pin.sha256 === digest(fs.readFileSync(externalDependency))));
    fs.writeFileSync(externalProtocol, 'changed external protocol');
    assert.throws(() => assertFrozenCopied(manifest, frozen), /Frozen runtime or protocol drift/);
    fs.writeFileSync(externalProtocol, 'synthetic runtime fixture');
    assert.doesNotThrow(() => assertFrozenCopied(manifest, frozen));
    fs.writeFileSync(externalDependency, 'changed external SDK dependency');
    assert.throws(() => assertFrozenCopied(manifest, frozen), /Frozen runtime or protocol drift/);
    fs.writeFileSync(externalDependency, 'synthetic runtime fixture');
    assert.doesNotThrow(() => assertFrozenCopied(manifest, frozen));
    fs.writeFileSync(tasksPath, `${JSON.stringify({ changed: true })}\n`);
    assert.throws(() => assertFrozenCopied(manifest, frozen), /Frozen runtime or protocol drift/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
