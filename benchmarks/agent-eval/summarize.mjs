#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INPUTS = ['pilot-results.json', 'cycle-1-results.json', 'cycle-2-results.json'];

export class SummaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SummaryError';
  }
}

function fail(message) {
  throw new SummaryError(message);
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
}

function string(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
  return value;
}

function number(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${path} must be a finite non-negative number`);
  return value;
}

function integer(value, path) {
  number(value, path);
  if (!Number.isInteger(value)) fail(`${path} must be an integer`);
  return value;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentChange(before, after) {
  return before === 0 ? null : ((before - after) / before) * 100;
}

function validateAudit(data, runs, source) {
  if (data.manualAudit) {
    const audit = object(data.manualAudit, `${source}.manualAudit`);
    integer(audit.eligibleRuns, `${source}.manualAudit.eligibleRuns`);
    if (audit.eligibleRuns !== runs.length) fail(`${source}.manualAudit.eligibleRuns does not cover every run`);
    if (audit.contaminationObserved !== false) fail(`${source}.manualAudit.contaminationObserved must be false`);
    integer(audit.blockedCalls, `${source}.manualAudit.blockedCalls`);
    integer(audit.timeouts, `${source}.manualAudit.timeouts`);
    return {
      source: 'manualAudit', eligibleRuns: runs.length, blockedCalls: audit.blockedCalls,
      timeouts: audit.timeouts, contaminationObserved: audit.contaminationObserved,
    };
  }
  if (data.audit) {
    const audit = object(data.audit, `${source}.audit`);
    for (const key of ['eligibleRuns', 'gradedRuns', 'usageMatches']) integer(audit[key], `${source}.audit.${key}`);
    if (audit.eligibleRuns !== runs.length || audit.gradedRuns !== runs.length || audit.usageMatches !== runs.length) {
      fail(`${source}.audit does not mark every run eligible, graded, and usage-matched`);
    }
    if (audit.noRetries !== true) fail(`${source}.audit.noRetries has an ineligible value`);
    if (audit.contaminationObserved !== false) fail(`${source}.audit.contaminationObserved has an ineligible value`);
    if (typeof audit.noTimeouts !== 'boolean') fail(`${source}.audit.noTimeouts must be a boolean`);
    return {
      source: 'audit', eligibleRuns: runs.length, noRetries: audit.noRetries,
      noTimeouts: audit.noTimeouts, contaminationObserved: audit.contaminationObserved,
    };
  }
  if (runs.every((run) => run.manualReview && typeof run.manualReview === 'object')) {
    for (const [index, run] of runs.entries()) {
      if (run.manualReview.environmentValid !== true || run.manualReview.usageReconciled !== true) {
        fail(`${source}.runs[${index}].manualReview does not establish eligibility`);
      }
    }
    return { source: 'run.manualReview', eligibleRuns: runs.length };
  }
  fail(`${source} has no recognized audit proving run eligibility`);
}

function normalizeUsage(run, path) {
  const nested = run.usage && typeof run.usage === 'object' ? run.usage : null;
  const value = (camel, snake) => nested ? nested[snake] : run[camel];
  const inputTokens = number(value('inputTokens', 'input_tokens'), `${path}.inputTokens`);
  const cachedInputTokens = number(value('cachedInputTokens', 'cached_input_tokens'), `${path}.cachedInputTokens`);
  const outputTokens = number(value('outputTokens', 'output_tokens'), `${path}.outputTokens`);
  if (cachedInputTokens > inputTokens) fail(`${path}.cachedInputTokens exceeds inputTokens`);
  const explicitUncached = nested ? nested.uncached_input_tokens : run.uncachedInputTokens;
  const uncachedInputTokens = explicitUncached === undefined
    ? inputTokens - cachedInputTokens
    : number(explicitUncached, `${path}.uncachedInputTokens`);
  if (uncachedInputTokens !== inputTokens - cachedInputTokens) fail(`${path}.uncachedInputTokens does not reconcile input minus cached input`);
  const explicitTotal = run.totalTokens ?? (nested ? nested.total_tokens : undefined);
  const totalTokens = explicitTotal === undefined
    ? inputTokens + outputTokens
    : number(explicitTotal, `${path}.totalTokens`);
  if (totalTokens !== inputTokens + outputTokens) fail(`${path}.totalTokens does not reconcile input plus output`);
  return { inputTokens, cachedInputTokens, uncachedInputTokens, outputTokens, totalTokens };
}

function normalizeRun(run, index, source) {
  object(run, `${source}.runs[${index}]`);
  const path = `${source}.runs[${index}]`;
  const task = string(run.task, `${path}.task`);
  const arm = string(run.arm, `${path}.arm`);
  const repetition = integer(run.repetition, `${path}.repetition`);
  const grade = object(run.grade, `${path}.grade`);
  number(grade.score, `${path}.grade.score`);
  if (!Number.isInteger(grade.score) || grade.score > 4) fail(`${path}.grade.score must be an integer from 0 through 4`);
  if (typeof grade.pass !== 'boolean') fail(`${path}.grade.pass must be a boolean`);
  if (grade.pass !== (grade.score >= 3)) fail(`${path}.grade.pass must agree with the score threshold`);
  if (run.usageReconciled !== undefined && run.usageReconciled !== true) fail(`${path}.usageReconciled must be true`);
  const usage = normalizeUsage(run, `${path}.usage`);
  const elapsedMs = run.wallMs === undefined ? null : number(run.wallMs, `${path}.wallMs`);
  const mcpEvidence = typeof run.mcpUsed === 'boolean' ? 'mcpUsed' :
    (typeof run.mcpCalls === 'number' ? 'mcpCalls' : null);
  const mcpUsed = typeof run.mcpUsed === 'boolean' ? run.mcpUsed :
    (typeof run.mcpCalls === 'number' ? number(run.mcpCalls, `${path}.mcpCalls`) > 0 : null);
  if (run.mcpCalls !== undefined) number(run.mcpCalls, `${path}.mcpCalls`);
  return { task, arm, repetition, pass: grade.pass, score: grade.score, usage, elapsedMs, mcpUsed, mcpEvidence };
}

function usageTotals(runs) {
  const totals = { inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const run of runs) for (const key of Object.keys(totals)) totals[key] += run.usage[key];
  const correctCompletions = runs.filter((run) => run.pass).length;
  return { ...totals, tokensPerCorrectCompletion: correctCompletions ? totals.totalTokens / correctCompletions : null };
}

function adoption(runs) {
  const measured = runs.filter((run) => run.mcpUsed !== null);
  if (measured.length !== runs.length) return { status: 'unknown' };
  const usedAttempts = measured.filter((run) => run.mcpUsed).length;
  return {
    status: 'measured',
    usedAttempts,
    nonUseAttempts: runs.length - usedAttempts,
    attempts: runs.length,
    rate: runs.length ? usedAttempts / runs.length : null,
    source: [...new Set(runs.map((run) => run.mcpEvidence).filter(Boolean))].sort().join('+'),
  };
}

function correctness(runs) {
  const correctCompletions = runs.filter((run) => run.pass).length;
  return {
    attempts: runs.length,
    correctCompletions,
    failedAttempts: runs.length - correctCompletions,
    passRate: runs.length ? correctCompletions / runs.length : null,
  };
}

function taskSummary(runs) {
  const usage = usageTotals(runs);
  const measuredElapsed = runs.flatMap((run) => run.elapsedMs === null ? [] : [run.elapsedMs]);
  const elapsedTotal = measuredElapsed.length === runs.length ? measuredElapsed.reduce((total, value) => total + value, 0) : null;
  const correctCompletions = runs.filter((run) => run.pass).length;
  return {
    ...correctness(runs),
    usage,
    medians: {
      inputTokens: median(runs.map((run) => run.usage.inputTokens)),
      cachedInputTokens: median(runs.map((run) => run.usage.cachedInputTokens)),
      uncachedInputTokens: median(runs.map((run) => run.usage.uncachedInputTokens)),
      outputTokens: median(runs.map((run) => run.usage.outputTokens)),
      totalTokens: median(runs.map((run) => run.usage.totalTokens)),
      elapsedMs: median(measuredElapsed),
    },
    elapsedMs: {
      measuredAttempts: measuredElapsed.length,
      median: median(measuredElapsed),
      total: elapsedTotal,
      timePerCorrectCompletion: elapsedTotal !== null && correctCompletions ? elapsedTotal / correctCompletions : null,
    },
    results: runs.map((run) => ({
      repetition: run.repetition,
      pass: run.pass,
      score: run.score,
      usage: run.usage,
      elapsedMs: run.elapsedMs,
      mcpUsed: run.mcpUsed,
    })),
  };
}

function pairSummary(left, right, leftArm, rightArm) {
  if (!left || !right) return null;
  const bothPass = left.pass && right.pass;
  return {
    task: left.task,
    repetition: left.repetition,
    leftArm,
    rightArm,
    left: { pass: left.pass, totalTokens: left.usage.totalTokens },
    right: { pass: right.pass, totalTokens: right.usage.totalTokens },
    bothPass,
    savingsPct: bothPass ? percentChange(left.usage.totalTokens, right.usage.totalTokens) : null,
  };
}

function configuredComparisons(runs, arms) {
  const comparisons = [];
  const orderedArms = [...arms].sort((a, b) => {
    if (a === 'before') return -1;
    if (b === 'before') return 1;
    if (a === 'after') return -1;
    if (b === 'after') return 1;
    return a.localeCompare(b);
  });
  for (let i = 0; i < orderedArms.length; i += 1) for (let j = i + 1; j < orderedArms.length; j += 1) {
    const leftArm = orderedArms[i];
    const rightArm = orderedArms[j];
    const leftRuns = runs.filter((run) => run.arm === leftArm);
    const rightRuns = runs.filter((run) => run.arm === rightArm);
    const rightByKey = new Map(rightRuns.map((run) => [`${run.task}\0${run.repetition}`, run]));
    const pairs = leftRuns
      .map((run) => pairSummary(run, rightByKey.get(`${run.task}\0${run.repetition}`), leftArm, rightArm))
      .filter(Boolean)
      .sort((a, b) => a.task.localeCompare(b.task) || a.repetition - b.repetition);
    comparisons.push({
      leftArm,
      rightArm,
      interpretation: 'descriptive configured-arm comparison; MCP non-use remains an adoption observation',
      matchedPairs: pairs,
    });
  }
  return comparisons;
}

export function summarizeCampaign(data, source = '<input>') {
  object(data, source);
  string(data.condition, `${source}.condition`);
  string(data.date, `${source}.date`);
  if (!Array.isArray(data.runs) || data.runs.length === 0) fail(`${source}.runs must be a non-empty array`);
  const runs = data.runs.map((run, index) => normalizeRun(run, index, source));
  const seen = new Set();
  for (const run of runs) {
    const key = `${run.arm}\0${run.task}\0${run.repetition}`;
    if (seen.has(key)) fail(`${source}.runs contains duplicate arm/task/repetition ${run.arm}/${run.task}/${run.repetition}`);
    seen.add(key);
  }
  const audit = validateAudit(data, data.runs, source);
  const arms = [...new Set(runs.map((run) => run.arm))].sort((a, b) => a.localeCompare(b));
  const tasks = [...new Set(runs.map((run) => run.task))].sort((a, b) => a.localeCompare(b));
  const armSummaries = arms.map((arm) => {
    const armRuns = runs.filter((run) => run.arm === arm);
    return {
      id: arm,
      ...correctness(armRuns),
      usage: usageTotals(armRuns),
      elapsedMs: {
        measuredAttempts: armRuns.filter((run) => run.elapsedMs !== null).length,
        median: median(armRuns.flatMap((run) => run.elapsedMs === null ? [] : [run.elapsedMs])),
        total: armRuns.every((run) => run.elapsedMs !== null)
          ? armRuns.reduce((total, run) => total + run.elapsedMs, 0)
          : null,
        timePerCorrectCompletion: armRuns.every((run) => run.elapsedMs !== null) && armRuns.some((run) => run.pass)
          ? armRuns.reduce((total, run) => total + run.elapsedMs, 0) / armRuns.filter((run) => run.pass).length
          : null,
      },
      adoption: adoption(armRuns),
      tasks: tasks.filter((task) => armRuns.some((run) => run.task === task)).map((task) => ({
        id: task,
        ...taskSummary(armRuns.filter((run) => run.task === task)),
      })),
    };
  });
  const before = runs.filter((run) => run.arm === 'before');
  const after = runs.filter((run) => run.arm === 'after');
  const matchedPairs = before.length && after.length ? before
    .map((run) => pairSummary(run, after.find((candidate) => candidate.task === run.task && candidate.repetition === run.repetition), 'before', 'after'))
    .filter(Boolean)
    .sort((a, b) => a.task.localeCompare(b.task) || a.repetition - b.repetition) : [];
  return {
    source: basename(source),
    date: data.date,
    condition: data.condition,
    agent: data.agent ? {
      model: data.agent.model ?? null,
      reasoningEffort: data.agent.reasoningEffort ?? null,
      cli: data.agent.cli ?? null,
      platform: data.agent.platform ?? null,
    } : null,
    audit,
    arms: armSummaries,
    matchedPairs,
    configuredArmComparisons: configuredComparisons(runs, arms),
  };
}

export async function loadCampaign(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`cannot read or parse ${path}: ${error.message}`);
  }
  return summarizeCampaign(parsed, path);
}

function inputPaths(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pretty') continue;
    if (arg === '--input') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) fail('--input requires a path');
      paths.push(argv[++i]);
    } else if (arg.startsWith('--input=')) {
      const path = arg.slice('--input='.length);
      if (!path) fail('--input requires a path');
      paths.push(path);
    }
    else if (arg === '--help' || arg === '-h') return null;
    else if (arg.startsWith('-')) fail(`unknown option ${arg}`);
    else paths.push(arg);
  }
  return paths.length ? paths : DEFAULT_INPUTS.map((file) => resolve(HERE, file));
}

export async function main(argv = process.argv.slice(2), stdout = process.stdout) {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write('Usage: node summarize.mjs [--input FILE]... [--pretty]\n');
    return;
  }
  const paths = inputPaths(argv);
  const campaigns = [];
  for (const path of paths) campaigns.push(await loadCampaign(isAbsolute(path) ? path : resolve(process.cwd(), path)));
  campaigns.sort((a, b) => a.date.localeCompare(b.date) || a.condition.localeCompare(b.condition) || a.source.localeCompare(b.source));
  stdout.write(`${JSON.stringify({ schemaVersion: 1, campaigns }, null, argv.includes('--pretty') ? 2 : 0)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`summarize: ${error.message}\n`);
    process.exitCode = 1;
  });
}
