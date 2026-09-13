import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { metricFor, verifyEvidence, runServer } from './ranking-validation.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const here = dirname(fileURLToPath(import.meta.url));

const flag = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1] || process.argv[i + 1].startsWith('-')) throw new Error(`${name} requires a path`);
  return resolve(process.argv[i + 1]);
};

function payload(message) {
  const text = message?.result?.content?.find((part) => part.type === 'text')?.text;
  return message?.result?.structuredContent ?? (text ? JSON.parse(text) : null);
}

export function archiveSnapshot(archive, root) {
  const script = [
    'import hashlib,json,sys,tarfile,pathlib',
    'out={}; root=pathlib.Path(sys.argv[2])',
    'with tarfile.open(sys.argv[1], "r:*") as t:',
    '  for m in t.getmembers():',
    '    if m.isfile():',
    '      f=t.extractfile(m); b=f.read(); actual=(pathlib.Path(sys.argv[2])/m.name).read_bytes()',
    '      if actual != b: raise ValueError("snapshot file differs from archive: " + m.name)',
    '      out[m.name]={"sha256":hashlib.sha256(actual).hexdigest(),"bytes":len(actual)}',
    'actual_paths={p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}',
    'if actual_paths != set(out): raise ValueError("snapshot file set differs from archive")',
    'print(json.dumps(out,sort_keys=True,separators=(",",":")))',
  ].join('\n');
  const result = spawnSync('python', ['-X', 'utf8', '-c', script, archive, root], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`archive audit failed for ${archive}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

function validateManifest(manifest, manifestPath) {
  if (!manifest || !Array.isArray(manifest.cases) || !manifest.cases.length || manifest.cases.length > 28) throw new Error('manifest must contain 1..28 cases');
  if (!manifest.repositories || !manifest.binaries?.baseline || !manifest.binaries?.candidate) throw new Error('manifest requires repositories and baseline/candidate binaries');
  for (const c of manifest.cases) {
    if (!c.id || !c.repository || !c.query || !c.expected || !c.essentialSpan || !manifest.repositories[c.repository]) throw new Error(`invalid case ${c.id ?? '<unknown>'}`);
  }
  for (const [id, repo] of Object.entries(manifest.repositories)) {
    if (!repo.root || !repo.archive || !existsSync(resolve(repo.root)) || !existsSync(resolve(repo.archive))) throw new Error(`repository ${id} root/archive is missing`);
  }
  for (const [arm, binary] of Object.entries(manifest.binaries)) {
    if (!binary.path || !binary.sha256 || !existsSync(resolve(binary.path))) throw new Error(`${arm} binary is missing`);
  }
  return { manifestPath, cases: manifest.cases };
}

function evidenceAllowsUnavailableContext(response, checks) {
  const allowed = new Set((response?.context_entries ?? []).filter((entry) => ['unavailable', 'ambiguous'].includes(entry?.source?.status)).map((entry) => entry.symbol?.id));
  return checks.every((check) => check.contextSourceMatches !== false || allowed.has(check.symbolId));
}

function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.cohort ?? 'unspecified'}/${row.arm}`;
    const group = groups.get(key) ?? { cases: 0, top1: 0, recall5: 0, mrr5: 0, coverageKnown: 0, coverage: 0 };
    group.cases += 1; group.top1 += row.top1 ? 1 : 0; group.recall5 += row.recall5; group.mrr5 += row.mrr5;
    if (row.coverage !== null) { group.coverageKnown += 1; group.coverage += row.coverage ? 1 : 0; }
    groups.set(key, group);
  }
  return Object.fromEntries([...groups].map(([cohort, g]) => [cohort, { cases: g.cases, top1Rate: g.top1 / g.cases, recall5Mean: g.recall5 / g.cases, mrr5Mean: g.mrr5 / g.cases, coverageRate: g.coverageKnown ? g.coverage / g.coverageKnown : null, coverageKnown: g.coverageKnown }]));
}

async function main() {
  const manifestPath = flag('--manifest');
  const outputDir = flag('--output-dir');
  if (existsSync(outputDir)) throw new Error(`refusing to overwrite existing output directory: ${outputDir}`);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateManifest(manifest, manifestPath);
  const driver = fileURLToPath(import.meta.url);
  const binaries = {};
  for (const arm of ['baseline', 'candidate']) {
    const entry = manifest.binaries[arm];
    const actual = sha256(await readFile(resolve(entry.path)));
    if (actual !== entry.sha256) throw new Error(`${arm} binary hash mismatch: ${actual}`);
    binaries[arm] = { path: resolve(entry.path), sha256: actual };
  }
  const repositories = {};
  for (const [id, repo] of Object.entries(manifest.repositories)) {
    repositories[id] = { root: resolve(repo.root), archive: resolve(repo.archive), archiveSha256: sha256(await readFile(resolve(repo.archive))), revision: repo.revision ?? null, before: archiveSnapshot(resolve(repo.archive), resolve(repo.root)) };
  }
  const receipt = { schemaVersion: 1, status: 'launched', createdAt: new Date().toISOString(), manifest: manifestPath, manifestSha256: sha256(manifestBytes), driverSha256: sha256(await readFile(driver)), helperSha256: sha256(await readFile(resolve(here, 'ranking-validation.mjs'))), binaries, repositories: Object.fromEntries(Object.entries(repositories).map(([id, r]) => [id, { root: r.root, archive: r.archive, archiveSha256: r.archiveSha256, revision: r.revision, before: r.before }])), options: { detail: 'context', context_limit: 1, limit: 5, timeoutMs: 60000, maxSearchCallsPerBinary: 28, mapCallsPerRepositoryPerBinary: 1, retries: 0 } };
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}/launch-receipt.json`, json(receipt), { flag: 'wx' });

  const allRows = [];
  const casesByRepo = new Map(Object.keys(repositories).map((id) => [id, manifest.cases.filter((c) => c.repository === id)]));
  for (const arm of ['baseline', 'candidate']) {
    for (const [repository, info] of Object.entries(repositories)) {
      const cases = casesByRepo.get(repository) ?? [];
      const state = resolve(outputDir, `${arm}-${repository}.sqlite`);
      const record = await runServer(binaries[arm].path, info.root, state, cases);
      await writeFile(resolve(outputDir, `${arm}-${repository}-response.json`), json({ schemaVersion: 1, arm, repository, record }), { flag: 'wx' });
      if (!record.ok) throw new Error(`${arm}/${repository} MCP replay failed: ${record.error}`);
      const map = payload(record.messages.find((m) => m.id === 2));
      if (!map || map.freshness?.status !== 'fresh' || resolve(map.freshness.repository_root) !== info.root) throw new Error(`${arm}/${repository} map freshness/root mismatch`);
      for (let i = 0; i < cases.length; i += 1) {
        const c = cases[i];
        const message = record.messages.find((m) => m.id === 10 + i);
        const response = payload(message);
        if (!response || response.freshness?.status !== 'fresh' || resolve(response.freshness.repository_root) !== info.root) throw new Error(`${arm}/${repository}/${c.id} search freshness/root mismatch`);
        const evidence = await verifyEvidence(response, info.root);
        if (!evidenceAllowsUnavailableContext(response, evidence.checks) || evidence.checks.some((check) => check.sourceHashMatches === false)) throw new Error(`${arm}/${repository}/${c.id} source evidence mismatch`);
        const expected = { ...c.expected, essentialSpan: c.essentialSpan };
        const metrics = metricFor(response, expected);
        const text = message?.result?.content?.find((part) => part.type === 'text')?.text ?? JSON.stringify(response);
        allRows.push({ id: c.id, cohort: c.cohort ?? null, repository, query: c.query, arm, top1: metrics.top1, rank: metrics.firstRelevantRank, mrr5: metrics.mrr5, recall5: metrics.recall5, coverage: metrics.essentialSpanCovered, actualTextBytes: Buffer.byteLength(text), firstSourceBytes: metrics.firstSourceBytes, kindMismatch: metrics.kindMismatch, sourceChecks: { ...evidence, contextStatus: (response.context_entries ?? []).map((entry) => ({ symbolId: entry.symbol?.id ?? null, status: entry.source?.status ?? null })) } });
      }
    }
  }
  if (allRows.length !== manifest.cases.length * 2) throw new Error(`partial results: expected ${manifest.cases.length * 2}, got ${allRows.length}`);
  const after = {};
  for (const [id, info] of Object.entries(repositories)) {
    after[id] = archiveSnapshot(info.archive, info.root);
    if (sha256(await readFile(info.archive)) !== info.archiveSha256) throw new Error(`source archive hash changed: ${id}`);
    if (JSON.stringify(after[id]) !== JSON.stringify(info.before)) throw new Error(`source archive changed: ${id}`);
  }
  await writeFile(resolve(outputDir, 'results.json'), json({ schemaVersion: 1, manifestSha256: receipt.manifestSha256, driverSha256: receipt.driverSha256, binaries, repositories: Object.fromEntries(Object.entries(repositories).map(([id, r]) => [id, { root: r.root, revision: r.revision, archive: r.archive, before: r.before, after: after[id] }])), results: allRows, summary: summarize(allRows) }), { flag: 'wx' });
  process.stdout.write(json({ status: 'complete', outputDir, cases: manifest.cases.length, rows: allRows.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
