import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { summarizeCampaign } from './summarize.mjs';

const readCampaign = async (name) => JSON.parse(await readFile(new URL(`./${name}`, import.meta.url), 'utf8'));

test('keeps the three reviewed campaigns separate and summarizes audited arms', async () => {
  const [pilot, cycle1, cycle2] = await Promise.all([
    readCampaign('pilot-results.json'),
    readCampaign('cycle-1-results.json'),
    readCampaign('cycle-2-results.json'),
  ]);
  const summaries = [
    summarizeCampaign(pilot, 'pilot-results.json'),
    summarizeCampaign(cycle1, 'cycle-1-results.json'),
    summarizeCampaign(cycle2, 'cycle-2-results.json'),
  ];
  assert.deepEqual(summaries.map((summary) => summary.source), ['pilot-results.json', 'cycle-1-results.json', 'cycle-2-results.json']);
  assert.deepEqual(summaries.map((summary) => summary.condition), [
    'guided-warm-single-turn-navigation',
    'guided-warm-single-turn-navigation-before-after',
    'guided-warm-single-turn-navigation-before-after',
  ]);
  assert.equal(summaries[0].arms.find((arm) => arm.id === 'baseline').usage.totalTokens, 1173059);
  assert.equal(summaries[1].arms.find((arm) => arm.id === 'after').tasks.find((task) => task.id === 'provider_contract').medians.totalTokens, 270648.5);
  assert.equal(summaries[2].arms.find((arm) => arm.id === 'after').usage.tokensPerCorrectCompletion, 405059.3);
  assert.equal(summaries[2].audit.eligibleRuns, 20);
});

test('uses all attempts in the failure-cost denominator', () => {
  const campaign = {
    schemaVersion: 1,
    date: '2026-09-12',
    condition: 'fixture',
    manualAudit: { eligibleRuns: 2, contaminationObserved: false, blockedCalls: 0, timeouts: 0 },
    runs: [
      { task: 'task', arm: 'before', repetition: 1, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, totalTokens: 100, grade: { score: 4, pass: true } },
      { task: 'task', arm: 'before', repetition: 2, inputTokens: 180, cachedInputTokens: 0, outputTokens: 20, totalTokens: 200, grade: { score: 1, pass: false } },
    ],
  };
  const summary = summarizeCampaign(campaign, 'fixture.json');
  const usage = summary.arms[0].usage;
  assert.equal(usage.totalTokens, 300);
  assert.equal(usage.tokensPerCorrectCompletion, 300);
  assert.equal(summary.arms[0].failedAttempts, 1);
  assert.equal(summary.arms[0].elapsedMs.total, null);
  assert.equal(summary.arms[0].elapsedMs.timePerCorrectCompletion, null);
});

test('retains a reviewed timed-out attempt in cost and elapsed accounting', () => {
  const campaign = {
    schemaVersion: 1,
    date: '2026-09-12',
    condition: 'timeout-fixture',
    manualAudit: { eligibleRuns: 2, contaminationObserved: false, blockedCalls: 0, timeouts: 1 },
    runs: [
      { task: 'task', arm: 'before', repetition: 1, inputTokens: 90, cachedInputTokens: 10, outputTokens: 10, totalTokens: 100, wallMs: 1000, executionCompleted: true, grade: { score: 4, pass: true } },
      { task: 'task', arm: 'before', repetition: 2, inputTokens: 180, cachedInputTokens: 20, outputTokens: 20, totalTokens: 200, wallMs: 2000, executionCompleted: false, grade: { score: 2, pass: false } },
    ],
  };
  const summary = summarizeCampaign(campaign, 'timeout-fixture.json');
  assert.equal(summary.arms[0].usage.totalTokens, 300);
  assert.equal(summary.arms[0].usage.tokensPerCorrectCompletion, 300);
  assert.equal(summary.arms[0].elapsedMs.total, 3000);
  assert.equal(summary.arms[0].elapsedMs.timePerCorrectCompletion, 3000);
});

test('reports null quality-gated savings and preserves mixed MCP non-use', async () => {
  const source = await readCampaign('cycle-2-results.json');
  const summary = summarizeCampaign(source, 'cycle-2-results.json');
  const failedPair = summary.matchedPairs.find((pair) => pair.task === 'extraction_failure' && pair.repetition === 2);
  assert.equal(failedPair.bothPass, false);
  assert.equal(failedPair.savingsPct, null);
  const mixed = summary.arms.find((arm) => arm.id === 'after').tasks.find((task) => task.id === 'Q4');
  assert.equal(mixed.results[0].mcpUsed, false);
  assert.equal(mixed.results[1].mcpUsed, true);
  assert.equal(summary.arms.find((arm) => arm.id === 'after').adoption.usedAttempts, 9);
  assert.equal(summary.arms.find((arm) => arm.id === 'after').adoption.nonUseAttempts, 1);
});

test('returns null tokens per correct completion when no attempt passes', () => {
  const campaign = {
    schemaVersion: 1,
    date: '2026-09-12',
    condition: 'fixture',
    manualAudit: { eligibleRuns: 1, contaminationObserved: false, blockedCalls: 0, timeouts: 0 },
    runs: [{ task: 'task', arm: 'before', repetition: 1, inputTokens: 10, cachedInputTokens: 2, outputTokens: 1, totalTokens: 11, grade: { score: 0, pass: false } }],
  };
  const summary = summarizeCampaign(campaign, 'fixture.json');
  assert.equal(summary.arms[0].usage.tokensPerCorrectCompletion, null);
});

test('fails explicitly when grade or usage evidence is malformed', async () => {
  const source = await readCampaign('cycle-1-results.json');
  const missingGrade = structuredClone(source);
  delete missingGrade.runs[0].grade;
  assert.throws(() => summarizeCampaign(missingGrade, 'missing-grade.json'), /grade must be an object/);

  const missingUsage = structuredClone(source);
  delete missingUsage.runs[0].inputTokens;
  assert.throws(() => summarizeCampaign(missingUsage, 'missing-usage.json'), /inputTokens must be a finite non-negative number/);

  const inconsistentGrade = structuredClone(source);
  inconsistentGrade.runs[0].grade.pass = false;
  assert.throws(() => summarizeCampaign(inconsistentGrade, 'inconsistent-grade.json'), /pass must agree with the score threshold/);

  const duplicateRun = structuredClone(source);
  duplicateRun.runs[1].task = duplicateRun.runs[0].task;
  duplicateRun.runs[1].arm = duplicateRun.runs[0].arm;
  duplicateRun.runs[1].repetition = duplicateRun.runs[0].repetition;
  assert.throws(() => summarizeCampaign(duplicateRun, 'duplicate-run.json'), /duplicate arm\/task\/repetition/);
});
