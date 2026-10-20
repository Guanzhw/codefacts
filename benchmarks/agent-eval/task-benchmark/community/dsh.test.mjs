import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_OUTPUT_TOKENS, makeDshOverlay, runDshAttempt, summarizeDshEvents } from './dsh.mjs';
import { resolveDshTokenMeterClient, runDshAttempt as runBaseDshAttempt } from '../dsh-adapter.mjs';

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
  for (const name of ['persistent_bash', 'read_image', 'working_directory']) {
    const rows = turn(); rows.splice(2, 0, header({}, [{ name }]));
    assert.equal(summarizeDshEvents(rows, selection, () => observed).headerAudit, false);
  }
  assert.equal(summarizeDshEvents([], selection, () => undefined).headerAudit, false);
});

test('a completed turn without an active tool catalog retains cost but cannot export an answer', () => {
  for (const missing of [false, true]) {
    const rows = turn();
    rows[1] = header({}, []);
    if (missing) delete rows[1].data.header.tools;
    const result = summarizeDshEvents(rows, selection, () => observed);
    assert.equal(result.headerAudit, false);
    assert.equal(result.answer, '');
    assert.equal(result.partialOutput, 'Inspected source answer.');
    assert.deepEqual(result.exactTurnUsage, observed);
  }
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

// Fixture fold recognizes a valid accounting lifecycle and sums distinct
// settled requests. Duplicate representations invalidate an exact turn fold.
function fixtureUsageFold(events) {
  if (events[0]?.type !== 'turn/start' || events.at(-1)?.type !== 'turn/end') return undefined;
  const samples = [];
  let open = false, settled = false;
  for (const item of events.slice(1, -1)) {
    if (item.type === 'step/start') { if (open) return undefined; open = true; settled = false; }
    else if (['assistant/message', 'assistant/attempt'].includes(item.type)) {
      if (!open || settled) return undefined;
      const usage = item.data.usage ?? item.data.stream.find(record => record.chunk?.type === 'usage')?.chunk.usage;
      if (!usage) return undefined;
      samples.push(usage); settled = true;
    } else if (item.type === 'step/end') { if (!open || !settled) return undefined; open = false; }
  }
  if (open || !samples.length) return undefined;
  const sum = key => samples.reduce((total, usage) => total + usage[key], 0);
  return { uncachedInputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens') };
}

test('recovery counts duplicate settlements once and observed retry requests separately', () => {
  const attempt = () => event('assistant/attempt', { turn: 0, step: 0, stream: [
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 107 } } },
  ] });
  const rows = turn().slice(0, -1); rows.splice(3, 0, attempt());
  const duplicate = summarizeDshEvents(rows, selection, fixtureUsageFold);
  assert.equal(duplicate.derivedTurnUsage, null);
  assert.equal(duplicate.knownUsageLowerBound.totalTokens, 107);
  assert.equal(duplicate.usageRecovery.provenance.requests.length, 1);
  assert.deepEqual(duplicate.usageRecovery.provenance.requests[0].settlementEventIndices, [3, 4]);
  const retried = turn().slice(0, -1);
  retried.splice(3, 0, attempt(), event('llm/retry', { turn: 0, step: 0 }),
    event('llm/retry-started', { turn: 0, step: 0 }));
  const retry = summarizeDshEvents(retried, selection, fixtureUsageFold);
  assert.equal(retry.knownUsageLowerBound.totalTokens, 214);
  assert.deepEqual(retry.usageRecovery.provenance.requests.map(request => request.attempt), [0, 1]);
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

test('community overlay disables native tools added by SDK 0.2.1', () => {
  const options = { attemptDir: '/attempt', root: '/repo', ...selection, nodeCommand: 'node' };
  const rows = makeDshOverlay({ ...options, bridgeEntry: '/bridge.mjs', bridgeConfig: '/arm.json' });
  for (const id of ['llm-deepseek', 'persistent-bash', 'persistent-pwsh', 'llm-retry', 'session-title', 'mcp-resources',
    'tool-fs', 'tool-working-directory']) {
    assert.equal(rows.find(row => row.id === id).disabled, true);
  }
  const mcp = rows.at(-1).insert.at(-1).config;
  assert.equal(mcp.serverName, 'repo');
  assert.deepEqual(mcp.args, [path.resolve('/bridge.mjs'), '--config', path.resolve('/arm.json')]);
  assert.deepEqual(mcp.env, {});
  assert.equal(mcp.reconnect.enabled, false);
  assert.throws(() => makeDshOverlay({ ...options, bridgeEntry: '/bridge' }), /supplied together/);
});

function fakeSdk(directory, { terminalDelayMs = 0, shutdownDelayMs = 0, meterLayout = 'nested' } = {}) {
  const installRoot = meterLayout === 'hoisted'
    ? path.join(directory, 'prefix/node_modules/@deepseek-ai/dsh')
    : path.join(directory, 'sdk');
  const meterPackage = meterLayout === 'hoisted'
    ? path.join(path.dirname(installRoot), 'dsh-token-meter')
    : path.join(installRoot, 'node_modules/@deepseek-ai/dsh-token-meter');
  const meter = path.join(meterPackage, 'lib/types');
  fs.mkdirSync(meter, { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(meterPackage, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-token-meter',
    type: 'module',
    exports: { './client': './lib/types/client.js', './package.json': './package.json' },
  }));
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
        setTimeout(() => event('turn/end', { turn: 0, reason: { kind: 'completed' } }), ${terminalDelayMs});
      } else if (request.method === 'shutdown') {
        setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n', () => process.exit(0)), ${shutdownDelayMs});
      }
    });
  `);
  return installRoot;
}

test('both SDK run helpers persist the selected model compatibility in their overlay', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codefacts-dsh-compat-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installRoot = fakeSdk(directory);
  for (const [name, run] of [['base', runBaseDshAttempt], ['community', runDshAttempt]]) {
    for (const supportsStrictMode of [undefined, false, true]) {
      const attemptDir = path.join(directory, `${name}-${String(supportsStrictMode)}`);
      const receipt = await run({ installRoot, attemptDir, root: directory, ...selection,
        supportsStrictMode, probeOnly: true, timeoutMs: 10000 });
      assert.equal(receipt.status, 'probe-completed');
      assert.equal(receipt.didPrompt, false);
      const overlay = JSON.parse(fs.readFileSync(path.join(attemptDir, 'overlay.json')));
      const provider = overlay.at(-1).insert.find(row => row.id === 'eval-pi-ai').config.providers[selection.provider];
      assert.deepEqual(provider.models, [{ id: selection.model,
        ...(supportsStrictMode === undefined ? {} : { compat: { supportsStrictMode } }) }]);
    }
    const attemptDir = path.join(directory, `${name}-invalid`);
    await assert.rejects(run({ installRoot, attemptDir, root: directory, supportsStrictMode: null,
      probeOnly: true }), /supportsStrictMode must be a boolean/);
    assert.equal(fs.existsSync(attemptDir), false);
  }
});

test('both SDK helpers load the exported token-meter client from nested and hoisted npm layouts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codefacts-dsh-resolution-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const meterLayout of ['nested', 'hoisted']) {
    const installRoot = fakeSdk(path.join(directory, meterLayout), { meterLayout });
    const resolved = fileURLToPath(resolveDshTokenMeterClient(installRoot));
    assert.equal(resolved, path.join(meterLayout === 'hoisted'
      ? path.dirname(installRoot) : installRoot, meterLayout === 'hoisted'
        ? 'dsh-token-meter/lib/types/client.js' : 'node_modules/@deepseek-ai/dsh-token-meter/lib/types/client.js'));
    for (const [name, run] of [['base', runBaseDshAttempt], ['community', runDshAttempt]]) {
      const receipt = await run({ installRoot, attemptDir: path.join(directory, `${meterLayout}-${name}`),
        root: directory, ...selection, probeOnly: true, timeoutMs: 10000 });
      assert.equal(receipt.status, 'probe-completed', `${meterLayout} ${name}`);
    }
  }
});

test('missing token-meter export fails explicitly before allocating an attempt', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codefacts-dsh-missing-meter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installRoot = path.join(directory, 'sdk');
  fs.mkdirSync(installRoot);
  fs.writeFileSync(path.join(installRoot, 'package.json'), '{"type":"module"}');
  for (const [name, run] of [['base', runBaseDshAttempt], ['community', runDshAttempt]]) {
    const attemptDir = path.join(directory, name);
    await assert.rejects(run({ installRoot, attemptDir, root: directory, ...selection, probeOnly: true }), error =>
      error.code === 'MODULE_NOT_FOUND' && error.message.includes('@deepseek-ai/dsh-token-meter/client'));
    assert.equal(fs.existsSync(attemptDir), false);
  }
});

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

test('terminal event ends the task deadline while bounded SDK shutdown finishes later', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codefacts-community-dsh-shutdown-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'fixture-secret';
  t.after(() => { if (previous === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previous; });
  const timeoutMs = 1500;
  const receipt = await runDshAttempt({ installRoot: fakeSdk(directory, { terminalDelayMs: 100, shutdownDelayMs: 2000 }),
    root: directory, attemptDir: path.join(directory, 'attempt'), prompt: 'Fixture answer.', timeoutMs });
  assert.ok(receipt.timings.turnEndedAtMs < timeoutMs);
  assert.ok(receipt.durationMs > timeoutMs);
  assert.equal(receipt.timedOut, false);
  assert.equal(receipt.status, 'attempt-completed');
  assert.equal(receipt.answer, 'SDK fixture answer.');
});
