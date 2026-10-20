import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS } from './campaign.mjs';
import { hash } from '../rpc.mjs';

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const number = value => typeof value === 'number' && Number.isFinite(value);
const nullable = value => number(value) ? value : null;
const sum = values => values.reduce((total, value) => total + value, 0);
export function availability(values) {
  const known = values.filter(number);
  return { total: known.length === values.length ? sum(known) : null, knownTotal: known.length ? sum(known) : null,
    known: known.length, missing: values.length - known.length };
}
function flattenMetrics(value, prefix = '', result = {}) {
  if (number(value)) result[prefix] = value;
  else if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) flattenMetrics(child, prefix ? `${prefix}.${key}` : key, result);
  return result;
}
export function summarizeAttempt(slot, task, meta = null, receipt = null) {
  const usage = receipt?.exactTurnUsage;
  // The SDK's exact total is validated as input + output. Cache breakdown is
  // optional, so its absence does not erase an otherwise exact input total.
  const inputTokens = number(usage?.totalTokens) && number(usage?.outputTokens) ? usage.totalTokens - usage.outputTokens : null;
  const toolCalls = receipt?.toolCalls ?? [];
  const nativeNames = slot.arm === 'codefacts022' ? ['codefacts_explore', 'codefacts_expand', 'codefacts_impact'] : slot.arm === 'codegraph' ? ['codegraph_explore'] : [];
  const nativeCalls = toolCalls.filter(call => nativeNames.some(name => call.name === `mcp__repo__${name}`));
  const toolErrors = (receipt?.toolResults ?? []).filter(result => result.message?.isError === true || result.isError === true).length;
  const grade = meta?.grade ?? { status: 'pending', resolved: null, metrics: null };
  const resolved = task.cohort === 'swe' && grade.status === 'completed' && typeof grade.resolved === 'boolean' ? grade.resolved : null;
  const prompted = receipt?.timings?.promptedAtMs, ended = receipt?.timings?.turnEndedAtMs;
  return { slotId: slot.id, taskId: task.id, instanceId: task.instanceId, cohort: task.cohort, language: task.language, split: task.split, arm: slot.arm,
    status: meta?.status ?? 'not-started', outcome: meta?.audit?.outcome ?? null, receiptStatus: receipt?.status ?? null,
    providerCallSucceeded: receipt?.providerCallSucceeded ?? null, generationCutoff: receipt?.generationCutoff ?? null,
    usageAvailability: receipt?.usageAvailability ?? 'unavailable',
    totalTokens: nullable(usage?.totalTokens), inputTokens, outputTokens: nullable(usage?.outputTokens),
    uncachedInputTokens: nullable(usage?.uncachedInputTokens), cacheReadTokens: nullable(usage?.cacheReadTokens), cacheWriteTokens: nullable(usage?.cacheWriteTokens),
    knownUsageLowerBound: receipt?.knownUsageLowerBound ?? null,
    dshDurationMs: nullable(receipt?.durationMs), modelTurnMs: number(prompted) && number(ended) ? ended - prompted : null,
    gradeDurationMs: nullable(meta?.grade?.receipt?.durationMs), slotWallMs: nullable(meta?.slotWallMs),
    preparationAndSandboxMs: nullable(meta?.preparationAndSandboxMs), sourcePreparationMs: nullable(meta?.setup?.sourcePreparationMs),
    indexDurationMs: nullable(meta?.setup?.indexDurationMs), indexDiskBytes: nullable(meta?.setup?.indexDiskBytes),
    toolCalls: receipt ? toolCalls.length : null, toolErrors: receipt ? toolErrors : null, nativeCalls: receipt ? nativeCalls.length : null,
    nativeAdopted: receipt ? nativeCalls.length > 0 : null, gradeStatus: grade.status, resolved, metrics: grade.metrics ?? null,
    patchPath: meta?.patchPath ?? null, error: meta?.error ?? null };
}

const RESOURCES = ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'dshDurationMs', 'modelTurnMs', 'gradeDurationMs', 'slotWallMs', 'preparationAndSandboxMs', 'sourcePreparationMs', 'indexDurationMs', 'indexDiskBytes', 'toolCalls', 'toolErrors', 'nativeCalls'];
function aggregate(rows) {
  const resolvedApplicable = rows[0]?.cohort === 'swe';
  const resolved = rows.filter(row => typeof row.resolved === 'boolean');
  const metricKeys = [...new Set(rows.flatMap(row => Object.keys(flattenMetrics(row.metrics))))].sort();
  return { planned: rows.length, statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].sort().map(status => [status, rows.filter(row => row.status === status).length])),
    resolvedApplicable,
    resolved: resolvedApplicable && resolved.length === rows.length ? resolved.filter(row => row.resolved).length : null,
    knownResolved: resolvedApplicable ? resolved.filter(row => row.resolved).length : null,
    knownUnresolved: resolvedApplicable ? resolved.filter(row => !row.resolved).length : null,
    missingResolved: resolvedApplicable ? rows.length - resolved.length : null,
    resources: Object.fromEntries(RESOURCES.map(key => [key, availability(rows.map(row => row[key]))])),
    nativeAdoption: { known: rows.filter(row => row.nativeAdopted !== null).length, adopted: rows.filter(row => row.nativeAdopted === true).length },
    validContextMetrics: { valid: rows.filter(row => row.gradeStatus === 'completed' && row.metrics !== null).length, all: rows.length },
    validLocalizationQuality: { valid: rows.filter(row => row.gradeStatus === 'completed' && ['file', 'symbol', 'span', 'line'].every(level =>
      number(row.metrics?.localization?.[level]?.coverage) && number(row.metrics?.localization?.[level]?.precision))).length, all: rows.length },
    contextMetrics: Object.fromEntries(metricKeys.map(key => {
      const values = rows.map(row => flattenMetrics(row.metrics)[key]), available = availability(values);
      return [key, { ...available, knownMean: available.known ? available.knownTotal / available.known : null }];
    })) };
}
function paired(rows, arm, taskIds) {
  const pairs = taskIds.map(taskId => [rows.find(row => row.taskId === taskId && row.arm === 'ordinary'), rows.find(row => row.taskId === taskId && row.arm === arm)]);
  const correctness = pairs.filter(([base, treatment]) => typeof base?.resolved === 'boolean' && typeof treatment?.resolved === 'boolean');
  const contextKeys = [...new Set(rows.flatMap(row => Object.keys(flattenMetrics(row.metrics))))].sort();
  const difference = getter => {
    const values = pairs.map(([base, treatment]) => { const a = getter(base), b = getter(treatment); return number(a) && number(b) ? b - a : null; });
    const result = availability(values);
    return { ...result, knownMeanDifference: result.known ? result.knownTotal / result.known : null, differenceDirection: `${arm} minus ordinary` };
  };
  return { arm, plannedTaskPairs: taskIds.length,
    correctnessApplicable: rows[0]?.cohort === 'swe',
    correctness: rows[0]?.cohort === 'swe' ? { gradedPairs: correctness.length, missingPairs: taskIds.length - correctness.length,
      ordinaryCorrect: correctness.filter(([base]) => base.resolved).length, armCorrect: correctness.filter(([, treatment]) => treatment.resolved).length,
      gained: correctness.filter(([base, treatment]) => !base.resolved && treatment.resolved).length,
      lost: correctness.filter(([base, treatment]) => base.resolved && !treatment.resolved).length,
      bothCorrect: correctness.filter(([base, treatment]) => base.resolved && treatment.resolved).length,
      bothIncorrect: correctness.filter(([base, treatment]) => !base.resolved && !treatment.resolved).length } : null,
    resources: Object.fromEntries(RESOURCES.map(key => [key, difference(row => row?.[key])])),
    contextMetrics: Object.fromEntries(contextKeys.map(key => [key, difference(row => flattenMetrics(row?.metrics)[key])])) };
}

export function summarizeCampaign(frozen, attempts) {
  const rows = frozen.schedule.map(slot => {
    const task = frozen.manifest.tasks.find(task => task.id === slot.taskId), record = attempts.find(record => record.slotId === slot.id);
    return summarizeAttempt(slot, task, record?.meta, record?.receipt);
  });
  const groups = [];
  // Pilot and holdout remain distinct units; no pooled headline ranking is made.
  for (const cohort of ['context', 'swe']) for (const split of ['pilot', 'confirmation_holdout']) {
    const selected = rows.filter(row => row.cohort === cohort && row.split === split);
    if (!selected.length) continue;
    const taskIds = [...new Set(selected.map(row => row.taskId))];
    groups.push({ cohort, split, tasks: taskIds.length,
      arms: Object.fromEntries(ARMS.map(arm => [arm, aggregate(selected.filter(row => row.arm === arm))])),
      paired: ARMS.filter(arm => arm !== 'ordinary').map(arm => paired(selected, arm, taskIds)) });
  }
  return { schemaVersion: 1, campaignId: frozen.campaignId, model: frozen.manifest.model, freezeHash: hash(frozen), plannedAttempts: rows.length, attempts: rows, groups,
    interpretation: [
      'Descriptive fixed-task results, one attempt per task and arm; four holdout tasks per cohort do not establish a robust ranking or a general productivity effect.',
      'ContextBench uses an adapted read-only localization protocol, with gold patch/context withheld from the agent. Official metric code is retained; evaluator patch input is sanitized as recorded by its adapter.',
      'SWE resolved is supplied only by completed official per-instance grading. Pending, failed, and unavailable grading remain null.',
      'Native navigation is optional. Availability is the assigned treatment; actual calls, including errors, and adoption are secondary observations.',
      'Resource differences include all fixed task pairs with available measurements and disclose missingness. They are not filtered to jointly correct attempts.',
      'Token totals are provider usage, not monetary cost. Unknown usage remains null; known lower bounds are retained per attempt.',
      'Context metric means describe only the explicitly counted valid reports; invalid or missing localization declarations remain missing quality, so valid-report means are not whole-cohort quality estimates.',
      'Serial DSH duration, model-turn time, source/index preparation, and sandbox preparation are separate; grader duration is outside scored timing.',
      'Grade duration comes from the official grader receipt. Slot wall time covers the runner attempt including an injected grader when used; grading performed externally later is outside that slot clock.',
    ] };
}

export function loadSummary(evidenceDir) {
  const frozen = json(path.join(evidenceDir, 'freeze.json'));
  const attempts = frozen.schedule.map(slot => {
    const metaPath = path.join(evidenceDir, 'attempts', slot.id, 'slot-meta.json');
    if (!fs.existsSync(metaPath)) return { slotId: slot.id };
    const meta = json(metaPath), receipt = fs.existsSync(meta.receiptPath) ? json(meta.receiptPath) : null;
    return { slotId: slot.id, meta, receipt };
  });
  return summarizeCampaign(frozen, attempts);
}
export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--evidence' || !path.isAbsolute(argv[1])) throw new Error('Usage: --evidence ABS');
  const report = loadSummary(argv[1]), destination = path.join(argv[1], 'summary.json');
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ summary: destination, plannedAttempts: report.plannedAttempts }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
