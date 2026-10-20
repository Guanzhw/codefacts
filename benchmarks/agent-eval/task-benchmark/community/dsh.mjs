import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { makeDshOverlay as makeBaseDshOverlay } from '../dsh-adapter.mjs';
import { recoverKnownUsage } from '../usage-recovery.mjs';

/** Keep the community tool boundary across the 0.2.0 and 0.2.1 SDK profiles. */
export function makeDshOverlay(options) {
  return [
    // sdk-minimal 0.2.1 adds these native tool producers. Cordis skips
    // unmatched patch IDs, so the same overlay also supports 0.2.0.
    { id: 'tool-fs', disabled: true },
    { id: 'tool-working-directory', disabled: true },
    ...makeBaseDshOverlay(options),
  ];
}
// Keep the protocol's per-request generation allowance across SDK versions.
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

/** Export final text only from a successfully completed, audited SDK turn. */
export function summarizeDshEvents(events, { provider, model, reasoningEffort,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS }, deriveTurnTokenUsage,
  { timedOut = false, protocolError = null, processExitCode = 0 } = {}) {
  const start = events.findIndex(event => event.type === 'turn/start');
  const end = events.findIndex(event => event.type === 'turn/end');
  const turn = start < 0 ? [] : events.slice(start, end >= start ? end + 1 : undefined);
  const turnEnd = turn.at(-1)?.type === 'turn/end' ? turn.at(-1).data : null;
  const headers = events.filter(event => event.type === 'request/header').map(event => event.data);
  const headerAudit = headers.length > 0 && headers.every(({ header }) =>
    header.config.provider === provider && header.config.model === model &&
    header.config.reasoningEffort === reasoningEffort && header.config.maxTokens === maxOutputTokens &&
    header.tools?.length > 0 && header.tools.every(tool => tool.name.startsWith('mcp__repo__')));
  const lastMessage = turn.filter(event => event.type === 'assistant/message').at(-1);
  const content = lastMessage?.data.message.content ?? [];
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('');
  const completed = turnEnd?.reason?.kind === 'completed';
  const generationCutoff = turnEnd?.reason?.kind === 'max-tokens';
  const executionFailed = timedOut || Boolean(protocolError) || processExitCode !== 0;
  const answer = completed && !executionFailed && headerAudit && !lastMessage?.data.interrupted &&
    !content.some(block => block.type === 'tool-call') ? text : '';
  const derived = turn.length ? deriveTurnTokenUsage(turn) : undefined;
  const failedAttemptZeroUsage = turn.some(event => event.type === 'assistant/attempt' &&
    event.data.stream.some(record => record.type === 'chunk' && record.chunk.type === 'usage' &&
      record.chunk.usage.totalTokens === 0));
  const exactTurnUsage = completed && !executionFailed && !failedAttemptZeroUsage ? derived ?? null : null;
  const recovery = derived === undefined || failedAttemptZeroUsage ? recoverKnownUsage(turn, deriveTurnTokenUsage) : null;
  const knownUsageLowerBound = recovery ? recovery.knownUsageLowerBound : derived ?? null;
  return { turnEnd, answer, completed, generationCutoff, partialOutput: answer ? '' : text,
    headerAudit, actualRequestHeaders: headers,
    catalogs: headers.map(({ header }) => header.tools ?? []),
    toolCalls: events.filter(event => event.type === 'tool/call').map(event => event.data),
    toolResults: events.filter(event => event.type === 'tool/result').map(event => event.data),
    assistantUsage: events.filter(event => ['assistant/attempt', 'assistant/message'].includes(event.type)).map(event => ({
      type: event.type, turn: event.data.turn, step: event.data.step,
      ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
      ...(event.data.message?.source === undefined ? {} : { source: event.data.message.source }),
      stream: event.data.stream,
    })),
    exactTurnUsage, derivedTurnUsage: derived ?? null, knownUsageLowerBound, failedAttemptZeroUsage,
    usageRecovery: recovery ? { method: recovery.method, closedThroughStep: recovery.closedThroughStep,
      provenance: recovery.provenance } : null,
    usageAvailability: exactTurnUsage ? 'exact-provider-turn-usage' :
      knownUsageLowerBound?.totalTokens > 0 ? 'known-lower-bound' : 'unavailable',
  };
}
/** Run one fresh isolated DSH SDK session. The caller owns scheduling and source/version pinning. */
export async function runDshAttempt({ installRoot, nodeCommand = process.execPath, attemptDir, root,
  provider = 'opencode-go', model = 'deepseek-v4.1-flash', reasoningEffort = 'high',
  supportsStrictMode, bridgeEntry, bridgeConfig, prompt, timeoutMs = 600000, probeOnly = false,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS }) {
  attemptDir = path.resolve(attemptDir); root = path.resolve(root); installRoot = path.resolve(installRoot);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error('maxOutputTokens must be a positive safe integer');
  if (!probeOnly && typeof prompt !== 'string') throw new Error('prompt must be a string');
  if (!probeOnly && !process.env.OPENCODE_API_KEY) throw new Error('OPENCODE_API_KEY missing; no process started');
  const overlay = makeDshOverlay({ attemptDir, root, provider, model, supportsStrictMode, nodeCommand, bridgeEntry, bridgeConfig });
  const { deriveTurnTokenUsage } = await import(pathToFileURL(path.join(installRoot,
    'node_modules/@deepseek-ai/dsh-token-meter/lib/types/client.js')).href);
  fs.mkdirSync(path.dirname(attemptDir), { recursive: true });
  fs.mkdirSync(attemptDir); // Exclusive namespace: never overwrite an allocated attempt.
  const secret = process.env.OPENCODE_API_KEY;
  const scrub = value => secret ? String(value).split(secret).join('[REDACTED]') : String(value);
  const save = (name, value) => fs.writeFileSync(path.join(attemptDir, name), scrub(JSON.stringify(value, null, 2)) + '\n');
  const home = path.join(attemptDir, 'home');
  const overlayPath = path.join(attemptDir, 'overlay.json');
  save('overlay.json', overlay);
  const initialization = { cwd: root, provider, model, reasoningEffort, maxTokens: maxOutputTokens };
  const sessionId = `task-benchmark-${randomUUID()}`;
  const args = [path.join(installRoot, 'lib/bin.js'), '--profile', 'eval', '--from-default-profile', 'sdk-minimal', '--patch', overlayPath];
  save('request.json', { command: nodeCommand, args, initialization, sessionId, prompt: probeOnly ? null : prompt,
    environment: { DSH_HOME: home, OPENCODE_API_KEY: 'inherited; value omitted' }, probeOnly, timeoutMs });
  const events = [], pending = new Map();
  const stdout = fs.openSync(path.join(attemptDir, 'stdio.jsonl'), 'wx');
  const requests = fs.openSync(path.join(attemptDir, 'requests.jsonl'), 'wx');
  const eventLog = fs.openSync(path.join(attemptDir, 'events.jsonl'), 'wx');
  let stderr = '', nextId = 0, timedOut = false, shuttingDown = false, protocolError = null;
  let didInitialize = false, didPrompt = false, initializedAtMs = null, promptedAtMs = null, turnEndedAtMs = null;
  let killTimer;
  const startedAt = new Date().toISOString(), start = performance.now();
  const child = spawn(nodeCommand, args, { cwd: root, windowsHide: true,
    env: { ...process.env, DSH_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const elapsed = () => performance.now() - start;
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    clearTimeout(timer); clearTimeout(killTimer);
    for (const item of pending.values()) item.reject(new Error('DSH process closed'));
    pending.clear(); resolve({ code, signal });
  }));
  const send = (method, params) => {
    const id = ++nextId;
    const frame = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    fs.writeSync(requests, scrub(JSON.stringify(frame)) + '\n');
    child.stdin.write(JSON.stringify(frame) + '\n', error => {
      if (error && pending.has(id)) { pending.get(id).reject(error); pending.delete(id); }
    });
    return promise;
  };
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    send('shutdown').catch(() => {});
    killTimer = setTimeout(() => child.kill('SIGTERM'), 7000);
    killTimer.unref();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  child.stdin.on('error', error => { protocolError ??= scrub(error.message); });
  child.once('error', error => { protocolError ??= scrub(error.message); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    fs.writeSync(stdout, scrub(line) + '\n');
    let frame;
    try { frame = JSON.parse(line); } catch { protocolError = 'Non-JSON SDK stdout'; stop(); return; }
    if (frame.id !== undefined && pending.has(frame.id)) {
      const item = pending.get(frame.id); pending.delete(frame.id);
      frame.error ? item.reject(new Error(JSON.stringify(frame.error))) : item.resolve(frame.result);
    }
    if (frame.method === 'session.event') {
      if (frame.params.sessionId !== sessionId) { protocolError = 'Unexpected foreign session event'; stop(); return; }
      const event = frame.params.event;
      events.push(event); fs.writeSync(eventLog, scrub(JSON.stringify(event)) + '\n');
      if (event.type === 'turn/end') { turnEndedAtMs = elapsed(); clearTimeout(timer); stop(); }
    }
    if (frame.method?.startsWith('subagent.')) { protocolError = 'Unexpected subagent event'; stop(); }
  });
  try {
    const initialized = await send('initialize', initialization);
    if (initialized.serverInfo.name !== 'deepseek-harness-sdk-runtime') throw new Error('Unexpected SDK server identity');
    didInitialize = true; initializedAtMs = elapsed(); save('initialize.json', initialized);
    if (probeOnly || shuttingDown) stop();
    else {
      promptedAtMs = elapsed();
      await send('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: prompt }] });
      didPrompt = true;
    }
  } catch (error) { protocolError ??= scrub(error.message); stop(); }
  const processExit = await closed;
  const durationMs = elapsed();
  lines.close(); fs.closeSync(stdout); fs.closeSync(requests); fs.closeSync(eventLog);
  fs.writeFileSync(path.join(attemptDir, 'stderr.log'), scrub(stderr));
  const summary = summarizeDshEvents(events, { ...initialization, maxOutputTokens }, deriveTurnTokenUsage,
    { timedOut, protocolError, processExitCode: processExit.code });
  const succeeded = !timedOut && !protocolError && processExit.code === 0 && didInitialize &&
    (probeOnly ? !didPrompt && events.length === 0 : didPrompt && summary.completed && summary.headerAudit && summary.answer.trim().length > 0);
  const answer = succeeded && !probeOnly ? summary.answer : '';
  const receipt = { schemaVersion: 2, providerCallSucceeded: succeeded && !probeOnly, status: succeeded ? (probeOnly ? 'probe-completed' : 'attempt-completed') : 'attempt-failed',
    startedAt, endedAt: new Date().toISOString(), sessionId, initialization, maxOutputTokens, probeOnly,
    didInitialize, didPrompt, timedOut, processExit, protocolError, durationMs,
    timings: { initializedAtMs, promptedAtMs, turnEndedAtMs, processExitAtMs: durationMs },
    eventCount: events.length, ...summary, answer };
  save('headers.json', summary.actualRequestHeaders); save('catalogs.json', summary.catalogs);
  save('tools.json', { calls: summary.toolCalls, results: summary.toolResults });
  fs.writeFileSync(path.join(attemptDir, 'answer.md'), scrub(answer));
  save('receipt.json', receipt);
  return receipt;
}
