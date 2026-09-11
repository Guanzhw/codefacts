#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const repo = resolve('D:/WorkSpace/codefacts');
const base = 'C:/Users/QQ110/.codex/visualizations/2026/09/10/01a08ba7-0ca2-72b2-82a0-178d382c195f';
const tokenEval = `${base}/token-eval`;
const outDefault = `${base}/callsite-diagnostic-2026-09-12`;
const runner = resolve(repo, 'benchmarks/agent-eval/runner.mjs');
const driver = resolve(repo, 'benchmarks/agent-eval/callsite-diagnostic.mjs');
const codex = 'C:/Users/QQ110/AppData/Local/OpenAI/Codex/bin/7ac07f4ce733f89a/codex.exe';
const taskPrompt = 'After editing a source file, parsing succeeds but relationship extraction fails. Which previous facts remain queryable, and how does an MCP caller learn that the index is incomplete? Explain the behavior and cite source and regression coverage.';
const intervention = 'When a definition excerpt does not cover the needed behavior, use the returned production call-site locations to read a bounded source window and trace the result into its caller. Stop reading once the question and regression coverage are supported.';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const fileSha = async (path) => sha(await readFile(path));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const writeNew = async (path, value) => {
  await writeFile(path, typeof value === 'string' ? value : json(value), { encoding: 'utf8', flag: 'wx' });
};
async function auditSnapshot(outDir, label) {
  const auditPath = join(outDir, `source-audit-${label}.json`);
  const child = spawn('python', [`${base}/improvement-cycle-2/audit-snapshots.py`, tokenEval, auditPath], { stdio: 'ignore', windowsHide: true });
  const code = await new Promise((done) => child.once('close', done));
  if (code !== 0) throw new Error(`source snapshot audit failed (${label}): ${code}`);
  const report = JSON.parse(await readFile(auditPath, 'utf8'));
  if (report.snapshots.some((entry) => entry.changedFiles?.length)) throw new Error(`source snapshot changed (${label})`);
  return report;
}
const args = process.argv.slice(2);
const mode = args[0];
const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] || fallback : fallback; };

async function prepare(outDir) {
  if (existsSync(outDir)) throw new Error(`refusing to overwrite existing output directory: ${outDir}`);
  const rawPath = join(base, 'retrieval-diagnosis', 'retrieval-replay-full-response.json');
  const raw = JSON.parse(await readFile(rawPath, 'utf8'));
  const record = raw.records?.find((entry) => entry.repository === 'codefacts');
  const response = record?.messages?.find((entry) => entry.id === 14)?.result?.content?.[0]?.text;
  if (typeof response !== 'string') throw new Error('archived response ID14 text not found');
  const task = { id: 'extraction_failure', root: `${tokenEval}/repos/codefacts`, prompt: `${taskPrompt}\n\nSupplied prior navigation result:\n${response}` };
  await mkdir(join(outDir, 'manifests'), { recursive: true });
  await mkdir(join(outDir, 'results'), { recursive: true });
  await writeNew(join(outDir, 'task.json'), task);
  await writeNew(join(outDir, 'shared-text.txt'), response);
  const manifestBase = { runs: 1, codexBin: codex, tasks: [task] };
  await writeNew(join(outDir, 'manifests', 'control.json'), { ...manifestBase, arms: [{ id: 'control', configOverrides: ['windows.sandbox="elevated"'] }], guidance: '' });
  await writeNew(join(outDir, 'manifests', 'callsite.json'), { ...manifestBase, arms: [{ id: 'callsite', configOverrides: ['windows.sandbox="elevated"'] }], guidance: intervention });
  await auditSnapshot(outDir, 'before');
  const sourceArchive = {};
  for (const name of ['codefacts', 'opensession']) sourceArchive[name] = await fileSha(join(tokenEval, `${name}.tar`));
  const manifestHashes = { control: await fileSha(join(outDir, 'manifests', 'control.json')), callsite: await fileSha(join(outDir, 'manifests', 'callsite.json')) };
  await writeNew(join(outDir, 'receipt.json'), {
    schemaVersion: 1, status: 'prepared', createdAt: new Date().toISOString(), order: [['A1', 'control'], ['B1', 'callsite'], ['B2', 'callsite'], ['A2', 'control']], maxProcesses: 4, stopTokenThreshold: 1500000,
    hashes: { runner: await fileSha(runner), rawresponse: await fileSha(rawPath), task: await fileSha(join(outDir, 'task.json')), sharedtext: await fileSha(join(outDir, 'shared-text.txt')), CLI: await fileSha(codex), sourcearchive: sourceArchive, manifests: manifestHashes, driver: await fileSha(driver) },
    pinned: { runner, rawResponse: rawPath, taskSource: `${repo}/benchmarks/agent-eval/value-screen-results.json`, snapshot: task.root, codex },
  });
  process.stdout.write(`${json({ status: 'prepared', outputDir: outDir, receipt: join(outDir, 'receipt.json') })}`);
}

function runRunner(manifestPath, outputDir, arm) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [runner, '--manifest', manifestPath, '--output-dir', outputDir, '--task', 'extraction_failure', '--arm', arm, '--timeout-ms', '180000'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk))); child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => done({ exitCode: null, error: error.message, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    child.once('close', (exitCode, signal) => done({ exitCode, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

async function run(outDir) {
  const receiptPath = join(outDir, 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.status !== 'prepared') throw new Error('run requires a prepared receipt');
  const before = await auditSnapshot(outDir, 'immediately-before-run');
  for (const entry of before.snapshots) if (entry.archiveSha256 !== receipt.hashes.sourcearchive[entry.repo]) throw new Error(`source archive hash mismatch before run: ${entry.repo}`);
  const pinnedFiles = [
    [runner, receipt.hashes.runner], [codex, receipt.hashes.CLI],
    [join(base, 'retrieval-diagnosis', 'retrieval-replay-full-response.json'), receipt.hashes.rawresponse],
    [join(outDir, 'task.json'), receipt.hashes.task],
    [join(outDir, 'shared-text.txt'), receipt.hashes.sharedtext],
    [join(outDir, 'manifests', 'control.json'), receipt.hashes.manifests.control],
    [join(outDir, 'manifests', 'callsite.json'), receipt.hashes.manifests.callsite],
    [driver, receipt.hashes.driver],
  ];
  for (const [file, expected] of pinnedFiles) {
    if (await fileSha(file) !== expected) throw new Error(`pinned artifact hash mismatch: ${file}`);
  }
  const dispatchPath = join(outDir, 'dispatch.json');
  if (existsSync(dispatchPath)) throw new Error(`refusing to overwrite existing dispatch: ${dispatchPath}`);
  const order = [['A1', 'control'], ['B1', 'callsite'], ['B2', 'callsite'], ['A2', 'control']];
  const records = []; let totalTokens = 0; let stopped = null;
  const save = async (status) => writeFile(dispatchPath, json({ schemaVersion: 1, status, order, totalTokens, records, stopped }), { encoding: 'utf8', flag: 'w' });
  await save('running');
  for (let i = 0; i < order.length; i += 1) {
    const [label, arm] = order[i];
    if (totalTokens >= 1500000) { stopped = { reason: 'known eval token threshold reached before launch', totalTokens, next: label }; await save('stopped-token-threshold'); break; }
    const manifestPath = join(outDir, 'manifests', arm === 'control' ? 'control.json' : 'callsite.json');
    if (existsSync(join(outDir, 'results', label))) throw new Error(`refusing to overwrite existing result directory: ${label}`);
    const startedAt = new Date().toISOString(); const started = Date.now();
    const result = await runRunner(manifestPath, join(outDir, 'results', label), arm);
    await writeFile(join(outDir, 'results', `${label}.runner.stdout`), result.stdout, 'utf8');
    await writeFile(join(outDir, 'results', `${label}.runner.stderr`), result.stderr, 'utf8');
    const resultDir = join(outDir, 'results', label, 'extraction_failure', arm, 'run-001');
    let metrics = null; try { metrics = JSON.parse(await readFile(join(resultDir, 'metrics.json'), 'utf8')); } catch { /* recorded below */ }
    const usage = metrics?.usage || null; const usageAvailable = metrics?.usageAvailable === true;
    const usageConflict = metrics?.usageReconciliation?.matches === false;
    const runTokens = usageAvailable ? usage.input_tokens + usage.output_tokens : null; if (runTokens !== null) totalTokens += runTokens;
    const record = { index: i + 1, label, arm, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, exitCode: result.exitCode, signal: result.signal, spawnError: result.error || null, runnerStdoutSha256: sha(result.stdout), runnerStderrSha256: sha(result.stderr), resultDir, status: metrics?.status || null, executionCompleted: metrics?.executionCompleted ?? false, usageAvailable, usageConflict, usage, runTokens };
    records.push(record); await save('running');
    if (result.exitCode !== 0 || result.error || !metrics?.executionCompleted || !usageAvailable || usageConflict || metrics?.evaluationValidity === 'invalid_environment' || metrics?.rawEvaluationValidity === 'invalid_environment') { stopped = { reason: 'process failure, unknown/conflicting usage, or invalid evaluation', record }; await save('stopped-failure'); break; }
  }
  try {
    const after = await auditSnapshot(outDir, 'after');
    for (const entry of after.snapshots) if (entry.archiveSha256 !== receipt.hashes.sourcearchive[entry.repo]) throw new Error(`source archive hash mismatch after run: ${entry.repo}`);
  } catch (error) {
    stopped = { reason: 'post-run source audit failed', error: error.message };
    await save('invalid-source-audit');
    throw error;
  }
  if (!stopped && records.length === order.length) await save('completed');
  process.stdout.write(`${json({ status: stopped ? 'stopped' : 'completed', totalTokens, completed: records.length, stopped })}`);
}

if (mode === '--prepare') await prepare(resolve(value('--output-dir', outDefault)));
else if (mode === '--run') await run(resolve(value('--output-dir', outDefault)));
else throw new Error('usage: node callsite-diagnostic.mjs --prepare|--run [--output-dir PATH]');
