import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLifecycle, observeChild } from './lifecycle.mjs';

async function within(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

/** The caller owns this exact child handle before awaiting readiness. */
export async function startHttpBridge({ configFile, out, nodeCommand = process.execPath,
  parentInstanceId = null, context = {}, startupTimeoutMs = 60_000, closeTimeoutMs = 15_000,
  entry = fileURLToPath(new URL('./http-bridge.mjs', import.meta.url)) }) {
  fs.mkdirSync(out, { recursive: true });
  const directory = path.join(out, 'lifecycle');
  const lifecycle = createLifecycle({ directory, role: 'http-bridge-process', parentInstanceId, context });
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const ownedConfig = path.join(out, 'http-config.json');
  fs.writeFileSync(ownedConfig, JSON.stringify({ ...config, lifecycle: { directory, parentInstanceId: lifecycle.instanceId, context } }, null, 2), { flag: 'wx' });
  const child = spawn(nodeCommand, [entry, '--config', ownedConfig], { cwd: config.root, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ownership = observeChild(child, lifecycle);
  const logs = ['stdout', 'stderr'].map(name => {
    const stream = fs.createWriteStream(path.join(out, `${name}.log`), { flags: 'wx' }); child[name].pipe(stream); return stream;
  });
  let closeTask, closeObserved = false;
  ownership.closed.then(() => { closeObserved = true; });
  async function close() {
    closeTask ??= (async () => {
      lifecycle.event('close-requested');
      if (!closeObserved && child.connected) child.send({ type: 'http-bridge-shutdown' }, error => {
        if (error) lifecycle.event('shutdown-send-error', { message: error.message });
      });
      try { await within(ownership.closed, closeTimeoutMs, 'HTTP bridge did not close within teardown allowance'); }
      catch (error) {
        lifecycle.event('close-await-timeout', { message: error.message });
        ownership.requestKill('SIGTERM', 'http-bridge-close-timeout');
        try { await within(ownership.closed, 2000, 'HTTP bridge still open after termination'); }
        catch {
          ownership.requestKill('SIGKILL', 'http-bridge-kill-escalation');
          try { await within(ownership.closed, 2000, 'HTTP bridge still open after SIGKILL'); }
          catch (failure) {
            lifecycle.event('forced-pipe-close', { reason: 'bridge-output-pipes-open-after-cleanup', unknownDescendants: true });
            child.stdout.destroy(); child.stderr.destroy(); child.disconnect?.();
            await within(ownership.closed, 2000, failure.message);
          }
        }
      }
      await Promise.all(logs.map(stream => stream.closed ? undefined : new Promise(resolve => stream.once('close', resolve))));
      lifecycle.event('close-returned', { observedClose: closeObserved });
      return lifecycle.snapshot();
    })();
    return closeTask;
  }
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message?.type === 'http-bridge-ready') { lifecycle.event('readiness-observed', { url: message.url }); resolve(message.url); }
    });
    ownership.closed.then(() => reject(new Error('HTTP bridge closed before readiness')));
    child.once('error', reject);
  });
  try {
    const url = await within(ready, startupTimeoutMs, 'HTTP bridge readiness timed out');
    return { url, close, lifecycle, child, directory };
  } catch (error) {
    lifecycle.event('readiness-failed', { message: error.message });
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'HTTP bridge startup and cleanup failed'); }
    throw error;
  }
}
