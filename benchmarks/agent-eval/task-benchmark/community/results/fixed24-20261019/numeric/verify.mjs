import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyAdapted } from './adapter.mjs';
import { render } from './formatter.mjs';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const FILES = ['adapted.json', 'PRIMARY.zh-CN.md', 'adapter.mjs', 'formatter.mjs', 'verify.mjs', 'producer-core.mjs', 'common.mjs', 'statistics.mjs', 'METHODS.md'];
export async function verifyPackage(manifestPath, sha256) {
  const root = path.dirname(path.resolve(manifestPath)), bytes = fs.readFileSync(manifestPath);
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || digest(bytes) !== sha256) throw new Error('Explicit manifest SHA-256 mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'timing-regime-public-arithmetic') throw new Error('Public manifest schema differs');
  if (manifest.claim !== 'offline-arithmetic-reproduction-of-root-accepted-closed-inputs') throw new Error('Unsupported verification claim');
  assert.deepStrictEqual(Object.keys(manifest.sources).sort(), ['report', 'summary', 'selection', 'producer', 'timing-inventory'].sort(), 'Source inventory differs');
  if (!Object.values(manifest.sources).every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error('Missing source hash');
  assert.deepStrictEqual(Object.keys(manifest.files).sort(), [...FILES].sort(), 'Package file inventory');
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['manifest.json', ...FILES].sort(), 'Self-contained file inventory');
  for (const name of FILES) {
    const file = path.join(root, name);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || digest(fs.readFileSync(file)) !== manifest.files[name]) throw new Error(`Package file SHA-256 differs: ${name}`);
  }
  const { PRODUCER_SHA256 } = await import(pathToFileURL(path.join(root, 'common.mjs')).href);
  if (manifest.sources.producer !== PRODUCER_SHA256) throw new Error('Unsupported producer hash');
  const adapted = JSON.parse(fs.readFileSync(path.join(root, 'adapted.json')));
  if (adapted.nonTimingData.suiteId !== manifest.suiteId || adapted.timingMap.summarySha256 !== manifest.sources.summary) throw new Error('Manifest input binding differs');
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'PRIMARY.zh-CN.md'), 'utf8'), render(adapted), 'Chinese rendering differs');
  const core = await import(pathToFileURL(path.join(root, 'producer-core.mjs')).href);
  const { validateData, recompute } = await import(pathToFileURL(path.join(root, 'statistics.mjs')).href);
  return { ...verifyAdapted(adapted, validateData, recompute, core), manifestSha256: sha256, claim: manifest.claim };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--sha256') throw new Error('Usage: --manifest ABS/manifest.json --sha256 EXPECTED');
    console.log(JSON.stringify(await verifyPackage(args[1], args[3]), null, 2));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
