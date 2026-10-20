import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { connectNative } from './rpc.mjs';
import { evaluateLifecycle } from './lifecycle.mjs';

function fixture(t, { emitClose = true, delay = 0, failAt = null } = {}) {
  const directory = fs.mkdtempSync(path.join(process.env.TASK_BENCHMARK_CALIBRATION_DIR ?? os.tmpdir(), 'rpc-lifecycle-'));
  if (!process.env.TASK_BENCHMARK_CALIBRATION_DIR) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let transport, closeCalls = 0, scheduled = false;
  class Transport {
    constructor() { transport = this; this.stderr = new PassThrough(); this.pid = 731; }
    async start() { if (failAt === 'start') throw new Error('synthetic start failure'); }
    async close() {
      closeCalls++;
      this.pid = null;
      if (!scheduled && emitClose && failAt !== 'start') { scheduled = true; setTimeout(() => this.onclose?.(), delay); }
    }
    async send() {}
  }
  class Client {
    async connect(wire) { this.wire = wire; await wire.start(); if (failAt === 'initialize') throw new Error('synthetic initialize failure'); }
    async close() { await this.wire.close(); }
    async listTools() { if (failAt === 'list') throw new Error('synthetic list failure'); return { tools: [] }; }
    getServerVersion() { return { name: 'synthetic', version: '1' }; }
    getServerCapabilities() { return {}; }
    getInstructions() { return undefined; }
  }
  return { directory, sdk: { Client, StdioClientTransport: Transport }, get transport() { return transport; }, get closeCalls() { return closeCalls; },
    events() { return fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').map(JSON.parse)); } };
}
const config = { command: 'synthetic-no-process', args: [], cwd: 'synthetic' };

test('native close waits actual public close after close promise returns, repeated close shares work', async t => {
  const f = fixture(t, { delay: 35 });
  const native = await connectNative(f.sdk, config, f.directory, undefined, { directory: f.directory, closeTimeoutMs: 500 });
  assert.equal(native.metadata.pid, 731);
  await Promise.all([native.close(), native.close()]);
  const rows = f.events(), returned = rows.find(row => row.type === 'close-returned'), close = rows.find(row => row.type === 'child-close');
  assert.equal(returned.details.observedClose, false);
  assert.ok(close.seq > returned.seq);
  assert.equal(close.details.pid, 731);
  assert.equal(close.details.code, null); assert.equal(close.details.signal, null); assert.equal(close.details.terminationEscalated, null);
  assert.equal(rows.filter(row => row.type === 'close-requested').length, 1);
  assert.equal(evaluateLifecycle(rows).status, 'PASS');
});

test('native close promise without close event remains UNKNOWN and throws', async t => {
  const f = fixture(t, { emitClose: false });
  const native = await connectNative(f.sdk, config, f.directory, undefined, { directory: f.directory, closeTimeoutMs: 15 });
  await assert.rejects(native.close(), /without observed child close/);
  assert.equal(evaluateLifecycle(f.events()).status, 'UNKNOWN');
});

for (const failAt of ['start', 'initialize', 'list']) test(`native ${failAt} failure retains primary error and cleanup evidence`, async t => {
  const f = fixture(t, { failAt });
  await assert.rejects(connectNative(f.sdk, config, f.directory, undefined, { directory: f.directory, closeTimeoutMs: 500 }), new RegExp(`synthetic ${failAt} failure`));
  if (failAt !== 'start') assert.ok(f.events().some(row => row.type === 'child-close'));
  else assert.ok(f.events().some(row => row.type === 'spawn-error'));
  assert.match(fs.readFileSync(path.join(f.directory, 'native-startup-error.json'), 'utf8'), /synthetic/);
});
