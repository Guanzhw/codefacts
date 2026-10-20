import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runDshAttempt } from './dsh-adapter.mjs';
import { hash, writeJson } from './rpc.mjs';
import { prepareSlot, readSourceManifest, verifySource } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARMS = ['ordinary', 'codefacts017', 'codefacts022', 'codegraph'];
const MENUS = { ordinary: [], codefacts017: ['codefacts_map', 'codefacts_search', 'codefacts_outline', 'codefacts_expand', 'codefacts_path'], codefacts022: ['codefacts_explore', 'codefacts_expand', 'codefacts_impact'], codegraph: ['codegraph_explore'] };
const COMMON = ['source_list', 'source_read', 'source_search'];
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exclusive = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function absolute(value, label) { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`); return value; }

export function validateManifest(input) {
  if (input.schemaVersion !== 1 || !/^[\w.-]+$/.test(input.campaignId ?? '')) throw new Error('Invalid manifest identity');
  for (const key of ['suite', 'oracle', 'evidenceDir']) absolute(input[key], key);
  for (const key of ['dshRoot', 'node', 'sdkRoot', 'rg']) absolute(input.runtime?.[key], `runtime.${key}`);
  if (!['provider', 'id', 'reasoningEffort'].every(key => typeof input.model?.[key] === 'string' && input.model[key])) throw new Error('Explicit model identity required');
  if (input.concurrency !== 1 || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('Serial concurrency=1 and positive timeoutMs required');
  if (!Array.isArray(input.arms) || JSON.stringify(input.arms.map(row => row.id)) !== JSON.stringify(ARMS)) throw new Error('Four ordered benchmark arms required');
  for (const arm of input.arms) {
    if (arm.id.startsWith('codefacts')) absolute(arm.executable, 'arm.executable');
    if (arm.id === 'codegraph') { absolute(arm.node, 'codegraph.node'); absolute(arm.cli, 'codegraph.cli'); }
    if (arm.id !== 'ordinary' && typeof arm.version !== 'string') throw new Error('Native version required');
  }
  if (!Array.isArray(input.corpora) || !input.corpora.length || new Set(input.corpora.map(row => row.id)).size !== input.corpora.length) throw new Error('Unique corpora required');
  for (const row of input.corpora) { absolute(row.root, 'corpus.root'); absolute(row.manifestFile, 'corpus.manifestFile'); if (!/^[a-f0-9]{64}$/.test(row.manifestSha256)) throw new Error('Canonical corpus manifest hash required'); }
  for (const condition of ['guided-use', 'natural-choice']) if (!Number.isSafeInteger(input.repetitions?.[condition]) || input.repetitions[condition] < 1) throw new Error('Positive condition repetitions required');
  return input;
}

export function buildSchedule(tasks, repetitions) {
  const order = [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]];
  const rows = []; let round = 0;
  for (const condition of ['guided-use', 'natural-choice']) for (let rep = 1; rep <= repetitions[condition]; rep++, round++) {
    const indices = tasks.map((_, index) => (index + round) % tasks.length);
    if (round % 2) indices.reverse();
    for (const index of indices) for (let position = 0; position < 4; position++) {
      const task = tasks[index], arm = ARMS[order[(index + round) % 4][position]];
      rows.push({ ordinal: rows.length + 1, taskId: task.id, corpus: task.corpus, arm, condition, rep, position: position + 1, id: `${condition}-${task.id}-${arm}-r${rep}` });
    }
  }
  return rows;
}

export function buildPrompt(suite, task, condition) {
  const guided = 'In the first assistant step that inspects source, include a relevant query to a provided code-navigation tool if one is available; otherwise use an ordinary source tool. Obtain at least one native result containing a source location when native tools are provided. Continue with ordinary source tools whenever useful.';
  const natural = 'Choose ordinary source tools or provided code-navigation tools whenever useful. A native query is optional.';
  return `${suite.scope}\n${suite.answerContract}\n${condition === 'guided-use' ? guided : natural}\n\nRepository question:\n${task.question}`;
}

function nearestPackage(file) {
  let dir = path.dirname(file);
  while (true) { const candidate = path.join(dir, 'package.json'); if (fs.existsSync(candidate)) return candidate; const parent = path.dirname(dir); if (parent === dir) return null; dir = parent; }
}
export function collectPins(manifest, manifestPath) {
  const relativeEvidence = path.relative(HERE, manifest.evidenceDir);
  if (relativeEvidence === '' || (!relativeEvidence.startsWith(`..${path.sep}`) && relativeEvidence !== '..' && !path.isAbsolute(relativeEvidence))) throw new Error('Evidence directory must be outside the framework source tree');
  const files = new Set([manifestPath, manifest.suite, manifest.oracle, manifest.runtime.node, manifest.runtime.rg,
    path.join(manifest.runtime.dshRoot, 'package.json'), path.join(manifest.runtime.dshRoot, 'lib/bin.js'),
    path.join(manifest.runtime.dshRoot, 'node_modules/@deepseek-ai/dsh-token-meter/lib/types/turn-usage.js'), path.join(manifest.runtime.sdkRoot, 'package.json')]);
  function walk(dir, pattern) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file, pattern); else if (pattern.test(entry.name)) files.add(file); } }
  for (const name of ['campaign', 'prepare', 'dsh-adapter', 'bridge', 'rpc']) files.add(path.join(HERE, `${name}.mjs`));
  walk(path.join(manifest.runtime.dshRoot, 'lib'), /\.js$/);
  const packages = ['dsh-sdk-minimal', 'dsh-sdk-jsonrpc-server', 'dsh-sdk-app', 'dsh-agent', 'dsh-agent-loop', 'dsh-llm', 'dsh-llm-pi-ai', 'dsh-mcp-client', 'dsh-credentials-local', 'dsh-session', 'dsh-session-persistence-jsonl', 'dsh-system-prompt', 'dsh-tools', 'dsh-token-meter'];
  for (const name of packages) {
    const root = path.join(manifest.runtime.dshRoot, 'node_modules/@deepseek-ai', name);
    files.add(path.join(root, 'package.json'));
    const lib = path.join(root, 'lib'); if (fs.existsSync(lib)) walk(lib, /\.js$/);
    for (const entry of fs.readdirSync(root)) if (/patch\.(?:json|ya?ml)$/.test(entry)) files.add(path.join(root, entry));
  }
  const providerRequire = createRequire(path.join(manifest.runtime.dshRoot, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json'));
  // pi-ai exports an import-only entry, so resolve its installed package using
  // the provider's module search roots rather than a CommonJS require target.
  const providerPackage = providerRequire.resolve.paths('@earendil-works/pi-ai').map(root => path.join(root, '@earendil-works/pi-ai/package.json')).find(file => fs.existsSync(file));
  if (!providerPackage) throw new Error('pi-ai package identity unavailable');
  const providerEntry = path.resolve(path.dirname(providerPackage), json(providerPackage).exports['.'].import);
  files.add(providerPackage); walk(path.dirname(providerEntry), /\.(?:js|json)$/);
  walk(path.join(manifest.runtime.sdkRoot, 'dist/cjs'), /\.(?:js|json)$/);
  for (const corpus of manifest.corpora) files.add(corpus.manifestFile);
  for (const arm of manifest.arms) for (const file of [arm.executable, arm.node, arm.cli].filter(Boolean)) { files.add(file); const pkg = nearestPackage(file); if (pkg) files.add(pkg); }
  const cgPackage = nearestPackage(manifest.arms.find(arm => arm.id === 'codegraph').cli);
  if (!cgPackage) throw new Error('CodeGraph package identity unavailable');
  walk(path.dirname(cgPackage), /\.(?:js|wasm)$/);
  return [...files].sort().map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) }));
}

export function assertFrozen(manifest, frozen, pins) {
  if (hash(manifest) !== frozen.manifestHash || JSON.stringify(pins) !== JSON.stringify(frozen.pins)) throw new Error('Frozen campaign inputs drifted');
}
export function freezeCampaign(manifestPath) {
  absolute(manifestPath, 'manifest');
  const manifest = validateManifest(json(manifestPath)), suite = json(manifest.suite);
  if (!Array.isArray(suite.tasks) || !suite.tasks.length || new Set(suite.tasks.map(row => row.id)).size !== suite.tasks.length || suite.tasks.some(row => !/^[\w.-]+$/.test(row.id) || typeof row.question !== 'string' || !manifest.corpora.some(corpus => corpus.id === row.corpus))) throw new Error('Invalid suite tasks');
  json(manifest.oracle);
  const sources = manifest.corpora.map(corpus => { const source = readSourceManifest(corpus); verifySource(corpus.root, source.entries); return { id: corpus.id, digest: source.digest, files: source.entries.length, manifestFileSha256: source.manifestFileSha256 }; });
  const pins = collectPins(manifest, manifestPath), destination = path.join(manifest.evidenceDir, 'freeze.json');
  if (fs.existsSync(destination)) { const frozen = json(destination); assertFrozen(manifest, frozen, pins); return frozen; }
  const frozen = { schemaVersion: 1, campaignId: manifest.campaignId, at: new Date().toISOString(), manifestHash: hash(manifest), manifest, pins, sources, schedule: buildSchedule(suite.tasks, manifest.repetitions) };
  fs.mkdirSync(manifest.evidenceDir, { recursive: true }); exclusive(destination, frozen); return frozen;
}

export function assertReusable(meta, frozen, slot) {
  if (meta.freezeHash !== hash(frozen) || JSON.stringify(meta.slot) !== JSON.stringify(slot)) throw new Error('Existing attempt belongs to different frozen inputs');
  const validTaskFailure = slot.taskId !== 'canary' && meta.status === 'task-failed' && meta.audit?.infrastructureValid === true;
  if ((!validTaskFailure && meta.status !== 'attempt-completed') || !fs.existsSync(meta.receiptPath)) throw new Error(`Prior failed or incomplete attempt stops dispatch: ${slot.id}`);
  const receipt = json(meta.receiptPath);
  if (!['attempt-completed', ...(validTaskFailure ? ['attempt-failed'] : [])].includes(receipt.status)) throw new Error(`Prior receipt is incomplete: ${slot.id}`);
}

export function auditAttempt(receipt, arm, { canary = false } = {}) {
  const expected = [...COMMON, ...MENUS[arm]].map(name => `mcp__repo__${name}`).sort();
  const menus = receipt.catalogs ?? [];
  const catalogValid = menus.length > 0 && menus.every(menu => JSON.stringify(menu.map(row => row.name).sort()) === JSON.stringify(expected));
  const bodyCalls = receipt.toolCalls ?? [];
  const sourceCalls = bodyCalls.filter(call => expected.includes(call.name)).length;
  const nativeCalls = bodyCalls.filter(call => MENUS[arm].some(name => call.name === `mcp__repo__${name}`));
  const sourceBearingNativeResults = (receipt.toolResults ?? []).filter(result => {
    const message = result.message;
    if (!message || message.isError || !nativeCalls.some(call => call.callId === message.toolCallId)) return false;
    const text = JSON.stringify(message.content ?? []);
    return /[\w./\\-]+\.(?:md|js|ts|go|rs|json)(?::\d+|[^\n]{0,160}(?:start_line|startLine|line_start|line_number|"line"))/i.test(text);
  }).length;
  const reasons = [], taskFailureReasons = [];
  if (receipt.status !== 'attempt-completed') taskFailureReasons.push('DSH execution incomplete');
  if (!receipt.headerAudit || !catalogValid) reasons.push('Actual model identity or menu mismatch');
  if (receipt.protocolError || receipt.didInitialize === false || receipt.didPrompt === false) reasons.push('DSH startup or transport failure');
  if (!receipt.exactTurnUsage) taskFailureReasons.push('Exact provider usage unavailable');
  if (!sourceCalls) taskFailureReasons.push('No actual source inspection calls');
  if (canary && arm !== 'ordinary' && !sourceBearingNativeResults) reasons.push('Canary lacks a successful source-bearing native result');
  if (canary) reasons.push(...taskFailureReasons);
  return { catalogValid, sourceCalls, nativeCalls: nativeCalls.length, sourceBearingNativeResults, taskSucceeded: receipt.status === 'attempt-completed' && sourceCalls > 0, taskFailureReasons, infrastructureValid: reasons.length === 0, reasons };
}

export async function runSlot(manifest, frozen, suite, slot, phase, deps) {
  const dir = path.join(manifest.evidenceDir, phase, slot.id), metaPath = path.join(dir, 'slot-meta.json');
  if (fs.existsSync(dir)) { if (!fs.existsSync(metaPath)) throw new Error(`Allocated attempt is incomplete: ${slot.id}`); const meta = json(metaPath); assertReusable(meta, frozen, slot); return meta; }
  fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.mkdirSync(dir);
  const task = phase === 'canary' ? { id: 'canary', corpus: slot.corpus, question: 'Locate Router.prototype.hasRoute in this router snapshot. Use a native query when one is available, then verify an exact source range with ordinary source_read. Explain one implementation behavior with source line citations, under 80 words.' } : suite.tasks.find(row => row.id === slot.taskId);
  const corpus = manifest.corpora.find(row => row.id === slot.corpus), arm = manifest.arms.find(row => row.id === slot.arm);
  const meta = { slot, task, arm, condition: slot.condition, rep: slot.rep, freezeHash: hash(frozen), status: 'allocated', receiptPath: path.join(dir, 'dsh', 'receipt.json') };
  exclusive(metaPath, meta); console.log(JSON.stringify({ event: 'begin', phase, slot: slot.id, arm: slot.arm }));
  const heartbeat = setInterval(() => console.log(JSON.stringify({ event: 'heartbeat', phase, slot: slot.id, at: new Date().toISOString() })), 30000);
  try {
    const prepared = await deps.prepareSlot(manifest, slot, dir, corpus);
    const prompt = buildPrompt(suite, task, slot.condition);
    Object.assign(meta, { sourceRoot: prepared.root, sourceHash: prepared.sourceHash, prompt, setup: prepared.setup, status: 'prepared' }); writeJson(metaPath, meta);
    const receipt = await deps.runDshAttempt({ installRoot: manifest.runtime.dshRoot, nodeCommand: manifest.runtime.node, attemptDir: path.join(dir, 'dsh'), root: prepared.root, provider: manifest.model.provider, model: manifest.model.id, reasoningEffort: manifest.model.reasoningEffort, supportsStrictMode: manifest.model.supportsStrictMode, bridgeEntry: path.join(HERE, 'bridge.mjs'), bridgeConfig: prepared.bridgeConfig, prompt, timeoutMs: manifest.timeoutMs });
    const audit = auditAttempt(receipt, slot.arm, { canary: phase === 'canary' });
    verifySource(corpus.root, prepared.entries); verifySource(prepared.root, prepared.entries, { exact: true });
    Object.assign(meta, { audit, status: !audit.infrastructureValid ? 'infrastructure-failed' : audit.taskSucceeded ? 'attempt-completed' : 'task-failed' }); writeJson(metaPath, meta);
    if (!audit.infrastructureValid) throw new Error(audit.reasons.join('; '));
    return meta;
  } catch (error) { meta.status = 'infrastructure-failed'; meta.error = error.stack ?? error.message; writeJson(metaPath, meta); throw error; }
  finally { clearInterval(heartbeat); console.log(JSON.stringify({ event: 'end', phase, slot: slot.id, status: meta.status })); }
}

export async function executeCampaign(manifestPath, mode, onlySlot = null, dependencies = {}) {
  if (!['freeze', 'canary', 'run'].includes(mode)) throw new Error('mode must be freeze, canary, or run');
  if (mode === 'freeze') return freezeCampaign(manifestPath);
  const manifest = validateManifest(json(absolute(manifestPath, 'manifest'))), frozen = json(path.join(manifest.evidenceDir, 'freeze.json'));
  assertFrozen(manifest, frozen, collectPins(manifest, manifestPath));
  const suite = json(manifest.suite), deps = { prepareSlot, runDshAttempt, ...dependencies };
  const canaries = ARMS.map((arm, index) => ({ ordinal: index + 1, taskId: 'canary', corpus: manifest.corpora[0].id, arm, condition: 'guided-use', rep: 1, position: index + 1, id: `canary-${arm}` }));
  if (mode === 'canary') { for (const slot of canaries) await runSlot(manifest, frozen, suite, slot, 'canary', deps); return { canaries: 4 }; }
  for (const slot of canaries) { const metaFile = path.join(manifest.evidenceDir, 'canary', slot.id, 'slot-meta.json'); if (!fs.existsSync(metaFile)) throw new Error(`Missing canary: ${slot.arm}`); assertReusable(json(metaFile), frozen, slot); }
  if (onlySlot && !frozen.schedule.some(slot => slot.id === onlySlot || String(slot.ordinal) === onlySlot)) throw new Error(`Unknown slot: ${onlySlot}`);
  for (const slot of frozen.schedule) {
    const selected = !onlySlot || slot.id === onlySlot || String(slot.ordinal) === onlySlot;
    if (!selected) { const metaFile = path.join(manifest.evidenceDir, 'attempts', slot.id, 'slot-meta.json'); if (!fs.existsSync(metaFile)) throw new Error('Cannot skip an unallocated prior slot'); assertReusable(json(metaFile), frozen, slot); continue; }
    await runSlot(manifest, frozen, suite, slot, 'attempts', deps);
    if (onlySlot) break;
  }
  return { status: onlySlot ? 'slot-completed' : 'attempts-completed' };
}

export async function main(argv = process.argv.slice(2)) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) { if (!['--manifest', '--mode', '--slot'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: --manifest ABS --mode freeze|canary|run [--slot ID]'); values[argv[i].slice(2)] = argv[i + 1]; }
  if (!values.manifest || !values.mode) throw new Error('--manifest and --mode required');
  console.log(JSON.stringify(await executeCampaign(values.manifest, values.mode, values.slot)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
