import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWslLease } from './wsl-lease.mjs';
import { startSandbox } from './campaign.mjs';

function fixture(t, mode = 'normal') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const evidenceFile = path.join(dir, 'lease.json'), eofFile = path.join(dir, 'eof.json');
  const runtime = { wsl: 'fixture-wsl.exe', wslDistro: 'fixture-distro' };
  let child, invocation;
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options };
    const leaseId = args.at(-1).match(/READY ([a-f0-9-]+)/)[1];
    child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const [mode, leaseId, eofFile] = process.argv.slice(1);
      if (mode === 'startup-exit') { process.stderr.write('fixture startup failure'); process.exit(7); }
      if (mode !== 'no-ready') process.stdout.write('READY ' + leaseId + ' ' + process.pid + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => { fs.writeFileSync(eofFile, JSON.stringify({ pid: process.pid, eof: true })); });
      if (mode === 'early-exit') setTimeout(() => process.exit(9), 60);
      if (mode === 'hang-on-eof') setInterval(() => {}, 1000);
    `, mode, leaseId, eofFile], options);
    return child;
  };
  return { runtime, evidenceFile, eofFile, options: { spawnProcess, startupTimeoutMs: 2000, closeTimeoutMs: 200 }, get child() { return child; }, get invocation() { return invocation; }, read: () => JSON.parse(fs.readFileSync(evidenceFile)) };
}

test('foreground lease is ready before return, remains alive, and exits naturally on stdin EOF', async t => {
  const f = fixture(t), lease = await createWslLease(f.runtime, f.evidenceFile, f.options);
  const before = f.read();
  assert.deepEqual(f.invocation.args.slice(0, 7), ['-d', 'fixture-distro', '-u', 'root', '--exec', '/bin/sh', '-c']);
  assert.match(f.invocation.args[7], /exec cat >\/dev\/null$/);
  assert.equal(f.invocation.command, 'fixture-wsl.exe');
  assert.deepEqual(f.invocation.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(f.invocation.options.windowsHide, true);
  assert.equal(before.status, 'ready'); assert.equal(before.wslClientPid, f.child.pid); assert.equal(before.linuxPid, f.child.pid);
  assert.ok(before.startedAt <= before.readyAt); assert.equal(before.closedAt, null); assert.equal(before.leaseId.length, 36);
  assert.equal(f.child.exitCode, null); lease.assertAlive();
  const closed = await lease.close();
  assert.equal(closed.code, 0); assert.equal(closed.signal, null); assert.equal(closed.status, 'closed');
  assert.ok(closed.closedAt >= closed.closeRequestedAt); assert.equal(closed.ownedClientKillSent, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.eofFile)), { pid: before.linuxPid, eof: true });
  assert.equal(await lease.close(), closed);
});

test('startup process failure is explicit and retains its exit and stderr evidence', async t => {
  const f = fixture(t, 'startup-exit');
  await assert.rejects(createWslLease(f.runtime, f.evidenceFile, f.options), /WSL lease exited before release/);
  const receipt = f.read();
  assert.equal(receipt.code, 7); assert.equal(receipt.status, 'failed'); assert.equal(receipt.readyAt, null);
  assert.match(receipt.stderr, /fixture startup failure/); assert.ok(receipt.closedAt);
});

test('readiness timeout closes stdin and waits for the owned child to exit', async t => {
  const f = fixture(t, 'no-ready');
  await assert.rejects(createWslLease(f.runtime, f.evidenceFile, { ...f.options, startupTimeoutMs: 200 }), /WSL lease readiness timed out/);
  const receipt = f.read();
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.code, 0); assert.ok(receipt.closedAt);
  assert.equal(JSON.parse(fs.readFileSync(f.eofFile)).eof, true);
});

test('an exit after readiness fails the lease and cannot be mistaken for successful release', async t => {
  const f = fixture(t, 'early-exit'), lease = await createWslLease(f.runtime, f.evidenceFile, f.options);
  await once(f.child, 'close');
  assert.throws(() => lease.assertAlive(), /WSL lease exited before release/);
  await assert.rejects(lease.close(), /WSL lease exited before release/);
  assert.equal(f.read().code, 9); assert.equal(f.read().status, 'failed');
});

test('a child that ignores EOF is terminated through its owned handle and release fails', async t => {
  const f = fixture(t, 'hang-on-eof'), lease = await createWslLease(f.runtime, f.evidenceFile, f.options);
  await assert.rejects(lease.close(), /did not exit after stdin EOF/);
  const receipt = f.read();
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.ownedClientKillSent, true); assert.ok(receipt.closedAt);
  assert.equal(JSON.parse(fs.readFileSync(f.eofFile)).eof, true);
});

test('sandbox startup and container cleanup failures release their actual foreground child', async t => {
  for (const failure of ['run', 'rm']) await t.test(failure, async t => {
    const f = fixture(t), manifest = { campaignId: 'fixture', runtime: f.runtime };
    const run = async (_command, args) => ({ code: args[6] === failure ? 1 : 0, stdout: '', stderr: 'fixture Docker failure' });
    const leaseFactory = (runtime, evidenceFile) => createWslLease(runtime, evidenceFile, f.options);
    const start = () => startSandbox(manifest, { sandbox: { image: 'fixture-image' } }, 'D:/attempt/source', { id: failure }, path.dirname(f.evidenceFile), run, leaseFactory);
    if (failure === 'run') await assert.rejects(start(), /Sandbox startup failed/);
    else { const sandbox = await start(); await assert.rejects(sandbox.cleanup(), /Owned sandbox cleanup failed/); }
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(f.evidenceFile), 'wsl-lease.json')));
    assert.equal(receipt.status, 'closed'); assert.equal(receipt.code, 0); assert.ok(receipt.closedAt);
    assert.equal(JSON.parse(fs.readFileSync(f.eofFile)).eof, true);
  });
});
