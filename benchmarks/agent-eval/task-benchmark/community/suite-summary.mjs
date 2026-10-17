import { ARMS } from './campaign.mjs';
import { availability } from './summary.mjs';

const number = value => typeof value === 'number' && Number.isFinite(value);
const mean = values => values.reduce((total, value) => total + value, 0) / values.length;
const configKey = model => JSON.stringify([model.provider, model.id, model.reasoningEffort]);
const metricValues = (value, prefix = '', result = {}) => {
  if (number(value)) result[prefix] = value;
  else if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) metricValues(child, prefix ? `${prefix}.${key}` : key, result);
  return result;
};
const unique = (values, label) => { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`); };
const identity = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}`); };

function validate(suite, summaries) {
  identity(suite.suiteId, 'suiteId');
  if (!suite.models?.length || !suite.campaigns?.length) throw new Error('Suite models and campaigns are required');
  for (const model of suite.models) {
    identity(model.id, 'model id'); identity(model.family, 'model family');
    for (const key of ['provider', 'id', 'reasoningEffort']) identity(model.model?.[key], `model.${key}`);
  }
  unique(suite.models.map(model => model.id), 'model id');
  unique(suite.models.map(model => model.family), 'model family');
  unique(suite.models.map(model => configKey(model.model)), 'model configuration');
  unique(suite.campaigns.map(campaign => campaign.campaignId), 'campaign id');
  unique(suite.campaigns.map(campaign => JSON.stringify([campaign.modelId, campaign.cohort])), 'model/cohort campaign');
  for (const campaign of suite.campaigns) {
    identity(campaign.campaignId, 'campaign id');
    if (!suite.models.some(model => model.id === campaign.modelId) || !['context', 'swe'].includes(campaign.cohort)) throw new Error('Undeclared model or cohort in campaign');
  }
  const cohorts = [...new Set(suite.campaigns.map(campaign => campaign.cohort))];
  for (const model of suite.models) for (const cohort of cohorts) {
    if (!suite.campaigns.some(campaign => campaign.modelId === model.id && campaign.cohort === cohort)) throw new Error(`Missing campaign for ${model.id}/${cohort}`);
  }
  unique(summaries.map(summary => summary.campaignId), 'campaign summary');
  if (summaries.length !== suite.campaigns.length || summaries.some(summary => !suite.campaigns.some(campaign => campaign.campaignId === summary.campaignId))) throw new Error('Expected exactly one summary per declared campaign');
  const signatures = new Map();
  for (const campaign of suite.campaigns) {
    const summary = summaries.find(summary => summary.campaignId === campaign.campaignId);
    const model = suite.models.find(model => model.id === campaign.modelId);
    if (configKey(summary.model) !== configKey(model.model)) throw new Error(`Model mismatch: ${campaign.campaignId}`);
    if (!summary.attempts.length || summary.plannedAttempts !== summary.attempts.length || summary.attempts.some(row => row.cohort !== campaign.cohort) || summary.groups.some(group => group.cohort !== campaign.cohort)) throw new Error(`Campaign cohort or workload mismatch: ${campaign.campaignId}`);
    unique(summary.attempts.map(row => JSON.stringify([row.taskId, row.arm])), 'task/arm cell');
    const tasks = new Map();
    for (const row of summary.attempts) {
      if (!ARMS.includes(row.arm) || !['pilot', 'confirmation_holdout'].includes(row.split)) throw new Error('Invalid task arm or split');
      const task = JSON.stringify([row.taskId, row.instanceId, row.cohort, row.split, row.language]);
      if (tasks.has(row.taskId) && tasks.get(row.taskId) !== task) throw new Error('Inconsistent task identity within campaign');
      tasks.set(row.taskId, task);
    }
    if (summary.attempts.length !== tasks.size * ARMS.length) throw new Error('Each task requires all three arms');
    const signature = JSON.stringify([...tasks.values()].sort());
    if (signatures.has(campaign.cohort) && signatures.get(campaign.cohort) !== signature) throw new Error(`Fixed task/split set differs across models: ${campaign.cohort}`);
    signatures.set(campaign.cohort, signature);
  }
  return cohorts;
}

function macro(values, key) {
  const known = values.filter(value => number(value[key]));
  return { [key]: known.length === values.length ? mean(known.map(value => value[key])) : null,
    [`known${key[0].toUpperCase()}${key.slice(1)}`]: known.length ? mean(known.map(value => value[key])) : null,
    plannedModels: values.length, knownModels: known.length, missingModels: values.length - known.length,
    missingModelIds: values.filter(value => !number(value[key])).map(value => value.modelId) };
}

function difference(pairs, getter) {
  const values = pairs.map(([ordinary, native]) => {
    const a = getter(ordinary), b = getter(native);
    return number(a) && number(b) ? b - a : null;
  });
  const result = availability(values);
  return { plannedTaskPairs: pairs.length, gradedPairs: result.known, missingPairs: result.missing,
    meanDifference: result.total === null ? null : result.total / pairs.length,
    knownMeanDifference: result.known ? result.knownTotal / result.known : null };
}

function correctness(pairs) {
  const get = row => typeof row.resolved === 'boolean' ? Number(row.resolved) : null;
  const complete = pairs.filter(pair => pair.every(row => get(row) !== null));
  return { ...difference(pairs, get),
    gained: complete.filter(([a, b]) => !a.resolved && b.resolved).length,
    lost: complete.filter(([a, b]) => a.resolved && !b.resolved).length,
    bothCorrect: complete.filter(([a, b]) => a.resolved && b.resolved).length,
    bothIncorrect: complete.filter(([a, b]) => !a.resolved && !b.resolved).length,
    lowerBound: mean(pairs.map(([a, b]) => (get(b) ?? 0) - (get(a) ?? 1))),
    upperBound: mean(pairs.map(([a, b]) => (get(b) ?? 1) - (get(a) ?? 0))) };
}

function resolvedCounts(rows) {
  const knownTrue = rows.filter(row => row.resolved === true).length, knownFalse = rows.filter(row => row.resolved === false).length;
  const unknown = rows.length - knownTrue - knownFalse;
  return { planned: rows.length, knownTrue, knownFalse, unknown, rate: unknown ? null : knownTrue / rows.length,
    lowerBound: knownTrue / rows.length, upperBound: (knownTrue + unknown) / rows.length };
}

/** Summarize independent single-model/cohort campaigns without merging their rows. */
export function summarizeSuite(suite, summaries) {
  const cohorts = validate(suite, summaries);
  const models = suite.models.map(model => ({ ...model, campaigns: suite.campaigns.filter(campaign => campaign.modelId === model.id)
    .map(campaign => summaries.find(summary => summary.campaignId === campaign.campaignId)) }));
  const groups = [];
  for (const cohort of cohorts) for (const split of ['pilot', 'confirmation_holdout']) {
    const panels = models.map(model => {
      const campaign = model.campaigns.find(campaign => campaign.attempts[0].cohort === cohort);
      return { modelId: model.id, family: model.family, campaignId: campaign.campaignId,
        rows: campaign.attempts.filter(row => row.split === split), group: campaign.groups.find(group => group.split === split) };
    });
    if (!panels[0].rows.length) continue;
    const taskIds = [...new Set(panels[0].rows.map(row => row.taskId))];
    const paired = ARMS.filter(arm => arm !== 'ordinary').map(arm => {
      const perModel = panels.map(panel => {
        const pairs = taskIds.map(taskId => [panel.rows.find(row => row.taskId === taskId && row.arm === 'ordinary'), panel.rows.find(row => row.taskId === taskId && row.arm === arm)]);
        const resources = Object.fromEntries(Object.keys(panel.group.arms.ordinary.resources).map(key => {
          const ordinary = availability(pairs.map(([row]) => row[key])), native = availability(pairs.map(([, row]) => row[key]));
          const ratio = ordinary.total !== null && ordinary.total !== 0 && native.total !== null ? native.total / ordinary.total : null;
          return [key, { ordinary, native, ratio, relativeChange: ratio === null ? null : ratio - 1 }];
        }));
        const keys = [...new Set(panels.flatMap(panel => panel.rows.flatMap(row => Object.keys(metricValues(row.metrics)))))].sort();
        return { modelId: panel.modelId, family: panel.family, campaignId: panel.campaignId, plannedTaskPairs: taskIds.length,
          correctness: cohort === 'swe' ? correctness(pairs) : null,
          contextMetrics: cohort === 'context' ? Object.fromEntries(keys.map(key => [key, difference(pairs, row => metricValues(row.metrics)[key])])) : null,
          resources };
      });
      const resources = Object.fromEntries(Object.keys(perModel[0].resources).map(key => {
        const result = macro(perModel.map(model => ({ modelId: model.modelId, ratio: model.resources[key].ratio })), 'ratio');
        return [key, { ...result, relativeChange: result.ratio === null ? null : result.ratio - 1 }];
      }));
      const quality = cohort === 'swe' ? {
        ...macro(perModel.map(model => ({ modelId: model.modelId, meanDifference: model.correctness.meanDifference })), 'meanDifference'),
        lowerBound: mean(perModel.map(model => model.correctness.lowerBound)), upperBound: mean(perModel.map(model => model.correctness.upperBound)),
        bySourceTask: taskIds.map(taskId => ({ taskId, ...macro(panels.map(panel => {
          const a = panel.rows.find(row => row.taskId === taskId && row.arm === 'ordinary'), b = panel.rows.find(row => row.taskId === taskId && row.arm === arm);
          return { modelId: panel.modelId, meanDifference: typeof a.resolved === 'boolean' && typeof b.resolved === 'boolean' ? Number(b.resolved) - Number(a.resolved) : null };
        }), 'meanDifference') }))
      } : { contextMetrics: Object.fromEntries(Object.keys(perModel[0].contextMetrics).map(key => [key,
        macro(perModel.map(model => ({ modelId: model.modelId, meanDifference: model.contextMetrics[key].meanDifference })), 'meanDifference')])) };
      return { arm, differenceDirection: `${arm} minus ordinary`, ratioDirection: `${arm} divided by ordinary`, perModel, quality, resources };
    });
    groups.push({ cohort, split, sourceTaskCount: taskIds.length, modelTaskCells: taskIds.length * models.length,
      plannedModels: models.length, plannedAttempts: taskIds.length * models.length * ARMS.length,
      perModel: panels.map(panel => ({ modelId: panel.modelId, family: panel.family, campaignId: panel.campaignId, group: panel.group,
        ...(cohort === 'swe' ? { resolved: Object.fromEntries(ARMS.map(arm => [arm, resolvedCounts(panel.rows.filter(row => row.arm === arm))])) } : {}) })), paired });
  }
  return { schemaVersion: 1, suiteId: suite.suiteId, plannedModels: models.length, plannedCampaigns: suite.campaigns.length,
    plannedAttempts: summaries.reduce((total, summary) => total + summary.plannedAttempts, 0), models, groups,
    operationalTokenLedger: { ...availability(summaries.flatMap(summary => summary.attempts.map(row => row.totalTokens))), interpretation: 'Provider token counts across tokenizers are an operational ledger, not equal compute or a cross-model efficiency score. Exact usage excludes separate per-attempt known lower bounds.' },
    interpretation: [
      'Each model retains its complete campaign groups and attempts. Quality pairs compare the same task and model, without filtering to joint correctness or native adoption.',
      'Pilot and confirmation_holdout are reported separately. Shared source tasks are counted once per cohort/split; model-task cells and arms are not independent source tasks. The fixed holdout was previously observed.',
      'Cross-model effects use equal model weights. Main means and workload ratios require every planned model; known means and missing model identities disclose partial coverage.',
      'Resource ratios first divide each model native full-workload total by its ordinary full-workload total. Missing measurements or a zero ordinary total yield null.',
      'SWE quality is completed official resolved true/false/null. Bounds retain unknown outcomes and paired differences; Context reference-context agreement and declaration validity remain separate from SWE resolved.',
      'One attempt per model/task/arm supports descriptive fixed-task comparisons, without a robust ranking or a general productivity conclusion.',
    ] };
}
