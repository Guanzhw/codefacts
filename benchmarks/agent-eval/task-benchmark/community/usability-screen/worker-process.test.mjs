import test from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startWorker, workerDeadlineMs } from './worker-process.mjs';

assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Portable worker tests require Node.js 24 or newer');
assert.ok(['win32', 'linux'].includes(process.platform), 'Controlled worker fixtures support Windows and Linux; do not silently skip another platform');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fixture-worker.mjs');
const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-worker-' + process.platform + '-'));
console.log(`Evidence: ${suite}`);
const start = (label, mode, options = {}) => startWorker({ node: process.execPath, script: FIXTURE,
  args: [mode, path.join(suite, label + '-result.json')], out: path.join(suite, label), deadlineMs: 5000, ...options });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

test('a blocked preparation worker cannot starve sibling handshake or parent timer', async () => {
  let tickAt = null, handshakeAt = null;
  const timer = setTimeout(() => { tickAt = Date.now(); }, 100);
  const blocked = start('blocking', 'block');
  const sibling = start('sibling', 'sibling', { onMessage: frame => { if (frame.type === 'handshake') handshakeAt = Date.now(); } });
  const [blockingReceipt, siblingReceipt] = await Promise.all([blocked, sibling]);
  clearTimeout(timer);
  assert.equal(blockingReceipt.code, 0); assert.equal(siblingReceipt.code, 0);
  const ended = blockingReceipt.frames.find(x => x.frame.type === 'block-ended').frame.atMs;
  assert.ok(handshakeAt < ended, `sibling handshake ${handshakeAt} must precede blocking end ${ended}`);
  assert.ok(tickAt < ended, 'parent timer must fire during sibling synchronous work');
  assert.ok(Date.parse(siblingReceipt.closedAt) < ended, 'independent sibling closes during blocked prep');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(suite, 'sibling-result.json'))), { exact: null, duration: null, status: 'attempt-failed' });
});

test('child failure and spawn failure remain explicit and settle on close', async () => {
  const failed = await start('failed', 'fail');
  assert.equal(failed.code, 7); assert.equal(failed.timedOut, false); assert.ok(failed.closedAt);
  assert.match(fs.readFileSync(path.join(suite, 'failed', 'stderr.log'), 'utf8'), /deliberate failure/);
  const missing = await start('missing', 'sibling', { node: path.join(suite, 'missing-node.exe') });
  assert.ok(missing.spawnError); assert.ok(missing.closedAt); assert.equal(missing.timedOut, false);
});

test('a slot is retained until actual close even after a terminal IPC message', async () => {
  let readyAt;
  const receipt = await start('close-slot', 'block', { onMessage: frame => { if (frame.type === 'ready') readyAt = Date.now(); } });
  assert.ok(Date.parse(receipt.closedAt) - readyAt > 1000);
  assert.equal(alive(receipt.pid), false);
});

test('deadline kills only the owned worker tree, retains receipts and waits for close', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const unrelatedClosed = new Promise(resolve => unrelated.once('close', resolve));
  try {
    const receipt = await start('deadline-tree', 'descendant', { deadlineMs: 700 });
    const descendant = Number(fs.readFileSync(path.join(suite, 'deadline-tree-result.json'), 'utf8'));
    assert.equal(receipt.timedOut, true); assert.ok(receipt.closedAt); assert.ok(receipt.cleanup);
    assert.equal(alive(receipt.pid), false); assert.equal(alive(descendant), false);
    assert.equal(alive(unrelated.pid), true);
    if (process.platform === 'win32') {
      assert.deepEqual(receipt.cleanup.args, ['/PID', String(receipt.pid), '/T', '/F']);
      assert.equal(receipt.cleanup.code, 0);
    } else assert.equal(receipt.cleanup.strategy, 'owned-process-group');
  } finally { unrelated.kill(); await unrelatedClosed; }
});

test('stdout/stderr stay bounded and inherited credential is scrubbed', async () => {
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'fixture-secret-no-provider-call';
  try {
    const receipt = await start('logs', 'logs');
    for (const stream of ['stdout', 'stderr']) {
      const bytes = fs.readFileSync(path.join(suite, 'logs', stream + '.log'));
      assert.ok(bytes.length <= 65536); assert.ok(receipt.logs[stream].droppedBytes > 0);
      assert.ok(!bytes.includes(Buffer.from('fixture-secret-no-provider-call')));
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previous;
  }
});

test('an exited root with an escaped pipe holder settles as explicit timeout after forced pipe close', async () => {
  let descendant;
  try {
    const receipt = await start('escaped-pipe', 'escaped-pipe', { deadlineMs: 700 });
    descendant = Number(fs.readFileSync(path.join(suite, 'escaped-pipe-result.json'), 'utf8'));
    assert.ok(receipt.exitedAt); assert.ok(receipt.closedAt); assert.equal(receipt.code, 0);
    assert.equal(receipt.timedOut, true); assert.ok(receipt.forcedPipeClose);
    assert.ok(receipt.durationMs < 5000, 'escaped pipe cannot hold the supervisor indefinitely');
    assert.equal(alive(receipt.pid), false); assert.equal(alive(descendant), true, 'escape remains an explicit cleanup limitation');
    if (process.platform === 'win32') {
      assert.equal(receipt.cleanup.skipped, true);
      assert.equal(receipt.cleanup.reason, 'root-exited-descendants-untracked');
      assert.equal(receipt.cleanup.command, undefined, 'a known exited root PID must never be signalled after possible reuse');
    }
    else assert.ok(receipt.cleanup.signals.some(row => row.sent === false));
  } finally {
    if (descendant && alive(descendant)) process.kill(descendant);
  }
});

test('exclusive identity prevents automatic retry and screen deadline retains full DSH allowance', async () => {
  await assert.rejects(start('sibling', 'sibling'), /EEXIST/);
  assert.equal(workerDeadlineMs(360000), 1290000);
  assert.ok(workerDeadlineMs(360000) > 2 * 360000);
});
