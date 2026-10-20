import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createBridge, MAX_BYTES, sourceTools, validateConfig } from './bridge.mjs';
import { loadSdk } from './rpc.mjs';

const sdkRoot = process.env.TASK_BENCHMARK_SDK_ROOT;
const rgCommand = process.env.TASK_BENCHMARK_RG_COMMAND;
const enabled = Boolean(sdkRoot && rgCommand);
const dir = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(dir, 'bridge.mjs');

function fixture(t, arm = 'ordinary') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-bridge-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'source'), evidenceDir = path.join(tmp, 'evidence');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'sample.js'), 'export function alpha() {}\nconst literal = "a.b";\nconst regex = "axb";\n');
  fs.writeFileSync(path.join(root, '.hidden.js'), 'alpha hidden source\n');
  for (const name of ['.git', 'node_modules', '.codegraph-cache', '.code-graph', '.codefacts', 'indexstate']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'hidden.js'), 'alpha excluded\n');
  }
  const config = { root, evidenceDir, rgCommand, sdkRoot, arm, native: null };
  return { tmp, root, config };
}

function nativeFixture(config, tmp, arm = config.arm, extraEnv = {}) {
  const script = path.join(tmp, 'fake-native.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.env.FIXTURE_SDK_ROOT, 'package.json'));
const { Server } = require(path.join(process.env.FIXTURE_SDK_ROOT, 'dist/cjs/server/index.js'));
const { StdioServerTransport } = require(path.join(process.env.FIXTURE_SDK_ROOT, 'dist/cjs/server/stdio.js'));
const { ListToolsRequestSchema, CallToolRequestSchema } = require(path.join(process.env.FIXTURE_SDK_ROOT, 'dist/cjs/types.js'));
const names = JSON.parse(process.env.FIXTURE_NAMES);
const rootKey = process.env.FIXTURE_ARM === 'codegraph' ? 'projectPath' : 'repository_root';
const server = new Server({ name: 'fake-native', version: 'fixture-1' }, { capabilities: { tools: {} }, instructions: 'NATIVE INSTRUCTIONS FOR METADATA ONLY' });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map(name => ({ name, description: 'VERBATIM description ' + name, annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { [rootKey]: { type: 'string' }, query: { type: 'string' } }, required: [rootKey], additionalProperties: false } })) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.arguments.query === 'rpc-error') throw new Error('native primary failure');
  return { content: [{ type: 'text', text: '原生 exact payload' }], structuredContent: { request: request.params, secretWasInherited: Boolean(process.env.TASK_BRIDGE_SECRET_SENTINEL) }, _meta: { native: 'retained' }, extensionField: 'raw retained', ...(request.params.arguments.query === 'tool-error' ? { isError: true } : {}) };
});
process.stdin.once('end', () => { fs.writeFileSync(process.env.FIXTURE_CLOSED, 'closed'); void server.close(); });
await server.connect(new StdioServerTransport());
`);
  const names = { codefacts017: ['map', 'search', 'outline', 'expand', 'path'], codefacts022: ['explore', 'expand', 'impact'], codegraph: ['codegraph_explore'] }[arm];
  config.native = { command: process.execPath, args: [script], cwd: config.root, env: {
    FIXTURE_SDK_ROOT: sdkRoot, FIXTURE_NAMES: JSON.stringify(names), FIXTURE_ARM: arm, FIXTURE_CLOSED: path.join(tmp, 'native-closed'), ...extraEnv,
  } };
}

test('importing bridge starts no server and exits cleanly', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./bridge.mjs', import.meta.url).href)});`], { timeout: 10_000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('SDK and ripgrep fixture prerequisites are explicit', () => {
  assert.ok(enabled, 'Set TASK_BENCHMARK_SDK_ROOT and TASK_BENCHMARK_RG_COMMAND to existing absolute paths; no dependency download is performed');
});

test('ordinary menu, current source, literal/regex/glob and exclusions', { skip: !enabled }, async t => {
  const { root, config } = fixture(t);
  const bridge = await createBridge(config);
  t.after(() => bridge.close());
  assert.deepEqual(bridge.tools, sourceTools);
  assert.equal(fs.existsSync(path.join(config.evidenceDir, 'native-metadata.json')), false);
  assert.equal((await bridge.callTool({ name: 'codegraph_explore' })).isError, true);
  const list = await bridge.callTool({ name: 'source_list', arguments: { glob: '**/*.js' } });
  assert.match(list.content[0].text, /sample\.js/);
  assert.match(list.content[0].text, /\.hidden\.js/);
  assert.doesNotMatch(list.content[0].text, /hidden\.js.*excluded|node_modules|\.git|\.codegraph|\.code-graph|\.codefacts|indexstate/);
  const literal = await bridge.callTool({ name: 'source_search', arguments: { pattern: 'a.b', literal: true, glob: '*.js' } });
  assert.match(literal.content[0].text, /sample\.js:2:/);
  assert.doesNotMatch(literal.content[0].text, /sample\.js:3:/);
  const regex = await bridge.callTool({ name: 'source_search', arguments: { pattern: 'a.b', glob: '*.js' } });
  assert.match(regex.content[0].text, /sample\.js:3:/);
  const noMatches = await bridge.callTool({ name: 'source_search', arguments: { pattern: 'not-present' } });
  assert.equal(noMatches.isError, undefined);
  assert.equal(noMatches.content[0].text, '');
  const invalid = await bridge.callTool({ name: 'source_search', arguments: { pattern: '[' } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /ripgrep failed/);
  const read = await bridge.callTool({ name: 'source_read', arguments: { file_path: 'sample.js', start_line: 1, end_line: 2 } });
  assert.equal(read.content[0].text, '1\texport function alpha() {}\n2\tconst literal = "a.b";');
  fs.writeFileSync(path.join(root, 'sample.js'), 'changed source\n');
  const changed = await bridge.callTool({ name: 'source_read', arguments: { file_path: 'sample.js', start_line: 1, end_line: 2 } });
  assert.match(changed.content[0].text, /changed source/);
  assert.equal(changed.structuredContent.sourceSha256, undefined);
  assert.equal(read.structuredContent.sourceSha256, undefined);
  assert.doesNotMatch(sourceTools[1].description, /SHA|hash/);
});

test('source paths reject traversal, absolute paths, excluded source, and escaping junctions', { skip: !enabled }, async t => {
  const { tmp, root, config } = fixture(t);
  const bridge = await createBridge(config);
  t.after(() => bridge.close());
  fs.writeFileSync(path.join(tmp, 'outside.js'), 'outside alpha\n');
  const outsideDir = path.join(tmp, 'outside');
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'escape.js'), 'escaped alpha\n');
  fs.symlinkSync(outsideDir, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file_path of ['../outside.js', path.join(tmp, 'outside.js'), '.git/hidden.js', 'node_modules/hidden.js', '.codegraph-cache/hidden.js', 'escape/escape.js']) {
    const result = await bridge.callTool({ name: 'source_read', arguments: { file_path, start_line: 1, end_line: 1 } });
    assert.equal(result.isError, true, file_path);
  }
  const search = await bridge.callTool({ name: 'source_search', arguments: { pattern: 'escaped', glob: '**/*' } });
  assert.equal(search.content[0].text, '');
  const forcedGlob = await bridge.callTool({ name: 'source_search', arguments: { pattern: 'excluded', glob: '**/*' } });
  assert.equal(forcedGlob.content[0].text, '');
});

test('source byte and line bounds produce explicit valid UTF-8 truncation', { skip: !enabled }, async t => {
  const { root, config } = fixture(t);
  fs.writeFileSync(path.join(root, 'long.js'), '界'.repeat(30_000) + '\n');
  fs.writeFileSync(path.join(root, 'lines.js'), Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join('\n'));
  const bridge = await createBridge(config);
  t.after(() => bridge.close());
  for (const params of [
    { name: 'source_read', arguments: { file_path: 'long.js', start_line: 1, end_line: 1 } },
    { name: 'source_search', arguments: { pattern: '界' } },
    { name: 'source_read', arguments: { file_path: 'lines.js', start_line: 1, end_line: 400 } },
  ]) {
    const result = await bridge.callTool(params);
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(result.structuredContent.truncated, true);
    assert.match(result.content[0].text, /TRUNCATED/);
    assert.ok(Buffer.byteLength(result.content[0].text) <= MAX_BYTES);
    assert.doesNotMatch(result.content[0].text, /\uFFFD/);
    assert.doesNotMatch(result.content[0].text, /^301\t/m);
  }
  fs.mkdirSync(path.join(root, 'many'));
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(root, 'many', `${i}-${'x'.repeat(40)}.js`), '');
  const listed = await bridge.callTool({ name: 'source_list', arguments: {} });
  assert.equal(listed.structuredContent.truncated, true);
  assert.match(listed.content[0].text, /TRUNCATED/);
  assert.ok(Buffer.byteLength(listed.content[0].text) <= MAX_BYTES);
});

for (const arm of ['codefacts017', 'codefacts022', 'codegraph']) {
  test(`${arm} native menu, fixed roots, exact payload, errors, raw receipts and closure`, { skip: !enabled }, async t => {
    const { tmp, config } = fixture(t, arm);
    nativeFixture(config, tmp);
    const sentinel = process.env.TASK_BRIDGE_SECRET_SENTINEL;
    process.env.TASK_BRIDGE_SECRET_SENTINEL = 'must-never-reach-native';
    t.after(() => { if (sentinel === undefined) delete process.env.TASK_BRIDGE_SECRET_SENTINEL; else process.env.TASK_BRIDGE_SECRET_SENTINEL = sentinel; });
    const bridge = await createBridge(config);
    t.after(() => bridge.close());
    assert.deepEqual(bridge.tools.slice(0, 3), sourceTools);
    const tool = bridge.tools[3];
    const rootKey = arm === 'codegraph' ? 'projectPath' : 'repository_root';
    const nativeName = arm === 'codegraph' ? tool.name : tool.name.replace(/^codefacts_/, '');
    assert.equal(tool.description, `VERBATIM description ${nativeName}`);
    assert.equal(tool.inputSchema.properties[rootKey], undefined);
    assert.equal(tool.inputSchema.required.includes(rootKey), false);
    const forged = await bridge.callTool({ name: tool.name, arguments: { [rootKey]: tmp } });
    assert.equal(forged.isError, true);
    const result = await bridge.callTool({ name: tool.name, arguments: { query: 'hello' } });
    assert.equal(result.content[0].text, '原生 exact payload');
    assert.equal(result.extensionField, 'raw retained');
    assert.deepEqual(result._meta, { native: 'retained' });
    assert.equal(result.structuredContent.request.arguments[rootKey], fs.realpathSync(config.root));
    assert.equal(result.structuredContent.secretWasInherited, false);
    const receipt = JSON.parse(fs.readFileSync(path.join(config.evidenceDir, '0002-receipt.json')));
    assert.equal(receipt.nativeResponseUnmodified, true);
    assert.deepEqual(receipt.native.response.message.result, result);
    assert.ok(receipt.native.request.bytes > 0);
    assert.ok(receipt.native.response.bytes > 0);
    const nativeError = await bridge.callTool({ name: tool.name, arguments: { query: 'rpc-error' } });
    assert.equal(nativeError.isError, true);
    assert.match(nativeError.content[0].text, /native primary failure/);
    const nativeToolError = await bridge.callTool({ name: tool.name, arguments: { query: 'tool-error' } });
    assert.equal(nativeToolError.isError, true);
    assert.equal(nativeToolError.extensionField, 'raw retained');
    const metadata = JSON.parse(fs.readFileSync(path.join(config.evidenceDir, 'bridge-metadata.json')));
    assert.equal(metadata.native.instructions, 'NATIVE INSTRUCTIONS FOR METADATA ONLY');
    assert.equal(metadata.native.serverInfo.version, 'fixture-1');
    assert.ok(metadata.native.pid > 0);
    assert.doesNotMatch(fs.readFileSync(path.join(config.evidenceDir, 'native-metadata.json'), 'utf8'), /must-never-reach-native/);
    await bridge.close();
    assert.equal(fs.readFileSync(path.join(tmp, 'native-closed'), 'utf8'), 'closed');
  });
}

test('invalid arm config and secret-bearing flags fail before startup', { skip: !enabled }, t => {
  const { tmp, config } = fixture(t);
  assert.throws(() => validateConfig({ ...config, native: { command: process.execPath } }), /native:null/);
  config.arm = 'codefacts022';
  nativeFixture(config, tmp);
  assert.throws(() => validateConfig({ ...config, nativeEnv: { OPENAI_API_KEY: 'do-not-log' } }), /Secret-bearing/);
  assert.throws(() => validateConfig({ ...config, native: null }), /requires native/);
});

test('native menu mismatch closes child and preserves primary error', { skip: !enabled }, async t => {
  const { tmp, config } = fixture(t, 'codefacts022');
  nativeFixture(config, tmp, 'codefacts017');
  await assert.rejects(createBridge(config), /Native codefacts022 menu mismatch/);
  assert.equal(fs.readFileSync(path.join(tmp, 'native-closed'), 'utf8'), 'closed');
});

for (const ending of ['eof', 'signal']) {
  test(`CLI MCP initializes, exposes audited menu, and closes native on ${ending}`, { skip: !enabled }, async t => {
    const { tmp, config } = fixture(t, 'codefacts022');
    nativeFixture(config, tmp);
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config));
    // Windows cannot deliver POSIX SIGTERM through child.kill(). Deliver the
    // Node signal event over IPC there, exercising the same shutdown handler.
    const simulateSignal = ending === 'signal' && process.platform === 'win32';
    const args = simulateSignal ? ['--input-type=module', '-e', `import { main } from ${JSON.stringify(new URL('./bridge.mjs', import.meta.url).href)}; process.on('message', () => process.emit('SIGTERM')); await main(['--config', ${JSON.stringify(configPath)}]);`] : [bridgePath, '--config', configPath];
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe', ...(simulateSignal ? ['ipc'] : [])], windowsHide: true });
    t.after(() => child.kill());
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 10_000;
    const waitFor = async predicate => {
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`CLI fixture timeout: ${stderr}\n${stdout}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
    await waitFor(() => stdout.includes('"id":1'));
    const initialized = stdout.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 1);
    assert.equal(initialized.result.instructions, 'NATIVE INSTRUCTIONS FOR METADATA ONLY');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    await waitFor(() => stdout.includes('"id":2'));
    const menu = stdout.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 2).result.tools;
    assert.deepEqual(menu.map(tool => tool.name), [...sourceTools.map(tool => tool.name), 'codefacts_explore', 'codefacts_expand', 'codefacts_impact']);
    const pid = JSON.parse(fs.readFileSync(path.join(config.evidenceDir, 'native-metadata.json'))).pid;
    if (ending === 'eof') child.stdin.end();
    else if (simulateSignal) child.send({ signal: 'SIGTERM' });
    else child.kill('SIGTERM');
    await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('CLI did not terminate')), 8_000).unref())]);
    assert.equal(fs.readFileSync(path.join(tmp, 'native-closed'), 'utf8'), 'closed');
    assert.throws(() => process.kill(pid, 0));
  });
}

test('SDK client receives native instructions verbatim through bridge initialization', { skip: !enabled }, async t => {
  const { tmp, config } = fixture(t, 'codegraph');
  nativeFixture(config, tmp);
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const sdk = loadSdk(sdkRoot);
  const client = new sdk.Client({ name: 'instruction-test', version: '1' }, { capabilities: {} });
  const transport = new sdk.StdioClientTransport({ command: process.execPath, args: [bridgePath, '--config', configPath], stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 10_000 });
  assert.equal(client.getInstructions(), 'NATIVE INSTRUCTIONS FOR METADATA ONLY');
  await client.close();
  assert.equal(fs.readFileSync(path.join(tmp, 'native-closed'), 'utf8'), 'closed');
});
