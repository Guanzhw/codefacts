import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWave, drainWave } from './scheduler.mjs';

const cells = [
  { id: 'gpt/46', campaignId: 'gpt' }, { id: 'gpt/47', campaignId: 'gpt' }, { id: 'gpt/48', campaignId: 'gpt' },
  { id: 'deepseek/49', campaignId: 'deepseek' }, { id: 'deepseek/50', campaignId: 'deepseek' },
  { id: 'qwen/52', campaignId: 'qwen' },
];
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('first prospective wave preserves frozen order and skips busy campaign', () => {
  assert.deepEqual(selectWave(cells, ['gpt/46'], 2).map(cell => cell.id), ['gpt/47', 'deepseek/49']);
  assert.deepEqual(selectWave(cells, ['gpt/46', 'gpt/47', 'deepseek/49'], 2).map(cell => cell.id), ['gpt/48', 'deepseek/50']);
});
test('accounted outcomes are never scheduled again', () => {
  const accounted = cells.map(cell => cell.id);
  assert.deepEqual(selectWave(cells, accounted, 2), []);
});
test('single remaining campaign retains its enforced serial contract', () => {
  assert.equal(selectWave(cells.slice(0, 3), [], 2).length, 1);
});
test('only reviewed concurrency 1..2 is accepted', () => {
  for (const invalid of [0, 3, 2.5, NaN, '2']) assert.throws(() => selectWave(cells, [], invalid));
});
test('success drains both asynchronous workers before boundary can commit', async () => {
  const first = deferred(), second = deferred(), seen = [];
  const wave = selectWave(cells, ['gpt/46'], 2);
  let completed = false;
  const promise = drainWave(wave, { start: cell => { seen.push(cell.id); return cell.campaignId === 'gpt' ? first.promise : second.promise; } }).then(result => { completed = true; return result; });
  assert.deepEqual(seen, ['gpt/47', 'deepseek/49']);
  first.resolve({ accepted: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(completed, false);
  second.resolve({ accepted: true });
  const result = await promise;
  assert.equal(completed, true); assert.equal(result.failed, false);
  assert.equal(result.results.length, 2);
});
test('failed worker preserves active peer until peer close', async () => {
  const first = deferred(), second = deferred(); let settled = false;
  const promise = drainWave(selectWave(cells, ['gpt/46'], 2), {
    start: cell => cell.campaignId === 'gpt' ? first.promise : second.promise,
  }).then(result => { settled = true; return result; });
  first.reject(new Error('native initialization failure'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  second.resolve('peer grade and cleanup closed');
  const result = await promise;
  assert.equal(result.failed, true);
  assert.deepEqual(result.results.map(row => row.status), ['rejected', 'fulfilled']);
});
test('later admission failure also drains already running worker', async () => {
  const live = deferred(); let calls = 0, settled = false;
  const promise = drainWave(selectWave(cells, ['gpt/46'], 2), { start: () => {
    if (++calls === 2) throw new Error('aggregate disk gate denied');
    return live.promise;
  } }).then(result => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  live.resolve('owned cleanup completed');
  const result = await promise;
  assert.equal(result.failed, true); assert.match(result.admissionError.message, /disk gate/);
  assert.deepEqual(result.admitted, ['gpt/47']);
});
test('drain requested between admissions preserves first worker and starts no second', async () => {
  const live = deferred(); let started = 0;
  const promise = drainWave(selectWave(cells, ['gpt/46'], 2), { shouldStop: () => started === 1,
    start: () => { started++; return live.promise; } });
  assert.equal(started, 1);
  live.resolve('graded and cleaned');
  const result = await promise;
  assert.equal(result.stopRequested, true); assert.equal(result.failed, false);
  assert.deepEqual(result.admitted, ['gpt/47']);
});
test('malformed stop request is failstop and still drains first worker', async () => {
  const live = deferred(); let started = 0, returned = false;
  const promise = drainWave(selectWave(cells, ['gpt/46'], 2), { shouldStop: () => {
    if (started) throw new Error('invalid drain binding'); return false;
  }, start: () => { started++; return live.promise; } }).then(result => { returned = true; return result; });
  await Promise.resolve(); assert.equal(returned, false);
  live.resolve('closed');
  const result = await promise;
  assert.equal(result.failed, true); assert.match(result.admissionError.message, /binding/);
});
test('stop before a wave allocates no worker', async () => {
  let started = 0;
  const result = await drainWave(selectWave(cells, [], 2), { shouldStop: () => true, start: () => { started++; } });
  assert.equal(started, 0); assert.equal(result.stopRequested, true); assert.equal(result.failed, false);
});
