import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeDshOverlay, summarizeDshEvents } from './dsh-adapter.mjs';

const selection = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' };
const event = (type, data) => ({ type, data });
const header = (tools = [{ name: 'mcp__repo__source_read' }]) => event('request/header', {
  header: { config: { ...selection, maxTokens: 8192 }, tools },
});
const message = text => event('assistant/message', { turn: 0, step: 0,
  message: { source: { provider: selection.provider, model: selection.model }, content: [{ type: 'text', text }] },
  usage: { inputTokens: 5, outputTokens: 2, totalTokens: 107, cacheReadTokens: 100 }, stream: [],
});
const complete = reason => [event('turn/start', { turn: 0 }), header(), message('Complete source answer.'),
  event('turn/end', { turn: 0, reason: { kind: reason } })];

test('SDK overlay isolates tools and forwards only explicit bridge configuration', () => {
  const options = { attemptDir: '/tmp/attempt', root: '/tmp/repo', ...selection, nodeCommand: 'node' };
  const plain = makeDshOverlay(options);
  for (const id of ['llm-deepseek', 'persistent-bash', 'persistent-pwsh', 'llm-retry', 'session-title', 'mcp-resources']) {
    assert.equal(plain.find(row => row.id === id).disabled, true);
  }
  assert.equal(plain.at(-1).insert.some(row => row.name.includes('mcp')), false);
  const rows = makeDshOverlay({ ...options, bridgeEntry: '/bridge.mjs', bridgeConfig: '/arm.json' });
  const mcp = rows.at(-1).insert.at(-1).config;
  assert.equal(mcp.serverName, 'repo');
  assert.deepEqual(mcp.args, [path.resolve('/bridge.mjs'), '--config', path.resolve('/arm.json')]);
  assert.equal(mcp.reconnect.enabled, false);
  assert.throws(() => makeDshOverlay({ ...options, bridgeEntry: '/bridge' }), /supplied together/);
});

test('success preserves authoritative full usage and unknown cache buckets', () => {
  const usage = { uncachedInputTokens: 5, outputTokens: 2, totalTokens: 107, cacheReadTokens: 100 };
  const result = summarizeDshEvents(complete('completed'), selection, () => usage);
  assert.equal(result.answer, 'Complete source answer.');
  assert.deepEqual(result.exactTurnUsage, usage);
  assert.equal('cacheWriteTokens' in result.exactTurnUsage, false);
  assert.equal(result.assistantUsage.length, 1);
});

test('incomplete or failed turns never export commentary as an answer', () => {
  for (const rows of [complete('error'), complete('aborted'), complete('completed').slice(0, -1)]) {
    assert.equal(summarizeDshEvents(rows, selection, () => undefined).answer, '');
  }
  const interrupted = complete('completed'); interrupted[2].data.interrupted = true;
  assert.equal(summarizeDshEvents(interrupted, selection, () => undefined).answer, '');
  const tools = complete('completed'); tools[2].data.message.content.push({ type: 'tool-call', name: 'mcp__repo__source_read' });
  assert.equal(summarizeDshEvents(tools, selection, () => undefined).answer, '');
});

test('every request header must match the pinned route and strict tool namespace', () => {
  const rows = complete('completed'); rows.splice(2, 0, header([{ name: 'pwsh' }]));
  assert.equal(summarizeDshEvents(rows, selection, () => undefined).headerAudit, false);
  assert.equal(summarizeDshEvents(rows, selection, () => undefined).answer, '');
  const mismatch = complete('completed'); mismatch[1].data.header.config.model = 'another-model';
  assert.equal(summarizeDshEvents(mismatch, selection, () => undefined).headerAudit, false);
});

test('failed zero usage remains unknown and retry streams remain available', () => {
  const rows = complete('error');
  rows.splice(2, 0, event('assistant/attempt', { turn: 0, step: 0, stream: [{ chunk: { type: 'usage', usage: { totalTokens: 7 } } }] }));
  const result = summarizeDshEvents(rows, selection, () => ({ totalTokens: 0 }));
  assert.equal(result.exactTurnUsage, null);
  assert.deepEqual(result.derivedTurnUsage, { totalTokens: 0 });
  assert.equal(result.assistantUsage[0].stream[0].chunk.usage.totalTokens, 7);
});

test('known billed request plus failed zero sample is only a lower bound', () => {
  const rows = complete('error');
  rows.splice(3, 0, event('assistant/attempt', { turn: 0, step: 1, stream: [
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
    { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } },
  ] }));
  const observed = { uncachedInputTokens: 5, outputTokens: 2, totalTokens: 107, cacheReadTokens: 100 };
  const result = summarizeDshEvents(rows, selection, () => observed);
  assert.equal(result.exactTurnUsage, null);
  assert.equal(result.knownUsageLowerBound.totalTokens, 107);
  assert.equal(result.usageAvailability, 'known-lower-bound');
  assert.equal(result.failedAttemptZeroUsage, true);
  assert.equal(result.answer, '');
  rows.at(-1).data.reason.kind = 'completed';
  const retried = summarizeDshEvents(rows, selection, () => observed);
  assert.equal(retried.exactTurnUsage, null);
  assert.equal(retried.knownUsageLowerBound.totalTokens, 107);
});

test('timeout and process errors keep successful-turn counters as a lower bound', () => {
  const observed = { uncachedInputTokens: 5, outputTokens: 2, totalTokens: 107 };
  for (const state of [{ timedOut: true }, { protocolError: 'wire error' }, { processExitCode: 1 }]) {
    const result = summarizeDshEvents(complete('completed'), selection, () => observed, state);
    assert.equal(result.exactTurnUsage, null);
    assert.equal(result.knownUsageLowerBound.totalTokens, 107);
    assert.equal(result.usageAvailability, 'known-lower-bound');
    assert.equal(result.answer, '');
  }
});
