import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validate, schedule, buildPrompt, plan, reviewEvidence, runCell } from './run.mjs';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-screen-manifest-fixture-'));
  const tasks = ['cli__cli-3608', 'nushell__nushell-12901', 'sveltejs__svelte-3394', 'mui__material-ui-34229'].map((instanceId, index) => {
    const sourceRoot = path.join(root, instanceId, 'source'); fs.mkdirSync(sourceRoot, { recursive: true });
    const files = [`src/${index}.rs`, `tests/${index}.rs`, `src/extra-${index}.rs`];
    const entries = files.map(file => {
      const bytes = `fixture ${instanceId} ${file}\n`;
      fs.mkdirSync(path.dirname(path.join(sourceRoot, file)), { recursive: true }); fs.writeFileSync(path.join(sourceRoot, file), bytes);
      return { path: file, bytes: Buffer.byteLength(bytes), sha256: digest(Buffer.from(bytes)) };
    });
    const source = { repo: instanceId, baseCommit: String(index + 1).padStart(40, '0'), instanceId, entries };
    source.digest = digest(JSON.stringify(entries));
    const manifestFile = path.join(root, instanceId, 'manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify(source));
    return { id: `ctx-${instanceId}`, instanceId, cohort: 'context', repo: source.repo, baseCommit: source.baseCommit,
      sourceRoot, manifestFile, sourceDigest: source.digest,
      prompt: `Issue ${instanceId}. Investigation: explain the production behavior and regression coverage.`,
      gates: files.map((file, gateIndex) => ({ id: `gate-${gateIndex}`, file, start: 1, end: 1,
        criterion: `Explain behavior in ${file}.`, sha256: entries[gateIndex].sha256 })) };
  });
  const manifest = { schemaVersion: 1, campaignId: 'fixture-screen', seed: 'fixture-seed', evidenceDir: path.join(root, 'evidence'),
    concurrency: 4, timeoutMs: 360000, maxOutputTokens: 16384,
    runtime: { node: path.join(root, 'missing-node'), rg: path.join(root, 'missing-rg'), dshRoot: path.join(root, 'missing-dsh'),
      sdkRoot: path.join(root, 'missing-sdk'), contextSourceMode: 'copy', contextGitMode: 'boundary-only' },
    arms: [{ id: 'ordinary' }, { id: 'codefacts022', executable: path.join(root, 'missing-baseline.exe') },
      { id: 'candidate', executable: path.join(root, 'missing-candidate.exe') }, { id: 'codegraph', node: path.join(root, 'missing-cg-node'), cli: path.join(root, 'missing-cg.js') }],
    models: [['qwen', 'qwen3.8-flash'], ['claude', 'claude-haiku-5-5'], ['gpt', 'gpt-6-luna']].map(([key, id]) => ({ key, id, provider: 'opencode-go', reasoningEffort: 'high' })), tasks };
  return { root, manifest };
}
const FIXTURE = makeFixture();
const manifest = FIXTURE.manifest;
after(() => fs.rmSync(FIXTURE.root, { recursive: true, force: true }));

test('48 reproducible independent cells preserve four product arms and three declared routes', () => {
  validate(manifest); const cells = schedule(manifest);
  assert.equal(cells.length, 48); assert.equal(new Set(cells.map(x => x.id)).size, 48);
  assert.deepEqual(schedule(manifest), cells);
  for (const task of manifest.tasks) for (const model of manifest.models) {
    assert.deepEqual(cells.filter(x => x.taskId === task.id && x.modelKey === model.key).map(x => x.arm).sort(), ['candidate', 'codefacts022', 'codegraph', 'ordinary']);
  }
  for (const task of manifest.tasks) {
    assert.match(buildPrompt(task), /native use is optional/);
    assert.match(buildPrompt(task), /whether the reported issue is present/);
    assert.match(buildPrompt(task), /already supported/);
    assert.doesNotMatch(buildPrompt(task), /sha256|sourceDigest|criterion|declaredOverlap/);
  }
});

test('plan starts no model and preserves exact source identities and missing runtime inputs', () => {
  const result = plan(manifest);
  assert.equal(result.modelCallsStarted, 0); assert.equal(result.credentialValuesRead, false);
  assert.equal(result.sourcePins.length, 4); assert.equal(result.cells.length, 48);
  assert.deepEqual(result.sourcePins.map(x => x.commit), manifest.tasks.map(t => t.baseCommit));
});

test('overlapping locators never automatically pass semantic task quality', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-screen-review-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.rs'), 'fn target() {}\n');
    const task = { gates: [{ id: 'owner', file: 'a.rs', start: 1, end: 1, criterion: 'Connect cause to implementation' }] };
    const review = reviewEvidence(task, JSON.stringify({ regions: [{ file_path: 'a.rs', start_line: 1, end_line: 1 }], rationale: 'unverified claim' }), dir);
    assert.equal(review.locatorGates[0].declaredOverlap, true);
    assert.equal(review.semanticReviewStatus, 'pending-independent-source-review');
    assert.equal(reviewEvidence(task, '{bad', dir).declarationStatus, 'invalid-final-json');
    assert.equal(reviewEvidence(task, JSON.stringify({ regions: [{ file_path: 'a.rs', start_line: 1, end_line: 2 }], rationale: '' }), dir).declarationStatus, 'invalid-final-region');
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('candidate uses existing CF prepare and DSH adapter contract with a private cell namespace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-screen-cell-'));
  try {
    const config = { ...manifest, evidenceDir: dir }, cell = schedule(config).find(x => x.arm === 'candidate');
    let seenPrepare, seenAttempt;
    const output = await runCell(config, { manifestHash: 'fixture' }, cell, {
      prepare: async options => {
        seenPrepare = options; const root = path.join(options.dir, 'source'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'a.rs'), 'fn target() {}\n');
        return { root, bridgeConfig: path.join(options.dir, 'bridge-config.json'), setup: { durationMs: 1 }, entries: [] };
      },
      attempt: async options => {
        seenAttempt = options;
        return { status: 'attempt-completed', answer: '{"regions":[],"rationale":"fixture"}', didInitialize: true, headerAudit: true,
          catalogs: [[...['source_list', 'source_read', 'source_search', 'codefacts_explore', 'codefacts_expand', 'codefacts_impact'].map(name => ({ name: `mcp__repo__${name}` }))]],
          actualRequestHeaders: [{}], toolCalls: [], exactTurnUsage: null, knownUsageLowerBound: { totalTokens: 3 }, usageAvailability: 'known-lower-bound', timings: { promptedAtMs: 20, turnEndedAtMs: 100 }, durationMs: 120 };
      }, verify: () => ({ verified: true }),
    });
    assert.equal(seenPrepare.arm.id, 'codefacts022');
    assert.equal(seenPrepare.arm.executable, manifest.arms.find(a => a.id === 'candidate').executable);
    assert.equal(seenAttempt.model, config.models.find(m => m.key === cell.modelKey).id);
    assert.equal(seenAttempt.maxOutputTokens, 16384);
    assert.equal(output.audit.nativeCalls, 0); assert.equal(output.audit.nativeAdopted, false);
    assert.equal(output.tokenUsage.exact, null); assert.equal(output.tokenUsage.knownLowerBound.totalTokens, 3);
    assert.equal(output.grade.resolved, null); assert.equal(output.review.semanticReviewStatus, 'pending-independent-source-review');
    assert.equal(output.modelDurationMs, 80); assert.equal(output.sdkProcessDurationMs, 120);
    await assert.rejects(runCell(config, {}, cell), /already exists/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('attempt failures remain explicit allocated outcomes without retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-screen-failure-'));
  try {
    const output = await runCell({ ...manifest, evidenceDir: dir }, {}, schedule(manifest)[0], { prepare: async () => { throw new Error('fixture source failure'); } });
    assert.equal(output.status, 'infrastructure-or-attempt-failed'); assert.equal(output.error, 'fixture source failure'); assert.equal(output.grade.resolved, null);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('missing model boundaries and SDK duration remain null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-screen-time-'));
  try {
    const output = await runCell({ ...manifest, evidenceDir: dir }, {}, schedule(manifest)[0], {
      prepare: async options => { const root = path.join(options.dir, 'source'); fs.mkdirSync(root); return { root, bridgeConfig: 'fixture', entries: [], setup: {} }; },
      attempt: async () => ({ status: 'attempt-failed', answer: '', timings: { promptedAtMs: 20, turnEndedAtMs: null }, toolCalls: [] }),
      verify: () => ({ verified: true }),
    });
    assert.equal(output.modelDurationMs, null); assert.equal(output.sdkProcessDurationMs, null);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
