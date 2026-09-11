#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 240_000;
const BASE_PROMPT = `You are answering a bounded repository question for a token-efficiency evaluation.

Use read-only inspection of this task's repository snapshot only. Use available code-navigation MCP tools if useful and ordinary shell rg/file reads. Do not edit files, write to the repository, access the network, read user/home skills or config, access generated indexes or evaluation artifacts, inspect another repository, invoke external agents, or invoke CodeFacts or CodeGraph through a shell command. Cite source paths and line or symbol locations for factual claims. Be concise and stop when there is sufficient evidence; keep the final answer under about 250 words.`;

const COMMAND_TYPES = new Set(['command_execution', 'shell_command', 'command', 'local_shell']);
const MCP_TYPES = new Set(['mcp_tool_call', 'mcp_call', 'mcp_tool']);

function usage() {
  return `Usage: node runner.mjs [options]

Run selected manifest entries (all selected entries run sequentially):
  --manifest PATH       Manifest JSON (default: ./manifest.json)
  --output-dir PATH     Results directory (default: ./results)
  --task ID              Run one task ID
  --arm ID               Run one arm ID
  --run N                Run one 1-based repetition
  --timeout-ms N         Per-process timeout (default: 240000)
  --codex PATH           Absolute codex.exe override
  --sessions-dir PATH    Codex sessions root for automatic rollout lookup
  --rollout PATH         Saved rollout JSONL to merge for this run
  --merge-run PATH       Augment an existing result directory with --rollout
  --inspect-jsonl PATH   Parse an existing stdout.jsonl and print metrics; no run
  --help                 Show this help

Manifest shape:
  { "tasks": [{ "id": "...", "root": "...", "prompt": "..." }],
    "arms": [{ "id": "...", "configOverrides": ["key=value"] }],
    "runs": 2, "codexBin": "C:/absolute/path/codex.exe",
    "guidance": "Optional identical guidance appended to every arm" }
`;
}

function parseArgs(argv) {
  const options = { manifest: join(SCRIPT_DIR, 'manifest.json'), outputDir: join(SCRIPT_DIR, 'results'), timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const key = {
      '--manifest': 'manifest', '--output-dir': 'outputDir', '--task': 'task', '--arm': 'arm',
      '--run': 'run', '--timeout-ms': 'timeoutMs', '--codex': 'codex', '--sessions-dir': 'sessionsDir',
      '--rollout': 'rollout', '--merge-run': 'mergeRun', '--inspect-jsonl': 'inspectJsonl',
    }[arg];
    if (!key) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    options[key] = value;
  }
  if (options.run !== undefined) {
    options.run = Number(options.run);
    if (!Number.isInteger(options.run) || options.run < 1) throw new Error('--run must be a positive integer');
  }
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('--timeout-ms must be a positive integer');
  return options;
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function codePointLength(value) {
  return Array.from(value).length;
}

function outputForItem(item) {
  if (!item || typeof item !== 'object') return '';
  const keys = item.type && COMMAND_TYPES.has(item.type)
    ? ['aggregated_output', 'output', 'stdout', 'stderr', 'result', 'content']
    : ['result', 'output', 'content', 'stdout', 'stderr', 'aggregated_output'];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(item, key)) return textValue(item[key]);
  }
  return '';
}

function mcpName(item) {
  const server = item.server || item.server_name || item.mcp_server;
  const tool = item.tool || item.tool_name || item.name || item.mcp_tool;
  if (server && tool) return `${server}/${tool}`;
  return String(tool || server || 'mcp');
}

function commandName(item) {
  const command = String(item.command || item.name || 'shell').trim();
  const first = command.match(/^(?:["']([^"']+)["']|(\S+))/);
  return first ? (first[1] || first[2]) : 'shell';
}

function parseJsonl(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  const events = [];
  const parseErrors = [];
  const usageEvents = [];
  const messages = [];
  const calls = new Map();
  const outputByCall = new Map();
  let threadId;
  let turnCompleted = 0;

  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
      events.push(event);
    } catch (error) {
      parseErrors.push({ line: index + 1, message: error.message, text: lines[index].slice(0, 500) });
      continue;
    }
    if (event.thread_id) threadId = event.thread_id;
    if (event.type === 'turn.completed') {
      turnCompleted += 1;
      if (event.usage && typeof event.usage === 'object') usageEvents.push(event.usage);
    }
    const topLevelItem = event.item && typeof event.item === 'object' ? event.item : null;
    const item = topLevelItem || (event.type && event.type.startsWith('item.') ? event : null);
    if (item && item.type) {
      const commandLike = COMMAND_TYPES.has(item.type);
      const mcpLike = MCP_TYPES.has(item.type);
      const key = item.id ? String(item.id) : `${item.type}:${commandLike ? commandName(item) : mcpLike ? mcpName(item) : 'item'}:${index}`;
      const completed = event.type === 'item.completed' || event.type === 'item.failed' || item.status === 'completed' || item.status === 'failed';
      if ((commandLike || mcpLike) && (!calls.has(key) || completed)) {
        if (!calls.has(key)) calls.set(key, {
          key,
          id: item.id || null,
          type: item.type,
          name: commandLike ? commandName(item) : mcpName(item),
          command: commandLike ? String(item.command || '') : undefined,
          item,
        });
      }
      if (calls.has(key)) {
        const call = calls.get(key);
        call.item = item;
        if (commandLike) {
          if (item.command) call.command = String(item.command);
          call.name = commandName(item);
        }
        if (mcpLike) call.name = mcpName(item);
        if (completed) call.completed = true;
      }
      const output = outputForItem(item);
      if (output && (!outputByCall.has(key) || completed)) outputByCall.set(key, output);
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) messages.push(item.text);
    }
    if (event.type === 'agent_message' && typeof event.text === 'string' && event.text.trim()) messages.push(event.text);
  }

  const byType = {};
  const byName = {};
  let commandBytes = 0;
  let commandChars = 0;
  let mcpBytes = 0;
  let mcpChars = 0;
  let commandCalls = 0;
  let mcpCalls = 0;
  const forbiddenCliCommands = [];
  const forbiddenExternalAgentCommands = [];
  const forbiddenEvalArtifactCommands = [];
  const forbiddenUserConfigCommands = [];
  const forbiddenCli = /(?:^|[\s"'\\/])(?:codefacts|codegraph)(?:\.exe)?(?:\s|$)/i;
  const externalAgent = /(?:^|[\s"'\\/])(?:pi|claude|gemini|aider|opencode)(?:\.exe)?(?:\s|$)/i;
  const userConfig = /(?:\.codex[\\/]config\.toml|CODEX_HOME|AppData[\\/]Local[\\/]OpenAI)/i;
  for (const call of calls.values()) {
    byType[call.type] = (byType[call.type] || 0) + 1;
    const nameKey = `${call.type}:${call.name}`;
    byName[nameKey] = (byName[nameKey] || 0) + 1;
    const callOutput = outputByCall.get(call.key) || '';
    const bytes = Buffer.byteLength(callOutput, 'utf8');
    const chars = codePointLength(callOutput);
    if (COMMAND_TYPES.has(call.type)) {
      commandCalls += 1;
      commandBytes += bytes;
      commandChars += chars;
      if (forbiddenCli.test(call.command || '')) forbiddenCliCommands.push({ id: call.id, command: call.command });
      if (externalAgent.test(call.command || '')) forbiddenExternalAgentCommands.push({ id: call.id, command: call.command });
      if (userConfig.test(call.command || '')) forbiddenUserConfigCommands.push({ id: call.id, command: call.command });
    } else if (MCP_TYPES.has(call.type)) {
      mcpCalls += 1;
      mcpBytes += bytes;
      mcpChars += chars;
    }
  }

  const normalizeUsage = (value) => value ? {
    input_tokens: value.input_tokens ?? null,
    cached_input_tokens: value.cached_input_tokens ?? null,
    cache_write_input_tokens: value.cache_write_input_tokens ?? null,
    output_tokens: value.output_tokens ?? null,
    reasoning_output_tokens: value.reasoning_output_tokens ?? null,
  } : null;
  const usage = usageEvents.length ? usageEvents[usageEvents.length - 1] : null;
  return {
    threadId: threadId || null,
    eventCount: events.length,
    parseErrors,
    turnCompleted,
    answer: messages.length ? messages[messages.length - 1] : '',
    usage: normalizeUsage(usage),
    usageEvents: usageEvents.map(normalizeUsage),
    toolCalls: {
      total: calls.size,
      byType,
      byName,
      command: { calls: commandCalls, outputBytes: commandBytes, outputChars: commandChars },
      mcp: { calls: mcpCalls, outputBytes: mcpBytes, outputChars: mcpChars },
    },
    policy: {
      noToolUse: calls.size === 0,
      forbiddenCliContamination: forbiddenCliCommands.length > 0,
      forbiddenCliCommands,
      forbiddenExternalAgentUse: forbiddenExternalAgentCommands.length > 0,
      forbiddenExternalAgentCommands,
      forbiddenEvalArtifactAccess: forbiddenEvalArtifactCommands.length > 0,
      forbiddenEvalArtifactCommands,
      forbiddenUserConfigAccess: forbiddenUserConfigCommands.length > 0,
      forbiddenUserConfigCommands,
    },
  };
}

function extractJsString(source, start) {
  const quote = source[start];
  if (!['"', "'", '`'].includes(quote)) return null;
  let value = '';
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === quote) return value;
    if (char === '\\' && i + 1 < source.length) {
      const next = source[++i];
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
      value += escapes[next] ?? next;
    } else value += char;
  }
  return null;
}

function extractJsField(source, field) {
  const match = new RegExp(`\\b${field}\\s*:\\s*([\\"'\`])`).exec(source);
  if (!match || match.index === undefined) return null;
  const quoteIndex = match.index + match[0].length - 1;
  return extractJsString(source, quoteIndex);
}

function nestedToolCalls(rawInput) {
  const calls = [];
  const pattern = /\btools\.([A-Za-z0-9_]+)\s*\(/g;
  let match;
  while ((match = pattern.exec(rawInput))) {
    const name = match[1];
    if (name === 'exec_command') {
      calls.push({ type: 'command_execution', name, command: extractJsField(rawInput.slice(match.index), 'cmd'), workdir: extractJsField(rawInput.slice(match.index), 'workdir') });
    } else if (name.startsWith('mcp__')) {
      const mcpNameValue = name.slice('mcp__'.length).replaceAll('__', '/');
      calls.push({ type: 'mcp_tool_call', name: mcpNameValue });
    } else {
      calls.push({ type: 'nested_tool_call', name });
    }
  }
  return calls;
}

function directForbiddenCli(command) {
  const value = String(command || '').trim();
  // Inspect the executable position only. This deliberately does not flag
  // source searches such as `rg codefacts` or a legitimate token-eval path.
  return /^(?:(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+.*?-Command)\s+)?(?:["']?[A-Za-z]:[\\/][^"']*[\\/])?["']?(?:codefacts|codegraph)(?:\.exe)?["']?(?:\s|$)/i.test(value)
    || /^(?:npx|npm\s+(?:exec|x)|pnpm\s+dlx|yarn)\s+(?:[^\s]+\s+)?(?:codefacts|codegraph)(?:@[^\s]+)?(?:\s|$)/i.test(value);
}

function customOutputText(output) {
  if (Array.isArray(output)) return output.map((entry) => entry && typeof entry.text === 'string' ? entry.text : textValue(entry)).join('');
  return textValue(output);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseRollout(rollout, { taskRoot = null } = {}) {
  const lines = rollout.split(/\r?\n/).filter((line) => line.trim() !== '');
  const calls = new Map();
  const tokenEvents = [];
  const parseErrors = [];
  let sessionId = null;
  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try { event = JSON.parse(lines[index]); } catch (error) { parseErrors.push({ line: index + 1, message: error.message }); continue; }
    if (event.type === 'session_meta' && (event.payload?.id || event.payload?.session_id)) sessionId = event.payload.id || event.payload.session_id;
    if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
      const info = event.payload.info || {};
      tokenEvents.push({ ordinal: event.ordinal ?? index, total: info.total_token_usage || null, last: info.last_token_usage || null, model_context_window: info.model_context_window ?? null });
    }
    if (event.type !== 'response_item' || !event.payload) continue;
    const payload = event.payload;
    if (payload.type === 'custom_tool_call') {
      const key = payload.call_id || payload.id || `custom-${index}`;
      calls.set(key, {
        callId: payload.call_id || null,
        id: payload.id || null,
        name: payload.name || 'unknown',
        rawInput: payload.input ?? null,
        rawOutput: null,
        outputText: '',
        nested: typeof payload.input === 'string' ? nestedToolCalls(payload.input) : [],
        ordinal: event.ordinal ?? index,
      });
    } else if (payload.type === 'custom_tool_call_output') {
      const key = payload.call_id || payload.id || `custom-output-${index}`;
      const call = calls.get(key) || { callId: payload.call_id || null, id: payload.id || null, name: 'unknown', rawInput: null, nested: [], ordinal: event.ordinal ?? index };
      call.rawOutput = payload.output ?? null;
      call.outputText = customOutputText(payload.output);
      call.outputFailed = /(?:blocked by policy|requires approval|approval policy is never|permission denied|rejected\()/i.test(call.outputText);
      calls.set(key, call);
    }
  }
  const nested = [];
  const blocked = [];
  const approvalRejections = [];
  const forbiddenCliCommands = [];
  const byType = {};
  const byName = {};
  for (const call of calls.values()) {
    for (const item of call.nested || []) {
      const attributionUncertain = (call.nested || []).length > 1;
      const nestedItem = { ...item, wrapperCallId: call.callId, wrapperName: call.name, rawInput: call.rawInput, rawOutput: call.rawOutput, outputText: call.outputText, outputFailed: Boolean(call.outputFailed), attributionUncertain };
      nested.push(nestedItem);
      byType[item.type] = (byType[item.type] || 0) + 1;
      byName[`${item.type}:${item.name}`] = (byName[`${item.type}:${item.name}`] || 0) + 1;
      if (call.outputFailed) {
        const failure = { wrapperCallId: call.callId, tool: item.name, reason: call.outputText, attributionUncertain };
        blocked.push(failure);
        if (/requires approval|approval policy is never|approval/i.test(call.outputText)) approvalRejections.push(failure);
      }
      if (item.type === 'command_execution' && directForbiddenCli(item.command)) forbiddenCliCommands.push({ wrapperCallId: call.callId, command: item.command, workdir: item.workdir });
    }
  }
  const normalizeUsage = (usage) => usage ? {
    input_tokens: finiteNumber(usage.input_tokens),
    cached_input_tokens: finiteNumber(usage.cached_input_tokens),
    cache_write_input_tokens: finiteNumber(usage.cache_write_input_tokens),
    output_tokens: finiteNumber(usage.output_tokens),
    reasoning_output_tokens: finiteNumber(usage.reasoning_output_tokens),
    reported_total_tokens: finiteNumber(usage.total_tokens),
    total_tokens: Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens) ? usage.input_tokens + usage.output_tokens : null,
  } : null;
  const usageEvents = tokenEvents.map((event) => ({ ordinal: event.ordinal, total: normalizeUsage(event.total), last: normalizeUsage(event.last), model_context_window: event.model_context_window }));
  const finalEvent = usageEvents.length ? usageEvents[usageEvents.length - 1] : null;
  const finalTotalUsage = finalEvent?.total || null;
  const finalContextInputTokens = Number.isFinite(finalEvent?.last?.input_tokens) ? finalEvent.last.input_tokens : null;
  const usageAvailable = Number.isFinite(finalTotalUsage?.input_tokens) && Number.isFinite(finalTotalUsage?.output_tokens);
  const derivedTotalTokens = usageAvailable ? finalTotalUsage.input_tokens + finalTotalUsage.output_tokens : null;
  const wrapperOutputBytes = [...calls.values()].reduce((sum, call) => sum + Buffer.byteLength(call.outputText || '', 'utf8'), 0);
  const wrapperOutputChars = [...calls.values()].reduce((sum, call) => sum + codePointLength(call.outputText || ''), 0);
  return {
    available: true,
    sessionId,
    taskRoot,
    parseErrors,
    wrapperCalls: [...calls.values()].map((call) => ({ callId: call.callId, id: call.id, name: call.name, ordinal: call.ordinal, rawInput: call.rawInput ?? null, rawOutput: call.rawOutput, hasOutput: call.rawOutput !== null, outputFailed: Boolean(call.outputFailed) })),
    nestedCalls: nested,
    toolCalls: { total: nested.length, byType, byName, command: { calls: nested.filter((item) => item.type === 'command_execution').length, outputBytes: null, outputChars: null }, mcp: { calls: nested.filter((item) => item.type === 'mcp_tool_call').length, outputBytes: null, outputChars: null }, wrapperOutputBytes, wrapperOutputChars, outputMeasurement: 'wrapper output text; not token count; per-tool attribution unavailable' },
    blockedToolFailures: blocked,
    approvalRejections,
    forbiddenCliCommands,
    tokenEvents: usageEvents,
    finalTotalUsage,
    finalContextInputTokens,
    derivedTotalTokens,
    usageAvailable,
    evaluationValidity: blocked.length ? 'invalid_environment' : (nested.length ? 'valid' : 'unknown'),
    contaminationAudit: { method: 'command-prefix-heuristic', manualReviewRequired: true, forbiddenCliContamination: forbiddenCliCommands.length > 0 },
  };
}

async function findRollout(sessionsDir, threadId) {
  if (!sessionsDir || !threadId) return null;
  const root = resolve(sessionsDir);
  const now = new Date();
  for (let delta = 0; delta <= 2; delta += 1) {
    const date = new Date(now.getTime() - delta * 86_400_000);
    const day = join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    let entries;
    try { entries = await readdir(day, { withFileTypes: true }); } catch { continue; }
    const match = entries.find((entry) => entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl'));
    if (match) return join(day, match.name);
  }
  return null;
}

function metricsFrom({ parsed, processResult = null, rollout = null }) {
  const executionCompleted = processResult
    ? !processResult.timedOut && !processResult.spawnError && processResult.exitCode === 0 && parsed.turnCompleted > 0
    : Boolean(parsed.turnCompleted > 0);
  const stdoutUsage = parsed.usage;
  const stdoutUsageAvailable = Number.isFinite(stdoutUsage?.input_tokens) && Number.isFinite(stdoutUsage?.output_tokens);
  const usageAvailable = stdoutUsageAvailable;
  const rawEvaluationValidity = rollout?.evaluationValidity || 'unknown';
  const toolCalls = parsed.toolCalls;
  const usageReconciliation = rollout ? {
    stdout: parsed.usage,
    rolloutTotal: rollout.finalTotalUsage,
    matches: ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'].every((key) => parsed.usage?.[key] === rollout.finalTotalUsage?.[key]),
  } : null;
  const policy = {
    ...(parsed.policy || {}),
    ...(rollout ? {
      forbiddenCliContamination: rollout.contaminationAudit.forbiddenCliContamination,
      forbiddenCliCommands: rollout.forbiddenCliCommands,
      contaminationAudit: rollout.contaminationAudit,
    } : { contaminationAudit: { method: 'stdout-only', manualReviewRequired: true } }),
  };
  const usageConflict = Boolean(usageReconciliation && usageReconciliation.matches === false);
  const auditPending = Boolean(policy.contaminationAudit?.manualReviewRequired);
  const status = !executionCompleted
    ? 'unsuccessful'
    : rawEvaluationValidity === 'invalid_environment'
      ? 'invalid-environment'
      : usageConflict
        ? 'usage-conflict'
        : auditPending ? 'pending-manual-review' : 'execution-completed';
  const evaluationValidity = status === 'pending-manual-review'
    ? 'pending_manual_review'
    : status === 'usage-conflict'
      ? 'usage_conflict'
      : rawEvaluationValidity;
  const tokenEligible = Boolean(usageAvailable && status === 'execution-completed' && evaluationValidity === 'valid');
  return {
    schemaVersion: 2,
    status,
    executionCompleted,
    unsuccessful: !executionCompleted,
    evaluationValidity,
    rawEvaluationValidity,
    correctness: 'external',
    correctnessVerified: false,
    evaluationEligible: Boolean(status === 'execution-completed' && executionCompleted && tokenEligible && evaluationValidity === 'valid'),
    exitCode: processResult?.exitCode ?? null,
    signal: processResult?.signal ?? null,
    timedOut: processResult?.timedOut ?? false,
    spawnError: processResult?.spawnError ?? null,
    threadId: parsed.threadId,
    eventCount: parsed.eventCount,
    parseErrors: parsed.parseErrors,
    turnCompleted: parsed.turnCompleted,
    usage: parsed.usage,
    rolloutUsage: rollout?.finalTotalUsage || null,
    usageEvents: rollout?.tokenEvents || parsed.usageEvents || [],
    usageAvailable,
    tokenEligible,
    finalContextInputTokens: rollout?.finalContextInputTokens ?? null,
    derivedTotalTokens: stdoutUsageAvailable ? stdoutUsage.input_tokens + stdoutUsage.output_tokens : null,
    total_tokens: stdoutUsageAvailable ? stdoutUsage.input_tokens + stdoutUsage.output_tokens : null,
    reportedTotalTokens: rollout?.finalTotalUsage?.reported_total_tokens ?? null,
    stdoutToolCalls: parsed.toolCalls,
    toolCalls,
    rolloutToolCalls: rollout?.toolCalls || null,
    policy,
    approvalRejections: rollout?.approvalRejections || [],
    blockedToolFailures: rollout?.blockedToolFailures || [],
    transcriptAvailable: Boolean(rollout),
    transcriptSessionId: rollout?.sessionId || null,
    usageReconciliation,
    usageConflict,
  };
}

function discoverCodex(explicit) {
  const candidates = [];
  if (explicit) return { path: explicit, source: 'explicit' };
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command codex.exe -ErrorAction SilentlyContinue).Source'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    for (const value of String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) candidates.push(value);
  } catch { /* fixed installation path remains the deterministic fallback */ }
  const absolutePath = candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate));
  if (absolutePath) return { path: absolutePath, source: explicit ? 'explicit' : 'powershell-command' };
  if (explicit) return { path: explicit, source: 'explicit-path-or-PATH' };
  // Let spawn resolve a PATH installation if PowerShell could not report one.
  return { path: 'codex', source: 'PATH-fallback' };
}

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '_').slice(0, 100) || '_';
}

async function allocateRunDir(outputDir, taskId, armId, runNumber) {
  const parent = join(outputDir, slug(taskId), slug(armId));
  await mkdir(parent, { recursive: true });
  const base = join(parent, `run-${String(runNumber).padStart(3, '0')}`);
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-attempt-${String(attempt).padStart(2, '0')}`;
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function buildArgs(task, arm) {
  const args = [
    '-a', 'never', 'exec', '--ignore-user-config', '--json', '--skip-git-repo-check',
    '-s', 'read-only', '-C', task.root, '-m', 'gpt-5.6-luna',
    '-c', 'model_reasoning_effort="medium"', '-c', 'project_doc_max_bytes=0',
    '--disable', 'standalone_web_search', '--disable', 'browser_use', '--disable', 'browser_use_external',
    '--disable', 'multi_agent', '--disable', 'plugins', '--disable', 'remote_plugin',
  ];
  for (const override of arm.configOverrides || []) {
    if (typeof override !== 'string' || !override.includes('=')) throw new Error(`Invalid config override for arm ${arm.id}: ${String(override)}`);
    args.push('-c', override.replaceAll('{root}', task.root));
  }
  return args;
}

function runProcess(command, args, cwd, prompt, timeoutMs) {
  return new Promise((resolveProcess) => {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolveProcess({ startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - start, pid: null, exitCode: null, signal: null, timedOut: false, spawnError: error.message, stdout: Buffer.alloc(0), stderr: Buffer.from(error.stack || error.message) });
      return;
    }
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    let timer;
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    const finish = (exitCode, signal, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - start, pid: child.pid || null, exitCode, signal, timedOut, spawnError, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    child.once('error', (error) => finish(null, null, error.message));
    child.once('close', (exitCode, signal) => finish(exitCode, signal));
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        // The PID is the exact process created above; /T scopes cleanup to its tree.
        const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        kill.unref();
      } else {
        child.kill('SIGTERM');
      }
    }, timeoutMs);
    child.stdin.end(prompt);
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runOne({ task, arm, runNumber, outputDir, timeoutMs, codex, rolloutPath, sessionsDir, guidance = '' }) {
  const resultDir = await allocateRunDir(outputDir, task.id, arm.id, runNumber);
  const args = buildArgs(task, arm);
  const prompt = `${BASE_PROMPT}${guidance ? `\n\nEvaluation guidance:\n${guidance}` : ''}\n\nRepository question:\n${task.prompt}`;
  const request = {
    schemaVersion: 1,
    task: { id: task.id, root: task.root, prompt: task.prompt },
    arm: { id: arm.id, configOverrides: arm.configOverrides || [] },
    run: runNumber,
    prompt,
    command: [codex.path, ...args],
    cwd: task.root,
    timeoutMs,
    codexBin: codex.path,
    codexPathSource: codex.source,
    sessionsDir: sessionsDir || null,
    rolloutPath: rolloutPath || null,
    guidance: guidance || null,
  };
  const processResult = await runProcess(codex.path, args, task.root, prompt, timeoutMs);
  const stdout = processResult.stdout.toString('utf8');
  const stderr = processResult.stderr.toString('utf8');
  const parsed = parseJsonl(stdout);
  const resolvedRolloutPath = rolloutPath || await findRollout(sessionsDir, parsed.threadId);
  const rollout = resolvedRolloutPath ? parseRollout(await readFile(resolvedRolloutPath, 'utf8'), { taskRoot: task.root }) : null;
  const metrics = metricsFrom({ parsed, processResult, rollout });
  await writeFile(join(resultDir, 'stdout.jsonl'), stdout, 'utf8');
  await writeFile(join(resultDir, 'stderr'), stderr, 'utf8');
  await writeFile(join(resultDir, 'answer.md'), parsed.answer || '', 'utf8');
  await writeJson(join(resultDir, 'request.json'), { ...request, pid: processResult.pid, startedAt: processResult.startedAt });
  await writeJson(join(resultDir, 'timing.json'), { startedAt: processResult.startedAt, endedAt: processResult.endedAt, durationMs: processResult.durationMs, timeoutMs, timedOut: processResult.timedOut });
  await writeJson(join(resultDir, 'metrics.json'), metrics);
  await writeJson(join(resultDir, 'transcript-tools.json'), rollout ? { path: resolvedRolloutPath, ...rollout } : { available: false, reason: sessionsDir || rolloutPath ? 'rollout-not-found' : 'sessions-dir-not-configured' });
  return { resultDir, ...metrics };
}

async function mergeExistingRun(resultDir, rolloutPath) {
  const root = resolve(resultDir);
  const stdout = await readFile(join(root, 'stdout.jsonl'), 'utf8');
  const existing = JSON.parse(await readFile(join(root, 'metrics.json'), 'utf8'));
  const request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8').catch(() => '{}'));
  const parsed = parseJsonl(stdout);
  const rollout = parseRollout(await readFile(resolve(rolloutPath), 'utf8'), { taskRoot: request.task?.root || null });
  const metrics = metricsFrom({ parsed, processResult: { exitCode: existing.exitCode, signal: existing.signal, timedOut: existing.timedOut, spawnError: existing.spawnError }, rollout });
  await writeJson(join(root, 'metrics.json'), metrics);
  await writeJson(join(root, 'transcript-tools.json'), { path: resolve(rolloutPath), ...rollout });
  return { resultDir: root, ...metrics };
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new Error('Manifest requires a non-empty tasks array');
  if (!Array.isArray(manifest.arms) || !manifest.arms.length) throw new Error('Manifest requires a non-empty arms array');
  if (!Number.isInteger(manifest.runs) || manifest.runs < 1) throw new Error('Manifest runs must be a positive integer');
  for (const task of manifest.tasks) {
    if (!task.id || !task.root || typeof task.prompt !== 'string') throw new Error(`Invalid task: ${JSON.stringify(task)}`);
  }
  for (const arm of manifest.arms) {
    if (!arm.id || !Array.isArray(arm.configOverrides || [])) throw new Error(`Invalid arm: ${JSON.stringify(arm)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage()); return; }
  if (options.mergeRun) {
    if (!options.rollout) throw new Error('--merge-run requires --rollout');
    const result = await mergeExistingRun(options.mergeRun, options.rollout);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.inspectJsonl) {
    const parsed = parseJsonl(await readFile(resolve(options.inspectJsonl), 'utf8'));
    const rollout = options.rollout ? parseRollout(await readFile(resolve(options.rollout), 'utf8')) : null;
    process.stdout.write(`${JSON.stringify({ parsed, rollout, metrics: metricsFrom({ parsed, rollout }) }, null, 2)}\n`);
    return;
  }
  const manifestPath = resolve(options.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest);
  const tasks = manifest.tasks.filter((task) => options.task === undefined || task.id === options.task);
  const arms = manifest.arms.filter((arm) => options.arm === undefined || arm.id === options.arm);
  if (!tasks.length) throw new Error(`No task matched --task ${options.task}`);
  if (!arms.length) throw new Error(`No arm matched --arm ${options.arm}`);
  const runs = Array.from({ length: manifest.runs }, (_, index) => index + 1).filter((run) => options.run === undefined || run === options.run);
  const codex = discoverCodex(options.codex || manifest.codexBin);
  const sessionsDir = options.sessionsDir || process.env.CODEX_SESSIONS_DIR || (process.env.CODEX_HOME || process.env.USERPROFILE ? join(process.env.CODEX_HOME || process.env.USERPROFILE, process.env.CODEX_HOME ? 'sessions' : '.codex/sessions') : null);
  const results = [];
  for (const task of tasks) for (const arm of arms) for (const runNumber of runs) {
    const result = await runOne({ task, arm, runNumber, outputDir: resolve(options.outputDir), timeoutMs: options.timeoutMs, codex, rolloutPath: options.rollout, sessionsDir, guidance: manifest.guidance || '' });
    results.push(result);
    process.stdout.write(`${JSON.stringify({ task: task.id, arm: arm.id, run: runNumber, resultDir: result.resultDir, status: result.status, usage: result.usage, toolCalls: result.toolCalls })}\n`);
  }
  process.stdout.write(`Completed ${results.length} run(s).\n`);
}

export { BASE_PROMPT, buildArgs, discoverCodex, findRollout, metricsFrom, parseJsonl, parseRollout };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}
