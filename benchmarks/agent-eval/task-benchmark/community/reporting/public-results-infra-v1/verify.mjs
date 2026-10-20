import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUITE, FRAMEWORK, PRODUCER_SHA256, FILES, keys, check, equal, isDigest, digest, pinned, contained, options } from './common.mjs';
import { verifyData } from './statistics.mjs';

export async function verifyPackage(manifestPath, manifestSha256) {
  const root = path.dirname(path.resolve(manifestPath));
  check(path.basename(manifestPath) === 'manifest.json' && fs.lstatSync(manifestPath).isFile() && !fs.lstatSync(manifestPath).isSymbolicLink(), 'One regular manifest.json required');
  const manifest = JSON.parse(pinned(manifestPath, manifestSha256, 'public manifest'));
  keys(manifest, ['schemaVersion', 'kind', 'suiteId', 'producer', 'sources', 'files', 'scope'], 'manifest');
  check(manifest.schemaVersion === 1 && manifest.kind === 'accepted-results-arithmetic-projection' && manifest.suiteId === SUITE, 'Public manifest identity differs');
  keys(manifest.producer, ['version', 'frameworkRevision', 'aggregateSha256', 'coreDerivation'], 'producer');
  check(manifest.producer.version === '2.0.0-infra' && manifest.producer.frameworkRevision === FRAMEWORK && manifest.producer.aggregateSha256 === PRODUCER_SHA256 && manifest.producer.coreDerivation === 'aggregate-core-v1', 'Unsupported producer derivation');
  keys(manifest.sources, ['acceptedReportSha256', 'summarySha256', 'selectionSha256', 'closureSha256', 'approvedLedgerSha256'], 'source hashes');
  for (const key of ['acceptedReportSha256', 'summarySha256', 'selectionSha256']) check(isDigest(manifest.sources[key]), 'Source hash required');
  for (const key of ['closureSha256', 'approvedLedgerSha256']) check(manifest.sources[key] === null || isDigest(manifest.sources[key]), 'Nullable source hash required');
  check((manifest.sources.closureSha256 === null) === (manifest.sources.approvedLedgerSha256 === null), 'Closure source hashes must be paired');
  equal(manifest.scope, { plannedCells: 288, plannedNativeCells: 192, contextConfirmation: 'historically-observed-replication', sweConfirmation: 'confirmation', authority: 'existing-accepted-inputs-only', claim: 'public-arithmetic-reproduction' }, 'Public scope');
  keys(manifest.files, FILES, 'package file inventory');
  for (const name of FILES) {
    check(isDigest(manifest.files[name]), 'Package file hash required');
    check(digest(fs.readFileSync(contained(root, name))) === manifest.files[name], `Package file SHA-256 differs: ${name}`);
  }
  equal(fs.readdirSync(root).sort(), ['manifest.json', ...FILES].sort(), 'Single self-contained package inventory');
  const data = JSON.parse(fs.readFileSync(contained(root, 'data.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(contained(root, 'expected.json'), 'utf8'));
  check((data.infrastructure.length > 0) === (manifest.sources.closureSha256 !== null), 'Public classification/source closure differs');
  const core = await import(pathToFileURL(contained(root, 'producer-core.mjs')).href);
  verifyData(data, expected, core);
  return { status: 'passed', claim: manifest.scope.claim, suiteId: manifest.suiteId, plannedCells: 288,
    actualModelTerminal: expected.overallExecution.actualModelTerminal, signedInfrastructure: expected.overallExecution.signedInfrastructure,
    accountedClosed: expected.overallExecution.accountedClosed, expectedSuccessfulNativeCells: 192 - data.infrastructure.length, manifestSha256 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = options(process.argv.slice(2), ['manifest', 'sha256']);
    console.log(JSON.stringify(await verifyPackage(args.manifest, args.sha256), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
