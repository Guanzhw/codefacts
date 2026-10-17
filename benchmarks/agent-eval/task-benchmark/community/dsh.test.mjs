import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MAX_OUTPUT_TOKENS, makeDshOverlay, runDshAttempt, summarizeDshEvents } from './dsh.mjs';

const selection = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' };
const observed = { uncachedInputTokens: 5, outputTokens: 2, totalTokens: 107, cacheReadTokens: 100 };
const event = (type, data) => ({ type, data });
const header = (config = {}, tools = [{ name: 'mcp__repo__source_read' }]) => event('request/header', {
  header: { config: { ...selection, maxTokens: DEFAULT_MAX_OUTPUT_TOKENS, ...config }, tools },
});
const message = (text, step = 0) => event('assistant/message', { turn: 0, step,
  message: { source: { provider: selection.provider, model: selection.model }, content: [{ type: 'text', text }] },
  usage: { inputTokens: 5, outputTokens: 2, totalTokens: 107, cacheReadTokens: 100 }, stream: [],
});
const turn = (reason = 'completed') => [event('turn/start', { turn: 0 }), header(),
  event('step/start', { turn: 0, step: 0 }), message('Inspected source answer.'),
  event('step/end', { turn: 0, step: 0 }), event('turn/end', { turn: 0, reason: { kind: reason } })];

test('generation allowance is audited on every request alongside route and tool namespace', () => {
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 32768);
  const good = summarizeDshEvents(turn(), selection, () => observed);
  assert.equal(good.answer, 'Inspected source answer.');
  assert.deepEqual(good.exactTurnUsage, observed);
  assert.equal('cacheWriteTokens' in good.exactTurnUsage, false);
  for (const config of [{ maxTokens: 8192 }, { provider: 'different' }, { model: 'different' }, { reasoningEffort: 'low' }]) {
    const rows = turn(); rows.splice(2, 0, header(config));
    const result = summarizeDshEvents(rows, selection, () => observed);
    assert.equal(result.headerAudit, false);
    assert.equal(result.answer, '');
  }
  const rows = turn(); rows.splice(2, 0, header({}, [{ name: 'persistent_bash' }]));
  assert.equal(summarizeDshEvents(rows, selection, () => observed).headerAudit, false);
  assert.equal(summarizeDshEvents([], selection, () => undefined).headerAudit, false);
});

test('max-tokens preserves partial output and billed tokens without a completed answer', () => {
  const result = summarizeDshEvents(turn('max-tokens'), selection, () => observed);
  assert.equal(result.completed, false);
  assert.equal(result.generationCutoff, true);
  assert.equal(result.answer, '');
  assert.equal(result.partialOutput, 'Inspected source answer.');
  assert.equal(result.exactTurnUsage, null);
  assert.deepEqual(result.knownUsageLowerBound, observed);
  assert.equal(result.usageAvailability, 'known-lower-bound');
});

test('incomplete turns retain settled usage when the whole-turn SDK fold is unavailable', () => {
  const rows = turn().slice(0, -1);
  const fold = events => events.at(-1)?.type === 'turn/end' ? observed : undefined;
  const result = summarizeDshEvents(rows, selection, fold);
  assert.equal(result.answer, '');
  assert.equal(result.derivedTurnUsage, null);
  assert.deepEqual(result.knownUsageLowerBound, observed);
});

test('failed settlements do not manufacture exact usage or erase known consumption', () => {
  const rows = turn('error');
  rows.splice(-1, 0, event('step/start', { turn: 0, step: 1 }),
    event('assistant/attempt', { turn: 0, step: 1, stream: [
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
      { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } },
    ] }), event('step/end', { turn: 0, step: 1 }));
  const missingAttemptFold = events => events.some(item => item.type === 'assistant/attempt') ? undefined : observed;
  const failed = summarizeDshEvents(rows, selection, missingAttemptFold);
  assert.equal(failed.exactTurnUsage, null);
  assert.deepEqual(failed.knownUsageLowerBound, observed);
  assert.equal(failed.failedAttemptZeroUsage, true);
  rows.at(-1).data.reason.kind = 'completed';
  const retried = summarizeDshEvents(rows, selection, () => observed);
  assert.equal(retried.exactTurnUsage, null);
  assert.deepEqual(retried.knownUsageLowerBound, observed);
  assert.equal(retried.usageAvailability, 'known-lower-bound');
});

test('execution failures, interruptions and pending tools cannot become final answers', () => {
  for (const state of [{ timedOut: true }, { protocolError: 'broken protocol' }, { processExitCode: 1 }]) {
    const result = summarizeDshEvents(turn(), selection, () => observed, state);
    assert.equal(result.answer, '');
    assert.equal(result.exactTurnUsage, null);
    assert.equal(result.usageAvailability, 'known-lower-bound');
  }
  const interrupted = turn(); interrupted[3].data.interrupted = true;
  assert.equal(summarizeDshEvents(interrupted, selection, () => observed).answer, '');
  const pendingTool = turn(); pendingTool[3].data.message.content.push({ type: 'tool-call', name: 'mcp__repo__source_read' });
  assert.equal(summarizeDshEvents(pendingTool, selection, () => observed).answer, '');
});

test('minimal overlay preserves the frozen adapter tool boundary', () => {
  const options = { attemptDir: '/attempt', root: '/repo', ...selection, nodeCommand: 'node' };
  const rows = makeDshOverlay({ ...options, bridgeEntry: '/bridge.mjs', bridgeConfig: '/arm.json' });
  for (const id of ['llm-deepseek', 'persistent-bash', 'persistent-pwsh', 'llm-retry', 'session-title', 'mcp-resources']) {
    assert.equal(rows.find(row => row.id === id).disabled, true);
  }
  const mcp = rows.at(-1).insert.at(-1).config;
  assert.equal(mcp.serverName, 'repo');
  assert.deepEqual(mcp.args, [path.resolve('/bridge.mjs'), '--config', path.resolve('/arm.json')]);
  assert.deepEqual(mcp.env, {});
  assert.equal(mcp.reconnect.enabled, false);
  assert.throws(() => makeDshOverlay({ ...options, bridgeEntry: '/bridge' }), /supplied together/);
});

function fakeSdk(directory) {
  const installRoot = path.join(directory, 'sdk');
  const meter = path.join(installRoot, 'node_modules/@deepseek-ai/dsh-token-meter/lib/types');
  fs.mkdirSync(meter, { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'lib'));
  fs.writeFileSync(path.join(installRoot, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(meter, '../../package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(meter, 'client.js'), `export const deriveTurnTokenUsage = () => (${JSON.stringify(observed)});`);
  fs.writeFileSync(path.join(installRoot, 'lib/bin.js'), `
    import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    let config;
    input.on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') {
        config = request.params;
        send({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } });
      } else if (request.method === 'session/prompt') {
        send({ jsonrpc: '2.0', id: request.id, result: {} });
        const event = (type, data) => send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: request.params.sessionId, event: { type, data } } });
        event('turn/start', { turn: 0 });
        event('request/header', { header: { config, tools: [{ name: 'mcp__repo__source_read' }] } });
        event('assistant/message', { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'SDK fixture answer.' }] }, stream: [] });
        event('turn/end', { turn: 0, reason: { kind: 'completed' } });
      } else if (request.method === 'shutdown') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n', () => process.exit(0));
      }
    });
  `);
  return installRoot;
}

test('SDK process receives the configured allowance and startup probe is explicit', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codefacts-community-dsh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installRoot = fakeSdk(directory);
  const options = { installRoot, root: directory, timeoutMs: 10000, maxOutputTokens: 49152 };
  const probeDir = path.join(directory, 'probe');
  const probe = await runDshAttempt({ ...options, attemptDir: probeDir, probeOnly: true });
  assert.equal(probe.status, 'probe-completed');
  assert.equal(probe.providerCallSucceeded, false);
  assert.equal(probe.didPrompt, false);
  assert.equal(probe.initialization.maxTokens, 49152);
  assert.equal(probe.exactTurnUsage, null);
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'fixture-secret-never-record';
  t.after(() => { if (previous === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previous; });
  const attemptDir = path.join(directory, 'attempt');
  const receipt = await runDshAttempt({ ...options, attemptDir, prompt: 'Test fixture-secret-never-record redaction.' });
  assert.equal(receipt.status, 'attempt-completed');
  assert.equal(receipt.providerCallSucceeded, true);
  assert.equal(receipt.headerAudit, true);
  assert.equal(receipt.maxOutputTokens, 49152);
  assert.equal(receipt.actualRequestHeaders[0].header.config.maxTokens, 49152);
  assert.equal(receipt.answer, 'SDK fixture answer.');
  const requests = fs.readFileSync(path.join(attemptDir, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests[0].params.maxTokens, 49152);
  for (const name of fs.readdirSync(attemptDir).filter(name => fs.statSync(path.join(attemptDir, name)).isFile())) {
    assert.equal(fs.readFileSync(path.join(attemptDir, name), 'utf8').includes(process.env.OPENCODE_API_KEY), false, name);
  }
  await assert.rejects(runDshAttempt({ ...options, attemptDir: path.join(directory, 'invalid'), maxOutputTokens: 0 }), /positive safe integer/);
  assert.equal(fs.existsSync(path.join(directory, 'invalid')), false);
});
