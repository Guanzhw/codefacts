import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { publishCampaign, main } from './publish.mjs';

const ANSWER = '/hello/%world is a malformed URL.\nThe /some/path source claim uses https://example.org/some/path.\nThe [navigation tool] returned index.js:20-25.\n';

function fixture(t, repetitions = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codefacts-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const suite = { suiteId: 'fixture', tasks: [{ id: 'router-01', corpus: 'router' }] };
  const runs = [], mapping = [];
  for (const condition of ['guided-use', 'natural-choice']) for (const arm of ['ordinary', 'codefacts017', 'codefacts022', 'codegraph']) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const id = `${condition}-${arm}-r${repetition}`, sample = `sample-${id}`;
    runs.push({ id, taskId: 'router-01', condition, arm, repetition, status: 'completed', wallMs: arm === 'ordinary' ? 2000 : 1000, setupMs: 100,
      usage: { uncachedInputTokens: 70, outputTokens: 30, totalTokens: arm === 'ordinary' ? 200 : 100 },
      toolCalls: { ordinary: 1, native: arm === 'ordinary' ? 0 : 1, nativeSuccessful: arm === 'ordinary' ? 0 : 1 },
      traceAudit: { valid: true, adherent: true, reasons: [] },
      grade: { locked: true, reviewer: 'independent', criteria: ['C1', 'C2', 'C3', 'C4'].map(id => ({ id, pass: true, evidence: 'index.js:20-25' })), criticalFalseClaim: false, fullyCorrect: true },
      evidence: { receiptPath: 'D:\\private\\campaign\\receipt.json', slotMeta: '/home/private/campaign/slot-meta.json' },
      gradingAnswerSha256: createHash('sha256').update(ANSWER).digest('hex') });
    mapping.push({ sample, slotId: id, taskId: 'router-01' });
    fs.mkdirSync(path.join(dir, 'blind', 'router-01'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'blind', 'router-01', sample + '.md'), ANSWER);
  }
  const campaign = { schemaVersion: 1, suiteId: suite.suiteId, metadata: { plannedAttempts: runs.length, observedAttempts: runs.length, pending: [], concurrency: 1, model: { model: 'fixed-model' } }, runs };
  const opts = { input: path.join(dir, 'reviewed-results.json'), suite: path.join(dir, 'tasks.json'), blind: path.join(dir, 'blind'), output: path.join(dir, 'published') };
  save(opts.input, campaign); save(opts.suite, suite); save(path.join(dir, 'unblinded-map.json'), mapping);
  return { opts, campaign, save };
}

test('publishes portable per-run answers, locked source grades and exact all-attempt costs', t => {
  const { opts } = fixture(t);
  const { results, summary, report } = publishCampaign(opts);
  assert.equal(results.runs.length, 8);
  assert.equal(results.runs[0].grade.criteria[0].evidence, 'index.js:20-25');
  assert.equal(results.runs[0].answer, ANSWER);
  assert.equal(results.runs[0].answerSha256, createHash('sha256').update(results.runs[0].answer).digest('hex'));
  const disk = fs.readFileSync(path.join(opts.output, 'results.json'), 'utf8');
  assert.equal(disk.includes('private'), false);
  assert.equal(disk.includes('D:'), false);
  assert.equal(disk.includes('/home/'), false);
  assert.equal(JSON.parse(disk).runs[0].evidence.receiptPath, '[local evidence retained outside publication]');
  assert.equal(JSON.parse(disk).runs[0].answer, ANSWER);
  const ordinary = summary.groups.find(g => g.condition === 'guided-use' && g.arm === 'ordinary');
  assert.equal(ordinary.tokens.authoritativeTotal, 200);
  assert.equal(ordinary.tokens.costPerCorrect, 200);
  assert.match(report, /\n\| Arm \| Median task s/);
  assert.match(report, /### JavaScript/);
  assert.match(report, /\| ordinary \| codefacts022 \| 1\/1 \| -50 \| -50 \|/);
  assert.equal(fs.readFileSync(path.join(opts.output, 'REPORT.md'), 'utf8'), report);
  assert.ok(report.endsWith('\n'));
  assert.throws(() => publishCampaign(opts), /new or empty/);
});

test('exact costs plus failed attempt lower bounds stay in workload costs and disqualify affected pairs', t => {
  const { opts, campaign, save } = fixture(t, 2);
  Object.assign(campaign.runs[0], { status: 'failed', usage: null, knownUsageLowerBound: { uncachedInputTokens: 7, outputTokens: 3, totalTokens: 10 } });
  campaign.runs[0].grade.criteria[0].pass = false;
  campaign.runs[0].grade.fullyCorrect = false;
  save(opts.input, campaign);
  const { summary, report } = publishCampaign(opts);
  const group = summary.groups.find(g => g.condition === 'guided-use' && g.arm === 'ordinary');
  assert.equal(group.tokens.authoritativeTotal, 210);
  assert.equal(group.tokens.authoritativeTotalIsLowerBound, true);
  assert.equal(group.tokens.medianKnownSampleTotal, 200);
  assert.equal(group.tokens.costPerCorrect, null);
  assert.deepEqual(group.tokens.coverage, { known: 1, unknown: 1, total: 2 });
  const pair = summary.comparisons.find(c => c.condition === 'guided-use' && c.baselineArm === 'ordinary' && c.candidateArm === 'codefacts022');
  assert.equal(pair.possiblePairs, 2); assert.equal(pair.eligiblePairs, 1);
  assert.match(report, /\| ordinary \| 2 \| 200 \| >= 210 \| 0\/2 \| 0\/1 \| unknown \|/);
});

test('rejects ungraded, unlocked, incomplete and missing schedule cells before writing', t => {
  for (const change of [
    c => { c.runs[0].grade = null; },
    c => { c.runs[0].grade.locked = false; },
    c => { c.metadata.pending = ['not-done']; },
    c => { c.metadata.plannedAttempts = 9; },
    c => { c.runs.pop(); c.metadata.plannedAttempts = c.metadata.observedAttempts = 7; },
  ]) {
    const { opts, campaign, save } = fixture(t);
    change(campaign); save(opts.input, campaign);
    assert.throws(() => publishCampaign(opts), /grade|incomplete/);
    assert.equal(fs.existsSync(opts.output), false);
  }
});

test('rejects changed or unbound grading answers before publishing', t => {
  for (const missingHash of [false, true]) {
    const { opts, campaign, save } = fixture(t);
    if (missingHash) { delete campaign.runs[0].gradingAnswerSha256; save(opts.input, campaign); }
    else {
      const sample = JSON.parse(fs.readFileSync(path.join(path.dirname(opts.input), 'unblinded-map.json'), 'utf8'))[0].sample;
      fs.writeFileSync(path.join(opts.blind, 'router-01', sample + '.md'), ANSWER + 'changed');
    }
    assert.throws(() => publishCampaign(opts), /Graded answer identity/);
    assert.equal(fs.existsSync(opts.output), false);
  }
});

test('rejects malformed CLI', () => {
  assert.throws(() => main(['--input', 'relative.json']), /required/);
});
