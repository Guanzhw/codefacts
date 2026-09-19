import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ARMS,
  assertRunSlotOpen,
  buildSchedule,
  classifyFaults,
  comparableInputs,
  substantiveReadinessCalls,
  summarizeRows,
} from './campaign.mjs';

const tasks = Array.from({ length: 6 }, (_, index) => ({ id: `T${index + 1}`, prompt: `Question ${index + 1}` }));

test('two reversed Latin rotations balance every arm and position per task', () => {
  const schedule = buildSchedule(tasks);
  assert.equal(schedule.length, 36);
  for (const task of tasks) {
    const rows = schedule.filter((row) => row.taskId === task.id);
    assert.deepEqual(rows.slice(3).map((row) => row.arm), rows.slice(0, 3).map((row) => row.arm).reverse());
    for (const arm of ARMS) assert.deepEqual(rows.filter((row) => row.arm === arm).map((row) => row.run), [1, 2]);
  }
  for (const round of [1, 2]) for (const position of [1, 2, 3]) {
    const counts = Object.fromEntries(ARMS.map((arm) => [arm, schedule.filter((row) => row.round === round && row.position === position && row.arm === arm).length]));
    assert.deepEqual(counts, { ordinary: 2, codefacts: 2, codegraph: 2 });
  }
});

test('freeze comparison catches source and implementation drift but permits CodeGraph cache byte drift', () => {
  const base = {
    source: { files: 446, bytes: 1000, digest: 'source-a' },
    toySource: { files: 3, bytes: 100, digest: 'toy-a' },
    codegraphIndex: { files: 3, bytes: 50, digest: 'index-a' },
    codegraphMaster: { files: 3, bytes: 50, digest: 'index-a' },
    toyCodegraphMaster: { files: 3, bytes: 20, digest: 'toy-index-a' },
    codefactsMaster: { bytes: 80, sha256: 'cf-state' },
    tasksSha256: 'tasks', rubricSha256: 'rubric', provenanceSha256: 'provenance', readmeSha256: 'readme',
    preparedSha256: 'prepared',
    runnerSha256: 'runner', campaignSha256: 'campaign', configSha256: 'config',
    codexSha256: 'codex', codefactsSha256: 'cf', codegraphNodeSha256: 'node', codegraphPackageSha256: 'pkg', codegraphDistDigest: 'dist',
  };
  assert.deepEqual(comparableInputs({ ...base, codegraphIndex: { files: 4, bytes: 60, digest: 'index-b' } }), comparableInputs(base));
  assert.notDeepEqual(comparableInputs({ ...base, source: { ...base.source, digest: 'source-b' } }), comparableInputs(base));
  assert.notDeepEqual(comparableInputs({ ...base, codegraphDistDigest: 'dist-b' }), comparableInputs(base));
});

test('an orphaned runner directory blocks an implicit attempt suffix rerun', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codefacts-campaign-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertRunSlotOpen(root, 'T1', 'ordinary', 1));
  await mkdir(join(root, 'T1', 'ordinary', 'run-001'), { recursive: true });
  assert.throws(() => assertRunSlotOpen(root, 'T1', 'ordinary', 1), /blocks rerun/);
});

test('runtime, MCP, policy, and environment faults stop; answer quality does not', () => {
  const clean = { executionCompleted: true, timedOut: false, spawnError: null, exitCode: 0, startupErrors: [], approvalRejections: [], blockedToolFailures: [], usageConflict: false, parseErrors: [] };
  assert.deepEqual(classifyFaults(clean), []);
  assert.deepEqual(classifyFaults({ ...clean, timedOut: true }), ['runtime']);
  assert.deepEqual(classifyFaults({ ...clean, approvalRejections: [{}] }), ['policy']);
  assert.deepEqual(classifyFaults({ ...clean, usageConflict: true }), ['environment']);
  assert.deepEqual(classifyFaults({ ...clean, policy: { forbiddenUserConfigAccess: true } }), ['contamination']);
  assert.deepEqual(classifyFaults({ ...clean, applicationMcpErrors: 1 }), []);
  assert.deepEqual(classifyFaults(clean, { mcpTransportError: true }), ['mcp-transport']);
});

test('readiness requires a substantive tool rather than CodeFacts map alone', () => {
  const metrics = (byName) => ({ rolloutToolCalls: { byName } });
  assert.equal(substantiveReadinessCalls(metrics({ 'mcp_tool_call:codefacts/map': 1 }), 'codefacts'), 0);
  assert.equal(substantiveReadinessCalls(metrics({ 'mcp_tool_call:codefacts/search': 1 }), 'codefacts'), 1);
  assert.equal(substantiveReadinessCalls(metrics({ 'mcp_tool_call:codegraph/codegraph_explore': 1 }), 'codegraph'), 1);
});

test('summary charges every attempt to correct completions and keeps matched-correct differences secondary', () => {
  const labels = Object.fromEntries(tasks.flatMap((task) => ARMS.flatMap((arm) => [1, 2].map((run) => [`${task.id}:${arm}:${run}`, `${task.id}-${arm}-${run}`]))));
  const schedule = buildSchedule(tasks, labels);
  const attempts = schedule.map((row) => ({
    ...row,
    audit: {
      resultDir: `result/${row.ordinal}`,
      totalTokens: row.arm === 'codefacts' ? 80 : 100,
      durationMs: row.arm === 'codefacts' ? 800 : 1000,
      usage: { input_tokens: row.arm === 'codefacts' ? 70 : 90, cached_input_tokens: 20, output_tokens: 10 },
    },
  }));
  const grades = new Map(schedule.map((row) => [row.label, { correct: row.arm !== 'codefacts' || row.taskIndex < 3 }]));
  const evaluationAudits = new Map(schedule.map((row) => [row.label, { evaluationValid: true }]));
  const result = summarizeRows(schedule, attempts, grades, evaluationAudits);
  assert.equal(result.primary.ordinary.correctCompletions, 12);
  assert.equal(result.primary.codefacts.correctCompletions, 6);
  assert.equal(result.primary.codefacts.metrics.totalTokensAllAttempts.value, 960);
  assert.equal(result.primary.codefacts.metrics.totalTokensPerCorrectCompletion.value, 160);
  assert.equal(result.secondary.codefacts_vs_ordinary.totalTokens.medianTaskPercentDifference, -20);
  assert.equal(result.secondary.codefacts_vs_ordinary.totalTokens.tasks.length, 3);

  const missingMetric = structuredClone(attempts);
  missingMetric[0].audit.totalTokens = null;
  const incomplete = summarizeRows(schedule, missingMetric, grades, evaluationAudits);
  assert.equal(incomplete.primary[missingMetric[0].arm].metrics.totalTokensAllAttempts.value, null);

  const partialGrades = new Map([...grades].slice(0, 35));
  const partial = summarizeRows(schedule, attempts, partialGrades, evaluationAudits);
  assert.equal(partial.allGradesPresent, false);
  assert.equal(partial.primary.ordinary.correctnessRate, null);
  assert.equal(partial.primary.ordinary.metrics.totalTokensPerCorrectCompletion.value, null);

  const invalidAudit = new Map(evaluationAudits);
  invalidAudit.set(schedule[0].label, { evaluationValid: false });
  const invalid = summarizeRows(schedule, attempts, grades, invalidAudit);
  assert.equal(invalid.analysisEligible, false);
  assert.equal(invalid.primary.ordinary.metrics.totalTokensAllAttempts.value, 1200);
  assert.equal(invalid.primary.ordinary.metrics.totalTokensPerCorrectCompletion.value, null);
  assert.equal(invalid.secondary.codefacts_vs_ordinary.totalTokens.medianTaskPercentDifference, null);
});
