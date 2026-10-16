import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderReport } from './publish.mjs';
import { summarizeCampaign } from './summary.mjs';

const here = new URL('.', import.meta.url);
const baseline = new URL('./results/2026-10-17-flash-v2/', here);
const artifact = (name) => fileURLToPath(new URL(name, baseline));
const readJson = async (name) => JSON.parse(await readFile(artifact(name), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const [results, savedSummary, suite, validation, report] = await Promise.all([
  readJson('results.json'),
  readJson('summary.json'),
  readFile(fileURLToPath(new URL('./suites/source-investigation-v2/tasks.json', here)), 'utf8').then(JSON.parse),
  readJson('validation.json'),
  readFile(artifact('REPORT.md'), 'utf8'),
]);

test('published baseline preserves the complete reviewed schedule and derived outputs', () => {
  const arms = ['ordinary', 'codefacts017', 'codefacts022', 'codegraph'];
  const tasks = suite.tasks.map(({ id }) => id);
  assert.equal(tasks.length, 6, 'source-investigation-v2 must define six tasks');
  assert.equal(new Set(tasks).size, tasks.length, 'suite task IDs must be unique');
  assert.equal(results.runs.length, 96, 'published baseline must contain all 96 attempts');
  assert.equal(results.metadata.plannedAttempts, 96, 'planned attempt count must remain 96');
  assert.equal(results.metadata.observedAttempts, 96, 'observed attempt count must remain 96');

  const expectedCells = new Set();
  for (const taskId of tasks) for (const arm of arms) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      expectedCells.add(`guided-use/${taskId}/${arm}/${repetition}`);
    }
    expectedCells.add(`natural-choice/${taskId}/${arm}/1`);
  }
  const actualCells = results.runs.map((run) => `${run.condition}/${run.taskId}/${run.arm}/${run.repetition}`);
  assert.equal(new Set(actualCells).size, actualCells.length, 'schedule must not contain duplicate cells');
  assert.deepEqual(new Set(actualCells), expectedCells, 'every task/arm/repetition cell must be present exactly once');

  const guided = results.runs.filter((run) => run.condition === 'guided-use');
  const natural = results.runs.filter((run) => run.condition === 'natural-choice');
  assert.equal(guided.length, 72, 'guided-use schedule must contain 72 attempts');
  assert.equal(natural.length, 24, 'natural-choice schedule must contain 24 attempts');
  assert.equal(results.runs.filter((run) => run.usage !== null).length, 93, 'exact usage coverage must remain 93/96');
  assert.equal(results.runs.filter((run) => run.usage === null).length, 3, 'unknown usage coverage must remain 3/96');

  assert.deepEqual(summarizeCampaign(results), savedSummary, 'saved summary must equal the summary recomputed from published results');
  assert.equal(renderReport(results, savedSummary, suite), report, 'committed report must equal the rendered report');
});

test('all published answers remain byte-bound to their locked grades', () => {
  assert.equal(results.runs.length, 96, 'answer bindings must cover all 96 attempts');
  for (const run of results.runs) {
    assert.equal(run.grade?.locked, true, `${run.id}: grade must remain locked`);
    assert.equal(typeof run.answer, 'string', `${run.id}: published answer must be text`);
    const actualHash = sha256(Buffer.from(run.answer, 'utf8'));
    assert.equal(actualHash, run.answerSha256, `${run.id}: answerSha256 must match exact UTF-8 answer bytes`);
    assert.equal(actualHash, run.gradingAnswerSha256, `${run.id}: gradingAnswerSha256 must match the graded answer bytes`);
  }
});

test('validation hashes match published artifact bytes and public artifacts contain no local paths', async () => {
  for (const name of ['results.json', 'summary.json', 'REPORT.md']) {
    const record = validation.artifacts.find((item) => item.name === name);
    assert.ok(record, `validation.json must record ${name}`);
    assert.equal(record.sha256, sha256(await readFile(artifact(name))), `validation hash for ${name} must match its exact bytes`);
  }

  const publicJson = JSON.stringify({ results, summary: savedSummary });
  const localPath = /(?:\b[A-Z]:[\\/]|\\\\(?:Users|home)\\|\/(?:Users|home)\/[^/\s"']+)/i;
  assert.doesNotMatch(publicJson, localPath, 'published JSON must not expose local drive or user-home paths');
  assert.doesNotMatch(report, localPath, 'published report must not expose local drive or user-home paths');
});
