#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARMS = ['ordinary', 'codefacts017', 'codefacts022', 'codegraph'];
const CONDITIONS = ['guided-use', 'natural-choice'];
const STATUSES = ['completed', 'failed', 'invalid-environment'];
const CRITERIA = ['C1', 'C2', 'C3', 'C4'];

export class SummaryError extends Error {
  constructor(message) { super(message); this.name = 'SummaryError'; }
}
const fail = (message) => { throw new SummaryError(message); };
const obj = (v, p) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${p} must be an object`); return v; };
const str = (v, p) => { if (typeof v !== 'string' || !v.length) fail(`${p} must be a non-empty string`); return v; };
const num = (v, p) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(`${p} must be a finite non-negative number`); return v; };
const int = (v, p) => { num(v, p); if (!Number.isInteger(v)) fail(`${p} must be an integer`); return v; };
const oneOf = (v, values, p) => { if (!values.includes(v)) fail(`${p} must be one of ${values.join(', ')}`); return v; };

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function normalize(run, i) {
  const p = `runs[${i}]`; obj(run, p);
  const id = str(run.id, `${p}.id`), taskId = str(run.taskId, `${p}.taskId`);
  const arm = oneOf(run.arm, ARMS, `${p}.arm`), condition = oneOf(run.condition, CONDITIONS, `${p}.condition`);
  const repetition = int(run.repetition, `${p}.repetition`), status = oneOf(run.status, STATUSES, `${p}.status`);
  const wallMs = num(run.wallMs, `${p}.wallMs`), setupMs = num(run.setupMs, `${p}.setupMs`);
  const usage = run.usage === null ? null : obj(run.usage, `${p}.usage`);
  let normalizedUsage = null;
  if (usage) {
    if (run.knownUsageLowerBound !== undefined) fail(`${p}.knownUsageLowerBound is only valid when usage is null`);
    const uncachedInputTokens = num(usage.uncachedInputTokens, `${p}.usage.uncachedInputTokens`);
    const outputTokens = num(usage.outputTokens, `${p}.usage.outputTokens`);
    const totalTokens = num(usage.totalTokens, `${p}.usage.totalTokens`);
    if (outputTokens > totalTokens) fail(`${p}.usage.outputTokens exceeds totalTokens`);
    const optional = {};
    for (const k of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      if (usage[k] !== undefined && usage[k] !== null) optional[k] = num(usage[k], `${p}.usage.${k}`);
    }
    normalizedUsage = { uncachedInputTokens, outputTokens, totalTokens, ...optional };
  }
  let knownUsageLowerBound = null;
  if (!usage && run.knownUsageLowerBound !== undefined && run.knownUsageLowerBound !== null) {
    const lower = obj(run.knownUsageLowerBound, `${p}.knownUsageLowerBound`);
    knownUsageLowerBound = {
      uncachedInputTokens: num(lower.uncachedInputTokens, `${p}.knownUsageLowerBound.uncachedInputTokens`),
      outputTokens: num(lower.outputTokens, `${p}.knownUsageLowerBound.outputTokens`),
      totalTokens: num(lower.totalTokens, `${p}.knownUsageLowerBound.totalTokens`),
    };
    for (const k of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      if (lower[k] !== undefined && lower[k] !== null) knownUsageLowerBound[k] = num(lower[k], `${p}.knownUsageLowerBound.${k}`);
    }
  }
  const tc = obj(run.toolCalls, `${p}.toolCalls`);
  const toolCalls = Object.fromEntries(['ordinary', 'native', 'nativeSuccessful'].map((k) => [k, int(tc[k], `${p}.toolCalls.${k}`)]));
  const audit = obj(run.traceAudit, `${p}.traceAudit`);
  if (typeof audit.valid !== 'boolean' || typeof audit.adherent !== 'boolean' || !Array.isArray(audit.reasons) || audit.reasons.some((r) => typeof r !== 'string')) fail(`${p}.traceAudit must contain boolean valid/adherent and string reasons`);
  const grade = obj(run.grade, `${p}.grade`);
  if (grade.locked !== true) fail(`${p}.grade.locked must be true`);
  if (!Array.isArray(grade.criteria)) fail(`${p}.grade.criteria must be an array`);
  const seenCriteria = new Set();
  for (const [j, c] of grade.criteria.entries()) {
    obj(c, `${p}.grade.criteria[${j}]`); oneOf(c.id, CRITERIA, `${p}.grade.criteria[${j}].id`);
    if (seenCriteria.has(c.id)) fail(`${p}.grade.criteria contains duplicate ${c.id}`);
    if (typeof c.pass !== 'boolean') fail(`${p}.grade.criteria[${j}].pass must be a boolean`);
    seenCriteria.add(c.id);
  }
  if (CRITERIA.some((c) => !seenCriteria.has(c))) fail(`${p}.grade.criteria must include C1 through C4`);
  const criticalFalseClaim = grade.criticalFalseClaim;
  if (typeof criticalFalseClaim !== 'boolean') fail(`${p}.grade.criticalFalseClaim must be a boolean`);
  const fullyCorrect = CRITERIA.every((id) => grade.criteria.find((c) => c.id === id).pass) && !criticalFalseClaim;
  if (grade.fullyCorrect !== undefined && grade.fullyCorrect !== fullyCorrect) fail(`${p}.grade.fullyCorrect contradicts criteria/criticalFalseClaim`);
  str(grade.reviewer, `${p}.grade.reviewer`);
  return { id, taskId, arm, condition, repetition, status, wallMs, setupMs, usage: normalizedUsage, knownUsageLowerBound, toolCalls, traceAudit: audit, fullyCorrect };
}

function validPair(r) { return r.status === 'completed' && r.fullyCorrect && r.traceAudit.valid && r.traceAudit.adherent && r.usage !== null; }
function groupSummary(rows) {
  const known = rows.filter((r) => r.usage), totalKnown = (key) => known.reduce((n, r) => n + r.usage[key], 0);
  const incomplete = rows.filter((r) => !r.usage);
  const incompleteLowerBound = (key) => incomplete.reduce((n, r) => n + (r.knownUsageLowerBound?.[key] ?? 0), 0);
  const fullyCorrect = rows.filter((r) => r.fullyCorrect).length;
  const exactKnownTotal = known.reduce((n, r) => n + r.usage.totalTokens, 0);
  const incompleteKnownLowerBound = incompleteLowerBound('totalTokens');
  const tokenTotal = exactKnownTotal + incompleteKnownLowerBound;
  const wall = rows.map((r) => r.wallMs), setup = rows.reduce((n, r) => n + r.setupMs, 0);
  const taskMedians = [...new Set(rows.map((r) => r.taskId))].map((taskId) => median(rows.filter((r) => r.taskId === taskId).map((r) => r.wallMs))).filter((n) => n !== null);
  const meanKnownTotal = known.length ? exactKnownTotal / known.length : null;
  const tokenCoverage = { known: known.length, unknown: rows.length - known.length, total: rows.length };
  return {
    attempts: rows.length, completed: rows.filter((r) => r.status === 'completed').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    invalidEnvironment: rows.filter((r) => r.status === 'invalid-environment').length,
    fullyCorrect, validTrace: rows.filter((r) => r.traceAudit.valid).length, adherentTrace: rows.filter((r) => r.traceAudit.adherent).length,
    wallMs: { allAttemptTotal: wall.reduce((a, b) => a + b, 0), median: median(wall) }, setupMsTotal: setup,
    tokens: { authoritativeTotal: tokenTotal, authoritativeTotalIsLowerBound: known.length !== rows.length,
      knownExactTotal: exactKnownTotal, knownLowerBoundFromIncomplete: incompleteKnownLowerBound,
      knownLowerBoundSamples: incomplete.filter((r) => r.knownUsageLowerBound !== null).length,
      uncachedInputLowerBoundFromIncomplete: incompleteLowerBound('uncachedInputTokens'),
      outputLowerBoundFromIncomplete: incompleteLowerBound('outputTokens'),
      workloadTotalIsLowerBound: known.length !== rows.length, coverage: tokenCoverage,
      meanKnownSampleTotal: meanKnownTotal, medianKnownSampleTotal: median(known.map((r) => r.usage.totalTokens)),
      fullInputTotalKnownOnly: rows.length > 0 && known.length === rows.length
        ? known.reduce((sum, r) => sum + r.usage.totalTokens - r.usage.outputTokens, 0) : null,
      fullInputTotalDefinition: 'sum(totalTokens - outputTokens) across exact-usage workload runs; authoritative totalTokens equals all input tokens plus output tokens',
      uncachedInputTotalKnownOnly: known.length === rows.length ? totalKnown('uncachedInputTokens') : null,
      outputTotalKnownOnly: known.length === rows.length ? totalKnown('outputTokens') : null,
      cacheReadTotalKnownOnly: known.length === rows.length && known.every((r) => r.usage.cacheReadTokens !== undefined) ? totalKnown('cacheReadTokens') : null,
      cacheWriteTotalKnownOnly: known.length === rows.length && known.every((r) => r.usage.cacheWriteTokens !== undefined) ? totalKnown('cacheWriteTokens') : null,
      reasoningTotalKnownOnly: known.length === rows.length && known.every((r) => r.usage.reasoningTokens !== undefined) ? totalKnown('reasoningTokens') : null,
      costPerCorrect: known.length === rows.length && fullyCorrect ? tokenTotal / fullyCorrect : null },
    nativeActualCalls: rows.reduce((n, r) => n + r.toolCalls.native, 0),
    nativeSuccessfulCalls: rows.reduce((n, r) => n + r.toolCalls.nativeSuccessful, 0),
    nativeAdoptionTasks: new Set(rows.filter((r) => r.toolCalls.nativeSuccessful > 0).map((r) => r.taskId)).size,
    ordinaryActualCalls: rows.reduce((n, r) => n + r.toolCalls.ordinary, 0),
    setupAmortizedStageCostEstimateMs: [1, 10, 100].map((n) => ({ amortizedUses: n,
      estimatedMsPerUse: rows.length ? median(rows.map((r) => r.setupMs)) / n + median(taskMedians) : null })),
  };
}

const key = (r) => `${r.condition}\0${r.taskId}\0${r.repetition}`;
const pairEligible = (r) => validPair(r);
function compare(rows, condition, baselineArm, candidateArm) {
  const b = new Map(rows.filter((r) => r.condition === condition && r.arm === baselineArm).map((r) => [key(r), r]));
  const c = new Map(rows.filter((r) => r.condition === condition && r.arm === candidateArm).map((r) => [key(r), r]));
  const shared = [...b.keys()].filter((k) => c.has(k)).sort();
  const eligible = [], excluded = [];
  for (const k of shared) {
    const left = b.get(k), right = c.get(k), reasons = [];
    for (const [label, run] of [['baseline', left], ['candidate', right]]) {
      if (run.status !== 'completed') reasons.push(`${label}:${run.status}`);
      if (!run.fullyCorrect) reasons.push(`${label}:not-fully-correct`);
      if (!run.traceAudit.valid) reasons.push(`${label}:invalid-trace`);
      if (!run.traceAudit.adherent) reasons.push(`${label}:trace-nonadherent`);
      if (!run.usage) reasons.push(`${label}:unknown-usage`);
    }
    const base = { taskId: left.taskId, repetition: left.repetition, baselineArm, candidateArm };
    if (reasons.length) excluded.push({ ...base, reasons });
    else eligible.push({ ...base, baselineTotalTokens: left.usage.totalTokens, candidateTotalTokens: right.usage.totalTokens,
      tokenDeltaPct: left.usage.totalTokens === 0 ? null : (right.usage.totalTokens / left.usage.totalTokens - 1) * 100,
      baselineWallMs: left.wallMs, candidateWallMs: right.wallMs,
      wallDeltaPct: left.wallMs === 0 ? null : (right.wallMs / left.wallMs - 1) * 100 });
  }
  const reasonCounts = {};
  for (const x of excluded) for (const reason of x.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  return { condition, baselineArm, candidateArm, possiblePairs: shared.length, eligiblePairs: eligible.length,
    medianTokenDeltaPct: median(eligible.map((p) => p.tokenDeltaPct).filter((n) => n !== null)),
    medianWallDeltaPct: median(eligible.map((p) => p.wallDeltaPct).filter((n) => n !== null)),
    claimableEffect: eligible.length > 0, eligible, excluded, exclusionReasonCounts: reasonCounts };
}

export function summarizeCampaign(input) {
  obj(input, 'campaign');
  if (input.schemaVersion !== 1) fail('campaign.schemaVersion must be 1');
  const suiteId = str(input.suiteId, 'campaign.suiteId'); obj(input.metadata, 'campaign.metadata');
  if (!Array.isArray(input.runs) || !input.runs.length) fail('campaign.runs must be a non-empty array');
  const runs = input.runs.map(normalize), ids = new Set(), cells = new Set();
  for (const r of runs) {
    if (ids.has(r.id)) fail(`duplicate run id ${r.id}`); ids.add(r.id);
    const k = `${r.condition}\0${r.taskId}\0${r.arm}\0${r.repetition}`;
    if (cells.has(k)) fail(`duplicate condition/task/arm/repetition ${r.condition}/${r.taskId}/${r.arm}/${r.repetition}`); cells.add(k);
  }
  const groups = CONDITIONS.flatMap((condition) => ARMS.map((arm) => {
    const rows = runs.filter((r) => r.condition === condition && r.arm === arm);
    return { condition, arm, ...groupSummary(rows) };
  }));
  const comparisons = [];
  for (const condition of CONDITIONS) {
    for (const arm of ['codefacts017', 'codefacts022', 'codegraph']) comparisons.push(compare(runs, condition, 'ordinary', arm));
    comparisons.push(compare(runs, condition, 'codegraph', 'codefacts017'));
    comparisons.push(compare(runs, condition, 'codegraph', 'codefacts022'));
    comparisons.push(compare(runs, condition, 'codefacts017', 'codefacts022'));
  }
  return { schemaVersion: 1, suiteId, metadata: input.metadata, groups, comparisons };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pretty') { opts.pretty = true; continue; }
    if (!['--input', '--output'].includes(a) || !argv[i + 1] || argv[i + 1].startsWith('-')) fail(`expected --input ABS_JSON and --output ABS_JSON; got ${a}`);
    const path = argv[++i]; if (!isAbsolute(path)) fail(`${a} requires an absolute path`);
    if (opts[a.slice(2)]) fail(`${a} may be provided only once`); opts[a.slice(2)] = path;
  }
  if (!opts.input || !opts.output) fail('usage: node summary.mjs --input ABS_JSON --output ABS_JSON [--pretty]');
  const input = JSON.parse(await readFile(opts.input, 'utf8'));
  const result = summarizeCampaign(input);
  await writeFile(opts.output, `${JSON.stringify(result, null, opts.pretty ? 2 : 0)}\n`, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { process.stderr.write(`summary: ${e.message}\n`); process.exitCode = 1; });
