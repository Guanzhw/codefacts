import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule } from './campaign.mjs';
import { summarizeCampaign } from './summary.mjs';
import { summarizeSuite } from './suite-summary.mjs';

function fixture(change = () => {}, extraPilot = false) {
  const models = ['a', 'b'].map(id => ({ id, family: `family-${id}`, model: { provider: 'test', id: `model-${id}`, reasoningEffort: 'high' } }));
  const suite = { suiteId: 'suite-test', models, campaigns: models.flatMap(model => ['context', 'swe'].map(cohort => ({ campaignId: `${model.id}-${cohort}`, modelId: model.id, cohort }))) };
  const summaries = suite.campaigns.map(campaign => {
    const model = models.find(model => model.id === campaign.modelId);
    const tasks = ['pilot', 'confirmation_holdout'].map(split => ({ id: split, instanceId: `issue-${split}`, cohort: campaign.cohort, split, language: 'go' }));
    if (extraPilot) tasks.push({ ...tasks[0], id: 'pilot-extra', instanceId: 'issue-pilot-extra' });
    const frozen = { campaignId: campaign.campaignId, manifest: { model: model.model, tasks }, schedule: buildSchedule(tasks) };
    const attempts = frozen.schedule.map(slot => {
      const isA = model.id === 'a', pilot = slot.taskId.startsWith('pilot'), ordinary = slot.arm === 'ordinary';
      const resolved = pilot ? (isA ? !ordinary : ordinary) : ordinary;
      const totalTokens = isA ? (ordinary ? 100 : 50) : (ordinary ? 200 : 400);
      const record = { slotId: slot.id, meta: { status: 'attempt-completed', grade: { status: 'completed', resolved,
        metrics: campaign.cohort === 'context' ? { localization: { file: { coverage: ordinary ? 0.5 : (isA ? 1 : 0), precision: 1 } } } : null } },
        receipt: { exactTurnUsage: { totalTokens, outputTokens: 10 }, durationMs: totalTokens * 2,
          timings: { promptedAtMs: 0, turnEndedAtMs: totalTokens }, toolCalls: [], knownUsageLowerBound: { totalTokens: 999 } } };
      change(record, { campaign, model, slot });
      return record;
    });
    return summarizeCampaign(frozen, attempts);
  });
  return { suite, summaries };
}
const group = (result, cohort = 'swe', split = 'pilot') => result.groups.find(group => group.cohort === cohort && group.split === split);
const pair = (result, cohort = 'swe', split = 'pilot') => group(result, cohort, split).paired.find(pair => pair.arm === 'codefacts022');

test('same task IDs stay within their model/cohort; opposite effects and holdout stay visible', () => {
  const { suite, summaries } = fixture();
  const result = summarizeSuite(suite, summaries), pilot = pair(result), holdout = pair(result, 'swe', 'confirmation_holdout');
  assert.equal(result.plannedAttempts, 24);
  assert.equal(result.models[0].campaigns[0], summaries[0]);
  assert.equal(summaries[0].model, suite.models[0].model);
  assert.match(summaries[0].freezeHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(pilot.perModel.map(model => model.correctness.meanDifference), [1, -1]);
  assert.equal(pilot.quality.meanDifference, 0);
  assert.equal(holdout.quality.meanDifference, -1);
  assert.equal(pilot.resources.totalTokens.ratio, 1.25);
  assert.deepEqual(pilot.perModel.map(model => model.resources.totalTokens.ratio), [0.5, 2]);
  assert.equal(group(result).sourceTaskCount, 1);
  assert.equal(group(result).modelTaskCells, 2);
  assert.equal(pilot.quality.bySourceTask.length, 1);
  assert.deepEqual(pilot.perModel.map(model => [model.correctness.gained, model.correctness.lost]), [[1, 0], [0, 1]]);
  assert.equal(result.operationalTokenLedger.total, summaries.flatMap(summary => summary.attempts).reduce((total, row) => total + row.totalTokens, 0));
});

test('missing resource coverage and zero ordinary totals keep main macro ratios null', () => {
  const { suite, summaries } = fixture((record, { model, slot }) => {
    if (model.id === 'b' && slot.taskId === 'pilot' && slot.arm === 'codefacts022') record.receipt.exactTurnUsage = null;
    if (slot.taskId === 'confirmation_holdout' && slot.arm === 'ordinary') record.receipt.exactTurnUsage.totalTokens = 0;
  });
  const result = summarizeSuite(suite, summaries), resource = pair(result).resources.totalTokens;
  assert.equal(resource.ratio, null); assert.equal(resource.knownRatio, 0.5);
  assert.equal(resource.plannedModels, 2); assert.equal(resource.knownModels, 1); assert.deepEqual(resource.missingModelIds, ['b']);
  assert.equal(pair(result).perModel[1].resources.totalTokens.native.total, null);
  assert.equal(pair(result).perModel[1].resources.totalTokens.native.missing, 1);
  assert.equal(pair(result, 'swe', 'confirmation_holdout').resources.totalTokens.ratio, null);
  assert.equal(result.operationalTokenLedger.total, null);
  assert.equal(result.operationalTokenLedger.missing, 2);
});

test('resource ratios use each model full workload totals before equal model averaging', () => {
  const { suite, summaries } = fixture((record, { model, slot }) => {
    if (model.id === 'a' && slot.taskId === 'pilot-extra') record.receipt.exactTurnUsage.totalTokens = 900;
  }, true);
  const result = summarizeSuite(suite, summaries), resources = pair(result).resources.totalTokens;
  assert.equal(pair(result).perModel[0].resources.totalTokens.ratio, 0.95);
  assert.equal(resources.ratio, 1.475);
  assert.equal(group(result).sourceTaskCount, 2);
  assert.equal(group(result).modelTaskCells, 4);
  const incomplete = fixture((record, { model, slot }) => {
    if (model.id === 'a' && slot.taskId === 'pilot-extra' && slot.arm === 'codefacts022') record.receipt.exactTurnUsage = null;
  }, true);
  const missing = pair(summarizeSuite(incomplete.suite, incomplete.summaries));
  assert.equal(missing.perModel[0].resources.totalTokens.native.known, 1);
  assert.equal(missing.perModel[0].resources.totalTokens.native.missing, 1);
  assert.equal(missing.perModel[0].resources.totalTokens.ratio, null);
  assert.equal(missing.resources.totalTokens.ratio, null);
});

test('SWE unknown grading retains true/false/null counts, fixed denominator and paired bounds', () => {
  const { suite, summaries } = fixture((record, { campaign, model, slot }) => {
    if (campaign.cohort === 'swe' && model.id === 'b' && slot.taskId === 'pilot' && slot.arm === 'codefacts022') record.meta.grade = { status: 'failed', resolved: false };
  });
  const result = summarizeSuite(suite, summaries), quality = pair(result).quality;
  assert.equal(quality.meanDifference, null); assert.equal(quality.knownMeanDifference, 1);
  assert.equal(quality.knownModels, 1); assert.equal(quality.plannedModels, 2);
  assert.equal(quality.lowerBound, 0); assert.equal(quality.upperBound, 0.5);
  assert.deepEqual(group(result).perModel[1].resolved.codefacts022, { planned: 1, knownTrue: 0, knownFalse: 0, unknown: 1, rate: null, lowerBound: 0, upperBound: 1 });
  assert.equal(pair(result).perModel[1].correctness.gradedPairs, 0);
  assert.equal(pair(result).perModel[1].correctness.meanDifference, null);
  assert.equal(pair(result).perModel[1].correctness.knownMeanDifference, null);
});

test('Context agreement and report validity remain separate with no resolved outcomes', () => {
  const { suite, summaries } = fixture();
  const result = summarizeSuite(suite, summaries), context = pair(result, 'context');
  assert.equal(context.quality.contextMetrics['localization.file.coverage'].meanDifference, 0);
  assert.deepEqual(context.perModel.map(model => model.contextMetrics['localization.file.coverage'].meanDifference), [0.5, -0.5]);
  assert.equal(context.perModel[0].correctness, null);
  assert.equal('resolved' in group(result, 'context').perModel[0], false);
  assert.equal(result.models[0].campaigns[0].attempts[0].resolved, null);
  assert.equal(group(result, 'context').perModel[0].group.arms.ordinary.knownResolved, null);
  assert.deepEqual(group(result, 'context').perModel[0].group.arms.ordinary.validLocalizationQuality, { valid: 0, all: 1 });
  assert.deepEqual(group(result, 'context').perModel[0].group.arms.ordinary.validContextMetrics, { valid: 1, all: 1 });
});

test('undeclared, duplicate, missing or mismatched campaign summaries fail explicitly', () => {
  const { suite, summaries } = fixture();
  assert.throws(() => summarizeSuite(suite, [...summaries, summaries[0]]), /Duplicate campaign summary/);
  assert.throws(() => summarizeSuite(suite, summaries.slice(1)), /exactly one summary/);
  assert.throws(() => summarizeSuite(suite, summaries.map((summary, i) => i ? summary : { ...summary, campaignId: 'undeclared' })), /exactly one summary/);
  assert.throws(() => summarizeSuite(suite, summaries.map((summary, i) => i ? summary : { ...summary, model: suite.models[1].model })), /Model mismatch/);
  assert.throws(() => summarizeSuite(suite, summaries.map((summary, i) => i ? summary : { ...summary, attempts: summary.attempts.map(row => ({ ...row, cohort: 'swe' })) })), /cohort or workload mismatch/);
  assert.throws(() => summarizeSuite({ ...suite, campaigns: [...suite.campaigns, suite.campaigns[0]] }, summaries), /Duplicate campaign id/);
  assert.throws(() => summarizeSuite({ ...suite, models: suite.models.map(model => ({ ...model, family: 'same' })) }, summaries), /Duplicate model family/);
  assert.throws(() => summarizeSuite({ ...suite, models: suite.models.map(model => ({ ...model, id: 'same' })) }, summaries), /Duplicate model id/);
});

test('fixed task identities, splits and complete arm coverage must match across models', () => {
  const { suite, summaries } = fixture();
  const changed = transform => summaries.map((summary, index) => index !== 2 ? summary : { ...summary, attempts: transform(summary.attempts) });
  assert.throws(() => summarizeSuite(suite, changed(rows => rows.map(row => row.taskId !== 'pilot' ? row : { ...row, taskId: 'different' }))), /Fixed task\/split set differs/);
  assert.throws(() => summarizeSuite(suite, changed(rows => rows.map(row => ({ ...row, split: 'confirmation_holdout' })))), /Fixed task\/split set differs/);
  assert.throws(() => summarizeSuite(suite, changed(rows => rows.map((row, index) => index ? row : { ...row, arm: rows[1].arm }))), /Duplicate task\/arm cell/);
});
