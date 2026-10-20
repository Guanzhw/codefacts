import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const OWN = path.dirname(fileURLToPath(import.meta.url));
export function writeArtifact(outputDir, stem, value, extension = 'json') {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw new Error('Explicit absolute output directory required');
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, `${stem}-${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}.${extension}`);
  fs.writeFileSync(file, extension === 'json' ? JSON.stringify(value, null, 2) + '\n' : value, { flag: 'wx' });
  return file;
}
const sha = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ep = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a) === path.resolve(b);
const ARMS = ['ordinary', 'codefacts022', 'codegraph'];
const MISSING_CONTEXT = ['missing-final-declaration', 'invalid-final-json', 'invalid-final-schema', 'invalid-final-region'];
export const ADMITTED_ID = 'gpt-context/ctx-mui__material-ui-34229-codegraph';
// A supplied digest is an explicit caller trust anchor, not a cryptographic root signature.
export function verifyLedger({ ledgerPath, ledgerSha256, suite, frozen, freezeBytesSha256, readFile }) {
  if (!ledgerPath || !/^[a-f0-9]{64}$/.test(ledgerSha256 ?? '')) throw new Error('Ledger requires an explicit exact raw SHA256 trust anchor');
  const bytes = readFile(ledgerPath);
  if (sha(bytes) !== ledgerSha256) throw new Error('Ledger raw hash mismatch');
  const ledger = JSON.parse(bytes);
  if (ledger.schemaVersion !== 1 || ledger.status !== 'root-approved' || ledger.approvedBy !== 'root' || ledger.suiteId !== suite.suiteId || ledger.suiteFreezeSha256 !== freezeBytesSha256) throw new Error('Ledger is pending, unsigned or not bound to frozen suite');
  if (!Array.isArray(ledger.knownInfraCells) || ledger.knownInfraCells.length !== 1 || ledger.knownInfraCells[0].id !== ADMITTED_ID || !frozen.schedule.some(c => c.id === ADMITTED_ID)) throw new Error('Ledger permits only the one ROOT-admitted frozen cell');
  if (typeof ledger.supplementPath !== 'string' || sha(readFile(ledger.supplementPath)) !== ledger.supplementSha256) throw new Error('Supplement raw hash mismatch');
  const cell = ledger.knownInfraCells[0];
  if (cell.noModelRequest !== true || cell.recoveryClosed !== true || cell.resolved !== null || cell.tokens !== null || typeof cell.reason !== 'string' || !cell.reason.trim()) throw new Error('Ledger infrastructure outcome contract mismatch');
  if (!Array.isArray(cell.failureEvidence) || !cell.failureEvidence.length || !Array.isArray(cell.costRefs) || cell.costRefs.length !== 3) throw new Error('Ledger must retain failure evidence and all three prep costs');
  for (const evidence of cell.failureEvidence) if (sha(readFile(evidence.path)) !== evidence.sha256) throw new Error('Failure evidence hash mismatch');
  if (new Set(cell.costRefs.map(c => path.resolve(c.metadataPath))).size !== 3) throw new Error('Prep cost metadata paths must be distinct');
  for (const cost of cell.costRefs) {
    const bytes = readFile(cost.metadataPath), meta = JSON.parse(bytes);
    if (sha(bytes) !== cost.metadataSha256 || typeof cost.phase !== 'string' || !cost.phase || typeof cost.slotWallMs !== 'number' || cost.slotWallMs < 0 || !Number.isFinite(cost.slotWallMs) || meta.slotWallMs !== cost.slotWallMs) throw new Error('Prep cost metadata hash or wall time mismatch');
  }
  return { ledger, cell, ledgerSha256 };
}

export function verifyInfraCell({ admission, row, cell, meta, manifest, freeze, metadataHash, exists }) {
  if (!admission || row.id !== ADMITTED_ID || admission.cell.id !== row.id || !ep(row.metaPath, admission.cell.canonicalMetadataPath) || metadataHash !== admission.cell.metadataSha256) throw new Error('Infrastructure cell is not exactly ledger-bound');
  const slot = freeze.schedule.find(s => s.id === cell.slotId), task = manifest.tasks.find(t => t.id === cell.taskId);
  if (meta.freezeHash !== sha(freeze) || !same(meta.slot, slot) || meta.taskId !== cell.taskId || meta.cohort !== cell.cohort || meta.split !== cell.split || task?.split !== cell.split) throw new Error('Infrastructure original frozen slot identity mismatch');
  if (meta.status !== 'infrastructure-failed' || !same(meta.grade, { status: 'pending', resolved: null, metrics: null })) throw new Error('Infrastructure status/grade was changed or invented');
  const dsh = path.join(path.dirname(row.metaPath), 'dsh');
  if (!ep(meta.receiptPath, path.join(dsh, 'receipt.json')) || exists(dsh) || exists(meta.receiptPath) || exists(path.join(dsh, 'request.json')) || exists(path.join(path.dirname(row.metaPath), 'grade-run-0001'))) throw new Error('Infrastructure cell has DSH or grading evidence; no-model admission invalid');
  return { classification: 'root-admitted-infrastructure-missing', resolved: null, metrics: null, tokens: null, modelTimeMs: null, noModelRequest: true,
    prepCosts: admission.cell.costRefs, reason: admission.cell.reason };
}

// Exact acceptedGrade policy from frozen suite.mjs (157-166), with no execution import.
export function acceptedGrade(meta, cohort) {
  const grade = meta.grade;
  if (grade?.cleanup?.status === 'failed' || grade?.cleanupError) return false;
  if (grade?.status === 'completed') return true;
  if (cohort === 'context' && grade?.missingFinalDeclaration === true && MISSING_CONTEXT.includes(grade.status)) return true;
  return cohort === 'swe' && grade?.emptyModelPatch === true && grade?.status === 'missing-report' &&
    grade.receipt?.processExit?.code === 0 && grade.receipt.timedOut === false && grade.receipt.processError === null &&
    !grade.receipt.officialInfrastructureFailure && grade.cleanup?.status === 'completed';
}

/** Pure read-only audit. readFile override is used only by local mutation fixtures. */
export function audit({ cohort, split, readFile = p => fs.readFileSync(p), exists = p => fs.existsSync(p), suiteRoot,
  readReceiptHeader = p => { const fd = fs.openSync(p, 'r'), buffer = Buffer.alloc(16384); try { return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)); } finally { fs.closeSync(fd); } },
  ledgerPath, ledgerSha256 }) {
  if (typeof suiteRoot !== 'string' || !path.isAbsolute(suiteRoot)) throw new Error('Explicit absolute suite root required');
  if (!['context', 'swe', 'all'].includes(cohort) || !['pilot', 'confirmation_holdout', 'all'].includes(split)) throw new Error('Explicit --cohort context|swe|all and --split pilot|confirmation_holdout|all required');
  const out = { schemaVersion: 1, status: 'initializing', approvedBy: null, startedAt: new Date().toISOString(), cohort, split,
    errors: [], cells: [], inputHashes: {}, totals: { planned: 0, observed: 0, statuses: {}, gradeStatuses: {}, officialCompleted: 0, explicitMissing: 0 },
    limitations: ['Metadata audit only; root must verify complete frozen pins, source contents and candidate binding and make the final gate decision.',
      'Only the selected closed phase is inspected. Global host lock and mutable suite-summary are not phase-closure evidence while another phase is running.',
      'DSH receipts are read only through first 16 KiB; identity, status and transport fields must be available there or audit fails.',
      'Source/index namespace uniqueness does not prove inode independence. No source tree, index database, model trace body or source manifest contents are read.',
      'Catalog names establish exposure only; native call attempts are not counted as successfully served calls. No success/adoption or quality aggregate is inferred.'] };
  const check = (ok, message, row) => { if (row) row.checks[message] = !!ok; if (!ok) out.errors.push(`${row?.id ?? 'phase'}: ${message}`); };
  const load = p => { const b = readFile(p); out.inputHashes[p] = sha(b); return JSON.parse(b.toString('utf8')); };
  const closedError = (id, error) => out.errors.push(`${id}: ${error.message}`);
  let suite, frozen, selected, loaded, admission;
  try {
    suite = load(path.join(suiteRoot, 'suite.json')); frozen = load(path.join(suiteRoot, 'evidence/suite-freeze.json'));
    if (ledgerPath || ledgerSha256) {
      admission = verifyLedger({ ledgerPath, ledgerSha256, suite, frozen, freezeBytesSha256: out.inputHashes[path.join(suiteRoot, 'evidence/suite-freeze.json')], readFile });
      out.ledger = { path: ledgerPath, sha256: ledgerSha256, approvedBy: admission.ledger.approvedBy, status: admission.ledger.status };
    }
    check(same(suite, frozen.suite) && suite.suiteId === frozen.suiteId, 'suite frozen metadata');
    check(suite.models.length === 4 && new Set(suite.models.map(m => m.family)).size === 4 && new Set(suite.models.map(m => m.id)).size === 4, 'four model identities');
    check(frozen.schedule.length === 288 && new Set(frozen.schedule.map(c => c.id)).size === 288, 'fixed full denominator 288');
    selected = frozen.schedule.filter(c => (cohort === 'all' || c.cohort === cohort) && (split === 'all' || c.split === split));
    const expected = (cohort === 'all' ? 2 : 1) * (split === 'pilot' ? 96 : split === 'confirmation_holdout' ? 48 : 144);
    out.totals.planned = expected; check(selected.length === expected, 'selected fixed denominator');
    loaded = new Map();
    for (const campaign of suite.campaigns.filter(c => selected.some(s => s.campaignId === c.campaignId))) {
      const manifest = load(campaign.manifestPath), freeze = load(path.join(manifest.evidenceDir, 'freeze.json')), config = load(campaign.gradingConfigPath);
      loaded.set(campaign.campaignId, { manifest, freeze, config });
      check(freeze.pins.find(p => ep(p.path, campaign.gradingConfigPath))?.sha256 === out.inputHashes[campaign.gradingConfigPath], `${campaign.campaignId} frozen grading config`);
      check(same(manifest, freeze.manifest), `${campaign.campaignId} frozen manifest`);
      check(same(manifest.model, suite.models.find(m => m.id === campaign.modelId)?.model), `${campaign.campaignId} model contract`);
      check(same(manifest.arms.map(a => a.id), ARMS), `${campaign.campaignId} three arms`);
    }
    const groups = new Map();
    for (const cell of selected) { const key = `${cell.cohort}/${cell.taskId}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(cell); }
    for (const [key, cells] of groups) {
      check(cells.length === 12 && suite.models.every(m => ARMS.every(a => cells.filter(c => c.modelId === m.id && c.arm === a).length === 1)), `${key} four-model three-arm completeness`);
      const tasks = cells.map(c => loaded.get(c.campaignId).manifest.tasks.find(t => t.id === c.taskId));
      check(tasks.every(t => t && same(t, tasks[0])), `${key} source task contract across models`);
    }
    // Closure preflight is deliberately separate: no request, receipt or grade reads for an incomplete phase.
    for (const cell of selected) {
      const { manifest } = loaded.get(cell.campaignId), file = path.join(manifest.evidenceDir, 'attempts', cell.slotId, 'slot-meta.json');
      const row = { id: cell.id, modelId: cell.modelId, taskId: cell.taskId, arm: cell.arm, cohort: cell.cohort, split: cell.split, metaPath: file, checks: {} };
      out.cells.push(row);
      try {
        row.meta = load(file); out.totals.observed++;
        if (admission && cell.id === admission.cell.id) {
          row.infrastructureOutcome = verifyInfraCell({ admission, row, cell, meta: row.meta, manifest, freeze: loaded.get(cell.campaignId).freeze, metadataHash: out.inputHashes[file], exists });
          check(true, 'exact ROOT infrastructure admission', row);
        } else check(['attempt-completed', 'task-failed'].includes(row.meta.status), 'terminal', row);
      }
      catch (error) { closedError(cell.id, error); }
    }
  } catch (error) { closedError('phase', error); }
  if (out.errors.length) { out.status = 'refused-incomplete-or-invalid-selection'; return finish(); }
  const seen = new Map();
  function unique(key, value, row) {
    if (!seen.has(key)) seen.set(key, new Set());
    check(typeof value === 'string' && !!value && !seen.get(key).has(value), `unique ${key}`, row); seen.get(key).add(value);
  }
  for (const row of out.cells) {
    const cell = selected.find(c => c.id === row.id), { manifest, freeze, config } = loaded.get(cell.campaignId), meta = row.meta;
    const dir = path.dirname(row.metaPath), dsh = path.join(dir, 'dsh'), source = path.join(dir, 'source'), home = path.join(dsh, 'home');
    row.status = meta.status; row.gradeStatus = meta.grade?.status; row.outcome = meta.audit?.outcome;
    for (const [key, value] of [['statuses', row.status], ['gradeStatuses', row.gradeStatus]]) out.totals[key][value] = (out.totals[key][value] ?? 0) + 1;
    if (row.infrastructureOutcome) continue;
    try {
      check(meta.audit?.infrastructureValid === true && meta.audit.infrastructureReasons?.length === 0, 'infrastructure valid', row);
      check(!meta.cleanupError && meta.sandboxCleanup?.status !== 'failed' && meta.grade?.cleanup?.status !== 'failed' && !meta.grade?.cleanupError, 'cleanup valid', row);
      if (cell.cohort === 'swe') check(meta.sandboxCleanup?.absent === true && meta.sandboxCleanup?.removed?.code === 0 && meta.sandboxCleanup?.verification?.code === 0 && meta.grade?.cleanup?.status === 'completed', 'SWE cleanup complete', row);
      check(acceptedGrade(meta, cell.cohort), 'accepted frozen grade policy', row);
      const task = manifest.tasks.find(t => t.id === cell.taskId), frozenSlot = freeze.schedule.find(s => s.id === cell.slotId);
      check(meta.freezeHash === sha(freeze) && same(meta.slot, frozenSlot), 'frozen slot identity', row);
      check(meta.taskId === cell.taskId && meta.cohort === cell.cohort && meta.split === cell.split && task?.split === cell.split && task?.cohort === cell.cohort, 'task identity', row);
      const identity = meta.setup?.sourceIdentity;
      check(identity && ['repo', 'baseCommit', 'instanceId'].every(k => identity[k] === task[k]) && ep(identity.manifestFile, task.manifestFile) && identity.sourceHash === meta.sourceHash && meta.sourceHash === freeze.sources.find(s => s.taskId === cell.taskId)?.digest, 'source identity metadata', row);
      check(ep(meta.sourceRoot, source) && ep(meta.receiptPath, path.join(dsh, 'receipt.json')) && ep(meta.bridgeEvidenceDir, path.join(dir, cell.cohort === 'swe' ? 'bridge' : 'inner-bridge')), 'owned namespaces', row);
      const requestPath = path.join(dsh, 'request.json'), request = load(requestPath), bridge = load(path.join(dir, 'bridge-config.json'));
      // Read exactly a bounded prefix; never parse or hash the full model receipt.
      const header = readReceiptHeader(meta.receiptPath), n = header.length, text = header.toString('utf8'), boundary = text.indexOf('  "actualRequestHeaders"');
      if (n > 16384) throw new Error('Receipt prefix exceeds first16KiB');
      if (boundary < 0) throw new Error('required DSH summary boundary unavailable in first16KiB');
      const receipt = JSON.parse(text.slice(0, boundary).trimEnd().replace(/,$/, '') + '}');
      row.receiptHeader = { bytesRead: n, sha256: sha(header) };
      check(receipt.sessionId && receipt.sessionId === request.sessionId && (meta.status === 'attempt-completed' ? receipt.status === 'attempt-completed' : receipt.status === 'attempt-failed'), 'receipt session and status', row);
      check(['provider', 'reasoningEffort'].every(k => request.initialization[k] === manifest.model[k] && receipt.initialization[k] === manifest.model[k]) && request.initialization.model === manifest.model.id && receipt.initialization.model === manifest.model.id, 'model and effort', row);
      check(ep(receipt.initialization.cwd, source) && ep(request.initialization.cwd, source) && ep(request.environment?.DSH_HOME, home) && ep(bridge.root, source) && ep(bridge.evidenceDir, path.join(dir, 'inner-bridge')) && bridge.arm === cell.arm, 'fixed bridge and DSH namespaces', row);
      const outerModelTimeout = receipt.timedOut === true;
      row.receiptExecution = { receiptStatus: receipt.status, timedOut: receipt.timedOut, outerModelTimeout,
        category: outerModelTimeout ? 'outer-model-timeout' : meta.status === 'task-failed' ? 'retained-model-failure' : 'completed-model-attempt',
        providerCallSucceeded: receipt.providerCallSucceeded ?? null };
      check((receipt.timedOut === false || (outerModelTimeout && meta.status === 'task-failed' && receipt.status === 'attempt-failed')) && receipt.protocolError === null && receipt.processExit?.code === 0, 'DSH transport', row);
      for (const [key, value] of Object.entries({ session: receipt.sessionId, home, source, request: requestPath, receipt: meta.receiptPath })) unique(key, value, row);
      if (cell.arm !== 'ordinary') {
        const args = bridge.native?.args ?? [], arg = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
        check(ep(bridge.native?.cwd, source), 'native source namespace', row);
        if (cell.arm === 'codefacts022') { const state = path.join(dir, 'state.sqlite'); check(ep(arg('--root'), source) && ep(arg('--state'), state), 'native private index', row); unique('nativeIndex', state, row); }
        else { check(ep(arg('--path'), source), 'native private index', row); unique('nativeIndex', source, row); }
      }
      const catalogs = load(path.join(dsh, 'catalogs.json'));
      const expected = ['source_list', 'source_read', 'source_search', ...(cell.cohort === 'swe' ? ['source_edit', 'source_delete', 'source_exec', 'source_poll'] : []), ...(cell.arm === 'codefacts022' ? ['codefacts_explore', 'codefacts_expand', 'codefacts_impact'] : cell.arm === 'codegraph' ? ['codegraph_explore'] : [])].map(n => 'mcp__repo__' + n).sort();
      check(catalogs.length > 0 && catalogs.every(c => same(c.map(t => t.name).sort(), expected)), 'actual catalog tool names', row);
      row.catalogCount = catalogs.length; row.nativeCallAttempts = meta.audit.nativeCalls; row.nativeSuccessfulServiceCalls = null;
      const grade = meta.grade, gradePath = path.join(grade.outputDir, 'grade.json'); row.gradePath = gradePath;
      check(/^grade-run-\d+$/.test(path.relative(dir, grade.outputDir)), 'grade owned namespace', row);
      check(same(load(gradePath), grade), 'grade.json equals meta.grade', row);
      check(ep(grade.predictionsPath, path.join(grade.outputDir, 'predictions.json')), 'predictions owned namespace', row);
      const predictions = load(grade.predictionsPath), diagnostics = cell.cohort === 'context' ? load(path.join(grade.outputDir, 'trace-diagnostics.json')) : null;
      check(Array.isArray(predictions) && predictions.length === 1 && predictions[0]?.instance_id === task.instanceId, 'prediction identity', row);
      const prediction = predictions[0];
      check(same(grade.provenance, { freezeHash: sha(freeze), configHash: sha(config), inputHash: sha({ prediction, diagnostics, modelAttemptStatus: meta.status }) }), 'grade provenance binds prediction and diagnostics', row);
      if (cell.cohort === 'swe') check(typeof prediction.model_patch === 'string' && grade.emptyModelPatch === !prediction.model_patch.trim(), 'SWE empty patch evidence', row);
      // Both completed and accepted SWE missing-report ran the official grader.
      if (grade.status === 'completed' || cell.cohort === 'swe') {
        const official = load(path.join(grade.outputDir, 'grader-receipt.json'));
        check(same(official.receipt, grade.receipt) && same(official.metrics, grade.metrics) && official.resolved === grade.resolved && official.status === grade.status, 'official process receipt matches', row);
        const r = grade.receipt;
        check(r.processExit?.code === 0 && r.timedOut === false && r.processError === null && !r.officialInfrastructureFailure, 'official process valid', row);
        if (cell.cohort === 'swe') {
          const cleanup = load(path.join(grade.outputDir, 'official-container-cleanup.json')), sandbox = load(path.join(dir, 'sandbox-cleanup.json'));
          check(same(cleanup, grade.cleanup) && cleanup.status === 'completed' && cleanup.absent === true && !cleanup.error && cleanup.operations?.every(o => o.code === 0 && !o.timedOut) && same(sandbox, meta.sandboxCleanup), 'SWE disk cleanup receipts', row);
        }
      }
      if (grade.status === 'completed') {
        out.totals.officialCompleted++;
        const r = grade.receipt;
        check(ep(r.resultPath, path.join(grade.outputDir, 'result.json')), 'official result namespace', row);
        const bytes = readFile(r.resultPath); out.inputHashes[r.resultPath] = sha(bytes);
        check(sha(bytes) === r.resultSha256, 'official result hash', row);
      } else { out.totals.explicitMissing++; }
      if (cell.cohort === 'context') {
        check(grade.resolved === null, 'Context resolved null', row);
        if (grade.status === 'completed') check(diagnostics.declarationStatus === 'valid' && grade.metrics?.localization != null, 'Context valid declaration metrics', row);
        else check(MISSING_CONTEXT.includes(grade.status) && diagnostics.declarationStatus === grade.status && grade.missingFinalDeclaration === true && grade.metrics === null, 'Context missing quality preserved null', row);
      } else if (grade.status !== 'completed') check(grade.status === 'missing-report' && grade.resolved === null && grade.metrics === null, 'SWE missing stays missing', row);
    } catch (error) { closedError(row.id, error); }
  }
  for (const row of out.cells) { try { check(sha(readFile(row.metaPath)) === out.inputHashes[row.metaPath], 'metadata unchanged during audit', row); } catch (error) { closedError(row.id, error); } }
  out.uniqueNamespaces = Object.fromEntries([...seen].map(([k, v]) => [k, v.size]));
  out.perModel = suite.models.map(m => {
    const cells = out.cells.filter(c => c.modelId === m.id);
    return { modelId: m.id, planned: selected.filter(c => c.modelId === m.id).length, observed: cells.length,
      statuses: Object.fromEntries(['attempt-completed', 'task-failed'].map(s => [s, cells.filter(c => c.status === s).length])),
      officialCompleted: cells.filter(c => c.gradeStatus === 'completed').length,
      explicitMissing: cells.filter(c => !c.infrastructureOutcome && c.gradeStatus !== 'completed').length,
      ...(admission ? { infrastructureMissing: cells.filter(c => c.infrastructureOutcome).length } : {}) };
  });
  out.status = out.errors.length ? 'failed' : 'metadata-audit-passed-awaiting-root-review';
  return finish();
  function finish() {
    if (admission) {
      const infrastructureMissing = out.cells.filter(c => c.infrastructureOutcome).length;
      const actualModelTerminal = out.cells.filter(c => ['attempt-completed', 'task-failed'].includes(c.meta?.status ?? c.status)).length;
      out.accounting = { planned: out.totals.planned, accounted: actualModelTerminal + infrastructureMissing, actualModelTerminal, infrastructureMissing,
        remainingPlanned: out.totals.planned - actualModelTerminal - infrastructureMissing, infrastructureQuality: null, infrastructureTokens: null, infrastructureModelTimeMs: null };
    }
    for (const row of out.cells) delete row.meta; out.endedAt = new Date().toISOString(); return out;
  }
}

if (process.argv[1] && ep(process.argv[1], fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  for (const flag of ['--suite-root', '--output-dir', '--cohort', '--split']) if (!args.includes(flag) || !value(flag) || value(flag).startsWith('--')) throw new Error('Required argument: ' + flag);
  const suiteRoot = value('--suite-root'), outputDir = value('--output-dir');
  if (!path.isAbsolute(suiteRoot) || !path.isAbsolute(outputDir)) throw new Error('Suite and output roots must be absolute');
  const cohort = value('--cohort'), split = value('--split'), result = audit({ cohort, split, suiteRoot, ledgerPath: args.includes('--ledger') ? value('--ledger') : undefined, ledgerSha256: args.includes('--ledger-sha256') ? value('--ledger-sha256') : undefined });
  const name = `${cohort}-${split}`;
  const output = writeArtifact(outputDir, name, result);
  const report = writeArtifact(outputDir, name, `# Closed phase metadata audit\n\n${result.status}\n\nSelected ${cohort}/${split}; planned=${result.totals.planned}, observed=${result.totals.observed}, official=${result.totals.officialCompleted}, missing=${result.totals.explicitMissing}, errors=${result.errors.length}.\n\nJSON: ${output}\n\n${result.limitations.map(x => '- ' + x).join('\n')}\n\n${result.errors.slice(0, 12).map(x => '- ' + x).join('\n')}\n`, 'md');
  console.log(JSON.stringify({ status: result.status, totals: result.totals, errors: result.errors.length, output, report }));
  process.exitCode = result.errors.length ? 1 : 0;
}
