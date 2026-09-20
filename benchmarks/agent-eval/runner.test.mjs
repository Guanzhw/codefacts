import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BASE_PROMPT, EDIT_PROMPT, buildArgs, buildRunRequest, discoverCodex, findRollout, metricsFrom, parseJsonl, parseRollout, runOne, runProcess, validateManifest } from './runner.mjs';

const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n');

test('cumulative total usage is separate from final request context', () => {
  const parsed = parseRollout(jsonl([
    { type: 'session_meta', payload: { id: 'session-1' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 }, last_token_usage: { input_tokens: 200, output_tokens: 10 } } } },
  ]));
  assert.equal(parsed.finalTotalUsage.input_tokens, 1000);
  assert.equal(parsed.finalContextInputTokens, 200);
  assert.equal(parsed.derivedTotalTokens, 1050);
  assert.equal(parsed.finalTotalUsage.total_tokens, 1050);
  assert.equal(parsed.sessionId, 'session-1');
  assert.equal(parsed.evaluationValidity, 'unknown');
});

test('stdout direct MCP calls remain visible without a wrapper transcript', () => {
  const parsed = parseJsonl(jsonl([
    { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'codefacts', tool: 'map', result: { content: [{ type: 'text', text: 'facts' }] } } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } },
  ]));
  const metrics = metricsFrom({ parsed });
  assert.equal(metrics.toolCalls.total, 1);
  assert.equal(metrics.stdoutToolCalls.total, 1);
  assert.equal(metrics.evaluationValidity, 'pending_manual_review');
  assert.equal(metrics.rawEvaluationValidity, 'unknown');
  assert.equal(metrics.status, 'pending-manual-review');
  assert.equal(metrics.tokenEligible, false);
  assert.equal(metrics.evaluationEligible, false);
});

test('fatal Code Mode startup error invalidates an otherwise successful exit', () => {
  const message = 'Code Mode is unavailable because failed to spawn code-mode host D:\\Eval\\codex-code-mode-host.exe: host executable was not found. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
  const parsed = parseJsonl(jsonl([
    { type: 'item.completed', item: { id: 'err-1', type: 'error', message } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } },
  ]));
  const metrics = metricsFrom({ parsed, processResult: { exitCode: 0, timedOut: false, spawnError: null } });
  assert.deepEqual(parsed.startupErrors, [{ id: 'err-1', message }]);
  assert.deepEqual(metrics.startupErrors, parsed.startupErrors);
  assert.equal(metrics.rawEvaluationValidity, 'invalid_environment');
  assert.equal(metrics.evaluationValidity, 'invalid_environment');
  assert.equal(metrics.status, 'invalid-environment');
  assert.equal(metrics.executionCompleted, true);
  assert.equal(metrics.total_tokens, 13);
  assert.equal(metrics.tokenEligible, false);
  assert.equal(metrics.evaluationEligible, false);
  assert.equal(metrics.toolCalls.total, 0);
});

test('Code Mode wording in agent messages and ordinary errors remains unchanged', () => {
  const message = 'Code Mode is unavailable because failed to spawn code-mode host D:\\Eval\\codex-code-mode-host.exe: host executable was not found. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
  const parsed = parseJsonl(jsonl([
    { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: message } },
    { type: 'item.completed', item: { id: 'err-2', type: 'error', message: 'failed test command' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } },
  ]));
  assert.deepEqual(parsed.startupErrors, []);
  const metrics = metricsFrom({ parsed });
  assert.equal(metrics.rawEvaluationValidity, 'unknown');
  assert.equal(metrics.status, 'pending-manual-review');
});

test('completed item metadata replaces sparse started metadata', () => {
  const parsed = parseJsonl(jsonl([
    { type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call' } },
    { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'codefacts', tool: 'map', result: { content: [] } } },
  ]));
  assert.equal(parsed.toolCalls.byName['mcp_tool_call:codefacts/map'], 1);
  assert.equal(parsed.toolCalls.byName['mcp_tool_call:mcp'], undefined);
});

test('usage mismatch is explicit and stdout remains authoritative', () => {
  const parsed = parseJsonl(jsonl([
    { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'codefacts', tool: 'map', result: { content: [] } } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } },
  ]));
  const rollout = parseRollout(jsonl([
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'x', call_id: 'call-x', name: 'exec', input: 'const r = await tools.mcp__codefacts__map({});' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-x', output: [{ type: 'input_text', text: 'ok' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 3 }, last_token_usage: { input_tokens: 4, output_tokens: 1 } } } },
  ]));
  const metrics = metricsFrom({ parsed, rollout });
  assert.equal(metrics.status, 'usage-conflict');
  assert.equal(metrics.evaluationValidity, 'usage_conflict');
  assert.equal(metrics.tokenEligible, false);
  assert.equal(metrics.evaluationEligible, false);
  assert.equal(metrics.total_tokens, 13);
  assert.equal(metrics.usage.input_tokens, 10);
  assert.equal(metrics.finalContextInputTokens, 4);
});

test('rollout lookup uses local calendar directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-eval-'));
  try {
    const now = new Date();
    const day = join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    await mkdir(day, { recursive: true });
    const threadId = 'thread-local-day';
    const rolloutPath = join(day, `rollout-${threadId}.jsonl`);
    await writeFile(rolloutPath, '', 'utf8');
    assert.equal(await findRollout(root, threadId), rolloutPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('approval rejection invalidates the environment and preserves reason', () => {
  const parsed = parseRollout(jsonl([
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'x', call_id: 'call-x', name: 'exec', input: 'const r = await tools.mcp__codefacts__map({}); text(r);' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-x', output: [{ type: 'input_text', text: 'MCP tool call requires approval, but approval policy is never' }] } },
  ]));
  assert.equal(parsed.evaluationValidity, 'invalid_environment');
  assert.equal(parsed.approvalRejections.length, 1);
  assert.match(parsed.approvalRejections[0].reason, /requires approval/);
});

test('wrapper output is counted once when it contains multiple nested tools', () => {
  const parsed = parseRollout(jsonl([
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'x', call_id: 'call-x', name: 'exec', input: 'const a = await tools.exec_command({cmd:"rg x ."}); const b = await tools.mcp__codefacts__map({});' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-x', output: [{ type: 'input_text', text: 'one' }] } },
  ]));
  assert.equal(parsed.nestedCalls.length, 2);
  assert.equal(parsed.toolCalls.wrapperOutputBytes, Buffer.byteLength('one'));
  assert.equal(parsed.toolCalls.command.outputBytes, null);
  assert.equal(parsed.toolCalls.mcp.outputBytes, null);
});

test('explicit Codex path is never replaced during discovery', () => {
  const explicit = 'C:/missing/codex.exe';
  assert.deepEqual(discoverCodex(explicit), { path: explicit, source: 'explicit' });
});

const manifestFixture = (extra = {}) => ({
  tasks: [{ id: 'cleanup', root: tmpdir(), prompt: 'Fix the reported test cleanup failure.' }],
  arms: [{ id: 'ordinary', configOverrides: [] }],
  runs: 1,
  ...extra,
});

test('legacy manifests retain their read-only prompt, model and reasoning settings', () => {
  const manifest = manifestFixture();
  const execution = validateManifest(manifest);
  assert.deepEqual(execution, { mode: 'readonly', model: 'gpt-5.6-luna', reasoningEffort: 'medium' });
  const request = buildRunRequest({ task: manifest.tasks[0], arm: manifest.arms[0], runNumber: 1, timeoutMs: 1000, codex: { path: 'codex', source: 'fixture' }, execution });
  assert.ok(request.prompt.startsWith(BASE_PROMPT));
  assert.match(request.prompt, /Repository question:/);
  assert.equal(request.command[request.command.indexOf('-s') + 1], 'read-only');
  assert.equal(request.command[request.command.indexOf('-m') + 1], 'gpt-5.6-luna');
  assert.ok(request.command.includes('model_reasoning_effort="medium"'));
  for (const feature of ['apps', 'memories', 'skill_search']) {
    assert.equal(request.command[request.command.indexOf(feature) - 1], '--disable');
  }
  assert.equal(request.command[request.command.indexOf('skip_host_skill_discovery') - 1], '--enable');
  assert.equal(request.task.tempDir, null);
});

test('edit manifests freeze execution settings and retain ordinary or MCP tool choice', () => {
  const manifest = manifestFixture({ mode: 'edit', model: 'gpt-6-astra', reasoningEffort: 'high' });
  const execution = validateManifest(manifest);
  const task = { ...manifest.tasks[0], tempDir: join(tmpdir(), 'isolated-task-temp') };
  const arm = { id: 'codefacts', configOverrides: ['mcp_servers.codefacts.args=["mcp","--root","{root}"]'] };
  const request = buildRunRequest({ task, arm, runNumber: 1, timeoutMs: 1000, codex: { path: 'codex', source: 'fixture' }, execution });
  assert.deepEqual(request.execution, { mode: 'edit', model: 'gpt-6-astra', reasoningEffort: 'high', sandbox: 'workspace-write' });
  assert.equal(request.command[request.command.indexOf('-s') + 1], 'workspace-write');
  assert.equal(request.command[request.command.indexOf('-m') + 1], 'gpt-6-astra');
  assert.ok(request.command.includes('model_reasoning_effort="high"'));
  for (const feature of ['apps', 'memories', 'skill_search']) {
    assert.equal(request.command[request.command.indexOf(feature) - 1], '--disable');
  }
  assert.equal(request.command[request.command.indexOf('skip_host_skill_discovery') - 1], '--enable');
  assert.deepEqual(request.command.slice(1), buildArgs(task, arm, execution));
  assert.ok(request.command.includes(`mcp_servers.codefacts.args=["mcp","--root","${task.root}"]`));
  assert.ok(request.prompt.startsWith(EDIT_PROMPT));
  assert.match(request.prompt, /Repository task:/);
  assert.doesNotMatch(request.prompt, /Do not edit files|MCP-first|first repository inspection/);
  assert.equal(request.task.tempDir, task.tempDir);
  assert.equal(request.environment, undefined);
  assert.equal(request.env, undefined);
});

test('invalid execution settings and relative temporary paths fail at the manifest boundary', () => {
  for (const extra of [
    { mode: 'write' }, { mode: null }, { model: '' }, { model: 7 },
    { reasoningEffort: 'automatic' }, { reasoningEffort: null },
    { tasks: [{ id: 'cleanup', root: tmpdir(), prompt: 'Fix it.', tempDir: 'relative-temp' }] },
  ]) assert.throws(() => validateManifest(manifestFixture(extra)));
});

test('a real child process receives isolated temp paths and keeps unrelated inherited environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-eval-child-'));
  try {
    const script = 'process.stdout.write(JSON.stringify({TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR,path:process.env.PATH,tmpdir:require("node:os").tmpdir()}))';
    const result = await runProcess(process.execPath, ['-e', script], root, '', 10_000, root);
    assert.equal(result.exitCode, 0);
    assert.equal(result.spawnError, null);
    assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), { TEMP: root, TMP: root, TMPDIR: root, path: process.env.PATH, tmpdir: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('temporary directories must exist before an evaluation process starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-eval-temp-'));
  try {
    const options = { task: { id: 'cleanup', root, prompt: 'Fix it.', tempDir: join(root, 'missing') }, arm: { id: 'ordinary' }, runNumber: 1, outputDir: join(root, 'results'), timeoutMs: 1000, codex: { path: 'never-spawn-this-fixture', source: 'fixture' } };
    await assert.rejects(runOne(options), { code: 'ENOENT' });
    const file = join(root, 'file');
    await writeFile(file, 'fixture', 'utf8');
    await assert.rejects(runOne({ ...options, task: { ...options.task, tempDir: file } }), /not a directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
