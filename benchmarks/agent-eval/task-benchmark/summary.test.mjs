import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCampaign } from './summary.mjs';

const run = (overrides = {}) => ({
  id: 'r', taskId: 't', arm: 'ordinary', condition: 'guided-use', repetition: 1, status: 'completed',
  wallMs: 100, setupMs: 10,
  usage: { uncachedInputTokens: 80, outputTokens: 20, totalTokens: 120, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 8 },
  toolCalls: { ordinary: 2, native: 0, nativeSuccessful: 0 },
  traceAudit: { valid: true, adherent: true, reasons: [] },
  grade: { criteria: ['C1', 'C2', 'C3', 'C4'].map((id) => ({ id, pass: true })), criticalFalseClaim: false, fullyCorrect: true, reviewer: 'reviewer', locked: true },
  ...overrides,
});
const campaign = (runs) => ({ schemaVersion: 1, suiteId: 'fixture', metadata: {}, runs });

test('separates conditions and compares each arm using quality-gated matched pairs', () => {
  const runs = [];
  for (const condition of ['guided-use', 'natural-choice']) for (const arm of ['ordinary', 'codefacts017', 'codefacts022', 'codegraph']) {
    runs.push(run({ id: `${condition}-${arm}`, condition, arm, usage: { uncachedInputTokens: 80, outputTokens: 20, totalTokens: arm === 'ordinary' ? 120 : 90 } }));
  }
  const out = summarizeCampaign(campaign(runs));
  assert.equal(out.groups.length, 8);
  const guided = out.comparisons.find((c) => c.condition === 'guided-use' && c.baselineArm === 'ordinary' && c.candidateArm === 'codefacts017');
  const natural = out.comparisons.find((c) => c.condition === 'natural-choice' && c.baselineArm === 'ordinary' && c.candidateArm === 'codefacts017');
  assert.equal(guided.eligiblePairs, 1);
  assert.equal(guided.eligible[0].tokenDeltaPct, -25);
  assert.equal(guided.claimableEffect, true);
  assert.equal(natural.eligiblePairs, 1);
  assert.notEqual(guided.condition, natural.condition);
});

test('unknown usage stays unknown; failed work costs remain in totals and disable cost-per-correct', () => {
  const out = summarizeCampaign(campaign([
    run({ id: 'ok', usage: { uncachedInputTokens: 10, outputTokens: 3, totalTokens: 20, cacheReadTokens: 7 } }),
    run({ id: 'fail', repetition: 2, status: 'failed', wallMs: 200, setupMs: 30, usage: null }),
  ]));
  const g = out.groups.find((x) => x.condition === 'guided-use' && x.arm === 'ordinary');
  assert.equal(g.attempts, 2);
  assert.equal(g.failed, 1);
  assert.equal(g.wallMs.allAttemptTotal, 300);
  assert.equal(g.setupMsTotal, 40);
  assert.equal(g.tokens.authoritativeTotal, 20);
  assert.equal(g.tokens.workloadTotalIsLowerBound, true);
  assert.deepEqual(g.tokens.coverage, { known: 1, unknown: 1, total: 2 });
  assert.equal(g.tokens.costPerCorrect, null);
  assert.equal(g.tokens.uncachedInputTotalKnownOnly, null);
  assert.equal(g.tokens.meanKnownSampleTotal, 20);
});

test('adds observed failed-turn token lower bounds without changing exact-usage coverage or paired eligibility', () => {
  const failedGrade = { ...run().grade, criteria: run().grade.criteria.map((c, i) => i === 0 ? { ...c, pass: false } : c), fullyCorrect: false };
  const out = summarizeCampaign(campaign([
    run({ id: 'exact', usage: { uncachedInputTokens: 70, outputTokens: 30, totalTokens: 100 } }),
    run({ id: 'failed', repetition: 2, status: 'failed', usage: null,
      knownUsageLowerBound: { uncachedInputTokens: 5, outputTokens: 2, totalTokens: 7 }, grade: failedGrade }),
    run({ id: 'candidate', arm: 'codefacts017', repetition: 2 }),
  ]));
  const g = out.groups.find((x) => x.condition === 'guided-use' && x.arm === 'ordinary');
  assert.equal(g.tokens.authoritativeTotal, 107);
  assert.equal(g.tokens.knownExactTotal, 100);
  assert.equal(g.tokens.knownLowerBoundFromIncomplete, 7);
  assert.equal(g.tokens.meanKnownSampleTotal, 100);
  assert.deepEqual(g.tokens.coverage, { known: 1, unknown: 1, total: 2 });
  assert.equal(g.tokens.costPerCorrect, null);
  const pair = out.comparisons.find((c) => c.baselineArm === 'ordinary' && c.candidateArm === 'codefacts017');
  assert.equal(pair.eligiblePairs, 0);
  assert.equal(pair.exclusionReasonCounts['baseline:failed'], 1);
  assert.equal(pair.claimableEffect, false);
});

test('rejects a partial-usage lower bound alongside exact usage', () => {
  assert.throws(() => summarizeCampaign(campaign([run({ knownUsageLowerBound: { totalTokens: 1 } })])), /only valid when usage is null/);
});

test('uses authoritative total and never adds cache or reasoning subsets to it', () => {
  const g = summarizeCampaign(campaign([run()])).groups.find((x) => x.arm === 'ordinary' && x.condition === 'guided-use');
  assert.equal(g.tokens.authoritativeTotal, 120);
  assert.equal(g.tokens.uncachedInputTotalKnownOnly, 80);
  assert.equal(g.tokens.cacheReadTotalKnownOnly, 5);
  assert.equal(g.tokens.cacheWriteTotalKnownOnly, 2);
  assert.equal(g.tokens.reasoningTotalKnownOnly, 8);
  assert.equal(g.tokens.costPerCorrect, 120);
});

test('derives full input from exact authoritative total less output and requires complete usage coverage', () => {
  const exact = summarizeCampaign(campaign([run({ usage: { uncachedInputTokens: 90, outputTokens: 2, totalTokens: 107 } })]))
    .groups.find((g) => g.arm === 'ordinary' && g.condition === 'guided-use');
  assert.equal(exact.tokens.fullInputTotalKnownOnly, 105);
  assert.match(exact.tokens.fullInputTotalDefinition, /totalTokens - outputTokens/);

  const partial = summarizeCampaign(campaign([
    run({ id: 'exact', usage: { uncachedInputTokens: 90, outputTokens: 2, totalTokens: 107 } }),
    run({ id: 'unknown', repetition: 2, status: 'failed', usage: null,
      knownUsageLowerBound: { uncachedInputTokens: 3, outputTokens: 1, totalTokens: 4 } }),
  ])).groups.find((g) => g.arm === 'ordinary' && g.condition === 'guided-use');
  assert.equal(partial.tokens.coverage.known, 1);
  assert.equal(partial.tokens.coverage.unknown, 1);
  assert.equal(partial.tokens.fullInputTotalKnownOnly, null);
});

test('rejects usage where output exceeds authoritative total', () => {
  assert.throws(() => summarizeCampaign(campaign([run({ usage: { uncachedInputTokens: 1, outputTokens: 3, totalTokens: 2 } })])), /outputTokens exceeds totalTokens/);
});

test('requires complete locked grades and rejects contradiction and duplicate schedule cells', () => {
  assert.throws(() => summarizeCampaign(campaign([run({ grade: { ...run().grade, locked: false } })])), /locked must be true/);
  assert.throws(() => summarizeCampaign(campaign([run({ grade: { ...run().grade, fullyCorrect: false } })])), /contradicts/);
  assert.throws(() => summarizeCampaign(campaign([run(), run({ id: 'second' })])), /duplicate condition\/task\/arm\/repetition/);
  assert.throws(() => summarizeCampaign(campaign([run(), run()])), /duplicate run id/);
});

test('critical false claim prevents full correctness and protocol nonadherence excludes a pair', () => {
  const baseline = run({ id: 'b', arm: 'ordinary' });
  const candidate = run({ id: 'c', arm: 'codefacts017', traceAudit: { valid: true, adherent: false, reasons: ['unapproved-call'] } });
  const critical = run({ id: 'critical', arm: 'codefacts022', grade: { ...run().grade, criticalFalseClaim: true, fullyCorrect: false } });
  const out = summarizeCampaign(campaign([baseline, candidate, critical]));
  assert.equal(out.groups.find((g) => g.arm === 'codefacts022').fullyCorrect, 0);
  const pair = out.comparisons.find((c) => c.baselineArm === 'ordinary' && c.candidateArm === 'codefacts017');
  assert.equal(pair.possiblePairs, 1);
  assert.equal(pair.eligiblePairs, 0);
  assert.equal(pair.claimableEffect, false);
  assert.deepEqual(pair.excluded[0].reasons, ['candidate:trace-nonadherent']);
});

test('invalid environment is counted separately and never creates eligible savings', () => {
  const out = summarizeCampaign(campaign([
    run({ id: 'b', arm: 'ordinary', status: 'invalid-environment' }),
    run({ id: 'c', arm: 'codefacts017' }),
  ]));
  assert.equal(out.groups.find((g) => g.arm === 'ordinary').invalidEnvironment, 1);
  const pair = out.comparisons.find((c) => c.baselineArm === 'ordinary' && c.candidateArm === 'codefacts017');
  assert.equal(pair.eligiblePairs, 0);
  assert.equal(pair.exclusionReasonCounts['baseline:invalid-environment'], 1);
  assert.equal(pair.medianTokenDeltaPct, null);
});

test('reports zero native adoption while retaining successful-use task count when present', () => {
  const out = summarizeCampaign(campaign([
    run({ id: 'zero', toolCalls: { ordinary: 2, native: 0, nativeSuccessful: 0 } }),
    run({ id: 'used', taskId: 'other', arm: 'codefacts017', toolCalls: { ordinary: 0, native: 3, nativeSuccessful: 2 } }),
  ]));
  assert.equal(out.groups.find((g) => g.arm === 'ordinary').nativeActualCalls, 0);
  assert.equal(out.groups.find((g) => g.arm === 'ordinary').nativeAdoptionTasks, 0);
  assert.equal(out.groups.find((g) => g.arm === 'codefacts017').nativeActualCalls, 3);
  assert.equal(out.groups.find((g) => g.arm === 'codefacts017').nativeAdoptionTasks, 1);
});
