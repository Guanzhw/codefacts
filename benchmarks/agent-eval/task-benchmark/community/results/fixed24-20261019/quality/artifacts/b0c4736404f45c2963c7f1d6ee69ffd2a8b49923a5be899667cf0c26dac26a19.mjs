import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

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

export async function connectNative(sdk, config, evidenceDir, signal) {
  const client = new sdk.Client({ name: 'task-benchmark-native', version: '1' }, { capabilities: {} });
  const transport = new sdk.StdioClientTransport({ ...config, stderr: 'pipe' });
  const context = new AsyncLocalStorage();
  const calls = new Map();
  let closed;
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
    start: () => transport.start(),
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
  transport.onclose = () => wire.onclose?.();
  async function close() {
    closed ??= (async () => {
      try { await client.close(); }
      finally {
        await transport.close();
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
    const metadata = { config, pid: transport.pid, serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities(),
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
    writeJson(path.join(evidenceDir, 'native-startup-error.json'), { message: error.message, config, pid: transport.pid });
    try { await close(); } catch (cleanupError) { console.error(`Native cleanup failed: ${cleanupError.message}`); }
    throw error;
  }
}
