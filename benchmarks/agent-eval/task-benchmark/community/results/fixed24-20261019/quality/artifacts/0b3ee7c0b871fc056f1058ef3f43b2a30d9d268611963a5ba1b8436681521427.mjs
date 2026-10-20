import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function normalizeReport(kind, report, instanceId) {
  if (!object(report)) throw new Error('Official report must be a JSON object');
  if (kind === 'swe') {
    const id = instanceId ?? (Object.keys(report).length === 1 ? Object.keys(report)[0] : null);
    if (!id || !object(report[id]) || typeof report[id].resolved !== 'boolean') {
      throw new Error('Official per-instance SWE report requires a boolean resolved field');
    }
    if (report[id].infra_failure === true) return { resolved: null, metrics: null,
      instanceId: id, infrastructureFailure: report[id].infra_failure_reason ?? 'official-infrastructure-failure' };
    return { resolved: report[id].resolved, metrics: null, instanceId: id };
  }
  if (report.kind !== 'context' || typeof report.instance_id !== 'string' ||
      (instanceId !== undefined && instanceId !== report.instance_id)) throw new Error('Context instance identity mismatch');
  const result = report.officialResult;
  if (!object(result) || result.error || result.instance_id !== report.instance_id ||
      !object(result.final) || !object(result.trajectory) ||
      !object(result.trajectory.auc_coverage) || !object(result.trajectory.redundancy)) {
    throw new Error('Missing official ContextBench metrics');
  }
  if (!object(report.semantics)) throw new Error('Context metric semantics are missing');
  return { resolved: null, metrics: { localization: result.final, explored: result.trajectory,
    editloc: null, semantics: report.semantics }, instanceId: report.instance_id };
}

/** Trusted operator command, argument array, and one fresh grader output namespace. */
export async function runOfficialGrade({ kind, command, args = [], outputDir, resultPath,
  instanceId, timeoutMs = 30 * 60 * 1000, cwd, env = {} }) {
  if (!['context', 'swe'].includes(kind) || typeof command !== 'string' || !command ||
      !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Invalid official grader command');
  if (!path.isAbsolute(outputDir) || !path.isAbsolute(resultPath)) throw new Error('Absolute grader output paths required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Positive grader timeoutMs required');
  if (fs.existsSync(resultPath)) throw new Error('Refusing an existing official result; allocate a fresh grader run');
  fs.mkdirSync(outputDir, { recursive: true });
  const stdoutPath = path.join(outputDir, 'grader-stdout.log'), stderrPath = path.join(outputDir, 'grader-stderr.log');
  const stdout = fs.openSync(stdoutPath, 'wx');
  let stderr;
  try { stderr = fs.openSync(stderrPath, 'wx'); } catch (error) { fs.closeSync(stdout); throw error; }
  // Evaluation needs no model-provider credentials. Explicit operator env values are
  // useful for Docker endpoints and task-local Python paths; receipts store keys only.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:API.?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|CREDENTIAL)/i.test(key)));
  const startedAt = new Date().toISOString(), start = performance.now();
  let timedOut = false, processError = null, timer;
  let child;
  try {
    child = spawn(command, args, { cwd, env: { ...inherited, HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
      PYTHONDONTWRITEBYTECODE: '1', ...env }, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => fs.writeSync(stdout, bytes));
    child.stderr.on('data', bytes => fs.writeSync(stderr, bytes));
    child.on('error', error => { processError = error.message; });
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);
    const processExit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const receipt = { kind, command, args, cwd: cwd ?? null, environmentKeys: Object.keys(env).sort(),
      startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - start,
      processExit, processError, timedOut, stdoutPath, stderrPath, resultPath };
    let status = timedOut ? 'timed-out' : processError || processExit.code !== 0 ? 'failed' : 'completed';
    let normalized = { resolved: null, metrics: null };
    if (status === 'completed') {
      if (!fs.existsSync(resultPath)) status = 'missing-report';
      else {
        const bytes = fs.readFileSync(resultPath);
        receipt.resultSha256 = sha256(bytes);
        try { normalized = normalizeReport(kind, JSON.parse(bytes.toString('utf8')), instanceId); }
        catch (error) { status = 'invalid-report'; receipt.reportError = error.message; }
        if (normalized.infrastructureFailure) { status = 'failed'; receipt.officialInfrastructureFailure = normalized.infrastructureFailure; }
      }
    }
    const result = { status, resolved: normalized.resolved, metrics: normalized.metrics, receipt };
    fs.writeFileSync(path.join(outputDir, 'grader-receipt.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
  } finally {
    clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr);
  }
}
