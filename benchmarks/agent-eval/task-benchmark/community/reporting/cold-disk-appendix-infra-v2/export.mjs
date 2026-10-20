import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { derive, render } from './appendix.mjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Caller verifies the original public bundle first. This small exporter only pins
// adapted bytes and writes an exclusive sibling appendix; the accepted bundle is unchanged.
export function exportAppendix({ input, sha256, output }) {
  const source = path.resolve(input), destination = path.resolve(output);
  if (path.dirname(source) === destination || path.dirname(destination) !== path.dirname(path.dirname(source))) throw new Error('Output must be a new sibling directory of the verified public bundle');
  const bytes = fs.readFileSync(source);
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || hash(bytes) !== sha256) throw new Error('Explicit adapted JSON SHA-256 mismatch');
  const adapted = JSON.parse(bytes);
  if (adapted.schemaVersion !== 1 || adapted.kind !== 'timing-regime-adapted-public-results') throw new Error('Verified timing-regime adapted boundary required');
  const report = { ...derive(adapted), source: { adaptedSha256: sha256, prerequisite: 'ROOT verified original timing-regime public bundle before invoking this exporter' } };
  const contents = { 'appendix.json': JSON.stringify(report, null, 2) + '\n', 'APPENDIX.zh-CN.md': render(report) };
  assert.deepStrictEqual(fs.readFileSync(source), bytes, 'Adapted input changed during derivation');
  fs.mkdirSync(destination);
  for (const [name, content] of Object.entries(contents)) fs.writeFileSync(path.join(destination, name), content, { flag: 'wx' });
  return { output: destination, sourceSha256: sha256, files: Object.fromEntries(Object.entries(contents).map(([name, content]) => [name, hash(content)])) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--input' || args[2] !== '--sha256' || args[4] !== '--output') throw new Error('Usage: --input ABS/VERIFIED-public/adapted.json --sha256 HASH --output ABS/NEW-sibling-appendix');
    console.log(JSON.stringify(exportAppendix({ input: args[1], sha256: args[3], output: args[5] }), null, 2));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
