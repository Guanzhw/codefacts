import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const DEFAULT_BASE = 'C:/Users/QQ110/.codex/visualizations/2026/09/10/01a08ba7-0ca2-72b2-82a0-178d382c195f';
export const PINNED_BINARY_SHA256 = '2e725c9b3947545aecce845ba7fdd41d58e8fd456743d0cd9da2d34355ce7576';
const callableKinds = new Set(['method', 'function']);
const containerKinds = new Set(['class', 'struct', 'interface', 'trait']);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const idOf = (row) => row?.id ?? `${row?.kind ?? ''}:${row?.evidence?.file_path ?? row?.file_path ?? ''}:${row?.name ?? ''}:${row?.evidence?.start_line ?? row?.start_line ?? ''}`;
const evidenceOf = (row) => row?.evidence ?? row ?? {};
const identityOf = (row) => {
  const e = evidenceOf(row);
  return { name: row?.name ?? null, file_path: e.file_path ?? row?.file_path ?? null, start_line: e.start_line ?? row?.start_line ?? null };
};
const sameIdentity = (a, b) => a && b && a.name === b.name && a.file_path === b.file_path && a.start_line === b.start_line;

export function queryTokens(query) {
  if (typeof query !== 'string' || !/^\s*[A-Za-z0-9_]+(?:\s+[A-Za-z0-9_]+){1}\s*$/.test(query)) return null;
  return query.trim().split(/\s+/);
}

/** Stable top-5 replay reranker. It does not discover or create candidates. */
export function rerankSearchResponse(response, query, contextBySymbolId = new Map()) {
  const tokens = queryTokens(query);
  const rows = Array.isArray(response?.results) ? response.results.slice(0, 5) : [];
  if (!tokens || !rows.some((row) => row.name === tokens[0] && containerKinds.has(row.kind))) {
    return { response, applied: false, reason: tokens ? 'container-token0-missing' : 'query-not-exactly-two-ascii-tokens', missingContextSymbolIds: [] };
  }
  const matches = rows.filter((row) => row.name === tokens[1] && callableKinds.has(row.kind));
  if (!matches.length) return { response, applied: false, reason: 'callable-token1-missing', missingContextSymbolIds: [] };
  const ordered = [...matches, ...rows.filter((row) => !matches.includes(row))];
  if (ordered.every((row, i) => row === rows[i])) return { response, applied: false, reason: 'already-ordered', missingContextSymbolIds: [] };
  const firstId = idOf(ordered[0]);
  const context = contextBySymbolId.get(firstId);
  const missing = context ? [] : [firstId];
  const modeled = { ...response, results: ordered, context_entries: context ? [context] : [] };
  return { response: modeled, applied: true, reason: 'exact-container-callable-rerank', missingContextSymbolIds: missing };
}

export function metricFor(response, expected) {
  const rows = Array.isArray(response?.results) ? response.results.slice(0, 5) : [];
  const index = rows.findIndex((row) => sameIdentity(identityOf(row), expected));
  const matched = index < 0 ? null : rows[index];
  const top1 = index === 0;
  const mrr5 = index < 0 ? 0 : 1 / (index + 1);
  const recall5 = index < 0 ? 0 : 1;
  const first = response?.context_entries?.[0];
  const source = first?.source;
  const span = expected?.essentialSpan;
  const sourceStart = source?.start_line;
  const sourceEnd = source?.end_line;
  const coverage = Array.isArray(span) && Number.isInteger(sourceStart) && Number.isInteger(sourceEnd)
    ? source.status === 'ok' && evidenceOf(first.symbol).file_path === expected.file_path && span[0] >= sourceStart && span[1] <= sourceEnd : null;
  return { firstRelevantRank: index < 0 ? null : index + 1, top1, mrr5, recall5, kindMismatch: Boolean(matched && expected?.kind && matched.kind !== expected.kind), firstContextSymbolId: first?.symbol?.id ?? null, firstSourceBytes: source?.byte_length ?? null, essentialSpanCovered: coverage };
}

export async function verifyEvidence(response, repositoryRoot) {
  const files = new Map();
  const load = async (filePath) => {
    if (!files.has(filePath)) { const bytes = await readFile(resolve(repositoryRoot, filePath)); files.set(filePath, bytes); }
    return files.get(filePath);
  };
  const checks = [];
  for (const row of response?.results ?? []) {
    const evidence = evidenceOf(row); if (!evidence.file_path || !evidence.source_hash) continue;
    const bytes = await load(evidence.file_path);
    checks.push({ symbolId: idOf(row), sourceHashMatches: sha256(bytes) === evidence.source_hash });
  }
  for (const entry of response?.context_entries ?? []) {
    const evidence = evidenceOf(entry.symbol); const source = entry.source;
    if (!evidence.file_path || !source?.text || !Number.isInteger(source.start_line) || !Number.isInteger(source.end_line)) { checks.push({ symbolId: entry.symbol?.id ?? null, contextSourceMatches: false }); continue; }
    const bytes = await load(evidence.file_path); const text = bytes.toString('utf8');
    const lines = text.match(/.*(?:\r\n|\n|\r|$)/g)?.filter((line) => line.length > 0) ?? [];
    const excerpt = lines.slice(source.start_line - 1, source.end_line).join('');
    checks.push({ symbolId: entry.symbol?.id ?? null, contextSourceMatches: excerpt === source.text && Buffer.byteLength(source.text) === source.byte_length });
  }
  return { checks, allMatch: checks.every((check) => Object.values(check).slice(1).every(Boolean)) };
}

async function runServer(binary, root, statePath, cases) {
  return new Promise((done) => {
    const child = spawn(binary, ['mcp', '--root', root, '--state', statePath], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const messages = [], stderr = []; let buffer = '', cursor = 0, timer, stopped = false;
    const queue = [{ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ranking-validation', version: '1' } } }, { method: 'notifications/initialized', params: {} }, { id: 2, method: 'tools/call', params: { name: 'map', arguments: { repository_root: root } } }, ...cases.map((c, i) => ({ id: 10 + i, method: 'tools/call', params: { name: 'search', arguments: { repository_root: root, query: c.query, detail: 'context', context_limit: 1, limit: 5 } } }))];
    const finish = (result) => { if (stopped) return; stopped = true; clearTimeout(timer); if (child.exitCode === null) child.kill(); done({ root, messages, stderr: stderr.join(''), ...result }); };
    const advance = () => { clearTimeout(timer); if (cursor >= queue.length) return finish({ ok: true }); const request = queue[cursor++]; child.stdin.write(`${JSON.stringify(request)}\n`); if (request.id) timer = setTimeout(() => finish({ ok: false, error: `timeout waiting for request ${request.id}` }), 60000); else advance(); };
    child.stdout.on('data', (chunk) => { buffer += chunk.toString('utf8'); let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1); if (!line) continue; let message; try { message = JSON.parse(line); } catch (error) { return finish({ ok: false, error: `invalid JSON: ${error.message}` }); } messages.push(message); if (message.id != null) { if (message.error || message.result?.isError) return finish({ ok: false, error: `request ${message.id} failed` }); advance(); } } });
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8'))); child.once('error', (error) => finish({ ok: false, error: error.message })); child.once('close', (code, signal) => finish({ ok: false, error: `server exited: ${code}/${signal}` })); advance();
  });
}

const args = process.argv.slice(2); const mode = args[0];
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] || fallback : fallback; };
const base = resolve(flag('--base', DEFAULT_BASE));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const casesPath = resolve(flag('--cases', `${repo}/benchmarks/agent-eval/ranking-validation-cases.json`));
const outDir = resolve(flag('--output-dir', `${base}/ranking-validation-2026-09-13`));

async function prepare() {
  if (existsSync(outDir)) throw new Error(`refusing to overwrite existing output directory: ${outDir}`);
  const cases = JSON.parse(await readFile(casesPath, 'utf8'));
  const binary = resolve(flag('--binary', `${base}/value-screen-2026-09-12/bin/codefacts.exe`));
  const binaryBytes = await readFile(binary); const binaryHash = sha256(binaryBytes);
  if (binaryHash !== PINNED_BINARY_SHA256) throw new Error(`binary hash mismatch: ${binaryHash}`);
  await mkdir(outDir, { recursive: true });
  const receipt = { schemaVersion: 1, status: 'prepared', createdAt: new Date().toISOString(), base, binary, binarySha256: binaryHash, casesPath, casesSha256: sha256(await readFile(casesPath)), driverSha256: sha256(await readFile(fileURLToPath(import.meta.url))), sourceRevisions: cases.sourceRevisions ?? null, options: { detail: 'context', context_limit: 1, limit: 5, maxSearchCalls: 24, mapCalls: 2, retries: 0, timeoutMs: 60000 } };
  await writeFile(`${outDir}/receipt.json`, json(receipt), { flag: 'wx' });
  process.stdout.write(json({ status: 'prepared', outputDir: outDir, receipt: `${outDir}/receipt.json` }));
}

async function run() {
  const receipt = JSON.parse(await readFile(`${outDir}/receipt.json`, 'utf8'));
  if (receipt.status !== 'prepared') throw new Error('run requires a prepared receipt');
  if (sha256(await readFile(casesPath)) !== receipt.casesSha256 || sha256(await readFile(receipt.binary)) !== receipt.binarySha256 || sha256(await readFile(fileURLToPath(import.meta.url))) !== receipt.driverSha256) throw new Error('frozen artifact hash mismatch');
  const cases = JSON.parse(await readFile(casesPath, 'utf8')).cases;
  if (!cases.length || cases.length > receipt.options.maxSearchCalls || cases.some((c) => !['codefacts', 'opensession'].includes(c.repository))) throw new Error('case budget or repository mismatch');
  await writeFile(`${outDir}/run-started.json`, json({ startedAt: new Date().toISOString() }), { flag: 'wx' });
  const snapshots = { codefacts: `${base}/token-eval/repos/codefacts`, opensession: `${base}/token-eval/repos/opensession` };
  const records = [];
  for (const [repository, root] of Object.entries(snapshots)) {
    const state = `${outDir}/${repository}.sqlite`;
    const record = await runServer(receipt.binary, root, state, cases.filter((c) => c.repository === repository));
    records.push({ repository, root, ...record });
    await writeFile(`${outDir}/${repository}-raw.json`, json(record), { flag: 'wx' });
    if (!record.ok) throw new Error(`MCP replay failed: ${record.error}`);
  }
  await writeFile(`${outDir}/raw-responses.json`, json({ schemaVersion: 1, receipt, records }), { flag: 'wx' });
  const payload = (message) => message?.result?.structuredContent ?? JSON.parse(message?.result?.content?.find((x) => x.type === 'text')?.text ?? '{}');
  const contexts = new Map();
  for (const record of records) {
    const map = payload(record.messages.find((m) => m.id === 2));
    if (map.freshness?.status !== 'fresh' || resolve(map.freshness.repository_root) !== resolve(record.root)) throw new Error('map freshness/root mismatch');
    const byId = new Map();
    for (const message of record.messages.filter((m) => m.id >= 10)) {
      const body = payload(message);
      if (body.freshness?.status !== 'fresh' || resolve(body.freshness.repository_root) !== resolve(record.root)) throw new Error('search freshness/root mismatch');
      for (const entry of body.context_entries ?? []) if (entry.symbol?.id) byId.set(entry.symbol.id, entry);
    }
    contexts.set(record.repository, byId);
  }
  const portable = [];
  for (const record of records) for (const [localIndex, c] of cases.filter((x) => x.repository === record.repository).entries()) {
    const message = record.messages.find((m) => m.id === 10 + localIndex); const baseline = payload(message);
    const candidate = rerankSearchResponse(baseline, c.query, contexts.get(record.repository));
    const baselineText = message?.result?.content?.find((x) => x.type === 'text')?.text ?? JSON.stringify(baseline);
    const expected = { ...c.expected, essentialSpan: c.essentialSpan };
    const baselineMetrics = metricFor(baseline, expected); const candidateMetrics = metricFor(candidate.response, expected);
    const evidence = await verifyEvidence(baseline, record.root);
    const candidateEvidence = await verifyEvidence(candidate.response, record.root);
    if (!evidence.allMatch || !candidateEvidence.allMatch) throw new Error(`source evidence mismatch: ${c.id}`);
    portable.push({ id: c.id, repository: c.repository, query: c.query, cohort: c.cohort, role: c.role, actualBaselineTextContentBytes: Buffer.byteLength(baselineText), modeledBaselinePayloadBytes: Buffer.byteLength(JSON.stringify(baseline)), modeledCandidatePayloadBytes: Buffer.byteLength(JSON.stringify(candidate.response)), baseline: baselineMetrics, candidate: { ...candidateMetrics, falsePromotion: candidate.applied && !candidateMetrics.top1 }, evidence, candidateEvidence, rerank: { applied: candidate.applied, reason: candidate.reason, missingContextSymbolIds: candidate.missingContextSymbolIds } });
  }
  await writeFile(`${outDir}/results.json`, json({ schemaVersion: 1, binarySha256: receipt.binarySha256, casesSha256: receipt.casesSha256, results: portable, actualBaselineTextContentBytes: portable.reduce((n, x) => n + x.actualBaselineTextContentBytes, 0), modeledBaselinePayloadBytes: portable.reduce((n, x) => n + x.modeledBaselinePayloadBytes, 0), modeledCandidatePayloadBytes: portable.reduce((n, x) => n + x.modeledCandidatePayloadBytes, 0) }), { flag: 'wx' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (mode === '--prepare') await prepare(); else if (mode === '--run') await run(); else throw new Error('usage: node ranking-validation.mjs --prepare|--run [--base PATH]');
}
