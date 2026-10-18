import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtime, withConfig, assertConfigIdentity, CONFIG_MODULE } from '../config.mjs';
const { config: CONFIG, identity: CONFIG_IDENTITY, configPath: CONFIG_PATH, args: ARGS } = runtime();
const { verifySuite, auditProducedCells, acceptedGrade, terminal } = await import(pathToFileURL(ensureSidecar()).href);
import { ensureSidecar } from './build-sidecar.mjs';

export const SUITE = CONFIG.suitePath;
export const S = path.dirname(SUITE);
export const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
export const hash = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const sha = p => hash(fs.readFileSync(p));
const equal = (a, b) => hash(a) === hash(b);
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
const absolute = p => { if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Absolute path required'); return p; };
const resolveEvidence = p => path.isAbsolute(p) ? p : path.join(S, p);
const binding = value => Object.fromEntries(['schemaVersion', 'suiteId', 'suiteFreezeHash', 'cohort', 'cells'].map(k => [k, value[k]]));
export function loadContext(suitePath = SUITE) {
  const suite = read(suitePath), loaded = new Map(suite.campaigns.map(c => [c.campaignId, read(c.manifestPath)]));
  const freezePath = path.join(suite.evidenceDir, 'suite-freeze.json');
  return { suitePath, suite, loaded, freezePath, frozen: read(freezePath) };
}
const metaPath = (context, cell) => path.join(context.loaded.get(cell.campaignId).evidenceDir, 'attempts', cell.slotId, 'slot-meta.json');
function checkPin(pin) { if (sha(absolute(pin.path)) !== pin.sha256) throw new Error('Evidence hash differs: ' + pin.path); }
export function validateKnown(context, ledger, { signed = true } = {}) {
  const { suite, frozen, freezePath, loaded } = context;
  if (ledger.schemaVersion !== 1 || ledger.suiteId !== suite.suiteId || ledger.suiteFreezeSha256 !== sha(freezePath)) throw new Error('Known-infrastructure ledger frozen identity differs');
  if (signed && (ledger.status !== 'root-approved' || ledger.approvedBy !== 'root')) throw new Error('Root-approved infrastructure ledger required');
  if (sha(absolute(ledger.supplementPath)) !== ledger.supplementSha256) throw new Error('Protocol supplement differs');
  const ids = new Set();
  for (const item of ledger.knownInfraCells) {
    if (ids.has(item.id)) throw new Error('Duplicate known infrastructure ID'); ids.add(item.id);
    const cell = frozen.schedule.find(c => c.id === item.id);
    if (!cell || item.reason !== 'native-init-failed-before-model' || item.noModelRequest !== true || item.recoveryClosed !== true || item.resolved !== null || item.tokens !== null) throw new Error('Known infrastructure decision must close a pre-model failure with unknown quality');
    const canonical = metaPath(context, cell);
    if (path.resolve(item.canonicalMetadataPath) !== path.resolve(canonical) || sha(canonical) !== item.metadataSha256) throw new Error('Known canonical metadata differs');
    const campaignFrozen = read(path.join(loaded.get(cell.campaignId).evidenceDir, 'freeze.json'));
    const slot = campaignFrozen.schedule.find(row => row.id === cell.slotId);
    if (!Array.isArray(item.costRefs) || item.costRefs.length === 0 || !Array.isArray(item.failureEvidence) || item.failureEvidence.length === 0) throw new Error('Failure costs and evidence are required');
    const costPaths = new Set();
    for (const cost of item.costRefs) {
      const file = absolute(cost.metadataPath); if (costPaths.has(path.resolve(file))) throw new Error('Duplicate failure cost'); costPaths.add(path.resolve(file));
      if (sha(file) !== cost.metadataSha256) throw new Error('Historical failure metadata differs');
      const meta = read(file), dir = path.dirname(file);
      if (meta.status !== 'infrastructure-failed' || meta.freezeHash !== hash(campaignFrozen) || !equal(meta.slot, slot) || meta.taskId !== cell.taskId || meta.cohort !== cell.cohort || meta.split !== cell.split) throw new Error('Historical failure identity differs');
      if (meta.grade?.status !== 'pending' || meta.grade.resolved !== null || meta.grade.metrics !== null || meta.audit || meta.sourceRoot || fs.existsSync(path.join(dir, 'dsh'))) throw new Error('Known failure is not a pre-model pending allocation');
      // Archived metadata retains its original receiptPath; no fabricated receipt is accepted.
      if (!Number.isFinite(cost.slotWallMs) || cost.slotWallMs !== meta.slotWallMs || cost.slotWallMs < 0) throw new Error('Failure cost differs');
    }
    if (!costPaths.has(path.resolve(canonical))) throw new Error('Canonical failure cost omitted');
    for (const pin of item.failureEvidence) checkPin(pin);
  }
  return ids;
}
export function auditAccounted(context, ledger, options = {}) {
  for (const cell of context.frozen.schedule) {
    const file = metaPath(context, cell);
    if (fs.existsSync(path.dirname(file)) && !fs.existsSync(file)) throw new Error('Partial allocated slot requires root review: ' + cell.id);
  }
  const known = validateKnown(context, ledger, options);
  const produced = auditProducedCells(context.suite, context.loaded, context.frozen.schedule.filter(c => !known.has(c.id)));
  for (const row of produced) if (!terminal(row.meta) || !acceptedGrade(row.meta, row.cohort)) throw new Error('New or prior cell requires root review: ' + row.id);
  return { known, produced };
}
export function pilotBinding(context, produced, cohort) {
  const cells = context.frozen.schedule.filter(c => c.cohort === cohort && c.split === 'pilot').map(cell => {
    const found = produced.find(row => row.id === cell.id);
    if (!found || !terminal(found.meta) || !acceptedGrade(found.meta, cohort)) throw new Error('Pilot incomplete or infrastructure-invalid: ' + cell.id);
    return Object.fromEntries(['id', 'campaignId', 'modelId', 'slotId', 'metadataHash', 'receiptHash', 'requestHash'].map(k => [k, found[k]]));
  });
  return { schemaVersion: 1, suiteId: context.suite.suiteId, suiteFreezeHash: hash(context.frozen), cohort, status: 'pending-root-review', approvedBy: null, cells };
}
export function requirePilot(context, produced, cohort, review) {
  const candidate = pilotBinding(context, produced, cohort);
  if (review.status !== 'root-reviewed-pilot' || review.approvedBy !== 'root' || !equal(binding(candidate), binding(review))) throw new Error('Exact root-reviewed pilot binding required');
}
export function snapshotProduced(context, produced) {
  return produced.flatMap(row => {
    const meta = metaPath(context, row), dir = path.dirname(meta);
    const files = [meta, row.meta.receiptPath, path.join(dir, 'dsh/request.json'), path.join(dir, 'bridge-config.json')];
    if (row.meta.grade?.status === 'completed') files.push(row.meta.grade.receipt.resultPath);
    return files.map(file => ({ id: row.id, path: file, sha256: sha(file) }));
  });
}
export function checkPrior(rows) { for (const row of rows) if (sha(row.path) !== row.sha256) throw new Error('Prior model evidence changed: ' + row.id + ' ' + row.path); }
