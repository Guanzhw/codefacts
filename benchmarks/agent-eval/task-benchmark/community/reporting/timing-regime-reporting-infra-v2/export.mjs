import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCore, projectInputs } from '../public-results-infra-v1/export.mjs';
import { recompute, verifyData, validateData } from '../public-results-infra-v1/statistics.mjs';
import { digest, jsonBytes, pinned, options, PRODUCER_SHA256 } from '../public-results-infra-v1/common.mjs';
import { adapt, verifyAdapted } from './adapter.mjs';
import { render } from './formatter.mjs';
import { assembleMap } from './provenance.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const FILES = ['adapted.json', 'PRIMARY.zh-CN.md', 'adapter.mjs', 'formatter.mjs', 'verify.mjs', 'producer-core.mjs', 'common.mjs', 'statistics.mjs', 'METHODS.md'];

export async function exportPackage(args) {
  const inputs = Object.fromEntries(['report', 'summary', 'selection', 'producer', 'timing-inventory'].map(name => [name, pinned(args[name], args[`${name}-sha256`], name)]));
  const report = JSON.parse(inputs.report), summary = JSON.parse(inputs.summary), selection = JSON.parse(inputs.selection);
  if (args['producer-sha256'] !== PRODUCER_SHA256 || report.input.sha256 !== args['summary-sha256']) throw new Error('Producer/report summary binding differs');
  const coreSource = deriveCore(inputs.producer.toString('utf8'));
  const core = await import(`data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`);
  const { data, expected } = projectInputs(report, summary, selection);
  verifyData(data, expected, core); // Verify accepted numbers before removing the old time channel.
  const map = assembleMap(data, JSON.parse(inputs['timing-inventory']));
  if (map.summarySha256 !== args['summary-sha256']) throw new Error('Timing map summary binding differs');
  const adapted = adapt(data, expected, map, recompute, core);
  verifyAdapted(adapted, validateData, recompute, core);
  const contents = { 'adapted.json': jsonBytes(adapted), 'PRIMARY.zh-CN.md': render(adapted), 'producer-core.mjs': coreSource };
  for (const name of ['adapter.mjs', 'formatter.mjs', 'verify.mjs', 'METHODS.md']) contents[name] = fs.readFileSync(path.join(ROOT, name));
  for (const name of ['common.mjs', 'statistics.mjs']) contents[name] = fs.readFileSync(path.join(ROOT, '../public-results-infra-v1', name));
  const manifest = { schemaVersion: 1, kind: 'timing-regime-public-arithmetic', suiteId: data.suiteId, sources: Object.fromEntries(Object.keys(inputs).map(name => [name, digest(inputs[name])])),
    files: Object.fromEntries(FILES.map(name => [name, digest(contents[name])])), claim: 'offline-arithmetic-reproduction-of-root-accepted-closed-inputs' };
  for (const name of Object.keys(inputs)) pinned(args[name], args[`${name}-sha256`], name);
  const output = path.resolve(args.output); fs.mkdirSync(output);
  for (const name of FILES) fs.writeFileSync(path.join(output, name), contents[name], { flag: 'wx' });
  const bytes = jsonBytes(manifest); fs.writeFileSync(path.join(output, 'manifest.json'), bytes, { flag: 'wx' });
  return { output, manifestSha256: digest(bytes), ...verifyAdapted(adapted, validateData, recompute, core) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = ['report', 'summary', 'selection', 'producer', 'timing-inventory'];
  try { console.log(JSON.stringify(await exportPackage(options(process.argv.slice(2), [...names.flatMap(name => [name, `${name}-sha256`]), 'output'])), null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
