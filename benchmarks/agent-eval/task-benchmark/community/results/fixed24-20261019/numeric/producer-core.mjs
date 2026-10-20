// Derived from aggregate.mjs 274b786d8cb7f1cb540ff7327daadd1e2dd7f5de11086ff79ad6d3e41b7fd1c7; aggregate-core-v1.
import crypto from 'node:crypto';
export const ARMS = ['ordinary', 'codefacts022', 'codegraph'];
export const RESOURCES = ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'modelTurnMs', 'dshDurationMs', 'slotWallMs', 'preparationAndSandboxMs', 'sourcePreparationMs', 'indexDurationMs', 'gradeDurationMs', 'indexDiskBytes', 'nativeCalls', 'toolCalls', 'toolErrors'];
export const QUALITY = ['file', 'symbol', 'span', 'line'].flatMap(level => ['coverage', 'precision'].map(metric => `${level}.${metric}`));
const terminal = new Set(['attempt-completed', 'task-failed']);
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const sum = values => values.reduce((a, b) => a + b, 0);
const sorted = values => [...new Set(values)].sort();
const configKey = model => JSON.stringify([model?.provider, model?.id, model?.reasoningEffort]);
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function availability(values) {
  const known = values.filter(numeric);
  return { total: known.length === values.length ? sum(known) : null, knownTotal: known.length ? sum(known) : null,
    known: known.length, missing: values.length - known.length, knownMean: known.length ? sum(known) / known.length : null };
}
const count = (rows, key) => Object.fromEntries(sorted(rows.map(row => row[key] == null ? 'null' : String(row[key]))).map(value => [value, rows.filter(row => (row[key] == null ? 'null' : String(row[key])) === value).length]));
const valid = row => row.gradeStatus === 'completed' && row.metrics !== null;
const quality = (row, key) => { const [level, metric] = key.split('.'); return valid(row) ? row.metrics?.localization?.[level]?.[metric] ?? null : null; };
const resolved = row => row.cohort === 'swe' && row.gradeStatus === 'completed' && typeof row.resolved === 'boolean' ? Number(row.resolved) : null;
const difference = (a, b) => numeric(a) && numeric(b) ? b - a : null;

function execution(rows, signedRows = new Set()) {
  return { planned: rows.length, terminal: rows.filter(row => terminal.has(row.status)).length,
    actualModelTerminal: rows.filter(row => terminal.has(row.status)).length,
    signedInfrastructure: rows.filter(row => signedRows.has(row)).length,
    accountedClosed: rows.filter(row => terminal.has(row.status) || signedRows.has(row)).length,
    unaccounted: rows.filter(row => !terminal.has(row.status) && !signedRows.has(row)).length,
    attemptCompleted: rows.filter(row => row.status === 'attempt-completed').length,
    taskFailed: rows.filter(row => row.status === 'task-failed').length,
    infrastructureFailed: rows.filter(row => row.status === 'infrastructure-failed').length,
    nonterminal: rows.filter(row => !terminal.has(row.status)).length,
    statuses: count(rows, 'status'), outcomes: count(rows, 'outcome'), receiptStatuses: count(rows, 'receiptStatus'),
    providerCallSucceeded: count(rows, 'providerCallSucceeded'), generationCutoff: count(rows, 'generationCutoff'),
    gradeStatuses: count(rows, 'gradeStatus'), usageAvailability: count(rows, 'usageAvailability'), errors: count(rows, 'error') };
}
function resolvedCounts(rows) {
  const values = rows.map(resolved), knownTrue = values.filter(value => value === 1).length, knownFalse = values.filter(value => value === 0).length;
  const unknown = rows.length - knownTrue - knownFalse;
  return { planned: rows.length, knownTrue, knownFalse, unknown, rate: unknown || !rows.length ? null : knownTrue / rows.length,
    lowerBound: rows.length ? knownTrue / rows.length : null, upperBound: rows.length ? (knownTrue + unknown) / rows.length : null };
}
export function aggregate(rows, cohort, signedRows = new Set()) {
  const callPairs = rows.filter(row => numeric(row.toolCalls) && numeric(row.toolErrors));
  const calls = sum(callPairs.map(row => row.toolCalls)), errors = sum(callPairs.map(row => row.toolErrors));
  return { ...execution(rows, signedRows), resources: Object.fromEntries(RESOURCES.map(key => [key, availability(rows.map(row => row[key]))])),
    quality: cohort === 'context' ? Object.fromEntries(QUALITY.map(key => [key, availability(rows.map(row => quality(row, key)))])) : null,
    officialScored: rows.filter(row => row.gradeStatus === 'completed').length,
    validContextMetrics: cohort === 'context' ? { valid: rows.filter(valid).length, all: rows.length } : null,
    validLocalizationQuality: cohort === 'context' ? { valid: rows.filter(row => QUALITY.every(key => numeric(quality(row, key)))).length, all: rows.length } : null,
    missingQualityByReason: count(rows.filter(row => cohort === 'context' ? !valid(row) : resolved(row) === null).map(row => signedRows.has(row) ? { gradeStatus: 'signed-infrastructure-before-model' } : row), 'gradeStatus'),
    resolved: cohort === 'swe' ? resolvedCounts(rows) : null,
    lowerBoundOnlyForNonExact: availability(rows.filter(row => !numeric(row.totalTokens)).map(row => row.knownUsageLowerBound?.totalTokens ?? null)),
    nativeAdoption: { known: rows.filter(row => typeof row.nativeAdopted === 'boolean').length, adopted: rows.filter(row => row.nativeAdopted === true).length,
      interpretation: 'Recognized native attempts including errored calls; adoption does not establish successful native service.' },
    toolErrorRate: { knownAttempts: callPairs.length, plannedAttempts: rows.length, errors: callPairs.length ? errors : null,
      calls: callPairs.length ? calls : null, rate: calls ? errors / calls : null, denominator: 'All tool calls in attempts with known toolCalls and toolErrors; native-only errors are unavailable in this schema.' } };
}
function paired(rows, taskIds, arm, cohort) {
  const pairs = taskIds.map(taskId => {
    const ordinary = rows.find(row => row.taskId === taskId && row.arm === 'ordinary');
    const treatment = rows.find(row => row.taskId === taskId && row.arm === arm);
    return { taskId, instanceId: ordinary.instanceId, ordinaryGrade: ordinary.gradeStatus, treatmentGrade: treatment.gradeStatus,
      ordinaryStatus: ordinary.status, treatmentStatus: treatment.status,
      ordinaryResolved: cohort === 'swe' ? resolved(ordinary) : null, treatmentResolved: cohort === 'swe' ? resolved(treatment) : null,
      resources: Object.fromEntries(RESOURCES.map(key => [key, difference(ordinary[key], treatment[key])])),
      quality: cohort === 'context' ? Object.fromEntries(QUALITY.map(key => [key, difference(quality(ordinary, key), quality(treatment, key))])) : null };
  });
  const correctness = cohort === 'swe' ? (() => {
    const complete = pairs.filter(pair => pair.ordinaryResolved !== null && pair.treatmentResolved !== null);
    const deltas = availability(pairs.map(pair => difference(pair.ordinaryResolved, pair.treatmentResolved)));
    return { ...deltas, plannedTaskPairs: taskIds.length, gradedPairs: complete.length, missingPairs: taskIds.length - complete.length,
      meanDifference: deltas.total === null || !taskIds.length ? null : deltas.total / taskIds.length,
      gained: complete.filter(pair => pair.ordinaryResolved === 0 && pair.treatmentResolved === 1).length,
      lost: complete.filter(pair => pair.ordinaryResolved === 1 && pair.treatmentResolved === 0).length,
      bothCorrect: complete.filter(pair => pair.ordinaryResolved === 1 && pair.treatmentResolved === 1).length,
      bothIncorrect: complete.filter(pair => pair.ordinaryResolved === 0 && pair.treatmentResolved === 0).length,
      lowerBound: taskIds.length ? sum(pairs.map(pair => (pair.treatmentResolved ?? 0) - (pair.ordinaryResolved ?? 1))) / taskIds.length : null,
      upperBound: taskIds.length ? sum(pairs.map(pair => (pair.treatmentResolved ?? 1) - (pair.ordinaryResolved ?? 0))) / taskIds.length : null };
  })() : null;
  return { arm, direction: `${arm} minus ordinary`, plannedTaskPairs: taskIds.length, pairs, correctness,
    resources: Object.fromEntries(RESOURCES.map(key => {
      const ordinary = availability(rows.filter(row => row.arm === 'ordinary').map(row => row[key]));
      const treatment = availability(rows.filter(row => row.arm === arm).map(row => row[key]));
      const ratio = ordinary.total !== null && ordinary.total !== 0 && treatment.total !== null ? treatment.total / ordinary.total : null;
      return [key, { ...availability(pairs.map(pair => pair.resources[key])), ordinary, treatment, ratio, relativeChange: ratio === null ? null : ratio - 1 }];
    })), quality: cohort === 'context' ? Object.fromEntries(QUALITY.map(key => [key, availability(pairs.map(pair => pair.quality[key]))])) : null };
}
export function panel(rows, cohort, signedRows = new Set()) {
  const taskIds = sorted(rows.map(row => row.taskId));
  return { taskIds, sourceTaskCount: taskIds.length, plannedCells: rows.length,
    arms: Object.fromEntries(ARMS.map(arm => [arm, aggregate(rows.filter(row => row.arm === arm), cohort, signedRows)])),
    paired: ARMS.slice(1).map(arm => paired(rows, taskIds, arm, cohort)) };
}
function macro(values) {
  const result = availability(values.map(value => value.value));
  return { mean: result.missing || !values.length ? null : result.knownMean, knownMean: result.knownMean,
    plannedModels: values.length, knownModels: result.known, missingModels: result.missing,
    missingModelIds: values.filter(value => !numeric(value.value)).map(value => value.modelId) };
}
export { execution };
export function equalModelMacro(models) {
  const equalModelMacro = models[0].panels.map(first => ({ cohort: first.cohort, split: first.split,
    paired: ARMS.slice(1).map(arm => {
      const pairs = models.map(model => ({ modelId: model.modelId, pair: model.panels.find(p => p.cohort === first.cohort && p.split === first.split).primary.paired.find(pair => pair.arm === arm) }));
      return { arm, quality: first.cohort === 'context' ? Object.fromEntries(QUALITY.map(key => [key, macro(pairs.map(({ modelId, pair }) => ({ modelId, value: pair.quality[key].total === null ? null : pair.quality[key].knownMean })))])) : macro(pairs.map(({ modelId, pair }) => ({ modelId, value: pair.correctness.meanDifference }))),
        // Only dimensionless within-model ratios are averaged, as in suite-summary.mjs.
        resourceRatios: Object.fromEntries(RESOURCES.map(key => [key, macro(pairs.map(({ modelId, pair }) => ({ modelId, value: pair.resources[key].ratio })))])) };
    }) }));
  return equalModelMacro;
}
