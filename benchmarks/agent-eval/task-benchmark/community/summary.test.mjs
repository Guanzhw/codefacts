import test from 'node:test';
import assert from 'node:assert/strict';
import { availability, summarizeAttempt, summarizeCampaign } from './summary.mjs';
import { buildSchedule } from './campaign.mjs';

const model = { provider: 'test', id: 'model', reasoningEffort: 'high' };

test('missing or lower-bound usage stays null, while actual zero remains zero', () => {
  assert.deepEqual(availability([0, null]), { total: null, knownTotal: 0, known: 1, missing: 1 });
  const row = summarizeAttempt({ id: 'slot', arm: 'ordinary' }, { id: 'task' }, {}, { knownUsageLowerBound: { totalTokens: 25 }, toolCalls: [] });
  assert.equal(row.totalTokens, null); assert.equal(row.knownUsageLowerBound.totalTokens, 25); assert.equal(row.toolCalls, 0);
});
test('completed official grading alone supplies SWE resolved', () => {
  const slot = { id: 'slot', arm: 'ordinary' }, task = { id: 'task', cohort: 'swe' };
  assert.equal(summarizeAttempt(slot, task, { grade: { status: 'failed', resolved: false } }).resolved, null);
  assert.equal(summarizeAttempt(slot, task, { grade: { status: 'completed', resolved: false } }).resolved, false);
});
test('exact input derives from exact total minus output without inventing cache breakdown', () => {
  const row = summarizeAttempt({ id: 'slot', arm: 'ordinary' }, { id: 'task' }, {}, { exactTurnUsage: { uncachedInputTokens: 270, outputTokens: 3209, totalTokens: 3479 } });
  assert.equal(row.inputTokens, 270); assert.equal(row.cacheReadTokens, null); assert.equal(row.cacheWriteTokens, null);
});
test('official grading receipt and slot wall clocks remain distinct and missing times stay null', () => {
  const slot = { id: 'slot', arm: 'ordinary' }, task = { id: 'task', cohort: 'swe' };
  const row = summarizeAttempt(slot, task, { slotWallMs: 1700, grade: { status: 'completed', resolved: false, receipt: { durationMs: 600 } } }, { durationMs: 1000 });
  assert.equal(row.gradeDurationMs, 600); assert.equal(row.slotWallMs, 1700); assert.equal(row.dshDurationMs, 1000);
  const missing = summarizeAttempt(slot, task, { grade: { status: 'pending', durationMs: 999 } });
  assert.equal(missing.gradeDurationMs, null); assert.equal(missing.slotWallMs, null);
  const frozen = { campaignId: 'test', manifest: { model, tasks: [{ ...task, split: 'pilot' }] }, schedule: buildSchedule([{ ...task, split: 'pilot' }]) };
  const summary = summarizeCampaign(frozen, [{ slotId: frozen.schedule[0].id, meta: { slotWallMs: 1700, grade: { status: 'completed', resolved: false, receipt: { durationMs: 600 } } } }]);
  assert.equal(summary.groups[0].arms.ordinary.resources.gradeDurationMs.total, 600);
  assert.equal(summary.groups[0].arms.ordinary.resources.slotWallMs.total, 1700);
  assert.equal(summary.groups[0].arms.codefacts022.resources.gradeDurationMs.total, null);
});
test('all scheduled attempts remain visible, cohort and split remain separate, paired resources include incorrect tasks', () => {
  const tasks = ['context', 'swe'].flatMap(cohort => ['pilot', 'confirmation_holdout'].flatMap(split => [0, 1].map(i => ({ id: `${cohort}-${split}-${i}`, cohort, split, instanceId: `issue-${i}`, language: 'go' }))));
  const frozen = { campaignId: 'test', manifest: { model, tasks }, schedule: buildSchedule(tasks) };
  const attempts = frozen.schedule.filter(slot => slot.arm !== 'codegraph').map(slot => ({ slotId: slot.id,
    meta: { status: 'attempt-completed', grade: { status: 'completed', resolved: slot.arm === 'ordinary' } },
    receipt: { exactTurnUsage: { totalTokens: slot.arm === 'ordinary' ? 100 : 200, outputTokens: 10, uncachedInputTokens: 80, cacheReadTokens: 10, cacheWriteTokens: 0 }, toolCalls: [] } }));
  const result = summarizeCampaign(frozen, attempts);
  assert.equal(result.attempts.length, 24); assert.equal(result.groups.length, 4);
  assert.equal(result.attempts.filter(row => row.status === 'not-started').length, 8);
  const paired = result.groups.find(group => group.cohort === 'swe' && group.split === 'pilot').paired.find(row => row.arm === 'codefacts022');
  assert.equal(paired.correctness.lost, 2); assert.equal(paired.resources.totalTokens.knownMeanDifference, 100);
  assert.equal(paired.resources.totalTokens.known, 2); assert.equal(paired.correctness.bothCorrect, 0);
  assert.equal(result.groups[0].arms.codegraph.resources.totalTokens.total, null);
});
test('native adoption counts actual calls including error results, no forced-use assumption', () => {
  const row = summarizeAttempt({ id: 'slot', arm: 'codefacts022' }, { id: 'task' }, {}, {
    toolCalls: [{ name: 'mcp__repo__codefacts_explore', callId: '1' }], toolResults: [{ message: { isError: true, toolCallId: '1' } }],
  });
  assert.equal(row.nativeCalls, 1); assert.equal(row.nativeAdopted, true); assert.equal(row.toolErrors, 1);
});
test('valid explored reports do not imply valid declared localization quality', () => {
  const task = { id: 'context', instanceId: 'issue', cohort: 'context', split: 'pilot', language: 'go' };
  const frozen = { campaignId: 'test', manifest: { model, tasks: [task] }, schedule: buildSchedule([task]) };
  const summary = summarizeCampaign(frozen, [{ slotId: frozen.schedule[0].id, meta: { status: 'attempt-completed', grade: { status: 'completed', resolved: null,
    metrics: { explored: { recall: 0.5 }, localization: null, editloc: null } } } }]);
  assert.deepEqual(summary.groups[0].arms.ordinary.validContextMetrics, { valid: 1, all: 1 });
  assert.deepEqual(summary.groups[0].arms.ordinary.validLocalizationQuality, { valid: 0, all: 1 });
  const localization = Object.fromEntries(['file', 'symbol', 'span', 'line'].map(level => [level, { coverage: 1, precision: 1 }]));
  const valid = summarizeCampaign(frozen, [{ slotId: frozen.schedule[0].id, meta: { status: 'attempt-completed', grade: { status: 'completed', resolved: null,
    metrics: { localization, explored: { auc_coverage: { line: 1 }, redundancy: { line: 0 } }, editloc: null } } } }]);
  assert.deepEqual(valid.groups[0].arms.ordinary.validLocalizationQuality, { valid: 1, all: 1 });
});
