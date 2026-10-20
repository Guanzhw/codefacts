import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLifecycle, observeChild } from '../../lifecycle.mjs';

// Cold preparation includes copy/hash passes and a full native map allowance.
// The DSH timer still starts in runDshAttempt, with its own controlled shutdown.
export const PREPARATION_ALLOWANCE_MS = 15 * 60_000;
export const SHUTDOWN_ALLOWANCE_MS = 30_000;
export const workerDeadlineMs = timeoutMs => PREPARATION_ALLOWANCE_MS + timeoutMs + SHUTDOWN_ALLOWANCE_MS;
const LOG_LIMIT = 64 * 1024;
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

/** Only the admitted child's PID/tree (Windows) or process group (POSIX) is signalled. */
async function terminateOwnedTree(child, scrub) {
  if (process.platform === 'win32') {
    return await new Promise(resolve => {
      const command = 'taskkill.exe', args = ['/PID', String(child.pid), '/T', '/F'];
      const killer = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', spawnError = null;
      killer.stdout.on('data', bytes => { stdout = (stdout + scrub(bytes)).slice(0, LOG_LIMIT); });
      killer.stderr.on('data', bytes => { stderr = (stderr + scrub(bytes)).slice(0, LOG_LIMIT); });
      killer.once('error', error => { spawnError = scrub(error.message); });
      killer.once('close', (code, signal) => resolve({ strategy: 'owned-pid-tree', pid: child.pid, command, args, code, signal, spawnError, stdout, stderr }));
    });
  }
  const signals = [];
  const signal = name => {
    try { process.kill(-child.pid, name); signals.push({ signal: name, sent: true }); }
    catch (error) { signals.push({ signal: name, sent: false, error: scrub(error.code ?? error.message) }); }
  };
  signal('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 2000));
  signal('SIGKILL');
  let groupStillExists = false;
  try { process.kill(-child.pid, 0); groupStillExists = true; } catch (error) { if (error.code !== 'ESRCH') groupStillExists = null; }
  return { strategy: 'owned-process-group', pid: child.pid, signals, groupStillExists };
}

/** The returned promise settles after child close AND any owned-tree cleanup. */
export async function startWorker({ node, script, args, out, deadlineMs, onMessage }) {
  fs.mkdirSync(out); // Exclusive worker identity; no implicit retry or overwrite.
  const lifecycle = createLifecycle({ directory: path.join(out, 'lifecycle'), role: 'cell-worker-process', context: { out: path.resolve(out) } });
  const startedAt = new Date().toISOString(), startedMs = performance.now();
  const secret = process.env.OPENCODE_API_KEY;
  const scrub = value => secret ? String(value).split(secret).join('[REDACTED]') : String(value);
  const logs = Object.fromEntries(['stdout', 'stderr'].map(name => [name, { fd: fs.openSync(path.join(out, name + '.log'), 'wx'), bytes: 0, droppedBytes: 0, pending: '' }]));
  const frames = [];
  let child, ownership, spawnError = null, timedOut = false, cleanup = null, bookkeepingError = null;
  const writeLog = (name, bytes, final = false) => {
    const log = logs[name];
    log.pending += bytes.toString();
    // Keep the possible credential prefix across pipe chunk boundaries.
    const keep = !final && secret ? secret.length - 1 : 0;
    let boundary = Math.max(0, log.pending.length - keep);
    if (secret) {
      const occurrence = log.pending.lastIndexOf(secret, boundary);
      if (occurrence >= 0 && occurrence + secret.length > boundary) boundary = occurrence;
    }
    const value = Buffer.from(scrub(log.pending.slice(0, boundary)));
    log.pending = log.pending.slice(boundary);
    const count = Math.min(value.length, LOG_LIMIT - log.bytes);
    if (count) fs.writeSync(log.fd, value.subarray(0, count));
    log.bytes += count; log.droppedBytes += value.length - count;
  };
  try {
    child = spawn(node, [script, ...args], { windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, TASK_BENCHMARK_WORKER_INSTANCE_ID: lifecycle.instanceId } });
    ownership = observeChild(child, lifecycle);
  } catch (error) { spawnError = scrub(error.message); lifecycle.event('spawn-error', { message: spawnError }); }
  let code = null, signal = null, closedAt = null, exitedAt = null, cleanupFinished = false, forcedPipeClose = null;
  if (child) {
    // Register close before bookkeeping: no start-receipt failure can release a live child.
    const closed = new Promise(resolve => child.once('close', (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; closedAt = new Date().toISOString(); resolve(); }));
    const closeExitedRootPipes = () => {
      if (!exitedAt || !cleanupFinished || closedAt || forcedPipeClose) return;
      // A vanished Windows root cannot be taskkilled again. An escaped child
      // may still hold its pipe handles; retain cleanup failure, stop capture,
      // and obtain the actual root close instead of holding the wave forever.
      forcedPipeClose = { at: new Date().toISOString(), reason: 'root-exited-but-output-pipes-remain-open-after-cleanup' };
      lifecycle.event('forced-pipe-close', { ...forcedPipeClose, unknownDescendants: true });
      child.stdout.destroy(); child.stderr.destroy();
    };
    child.once('exit', () => { exitedAt = new Date().toISOString(); closeExitedRootPipes(); });
    child.once('error', error => { spawnError = scrub(error.message); });
    child.stdout.on('data', bytes => writeLog('stdout', bytes));
    child.stderr.on('data', bytes => writeLog('stderr', bytes));
    child.on('message', frame => {
      if (frames.length < 16) frames.push({ receivedAt: new Date().toISOString(), frame });
      onMessage?.(frame);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      lifecycle.event('cleanup-requested', { reason: 'worker-deadline', deadlineMs });
      const termination = process.platform === 'win32' && exitedAt
        ? Promise.resolve({ strategy: 'owned-pid-tree', pid: child.pid, skipped: true, reason: 'root-exited-descendants-untracked' })
        : terminateOwnedTree(child, scrub);
      cleanup = termination.then(receipt => { lifecycle.event('cleanup-result', receipt); cleanupFinished = true; closeExitedRootPipes(); return receipt; });
    }, deadlineMs);
    try { save(path.join(out, 'start.json'), { pid: child.pid ?? null, controllerPid: process.pid, startedAt, deadlineMs }); }
    catch (error) { bookkeepingError = scrub(error.message); }
    await closed;
    clearTimeout(timer);
    if (cleanup) cleanup = await cleanup;
  }
  for (const [name, log] of Object.entries(logs)) { writeLog(name, '', true); fs.closeSync(log.fd); }
  const receipt = { instanceId: lifecycle.instanceId, lifecycleFile: lifecycle.file, pid: child?.pid ?? null, controllerPid: process.pid, startedAt, exitedAt, closedAt, forcedPipeClose, durationMs: performance.now() - startedMs,
    code, signal, spawnError, timedOut, deadlineMs, cleanup, bookkeepingError,
    logs: Object.fromEntries(Object.entries(logs).map(([name, { bytes, droppedBytes }]) => [name, { bytes, droppedBytes }])), frames };
  save(path.join(out, 'exit.json'), receipt);
  return receipt;
}
