import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBridge, MAX_BYTES, repairTools, validateConfig } from './bridge.mjs';
import { connectNative, loadSdk } from '../rpc.mjs';

const sdkRoot = process.env.TASK_BENCHMARK_SDK_ROOT ?? 'C:/Users/QQ110/.dsh/profiles/web/node_modules/@modelcontextprotocol/sdk';
const enabled = fs.existsSync(path.join(sdkRoot, 'dist/cjs/client/index.js'));
const bridgeEntry = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
const rpcUrl = new URL('../rpc.mjs', import.meta.url).href;

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'community-bridge-'));
  const root = path.join(tmp, 'source'), evidenceDir = path.join(tmp, 'evidence');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'sample.js'), 'const one = "界";\r\nconst two = 2;\r\n');
  const innerBridgeEntry = path.join(tmp, 'inner.mjs'), innerConfig = path.join(tmp, 'inner.json');
  fs.writeFileSync(innerBridgeEntry, `
import fs from 'node:fs';
import path from 'node:path';
import { loadSdk } from ${JSON.stringify(rpcUrl)};
const config = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));
const sdk = loadSdk(config.sdkRoot);
const source = [
  { name: 'source_read', description: 'VERBATIM read description', inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, delay_ms: { type: 'integer' } }, required: ['file_path'], additionalProperties: false } },
  ...['source_search', 'source_list'].map(name => ({ name, description: 'VERBATIM ' + name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })),
  { name: 'native_query', description: config.nativeDescription ?? '原生 unknown catalog', catalog_extension: config.catalogExtension ?? { exact: true }, annotations: { readOnlyHint: true, unknown_hint: 'keep' }, inputSchema: { type: 'object', properties: { fail: { type: 'boolean' } }, additionalProperties: false } },
];
const server = new sdk.Server({ name: 'fixture-inner', version: '1' }, { capabilities: { tools: {} }, instructions: 'INNER instructions exactly\\n含中文' });
server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools: source }));
Object.getPrototypeOf(sdk.Server.prototype).setRequestHandler.call(server, sdk.CallToolRequestSchema, async request => {
  const args = request.params.arguments ?? {};
  if (args.delay_ms) await new Promise(resolve => setTimeout(resolve, args.delay_ms));
  const text = request.params.name === 'source_read' ? fs.readFileSync(path.join(config.root, args.file_path), 'utf8') : 'opaque exact native payload';
  return { content: [{ type: 'text', text, unknown_content: { exact: [1, 2] } }], structuredContent: { request: request.params, secretInherited: Boolean(process.env.COMMUNITY_SECRET_SENTINEL) }, unknown_result: { exact: ['keep'] }, _meta: { opaque: true }, ...(args.fail ? { isError: true } : {}) };
});
process.stdin.once('end', () => { fs.writeFileSync(config.closedFile, 'closed'); void server.close(); });
await server.connect(new sdk.StdioServerTransport());
`);
  fs.writeFileSync(innerConfig, JSON.stringify({ root, evidenceDir: path.join(root, 'private-evidence'), sdkRoot, closedFile: path.join(tmp, 'inner-closed'), native: { cwd: root, args: ['--state', path.join(root, 'custom-index.db')] } }));
  const helper = path.join(tmp, 'sandbox.mjs');
  fs.writeFileSync(helper, `
import fs from 'node:fs';
const argv = process.argv.slice(2);
const spec = JSON.parse(argv.at(-1));
if (spec.ignoreTerm) process.on('SIGTERM', () => {});
if (spec.inspect) console.log(JSON.stringify({ argv, secretInherited: Boolean(process.env.COMMUNITY_SECRET_SENTINEL) }));
if (spec.stdout) process.stdout.write(spec.stdout.repeat(spec.repeat ?? 1));
if (spec.stderr) process.stderr.write(spec.stderr.repeat(spec.repeat ?? 1));
if (spec.releaseFile) {
  const gate = setInterval(() => {
    if (!fs.existsSync(spec.releaseFile)) return;
    clearInterval(gate);
    if (spec.ending) process.stdout.write(spec.ending);
    process.exit(spec.exitCode ?? 0);
  }, 10);
}
else if (spec.endless) setInterval(() => {}, 1000);
else setTimeout(() => { if (spec.ending) process.stdout.write(spec.ending); process.exit(spec.exitCode ?? 0); }, spec.delayMs ?? 0);
`);
  const config = { root, evidenceDir, sdkRoot, nodeCommand: process.execPath, innerBridgeEntry, innerConfig,
    sandbox: { command: process.execPath, argsPrefix: [helper, 'bash', '-lc'], cwd: root } };
  const closers = [];
  t.after(async () => { try { for (const close of closers.reverse()) await close(); } finally { fs.rmSync(tmp, { recursive: true, force: true }); } });
  return { tmp, root, config, closers,
    async create(options = {}) { const bridge = await createBridge(config, options); closers.push(() => bridge.close()); return bridge; } };
}

function records(config, file) {
  const target = path.join(config.evidenceDir, file);
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

// The effective benchmark client projects MCP content text and drops structuredContent.
function modelText(response) {
  return response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

test('import starts no process; SDK prerequisite is explicit', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./bridge.mjs', import.meta.url).href)})`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.ok(enabled, 'Set TASK_BENCHMARK_SDK_ROOT to an installed SDK; no package install is performed');
});

test('inner catalog, unknown payload fields, instructions and safe environment survive actual outer MCP', { skip: !enabled }, async t => {
  const f = fixture(t), sdk = loadSdk(sdkRoot);
  const prior = process.env.COMMUNITY_SECRET_SENTINEL;
  process.env.COMMUNITY_SECRET_SENTINEL = 'host-only-secret';
  f.closers.push(() => { if (prior === undefined) delete process.env.COMMUNITY_SECRET_SENTINEL; else process.env.COMMUNITY_SECRET_SENTINEL = prior; });
  const outerConfig = path.join(f.tmp, 'outer.json');
  fs.writeFileSync(outerConfig, JSON.stringify(f.config));
  const clientEvidence = path.join(f.tmp, 'client-evidence'); fs.mkdirSync(clientEvidence);
  const outer = await connectNative(sdk, { command: process.execPath, args: [bridgeEntry, '--config', outerConfig], cwd: f.root, env: {} }, clientEvidence);
  f.closers.push(() => outer.close());
  assert.equal(outer.metadata.instructions, 'INNER instructions exactly\n含中文');
  assert.equal(outer.tools.length, 4 + repairTools.length);
  const metadata = JSON.parse(fs.readFileSync(path.join(f.config.evidenceDir, 'bridge-metadata.json'), 'utf8'));
  assert.equal(metadata.tools[0].description, 'VERBATIM read description');
  assert.deepEqual(metadata.tools[3].catalog_extension, { exact: true });
  assert.equal(metadata.tools[3].annotations.unknown_hint, 'keep');
  const payload = await outer.callTool({ name: 'native_query', arguments: {} }, {});
  assert.equal(payload.content[0].text, 'opaque exact native payload');
  assert.deepEqual(payload.content[0].unknown_content, { exact: [1, 2] });
  assert.deepEqual(payload.unknown_result, { exact: ['keep'] });
  assert.equal(payload.structuredContent.secretInherited, false);
  const wire = records({ evidenceDir: clientEvidence }, 'native-wire.jsonl');
  const menu = wire.find(record => record.message.result?.tools)?.message.result.tools;
  assert.deepEqual(menu, metadata.tools);
  const innerWire = records({ evidenceDir: path.join(f.config.evidenceDir, 'inner') }, 'native-wire.jsonl');
  const actualInner = innerWire.filter(record => record.message.result?.content).at(-1).message.result;
  assert.deepEqual(payload, actualInner);
  const exposure = records(f.config, 'exposures.jsonl')[0];
  assert.deepEqual(exposure, { sequence: 1, tool: 'native_query', arguments: {}, result: payload, revision: 0 });
  const failure = await outer.callTool({ name: 'native_query', arguments: { fail: true } }, {});
  assert.equal(failure.isError, true);
  assert.deepEqual(failure.content[0].unknown_content, { exact: [1, 2] });
  assert.equal(records(f.config, 'exposures.jsonl').length, 1);
  await outer.close();
  assert.equal(fs.readFileSync(path.join(f.tmp, 'inner-closed'), 'utf8'), 'closed');
});

test('reconnecting in the same evidence directory keeps only the current raw catalog and preserves history', { skip: !enabled }, async t => {
  const f = fixture(t), first = await f.create();
  const wireFile = path.join(f.config.evidenceDir, 'inner', 'native-wire.jsonl');
  assert.equal(first.tools.length, 4 + repairTools.length);
  await first.callTool({ name: 'native_query', arguments: {} });
  await first.close();
  const history = fs.readFileSync(wireFile);
  assert.ok(history.length > history.toString('utf8').length, 'history includes multibyte UTF-8');

  const innerConfig = JSON.parse(fs.readFileSync(f.config.innerConfig, 'utf8'));
  innerConfig.nativeDescription = '第二轮 current native catalog';
  innerConfig.catalogExtension = { exact: ['second', '界'] };
  fs.writeFileSync(f.config.innerConfig, JSON.stringify(innerConfig));
  const second = await f.create();
  assert.equal(second.tools.length, 4 + repairTools.length);
  const currentWire = records({ evidenceDir: path.dirname(wireFile) }, 'native-wire.jsonl');
  const menus = currentWire.filter(record => record.direction === 'response' && record.message.result?.tools).map(record => record.message.result.tools);
  assert.equal(menus.length, 2);
  assert.deepEqual(second.tools, [...menus[1], ...repairTools]);
  assert.equal(second.tools[3].description, innerConfig.nativeDescription);
  assert.deepEqual(second.tools[3].catalog_extension, innerConfig.catalogExtension);
  assert.equal(second.tools[3].annotations.unknown_hint, 'keep');
  const metadata = JSON.parse(fs.readFileSync(path.join(f.config.evidenceDir, 'bridge-metadata.json'), 'utf8'));
  assert.equal(metadata.inner.instructions, 'INNER instructions exactly\n含中文');
  assert.deepEqual(metadata.tools, second.tools);
  assert.deepEqual(currentWire.filter(record => record.direction === 'request' && record.message.method === 'initialize').map(record => record.message.id), [0, 0]);
  assert.deepEqual(currentWire.filter(record => record.direction === 'request' && record.message.method === 'tools/list').map(record => record.message.id), [1, 1]);
  const payload = await second.callTool({ name: 'native_query', arguments: {} });
  assert.equal(payload.content[0].text, 'opaque exact native payload');
  assert.deepEqual(payload.unknown_result, { exact: ['keep'] });
  const edited = await second.callTool({ name: 'source_edit', arguments: { file_path: 'sample.js', old_text: 'const two = 2;', new_text: 'const two = 3;' } });
  assert.equal(edited.isError, undefined);
  assert.match((await second.callTool({ name: 'source_read', arguments: { file_path: 'sample.js' } })).content[0].text, /two = 3/);
  await second.close();
  assert.deepEqual(fs.readFileSync(wireFile).subarray(0, history.length), history);
});

test('text-only outer MCP client can poll a silent job and observe nonzero completion', { skip: !enabled }, async t => {
  const f = fixture(t), sdk = loadSdk(sdkRoot);
  const outerConfig = path.join(f.tmp, 'outer.json');
  fs.writeFileSync(outerConfig, JSON.stringify(f.config));
  const clientEvidence = path.join(f.tmp, 'client-evidence'); fs.mkdirSync(clientEvidence);
  const outer = await connectNative(sdk, { command: process.execPath, args: [bridgeEntry, '--config', outerConfig], cwd: f.root, env: {} }, clientEvidence);
  f.closers.push(() => outer.close());
  const launched = await outer.callTool({ name: 'source_exec', arguments: { command: JSON.stringify({ delayMs: 1800, ending: 'finished\n' }) } }, {});
  const visible = modelText(launched);
  const state = JSON.parse(visible.split('\n')[0]);
  assert.equal(state.status, 'running');
  assert.equal(state.exit_code, null);
  assert.match(state.job_id, /^[\da-f-]{36}$/);
  assert.equal(visible.split('\n').slice(1).join('\n'), 'stdout:\n\nstderr:\n');
  assert.equal(launched.structuredContent.job_id, state.job_id);
  const polled = await outer.callTool({ name: 'source_poll', arguments: { job_id: state.job_id, wait_ms: 5000 } }, {});
  assert.deepEqual(JSON.parse(modelText(polled).split('\n')[0]), { ...state, status: 'completed', exit_code: 0 });
  assert.match(modelText(polled), /finished/);
  assert.equal((await outer.callTool({ name: 'source_read', arguments: { file_path: 'sample.js' } }, {})).isError, undefined);
  const failed = await outer.callTool({ name: 'source_exec', arguments: { command: JSON.stringify({ stderr: 'test failure\n', exitCode: 7 }) } }, {});
  const failureState = JSON.parse(modelText(failed).split('\n')[0]);
  assert.equal(failureState.status, 'completed');
  assert.equal(failureState.exit_code, 7);
  assert.match(failureState.job_id, /^[\da-f-]{36}$/);
  assert.match(modelText(failed), /test failure/);
  assert.equal(failed.isError, true);
});

test('unique UTF-8 edits, new files, deletion and exact byte/version receipts', { skip: !enabled }, async t => {
  const f = fixture(t), bridge = await f.create();
  const before = fs.readFileSync(path.join(f.root, 'sample.js'));
  const replace = await bridge.callTool({ name: 'source_edit', arguments: { file_path: 'sample.js', old_text: 'const one = "界";', new_text: 'const one = "新";' } });
  assert.equal(replace.isError, undefined);
  assert.equal(fs.readFileSync(path.join(f.root, 'sample.js'), 'utf8'), 'const one = "新";\r\nconst two = 2;\r\n');
  assert.doesNotMatch(replace.content[0].text, /sha|hash|revision/i);
  assert.equal((await bridge.callTool({ name: 'source_edit', arguments: { file_path: 'sample.js', old_text: 'const ', new_text: '' } })).isError, true);
  assert.equal((await bridge.callTool({ name: 'source_edit', arguments: { file_path: 'sample.js', old_text: 'absent', new_text: '' } })).isError, true);
  assert.equal((await bridge.callTool({ name: 'source_edit', arguments: { file_path: 'sample.js', old_text: '', new_text: 'overwrite' } })).isError, true);
  const created = await bridge.callTool({ name: 'source_edit', arguments: { file_path: 'new/nested.js', old_text: '', new_text: 'new source\n' } });
  assert.equal(created.isError, undefined);
  await bridge.callTool({ name: 'source_read', arguments: { file_path: 'new/nested.js' } });
  const deleted = await bridge.callTool({ name: 'source_delete', arguments: { file_path: 'new/nested.js' } });
  assert.equal(deleted.isError, undefined);
  assert.equal(fs.existsSync(path.join(f.root, 'new/nested.js')), false);
  const edits = records(f.config, 'edits.jsonl');
  assert.deepEqual(edits.map(edit => edit.revision), [1, 2, 3]);
  assert.deepEqual(Buffer.from(edits[0].old.base64, 'base64'), before);
  assert.equal(edits[0].new.text, 'const one = "新";\r\nconst two = 2;\r\n');
  assert.equal(edits[1].old, null);
  assert.equal(edits[2].new, null);
  assert.equal(records(f.config, 'exposures.jsonl')[0].revision, 2);
  fs.writeFileSync(path.join(f.root, 'invalid.js'), Buffer.from([0xff]));
  assert.match((await bridge.callTool({ name: 'source_edit', arguments: { file_path: 'invalid.js', old_text: '�', new_text: 'x' } })).content[0].text, /UTF-8/);
  assert.equal((await bridge.callTool({ name: 'source_delete', arguments: { file_path: 'sample.js', unexpected: true } })).isError, true);
});

test('real path escape, junctions, excluded state/evidence and source reads are rejected', { skip: !enabled }, async t => {
  const f = fixture(t), bridge = await f.create();
  const outside = path.join(f.tmp, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'escape.js'), 'outside');
  fs.symlinkSync(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const innerDir = path.join(f.root, 'inner'); fs.mkdirSync(innerDir);
  fs.writeFileSync(path.join(innerDir, 'safe.js'), 'inside');
  fs.symlinkSync(innerDir, path.join(f.root, 'internal-link'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['.git', '.codegraph', '.codefacts-cache', 'indexstate', 'private-evidence']) {
    fs.mkdirSync(path.join(f.root, name)); fs.writeFileSync(path.join(f.root, name, 'hidden.js'), 'hidden');
  }
  const windowsPaths = process.platform === 'win32' ? ['.git./hidden.js', '.git /hidden.js', 'sample.js:stream', 'NUL', 'nul.txt', 'COM1', 'created.'] : [];
  for (const file_path of ['../outside/escape.js', path.join(outside, 'escape.js'), 'linked/escape.js', 'internal-link/safe.js', '.git/hidden.js', '.codegraph/hidden.js', '.codefacts-cache/hidden.js', 'indexstate/hidden.js', 'private-evidence/hidden.js', 'custom-index.db', 'custom-index.db-wal', 'custom-index.db-journal', ...windowsPaths]) {
    for (const [name, args] of [['source_edit', { old_text: '', new_text: 'escape' }], ['source_read', {}], ['source_delete', {}]]) {
      const response = await bridge.callTool({ name, arguments: { file_path, ...args } });
      assert.equal(response.isError, true, `${name}: ${file_path}`);
    }
  }
  assert.equal(fs.readFileSync(path.join(outside, 'escape.js'), 'utf8'), 'outside');
  assert.equal((await bridge.callTool({ name: 'source_edit', arguments: { file_path: 'linked/new/sub.js', old_text: '', new_text: 'escape' } })).isError, true);
  assert.equal(fs.existsSync(path.join(outside, 'new')), false);
});

test('repository inspection and editing have a deterministic serialized source revision', { skip: !enabled }, async t => {
  const f = fixture(t), bridge = await f.create();
  const read = bridge.callTool({ name: 'source_read', arguments: { file_path: 'sample.js', delay_ms: 100 } });
  const edit = bridge.callTool({ name: 'source_edit', arguments: { file_path: 'sample.js', old_text: 'const two = 2;', new_text: 'const two = 3;' } });
  const first = await read;
  assert.match(first.content[0].text, /two = 2/);
  assert.equal((await edit).isError, undefined);
  const last = await bridge.callTool({ name: 'source_read', arguments: { file_path: 'sample.js' } });
  assert.match(last.content[0].text, /two = 3/);
  assert.deepEqual(records(f.config, 'exposures.jsonl').map(record => record.revision), [0, 1]);
  assert.deepEqual(records(f.config, 'events.jsonl').filter(record => ['operation-start', 'operation-end'].includes(record.type)).map(record => `${record.type}:${record.sequence}`),
    ['operation-start:1', 'operation-end:1', 'operation-start:2', 'operation-end:2', 'operation-start:3', 'operation-end:3']);
});

test('sandbox is fixed argv with safe environment; jobs return early, poll incrementally and gate source', { skip: !enabled, timeout: 30000 }, async t => {
  const f = fixture(t), bridge = await f.create({ execWaitMs: 50 });
  const prior = process.env.COMMUNITY_SECRET_SENTINEL;
  process.env.COMMUNITY_SECRET_SENTINEL = 'host-only-secret';
  f.closers.push(() => { if (prior === undefined) delete process.env.COMMUNITY_SECRET_SENTINEL; else process.env.COMMUNITY_SECRET_SENTINEL = prior; });
  const releaseFile = path.join(f.tmp, 'sandbox-release');
  // Always release the owned child before bridge cleanup on a failed assertion.
  f.closers.push(() => fs.writeFileSync(releaseFile, 'release'));
  const command = JSON.stringify({ inspect: true, releaseFile, ending: 'ending\n', payload: '"; $(host-command) `host-command` & < >' });
  const launched = await bridge.callTool({ name: 'source_exec', arguments: { command } });
  const visible = JSON.parse(modelText(launched).split('\n')[0]);
  assert.equal(visible.status, 'running');
  const id = visible.job_id;
  assert.equal(fs.existsSync(releaseFile), false);
  assert.ok(!records(f.config, 'events.jsonl').some(record => record.type === 'sandbox-close' && record.job_id === id));
  assert.equal((await bridge.callTool({ name: 'source_list', arguments: {} })).isError, true);
  assert.equal((await bridge.callTool({ name: 'source_edit', arguments: { file_path: 'sample.js', old_text: '', new_text: '' } })).isError, true);
  assert.equal((await bridge.callTool({ name: 'source_exec', arguments: { command } })).isError, true);
  assert.equal((await bridge.callTool({ name: 'source_poll', arguments: { job_id: id, wait_ms: 10001 } })).isError, true);
  const pending = await bridge.callTool({ name: 'source_poll', arguments: { job_id: id, wait_ms: 0 } });
  assert.equal(pending.structuredContent.status, 'running');
  assert.doesNotMatch(launched.content[0].text + pending.content[0].text, /^ending$/m);
  fs.writeFileSync(releaseFile, 'release');
  // Completion is an observed event, not a deadline on a contended host.
  while (!records(f.config, 'events.jsonl').some(record => record.type === 'sandbox-close' && record.job_id === id)) {
    await delay(10, undefined, { signal: t.signal });
  }
  const poll = await bridge.callTool({ name: 'source_poll', arguments: { job_id: id, wait_ms: 0 } });
  assert.equal(poll.structuredContent.status, 'completed');
  assert.match(poll.content[0].text, /^ending$/m);
  const stdout = response => modelText(response).split('\nstdout:\n')[1].split('\nstderr:\n')[0];
  const output = [launched, pending, poll].map(stdout).join('');
  assert.match(output, /"secretInherited":false/);
  const line = output.split('\n').find(value => value.startsWith('{"argv"'));
  assert.deepEqual(JSON.parse(line).argv, ['bash', '-lc', command]);
  assert.equal((await bridge.callTool({ name: 'source_list', arguments: {} })).isError, undefined);
  assert.equal(records(f.config, 'exposures.jsonl').at(-1).revision, 1);
  assert.equal(records(f.config, 'edits.jsonl').length, 0);
  const again = await bridge.callTool({ name: 'source_poll', arguments: { job_id: id, wait_ms: 0 } });
  assert.deepEqual(JSON.parse(modelText(again).split('\n')[0]), { job_id: id, status: 'completed', exit_code: 0 });
  assert.doesNotMatch(again.content[0].text, /^ending$/m);
  assert.equal((await bridge.callTool({ name: 'source_poll', arguments: { job_id: 'unknown' } })).isError, true);
  const lifecycle = records(f.config, 'events.jsonl').filter(record => record.job_id === id);
  assert.ok(lifecycle.some(record => record.type === 'sandbox-start'));
  assert.ok(lifecycle.some(record => record.type === 'sandbox-output'));
  assert.ok(lifecycle.some(record => record.type === 'sandbox-close'));
  assert.ok(lifecycle.some(record => record.type === 'sandbox-completion-observed'));
  assert.ok(lifecycle.some(record => record.type === 'source-observation-epoch' && record.reason === 'sandbox-command; source changes not individually journaled'));
});

test('completed unpolled jobs remain busy; output is bounded valid UTF-8 and failures are explicit', { skip: !enabled }, async t => {
  const f = fixture(t), bridge = await f.create({ execWaitMs: 0 });
  const response = await bridge.callTool({ name: 'source_exec', arguments: { command: JSON.stringify({ stdout: '界', stderr: 'bad', repeat: MAX_BYTES, delayMs: 0, exitCode: 7 }) } });
  const id = response.structuredContent.job_id;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.match((await bridge.callTool({ name: 'source_list', arguments: {} })).content[0].text, /Sandbox busy/);
  const completed = await bridge.callTool({ name: 'source_poll', arguments: { job_id: id, wait_ms: 1000 } });
  assert.equal(completed.structuredContent.status, 'completed');
  assert.equal(completed.isError, true);
  assert.equal(completed.structuredContent.exit_code, 7);
  assert.equal(completed.structuredContent.truncated, true);
  assert.deepEqual(JSON.parse(modelText(completed).split('\n')[0]), { job_id: id, status: 'completed', exit_code: 7 });
  assert.ok(Buffer.byteLength(completed.content[0].text) <= MAX_BYTES);
  assert.match(completed.content[0].text, /TRUNCATED/);
  assert.doesNotMatch(completed.content[0].text, /�/);
  assert.ok(fs.statSync(path.join(f.config.evidenceDir, `${id}-stdout.log`)).size > MAX_BYTES);
  assert.equal((await bridge.callTool({ name: 'source_list', arguments: {} })).isError, undefined);
  assert.equal(records(f.config, 'exposures.jsonl').at(-1).revision, 1);
});

test('sandbox launch errors are visible to a text-only client', { skip: !enabled }, async t => {
  const f = fixture(t);
  f.config.sandbox.command = path.join(f.tmp, 'missing-sandbox-command');
  const bridge = await f.create();
  const response = await bridge.callTool({ name: 'source_exec', arguments: { command: 'unused' } });
  const text = modelText(response), state = JSON.parse(text.split('\n')[0]);
  assert.equal(state.status, 'completed');
  assert.match(state.job_id, /^[\da-f-]{36}$/);
  assert.equal(state.exit_code, response.structuredContent.exit_code);
  assert.match(text, /error:\n.*ENOENT/);
  assert.equal(response.isError, true);
  assert.ok(Buffer.byteLength(text) <= MAX_BYTES);
  assert.equal((await bridge.callTool({ name: 'source_list', arguments: {} })).isError, undefined);
});

test('close terminates owned sandbox child and inner MCP and records cleanup', { skip: !enabled }, async t => {
  const f = fixture(t), bridge = await f.create({ execWaitMs: 30 });
  const response = await bridge.callTool({ name: 'source_exec', arguments: { command: JSON.stringify({ endless: true, ignoreTerm: true, stdout: 'ready' }) } });
  const id = response.structuredContent.job_id;
  const deadline = Date.now() + 1000;
  while (!records(f.config, 'events.jsonl').some(record => record.type === 'sandbox-output' && record.job_id === id)) {
    if (Date.now() > deadline) throw new Error('sandbox fixture did not spawn');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const pid = records(f.config, 'events.jsonl').find(record => record.type === 'sandbox-spawn' && record.job_id === id).pid;
  await bridge.close(); await bridge.close();
  assert.throws(() => process.kill(pid, 0));
  assert.equal(fs.readFileSync(path.join(f.tmp, 'inner-closed'), 'utf8'), 'closed');
  assert.ok(records(f.config, 'events.jsonl').some(record => record.type === 'cleanup-complete'));
  if (process.platform !== 'win32') assert.ok(records(f.config, 'events.jsonl').some(record => record.type === 'sandbox-cancel-escalated'));
  assert.equal((await bridge.callTool({ name: 'source_list', arguments: {} })).isError, true);
});

test('trusted config still requires absolute fixed paths and matching inner source root', { skip: !enabled }, t => {
  const f = fixture(t);
  assert.throws(() => validateConfig({ ...f.config, nodeCommand: 'node' }), /absolute/);
  assert.throws(() => validateConfig({ ...f.config, sandbox: { command: process.execPath, argsPrefix: ['-e', 'evil'] } }), /bash, -lc/);
  const other = path.join(f.tmp, 'other'); fs.mkdirSync(other);
  assert.throws(() => validateConfig({ ...f.config, root: other }), /must match/);
});
