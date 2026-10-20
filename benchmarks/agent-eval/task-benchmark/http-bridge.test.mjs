import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBridge } from './bridge.mjs';
import { loadSdk } from './rpc.mjs';
import { startHttpBridge } from './http-owner.mjs';
import { evaluateLifecycle } from './lifecycle.mjs';
import { makeDshOverlay } from './dsh-adapter.mjs';
import { runDshAttempt } from './community/dsh.mjs';

const sdkRoot = process.env.TASK_BENCHMARK_SDK_ROOT;
const rgCommand = process.env.TASK_BENCHMARK_RG_COMMAND;
const clientRoot = process.env.TASK_BENCHMARK_MCP_CLIENT_ROOT;
const enabled = Boolean(sdkRoot);
const sdk = enabled && loadSdk(sdkRoot);
const instructions = 'SYNTHETIC NATIVE INSTRUCTIONS';
function fixture(t, arm = 'ordinary') {
  const tmp = fs.mkdtempSync(path.join(process.env.TASK_BENCHMARK_CALIBRATION_DIR ?? os.tmpdir(), 'benchmark-http-'));
  if (!process.env.TASK_BENCHMARK_CALIBRATION_DIR) t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'source'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'sample.js'), 'export const sample = 1;\n');
  // Protocol-only calibration never invokes rg; Node is an absolute unused
  // config placeholder when CI supplies only the existing SDK fixture.
  const config = { root, evidenceDir: path.join(tmp, 'evidence'), sdkRoot, rgCommand: rgCommand ?? process.execPath, arm, native: null };
  if (arm !== 'ordinary') {
    const nativeScript = path.join(tmp, 'synthetic-native.mjs');
    fs.writeFileSync(nativeScript, `import fs from 'node:fs';
import {createRequire} from 'node:module'; import path from 'node:path';
const require=createRequire(path.join(process.env.SDK_ROOT,'package.json'));
const {Server}=require(path.join(process.env.SDK_ROOT,'dist/cjs/server/index.js'));
const {StdioServerTransport}=require(path.join(process.env.SDK_ROOT,'dist/cjs/server/stdio.js'));
const {ListToolsRequestSchema,CallToolRequestSchema}=require(path.join(process.env.SDK_ROOT,'dist/cjs/types.js'));
fs.appendFileSync(process.env.STARTS,JSON.stringify({pid:process.pid})+'\\n');
const s=new Server({name:'synthetic-native',version:'1'},{capabilities:{tools:{}},instructions:${JSON.stringify(instructions)}});
s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['explore','expand','impact'].map(name=>({name,description:'verbatim '+name,inputSchema:{type:'object',properties:{repository_root:{type:'string'},query:{type:'string'}},required:['repository_root']}}))}));
s.setRequestHandler(CallToolRequestSchema,async r=>({content:[{type:'text',text:'synthetic result'}],structuredContent:r.params,_meta:{synthetic:true}}));
process.stdin.on('end',()=>{void s.close();}); await s.connect(new StdioServerTransport());`);
    config.native = { command: process.execPath, args: [nativeScript], cwd: root, env: { SDK_ROOT: sdkRoot, STARTS: path.join(tmp, 'starts.jsonl') } };
  }
  const configFile = path.join(tmp, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  return { tmp, config, configFile, out: path.join(tmp, 'owner') };
}
async function connect(url) {
  const client = new sdk.Client({ name: 'synthetic-http-test', version: '1' });
  const transport = new sdk.StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport, async close() { await transport.terminateSession(); await client.close(); } };
}
function events(directory) {
  return fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').map(JSON.parse));
}

test('HTTP protocol calibration requires an existing SDK fixture', () => assert.ok(enabled, 'Set existing TASK_BENCHMARK_SDK_ROOT; no install is performed'));

test('HTTP overlay uses supported URL configuration and preserves stdio caller', () => {
  const options = { attemptDir: '/attempt', root: '/root', provider: 'p', model: 'm', nodeCommand: 'node' };
  const config = makeDshOverlay({ ...options, bridgeUrl: 'http://127.0.0.1:1234/mcp/test' }).at(-1).insert.at(-1).config;
  assert.equal(config.transport, 'streamable-http'); assert.equal(config.url, 'http://127.0.0.1:1234/mcp/test');
  assert.equal('command' in config, false); assert.deepEqual(config.reconnect, { enabled: false });
  assert.equal(makeDshOverlay({ ...options, bridgeEntry: '/bridge', bridgeConfig: '/config' }).at(-1).insert.at(-1).config.transport, 'stdio');
  assert.throws(() => makeDshOverlay({ ...options, bridgeEntry: '/bridge', bridgeConfig: '/config', bridgeUrl: 'http://localhost/' }), /mutually exclusive/);
});

test('invalid HTTP attempt parameters fail before allocating or starting a bridge', async t => {
  const directory = fs.mkdtempSync(path.join(process.env.TASK_BENCHMARK_CALIBRATION_DIR ?? os.tmpdir(), 'http-invalid-parameters-'));
  if (!process.env.TASK_BENCHMARK_CALIBRATION_DIR) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bridgeConfig = path.join(directory, 'bridge.json');
  // The valid ordinary config could initialize the HTTP bridge if validation
  // moved behind spawn again. No DSH fixture or provider is involved.
  const root = path.join(directory, 'source'); fs.mkdirSync(root);
  fs.writeFileSync(bridgeConfig, JSON.stringify({ root, sdkRoot: sdkRoot ?? directory, rgCommand: rgCommand ?? process.execPath,
    evidenceDir: path.join(directory, 'bridge-evidence'), arm: 'ordinary', native: null }));
  const cases = [
    [{ supportsStrictMode: null, probeOnly: true }, /supportsStrictMode must be a boolean/],
    [{ maxOutputTokens: 0, probeOnly: true }, /positive safe integer/],
    [{ prompt: null, probeOnly: false }, /prompt must be a string/],
  ];
  for (const [index, [invalid, expected]] of cases.entries()) {
    const attemptDir = path.join(directory, `attempt-${index}`);
    await assert.rejects(runDshAttempt({ installRoot: directory, root, attemptDir,
      bridgeEntry: fileURLToPath(new URL('./bridge.mjs', import.meta.url)), bridgeConfig,
      bridgeTransport: 'streamable-http', ...invalid }), expected);
    assert.equal(fs.existsSync(attemptDir), false);
    assert.equal(fs.existsSync(attemptDir + '-http'), false, 'No owner allocation or child-started receipt may precede parameter validation');
  }
  assert.equal(fs.existsSync(path.join(directory, 'bridge-evidence')), false);
});

test('two real HTTP bridge children isolate cells, source tool works, ordinary starts no native', { skip: !enabled }, async t => {
  const a = fixture(t), b = fixture(t);
  fs.writeFileSync(path.join(b.config.root, 'sample.js'), 'CELL B\n');
  const owners = await Promise.all([a, b].map(value => startHttpBridge({ ...value })));
  t.after(async () => { await Promise.all(owners.map(owner => owner.close())); });
  assert.notEqual(owners[0].url, owners[1].url);
  const clients = await Promise.all(owners.map(owner => connect(owner.url)));
  for (let i = 0; i < 2; i++) {
    const result = await clients[i].client.callTool({ name: 'source_read', arguments: { file_path: 'sample.js', start_line: 1, end_line: 1 } });
    assert.equal(result.content[0].text, i ? '1\tCELL B' : '1\texport const sample = 1;');
  }
  assert.equal((await fetch(new URL(new URL(owners[0].url).pathname, owners[1].url))).status, 404);
  await Promise.all(clients.map(client => client.close()));
  await Promise.all(owners.map(owner => owner.close()));
  for (let i = 0; i < 2; i++) {
    const ledger = events(owners[i].directory);
    assert.equal(ledger.some(row => row.role === 'native-stdio'), false);
    assert.equal(evaluateLifecycle(ledger).status, 'PASS', JSON.stringify(evaluateLifecycle(ledger)));
    assert.ok(ledger.some(row => row.type === 'http-quiescent'));
    assert.ok(ledger.find(row => row.type === 'child-close' && row.role === 'http-bridge-process'));
  }
});

test('real ripgrep helper has direct start/exit/close receipts', { skip: !enabled ? 'SDK prerequisite missing' : !rgCommand ? 'Existing ripgrep not configured; helper calibration unavailable' : false }, async t => {
  const f = fixture(t), owner = await startHttpBridge(f); t.after(() => owner.close());
  const connection = await connect(owner.url);
  assert.match((await connection.client.callTool({ name: 'source_list' })).content[0].text, /sample.js/);
  await connection.close(); await owner.close();
  const ledger = events(owner.directory);
  assert.ok(ledger.some(row => row.type === 'child-close' && row.role === 'ripgrep'));
  assert.equal(evaluateLifecycle(ledger).status, 'PASS');
});

test('synthetic native catalog/instructions/results equal old bridge; reconnect reuses one backend', { skip: !enabled }, async t => {
  const f = fixture(t, 'codefacts022');
  const owner = await startHttpBridge(f); t.after(() => owner.close());
  const first = await connect(owner.url);
  const catalog = (await first.client.listTools()).tools;
  assert.equal(first.client.getInstructions(), instructions);
  const request = { name: 'codefacts_explore', arguments: { query: 'bounded' } };
  const response = await first.client.callTool(request);
  await first.close();
  assert.equal(owner.child.exitCode, null, 'HTTP disconnect must not be counted as bridge process close');
  const second = await connect(owner.url);
  assert.deepEqual((await second.client.listTools()).tools, catalog);
  await second.close();
  assert.equal(fs.readFileSync(path.join(f.tmp, 'starts.jsonl'), 'utf8').trim().split('\n').length, 1);
  const old = await createBridge({ ...f.config, evidenceDir: path.join(f.tmp, 'old-evidence') });
  assert.deepEqual(old.tools, catalog);
  assert.deepEqual(await old.callTool(request), response);
  await old.close();
  await owner.close();
  const ledger = events(owner.directory), native = ledger.filter(row => row.role === 'native-stdio');
  assert.equal(native.filter(row => row.type === 'child-started').length, 1);
  const closed = native.find(row => row.type === 'child-close');
  assert.ok(closed); assert.equal(closed.details.code, null); assert.equal(closed.details.terminationEscalated, null);
  assert.equal(evaluateLifecycle(ledger).status, 'PASS', JSON.stringify(evaluateLifecycle(ledger)));
});

test('failed readiness retains direct child close and failure receipts', { skip: !enabled }, async t => {
  const f = fixture(t); f.config.arm = 'invalid'; fs.writeFileSync(f.configFile, JSON.stringify(f.config));
  await assert.rejects(startHttpBridge(f), /closed before readiness/);
  const ledger = events(path.join(f.out, 'lifecycle'));
  assert.ok(ledger.some(row => row.type === 'readiness-failed'));
  assert.ok(ledger.some(row => row.type === 'child-close'));
  assert.equal(evaluateLifecycle(ledger).status, 'FAIL');
});

test('installed MCP client 2 auto negotiation falls back in place on the same HTTP bridge', { skip: !enabled ? 'SDK prerequisite missing' : !clientRoot ? 'MCP client 2 not installed/configured; this negotiation check is unavailable' : false }, async t => {
  const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(clientRoot, 'dist/index.mjs')).href);
  const f = fixture(t, 'codefacts022'), owner = await startHttpBridge(f);
  t.after(() => owner.close());
  const client = new Client({ name: 'synthetic-client-2', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(owner.url));
  await client.connect(transport, { timeout: 5000 });
  assert.equal(client.getInstructions(), instructions);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'codefacts_explore'));
  assert.equal((await client.callTool({ name: 'codefacts_explore', arguments: { query: 'in-place' } })).content[0].text, 'synthetic result');
  await transport.terminateSession(); await client.close();
  const reconnected = new Client({ name: 'synthetic-client-2-reconnect', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  const reconnectedTransport = new StreamableHTTPClientTransport(new URL(owner.url));
  await reconnected.connect(reconnectedTransport, { timeout: 5000 });
  assert.deepEqual((await reconnected.listTools()).tools, (await connectCatalog(owner.url)));
  await reconnectedTransport.terminateSession(); await reconnected.close(); await owner.close();
  assert.equal(fs.readFileSync(path.join(f.tmp, 'starts.jsonl'), 'utf8').trim().split('\n').length, 1);
  const ledger = events(owner.directory);
  assert.ok(ledger.some(row => row.type === 'http-session-request' && row.details.method === 'server/discover'));
  assert.equal(ledger.filter(row => row.role === 'http-bridge-process' && row.type === 'child-started').length, 1);
  assert.equal(ledger.filter(row => row.role === 'native-stdio' && row.type === 'child-started').length, 1);
  assert.equal(evaluateLifecycle(ledger).status, 'PASS', JSON.stringify(evaluateLifecycle(ledger)));
});

async function connectCatalog(url) {
  const connection = await connect(url);
  try { return (await connection.client.listTools()).tools; }
  finally { await connection.close(); }
}
