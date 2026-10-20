import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createLifecycle } from './lifecycle.mjs';

export const hash = value => createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

// Resolve the existing SDK explicitly; importing this module starts no process.
export function loadSdk(sdkRoot) {
  const require = createRequire(path.join(sdkRoot, 'package.json'));
  return {
    ...require(path.join(sdkRoot, 'dist/cjs/client/index.js')),
    ...require(path.join(sdkRoot, 'dist/cjs/client/stdio.js')),
    ...require(path.join(sdkRoot, 'dist/cjs/server/index.js')),
    ...require(path.join(sdkRoot, 'dist/cjs/server/stdio.js')),
    ...require(path.join(sdkRoot, 'dist/cjs/server/streamableHttp.js')),
    ...require(path.join(sdkRoot, 'dist/cjs/client/streamableHttp.js')),
    ...require(path.join(sdkRoot, 'dist/cjs/types.js')),
    Ajv: require('ajv'),
  };
}

export function checkedFlags(env = {}) {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error('native env must contain string flags');
    if (/secret|token|password|credential|api.?key|authorization|private.?key|(?:^|_)(?:key|auth|cookie)(?:_|$)/i.test(key)) throw new Error(`Secret-bearing native env is unsupported: ${key}`);
  }
  return env;
}

export async function connectNative(sdk, config, evidenceDir, signal, lifecycleOptions) {
  const client = new sdk.Client({ name: 'task-benchmark-native', version: '1' }, { capabilities: {} });
  const transport = new sdk.StdioClientTransport({ ...config, stderr: 'pipe' });
  const context = new AsyncLocalStorage();
  const calls = new Map();
  let closed;
  const lifecycle = lifecycleOptions && createLifecycle({ ...lifecycleOptions, role: 'native-stdio' });
  let nativePid = null, observedClose = false, started = false;
  let resolveClose;
  const actualClose = new Promise(resolve => { resolveClose = resolve; });
  const stderrFile = path.join(evidenceDir, 'native-stderr.log');
  fs.writeFileSync(stderrFile, '');
  transport.stderr.on('data', chunk => { fs.appendFileSync(stderrFile, chunk); });
  const wireLog = path.join(evidenceDir, 'native-wire.jsonl');
  function record(direction, message) {
    const serialized = JSON.stringify(message);
    const entry = { direction, bytes: Buffer.byteLength(serialized), sha256: hash(serialized), message };
    fs.appendFileSync(wireLog, JSON.stringify(entry) + '\n');
    return entry;
  }
  const wire = {
    async start() {
      try {
        await transport.start(); started = true; nativePid = transport.pid;
        lifecycle?.event('child-started', { pid: nativePid, evidence: 'public-stdio-transport-start' });
      } catch (error) { lifecycle?.event('spawn-error', { message: error.message }); throw error; }
    },
    close: () => transport.close(),
    async send(message) {
      const request = record('request', message);
      const receipt = context.getStore();
      if (receipt && message.method === 'tools/call') { receipt.request = request; calls.set(message.id, receipt); }
      return transport.send(message);
    },
  };
  transport.onmessage = message => {
    const entry = record('response', message);
    const receipt = calls.get(message.id);
    if (receipt) { receipt.response = entry; calls.delete(message.id); }
    wire.onmessage?.(message);
  };
  transport.onerror = error => wire.onerror?.(error);
  transport.onclose = () => {
    observedClose = true;
    lifecycle?.event('child-close', { pid: nativePid, code: null, signal: null, terminationEscalated: null, evidence: 'public-stdio-transport-onclose' });
    resolveClose(); wire.onclose?.();
  };
  async function close() {
    closed ??= (async () => {
      lifecycle?.event('close-requested');
      try { await client.close(); }
      finally {
        await transport.close();
        lifecycle?.event('close-returned', { observedClose });
        if (lifecycle && started && !observedClose) {
          let timer;
          try { await Promise.race([actualClose, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native close returned without observed child close within teardown allowance')), lifecycleOptions.closeTimeoutMs ?? 10_000); })]); }
          catch (error) { lifecycle.event('close-await-timeout', { message: error.message }); throw error; }
          finally { clearTimeout(timer); }
        }
        signal?.removeEventListener('abort', abort);
      }
    })();
    return closed;
  }
  const abort = () => { void close().catch(error => console.error(`Native cleanup failed: ${error.message}`)); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect(wire, { timeout: 60_000 });
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 60_000 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const metadata = { config, pid: nativePid, ...(lifecycle ? { instanceId: lifecycle.instanceId } : {}), serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions() ?? null, tools, instructionPolicy: 'Native server instructions and tool descriptions retained verbatim by bridge.' };
    writeJson(path.join(evidenceDir, 'native-metadata.json'), metadata);
    return {
      client, tools, metadata, close,
      async callTool(params, receipt) {
        const result = await context.run(receipt, () => client.callTool(params, undefined, { timeout: 60_000 }));
        // Preserve the actual native payload, including extension fields accepted by MCP.
        return receipt.response?.message.result ?? result;
      },
    };
  } catch (error) {
    lifecycle?.event('startup-failed', { message: error.message, pid: nativePid });
    writeJson(path.join(evidenceDir, 'native-startup-error.json'), { message: error.message, config, pid: transport.pid });
    try { await close(); } catch (cleanupError) { console.error(`Native cleanup failed: ${cleanupError.message}`); }
    throw error;
  }
}
