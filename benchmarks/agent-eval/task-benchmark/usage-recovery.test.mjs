import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { recoverKnownUsage } from './usage-recovery.mjs';

const event = (type, data) => ({ type, data });
const start = () => event('turn/start', { turn: 1 });
const step = (type, number) => event(type, { turn: 1, step: number });
const firstUsage = { inputTokens: 320, outputTokens: 89, totalTokens: 921, cacheReadTokens: 512 };
const secondUsage = { inputTokens: 5025, outputTokens: 253, totalTokens: 6174, cacheReadTokens: 896 };
const message = (number, usage) => event('assistant/message', { turn: 1, step: number, usage,
  message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, content: [] }, stream: [] });
const attempt = (number, usage) => event('assistant/attempt', { turn: 1, step: number, stream: [
  { type: 'chunk', chunk: { type: 'usage', usage } },
  { type: 'chunk', chunk: { type: 'finish', reason: { kind: usage.totalTokens ? 'tool-calls' : 'error' } } },
] });
const interrupted = () => [start(), step('step/start', 1), message(1, firstUsage), step('step/end', 1),
  step('step/start', 2), message(2, secondUsage), step('step/end', 2), step('step/start', 3)];

// The injected test helper checks the accounting boundary contract and folds
// already valid fixture samples. Provider normalization is tested separately
// against the installed DSH helper below, without starting a provider process.
function fixtureDerive(events) {
  assert.equal(events[0].type, 'turn/start');
  assert.equal(events.at(-1).type, 'turn/end');
  const samples = [];
  for (let i = 1; i < events.length - 1; i += 3) {
    assert.equal(events[i].type, 'step/start');
    assert.equal(events[i + 2].type, 'step/end');
    const settlement = events[i + 1];
    const usage = settlement.data.usage ?? settlement.data.stream.at(0)?.chunk.usage;
    if (!usage || usage.totalTokens === undefined) return undefined;
    samples.push(usage);
  }
  if (!samples.length) return undefined;
  const sum = key => samples.reduce((total, usage) => total + usage[key], 0);
  return { uncachedInputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
    ...(samples.every(usage => usage.cacheReadTokens !== undefined) ? { cacheReadTokens: sum('cacheReadTokens') } : {}) };
}

test('two durable completed steps recover the actual interrupted pilot lower bound', () => {
  const events = interrupted();
  const original = JSON.stringify(events);
  const recovered = recoverKnownUsage(events, fixtureDerive);
  assert.deepEqual(recovered.knownUsageLowerBound,
    { uncachedInputTokens: 5345, outputTokens: 342, totalTokens: 7095, cacheReadTokens: 1408 });
  assert.equal(recovered.exactTurnUsage, null);
  assert.equal(recovered.usageAvailability, 'known-lower-bound');
  assert.equal(recovered.closedThroughStep, 2);
  assert.equal(recovered.provenance.observedTurnEnd, false);
  assert.equal(recovered.provenance.unknownRemainder, true);
  assert.deepEqual(recovered.provenance.requests.map(row => row.counted), [true, true, false]);
  assert.equal(JSON.stringify(events), original);
  assert.equal(events.some(row => row.type === 'turn/end'), false);
});

test('attempt, message and repeated message representations count one paid request', () => {
  const events = [start(), step('step/start', 1), attempt(1, firstUsage), message(1, firstUsage),
    message(1, firstUsage), step('step/end', 1)];
  const recovered = recoverKnownUsage(events, fixtureDerive);
  assert.equal(recovered.knownUsageLowerBound.totalTokens, 921);
  assert.deepEqual(recovered.provenance.requests[0].settlementEventIndices, [2, 3, 4]);
  assert.equal(recovered.provenance.requests.length, 1);
});

test('a settled request is recoverable before its step end is durable', () => {
  const recovered = recoverKnownUsage([start(), step('step/start', 1), message(1, firstUsage)], fixtureDerive);
  assert.equal(recovered.knownUsageLowerBound.totalTokens, 921);
  assert.equal(recovered.closedThroughStep, null);
  assert.equal(recovered.provenance.observedTurnEnd, false);
});

test('known request plus failed zero counters stays a lower bound', () => {
  const events = [start(), step('step/start', 1), message(1, firstUsage), step('step/end', 1),
    step('step/start', 2), attempt(2, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    step('step/end', 2), event('turn/end', { turn: 1, reason: { kind: 'error' } })];
  const recovered = recoverKnownUsage(events, fixtureDerive);
  assert.equal(recovered.knownUsageLowerBound.totalTokens, 921);
  assert.equal(recovered.exactTurnUsage, null);
  assert.equal(recovered.provenance.requests[1].counted, false);
  assert.equal(recovered.provenance.observedTurnEnd, true);
});

test('missing and failed zero counters remain unavailable instead of exact zero', () => {
  for (const settlement of [message(1, undefined), attempt(1, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })]) {
    const recovered = recoverKnownUsage([start(), step('step/start', 1), settlement], fixtureDerive);
    assert.equal(recovered.knownUsageLowerBound, null);
    assert.equal(recovered.exactTurnUsage, null);
    assert.equal(recovered.usageAvailability, 'unavailable');
  }
});

test('observed retry-started boundaries distinguish distinct requests within one step', () => {
  const events = [start(), step('step/start', 1), attempt(1, firstUsage), step('llm/retry', 1),
    step('llm/retry-started', 1), message(1, secondUsage), step('step/end', 1)];
  const recovered = recoverKnownUsage(events, fixtureDerive);
  assert.equal(recovered.knownUsageLowerBound.totalTokens, 7095);
  assert.deepEqual(recovered.provenance.requests.map(row => row.attempt), [0, 1]);
});

test('missing request lifecycle preserves earlier evidence and exposes the accounting gap', () => {
  const events = [start(), step('step/start', 1), message(1, firstUsage), step('step/end', 1), message(2, secondUsage)];
  const recovered = recoverKnownUsage(events, fixtureDerive);
  assert.equal(recovered.knownUsageLowerBound.totalTokens, 921);
  assert.deepEqual(recovered.provenance.lifecycleIssue, { eventIndex: 4, reason: 'missing-matching-step-start' });
});

const installedHelperPath = process.env.DSH_TURN_USAGE_MODULE;
test('installed DSH helper validates pilot totals, duplicate representations and failed counters',
  { skip: installedHelperPath ? false : 'set DSH_TURN_USAGE_MODULE to the installed turn-usage.js for offline integration' }, async () => {
    const { deriveTurnTokenUsage } = await import(pathToFileURL(installedHelperPath).href);
    const rows = interrupted();
    assert.equal(deriveTurnTokenUsage(rows), undefined);
    rows.splice(2, 0, attempt(1, firstUsage));
    const recovery = recoverKnownUsage(rows, deriveTurnTokenUsage);
    assert.equal(recovery.knownUsageLowerBound.totalTokens, 7095);
    assert.equal(recovery.knownUsageLowerBound.cacheReadTokens, 1408);
    assert.equal(Object.hasOwn(recovery.knownUsageLowerBound, 'cacheWriteTokens'), false);
    rows.push(attempt(3, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }), step('step/end', 3),
      event('turn/end', { turn: 1, reason: { kind: 'error' } }));
    assert.equal(recoverKnownUsage(rows, deriveTurnTokenUsage).knownUsageLowerBound.totalTokens, 7095);
    assert.equal(recoverKnownUsage(rows, deriveTurnTokenUsage).exactTurnUsage, null);
  });
