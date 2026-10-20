import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Resolve or reject only on child close, including spawn/bookkeeping failures. */
export function startWorker({ node, script, args, out, label, details = {} }) {
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const log = fs.openSync(path.join(out, label + '.log'), 'wx'), startedAt = new Date().toISOString();
  let child;
  try { child = spawn(node, [script, ...args], { windowsHide: true, shell: false, stdio: ['ignore', log, log] }); }
  catch (error) { fs.closeSync(log); throw error; }
  let bookkeepingError = null;
  try { write(path.join(out, label + '-start.json'), { pid: child.pid ?? null, controllerPid: process.pid, node, startedAt, ...details }); }
  catch (error) { bookkeepingError = error; }
  return new Promise((resolve, reject) => {
    let spawnError = null;
    child.once('error', error => { spawnError = error.stack ?? error.message; });
    child.once('close', (code, signal) => {
      let exitWriteError = null;
      const finishedAt = new Date().toISOString();
      try { write(path.join(out, label + '-exit.json'), { code, signal, spawnError, startedAt, finishedAt, bookkeepingError: bookkeepingError?.stack ?? null }); }
      catch (error) { exitWriteError = error; }
      finally { try { fs.closeSync(log); } catch (error) { exitWriteError ??= error; } }
      if (bookkeepingError || exitWriteError || code !== 0 || signal !== null || spawnError) reject(bookkeepingError ?? exitWriteError ?? new Error(label + ' failed; drain all workers before review'));
      else resolve({ code, signal, startedAt, finishedAt });
    });
  });
}
