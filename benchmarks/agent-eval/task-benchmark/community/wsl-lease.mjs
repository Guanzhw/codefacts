import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeJson } from '../rpc.mjs';

// An open foreground WSL client keeps the distro available while the model and
// native navigation run on Windows. The shell becomes cat, so closing our stdin
// releases the Linux process naturally after the owned container is removed.
export async function createWslLease(runtime, evidenceFile, { spawnProcess = spawn, startupTimeoutMs = 30000, closeTimeoutMs = 5000 } = {}) {
  const leaseId = randomUUID(), distro = runtime.wslDistro ?? 'Ubuntu';
  const args = ['-d', distro, '-u', 'root', '--exec', '/bin/sh', '-c', `printf 'READY ${leaseId} %s\\n' "$$"; exec cat >/dev/null`];
  const receipt = { leaseId, distro, command: runtime.wsl, args, startedAt: new Date().toISOString(), status: 'starting', wslClientPid: null, linuxPid: null, readyAt: null, closeRequestedAt: null, closedAt: null, code: null, signal: null, stderr: '', failures: [] };
  const persist = () => { if (evidenceFile) writeJson(evidenceFile, receipt); };
  const fail = message => { if (!receipt.failures.includes(message)) receipt.failures.push(message); receipt.status = 'failed'; persist(); };
  persist();
  let child;
  try { child = spawnProcess(runtime.wsl, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { fail(`WSL lease spawn failed: ${error.message}`); throw error; }
  receipt.wslClientPid = child.pid ?? null; persist();
  let closing = false, ended = false, closePromise, stdout = '';
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      ended = true;
      Object.assign(receipt, { closedAt: new Date().toISOString(), code, signal });
      if (!closing) fail(`WSL lease exited before release (code=${code}, signal=${signal})`);
      else if (code !== 0) fail(`WSL lease exit failed (code=${code}, signal=${signal})`);
      if (!receipt.readyAt) readyReject(new Error(receipt.failures.join('; ') || 'WSL lease exited before readiness'));
      receipt.status = receipt.failures.length ? 'failed' : 'closed'; persist(); resolve();
    });
  });
  child.once('error', error => { fail(`WSL lease process failed: ${error.message}`); readyReject(error); });
  child.stdin.on('error', error => { fail(`WSL lease stdin failed: ${error.message}`); readyReject(error); });
  child.stderr.on('data', chunk => { receipt.stderr = (receipt.stderr + chunk).slice(-16384); });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    const match = stdout.match(new RegExp(`^READY ${leaseId} ([0-9]+)\\r?\\n`));
    if (match && !receipt.readyAt) {
      Object.assign(receipt, { linuxPid: Number(match[1]), readyAt: new Date().toISOString(), status: 'ready' }); persist(); readyResolve();
    }
  });
  const assertAlive = () => {
    if (receipt.failures.length || ended || closing) throw new Error(receipt.failures.join('; ') || 'WSL lease is no longer active');
  };
  const close = () => closePromise ??= (async () => {
    closing = true; receipt.closeRequestedAt = new Date().toISOString();
    if (!receipt.failures.length) receipt.status = 'closing'; persist();
    if (!ended) {
      child.stdin.end();
      const timer = setTimeout(() => {
        fail('WSL lease did not exit after stdin EOF; terminating owned WSL client');
        receipt.ownedClientKillSent = child.kill(); persist();
      }, closeTimeoutMs);
      try { await closed; } finally { clearTimeout(timer); }
    }
    if (receipt.failures.length) throw new Error(receipt.failures.join('; '));
    return receipt;
  })();
  const timer = setTimeout(() => { const message = 'WSL lease readiness timed out'; fail(message); readyReject(new Error(message)); }, startupTimeoutMs);
  try { await ready; assertAlive(); }
  catch (error) {
    try { await close(); } catch (closeError) { throw new AggregateError([error, closeError], `${error.message}; ${closeError.message}`); }
    throw error;
  } finally { clearTimeout(timer); }
  return { assertAlive, close, receipt };
}
