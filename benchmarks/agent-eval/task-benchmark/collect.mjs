import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { summarizeCampaign } from './summary.mjs';
import { readSourceManifest } from './prepare.mjs';
import { validateManifest, assertFrozen, collectPins } from './campaign.mjs';
import { hash } from './rpc.mjs';
import { recoverKnownUsage } from './usage-recovery.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const PREFIX = 'mcp__repo__';
const ORDINARY = new Set(['source_read', 'source_search', 'source_list']);
const digest = value => createHash('sha256').update(value).digest('hex');

export function hasReturnedLocation(message, sourcePaths) {
  const allowed = new Set(sourcePaths);
  function span(value) {
    if (Array.isArray(value)) return value.some(span);
    if (!value || typeof value !== 'object') return false;
    const file = value.file_path ?? value.filePath ?? value.path ?? value.file;
    const line = value.start_line ?? value.startLine ?? value.line_start ?? value.line;
    if (allowed.has(file) && Number.isInteger(line) && line > 0) return true;
    return Object.entries(value).some(([key, child]) =>
      !['query', 'arguments', 'request', 'source_hashes', 'freshness'].includes(key) && span(child));
  }
  for (const block of message.content ?? []) {
    if (block.type !== 'text') continue;
    const text = block.text.trim();
    if (/^[\[{]/.test(text)) {
      try { if (span(JSON.parse(text))) return true; continue; } catch { /* ordinary Markdown text */ }
    }
    const codegraph = text.indexOf('**Source Code**');
    if (codegraph >= 0) {
      const body = text.slice(codegraph);
      if (/```[\s\S]*?\n\d+[\t ]/.test(body) && sourcePaths.some(file => body.includes('`' + file + '`'))) return true;
      continue;
    }
    for (const line of text.split('\n')) {
      if (/^\s*(?:query|request|input)\s*:/i.test(line)) continue;
      for (const file of sourcePaths) {
        const index = line.indexOf(file + ':');
        if (index >= 0 && /^:\d+/.test(line.slice(index + file.length)) &&
          (/^\s*(?:#{1,6}\s|[-*]\s|(?:source|definition|location)\b)/i.test(line) || text.includes('```') ||
            (text.includes('|at|') && line.trimStart().startsWith('|' + file + ':')))) return true;
      }
    }
  }
  return false;
}

export function gradingView(answer, sourceRoot) {
  let text = answer;
  for (const root of new Set([sourceRoot, sourceRoot.replaceAll('\\', '/'), sourceRoot.replaceAll('/', '\\')])) text = text.replaceAll(root, '.');
  return text.replace(/\b(?:mcp__repo__)?(?:codefacts(?:017|022)?|codegraph)(?:_[a-z_]+)?(?:\s+v?\d+\.\d+\.\d+)?\b/gi, '[navigation tool]');
}

/** Audit actual model calls separately from arm-blind source grading. */
export function auditTrace(receipt, slot, sourcePaths) {
  const calls = receipt.toolCalls;
  const ordinary = calls.filter(call => ORDINARY.has(call.name.slice(PREFIX.length)));
  const native = calls.filter(call => call.name.startsWith(PREFIX) && !ORDINARY.has(call.name.slice(PREFIX.length)));
  const nativeIds = new Set(native.map(call => call.callId));
  const successful = receipt.toolResults.filter(({ message }) => nativeIds.has(message.toolCallId) && !message.isError);
  const sourceBearing = successful.filter(({ message }) => hasReturnedLocation(message, sourcePaths));
  const firstStep = calls.length ? Math.min(...calls.map(call => call.step)) : null;
  const firstStepNative = native.some(call => call.step === firstStep);
  const reasons = [];
  if (!receipt.headerAudit) reasons.push('actual model/header audit failed');
  if (calls.some(call => !call.name.startsWith(PREFIX))) reasons.push('unassigned tool called');
  if (slot.arm === 'ordinary' && native.length) reasons.push('ordinary baseline invoked a native tool');
  const valid = reasons.length === 0;
  const adherent = valid && (slot.condition === 'natural-choice' ? calls.length > 0 :
    slot.arm === 'ordinary' ? ordinary.length > 0 : firstStepNative && sourceBearing.length > 0);
  if (!adherent) reasons.push('source-inspection/adherence predicate not satisfied');
  return { toolCalls: { ordinary: ordinary.length, native: native.length, nativeSuccessful: successful.length },
    traceAudit: { valid, adherent, reasons }, firstStep, firstStepNative, nativeSourceBearingResults: sourceBearing.length };
}

export function blindId() {
  return 'sample-' + randomUUID();
}

export function assertCollectedIdentity(meta, frozen, slot) {
  if (meta.freezeHash !== hash(frozen) || hash(meta.slot) !== hash(slot)) {
    throw new Error(`Attempt belongs to a different frozen slot: ${slot.id}`);
  }
}

export function collectedUsage(receipt) {
  return receipt.exactTurnUsage
    ? { usage: receipt.exactTurnUsage }
    : { usage: null, knownUsageLowerBound: receipt.knownUsageLowerBound?.totalTokens > 0 ? receipt.knownUsageLowerBound : null };
}

/** Export all available answers without exposing arm, trace, timing or usage to graders. */
export function collectCampaign(manifestPath, { outputDir, gradesDir, requireComplete = false, deriveTurnTokenUsage } = {}) {
  const manifest = validateManifest(read(manifestPath));
  const frozen = read(path.join(manifest.evidenceDir, 'freeze.json'));
  assertFrozen(manifest, frozen, collectPins(manifest, manifestPath));
  const suite = read(manifest.suite), oracle = read(manifest.oracle);
  outputDir ??= path.join(manifest.evidenceDir, 'evaluation');
  fs.mkdirSync(outputDir, { recursive: true });
  const paths = new Map(manifest.corpora.map(c => [c.id, readSourceManifest(c).entries.map(e => e.path)]));
  const mapFile = path.join(outputDir, 'unblinded-map.json');
  const mapping = fs.existsSync(mapFile) ? read(mapFile) : frozen.schedule.map(slot =>
    ({ sample: blindId(), slotId: slot.id, taskId: slot.taskId }));
  if (!fs.existsSync(mapFile)) fs.writeFileSync(mapFile, JSON.stringify(mapping, null, 2)+'\n', { flag: 'wx' });
  const runs = [], pending = [], observedSamples = new Set();
  for (const slot of frozen.schedule) {
    const dir = path.join(manifest.evidenceDir, 'attempts', slot.id), metaFile = path.join(dir, 'slot-meta.json');
    if (!fs.existsSync(metaFile)) { pending.push(slot.id); continue; }
    const meta = read(metaFile);
    if (!['attempt-completed', 'task-failed', 'infrastructure-failed'].includes(meta.status)) { pending.push(slot.id); continue; }
    if (!fs.existsSync(meta.receiptPath)) { pending.push(slot.id); continue; }
    assertCollectedIdentity(meta, frozen, slot);
    const receipt = read(meta.receiptPath), audit = auditTrace(receipt, slot, paths.get(slot.corpus));
    if (!meta.audit?.catalogValid) { audit.traceAudit.valid = false; audit.traceAudit.reasons.push('actual catalog mismatch'); }
    const sample = mapping.find(row => row.slotId === slot.id).sample;
    const taskDir = path.join(outputDir, 'blind', slot.taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    const answer = gradingView(receipt.answer || '', meta.sourceRoot);
    fs.writeFileSync(path.join(taskDir, sample + '.md'), answer);
    observedSamples.add(sample);
    const gradeFile = gradesDir ? path.join(gradesDir, slot.taskId + '.json') : null;
    const gradeSet = gradeFile && fs.existsSync(gradeFile) ? read(gradeFile) : null;
    const assessed = gradeSet?.samples?.find(value => value.id === sample);
    if (assessed && assessed.answerSha256 !== digest(answer)) throw new Error(`Grade answer identity differs: ${sample}`);
    const grade = assessed?.grade ?? null;
    const accounting = collectedUsage(receipt);
    if (!receipt.exactTurnUsage && deriveTurnTokenUsage) {
      const events = fs.readFileSync(path.join(path.dirname(meta.receiptPath), 'events.jsonl'), 'utf8')
        .split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      const recovery = recoverKnownUsage(events, deriveTurnTokenUsage);
      if (recovery.knownUsageLowerBound && (!accounting.knownUsageLowerBound ||
          recovery.knownUsageLowerBound.totalTokens > accounting.knownUsageLowerBound.totalTokens)) {
        accounting.knownUsageLowerBound = recovery.knownUsageLowerBound;
      }
      accounting.usageRecovery = recovery;
    }
    runs.push({ id: slot.id, taskId: slot.taskId, arm: slot.arm, condition: slot.condition,
      repetition: slot.rep, status: meta.status === 'infrastructure-failed' ? 'invalid-environment' :
        receipt.status === 'attempt-completed' ? 'completed' : 'failed',
      wallMs: receipt.durationMs, setupMs: meta.setup.indexDurationMs,
      executionOnlyMs: receipt.timings.turnEndedAtMs === null ? null : receipt.timings.turnEndedAtMs - receipt.timings.promptedAtMs,
      ...accounting, ...audit, grade, gradingAnswerSha256: digest(answer),
      evidence: { receiptPath: meta.receiptPath, slotMeta: metaFile },
      timeout: receipt.timedOut, terminalReason: receipt.turnEnd?.reason ?? null });
  }
  const metadata = { campaignId: manifest.campaignId, model: manifest.model,
    plannedAttempts: frozen.schedule.length, observedAttempts: runs.length, pending,
    taskScope: 'read-only source investigation', timing: 'fresh DSH process launch through exit; index preparation separate',
    concurrency: manifest.concurrency,
    partialUsageRecoveryEnabled: Boolean(deriveTurnTokenUsage),
    runtimeVersions: { dsh: read(path.join(manifest.runtime.dshRoot, 'package.json')).version,
      node: execFileSync(manifest.runtime.node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
      analysisNode: process.version, mcpSdk: read(path.join(manifest.runtime.sdkRoot, 'package.json')).version },
    platform: { os: process.platform, architecture: process.arch },
    sourceCommits: manifest.corpora.map(({ id, repo, commit }) => ({ id, repo, commit })),
    toolVersions: manifest.arms.map(({ id, version, artifactKind, sourceCommit }) =>
      ({ id, version: version ?? null, ...(artifactKind ? { artifactKind } : {}), ...(sourceCommit ? { sourceCommit } : {}) })),
    analysisInputs: ['collect.mjs', 'summary.mjs', 'usage-recovery.mjs'].map(name => ({ name,
      sha256: digest(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), name))) })) };
  const result = { schemaVersion: 1, suiteId: suite.suiteId, metadata, runs };
  save(path.join(outputDir, 'review-input.json'), result);
  // Each grader sees task, criterion oracle and anonymous answer names only.
  for (const task of suite.tasks) {
    const taskDir = path.join(outputDir, 'blind', task.id);
    fs.mkdirSync(taskDir, { recursive: true });
    save(path.join(taskDir, 'rubric.json'), { task, answerContract: suite.answerContract,
      grading: oracle.grading, oracle: oracle.tasks.find(row => row.id === task.id),
      answerFiles: mapping.filter(row => row.taskId === task.id && observedSamples.has(row.sample)).map(row => row.sample + '.md').sort() });
  }
  if (requireComplete && pending.length) throw new Error(`Campaign incomplete: ${pending.length} scheduled attempts remain`);
  if (gradesDir && !pending.length) {
    const summary = summarizeCampaign(result);
    save(path.join(outputDir, 'reviewed-results.json'), result);
    save(path.join(outputDir, 'summary.json'), summary);
    return { result, summary };
  }
  return { result };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--manifest', '--output', '--grades'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: --manifest ABS [--output ABS] [--grades ABS]');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  if (!options.manifest) throw new Error('--manifest required');
  const manifest = validateManifest(read(options.manifest));
  const { deriveTurnTokenUsage } = await import(pathToFileURL(path.join(manifest.runtime.dshRoot,
    'node_modules/@deepseek-ai/dsh-token-meter/lib/types/turn-usage.js')).href);
  const { result, summary } = collectCampaign(options.manifest,
    { outputDir: options.output, gradesDir: options.grades, deriveTurnTokenUsage });
  console.log(JSON.stringify({ observed: result.runs.length, planned: result.metadata.plannedAttempts,
    graded: result.runs.filter(row => row.grade).length, summaryAvailable: Boolean(summary) }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
