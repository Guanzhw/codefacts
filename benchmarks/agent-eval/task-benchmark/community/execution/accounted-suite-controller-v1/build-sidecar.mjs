import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtime } from '../config.mjs';
export const ORIGINAL = path.join(runtime().config.frameworkDir, 'suite.mjs');
export function transform(source, originalURL = pathToFileURL(ORIGINAL).href) {
  const changes = [];
  let output = source.replace(/(from\s+|import\(\s*)(['"])(\.{1,2}\/[^'"\r\n]+)\2/g, (match, prefix, quote, specifier) => {
    const replacement = `${prefix}${quote}${new URL(specifier, originalURL).href}${quote}`;
    changes.push({ kind: 'relative-import', from: match, to: replacement }); return replacement;
  });
  output = output.replace(/import\.meta\.url/g, () => { changes.push({ kind: 'original-module-url', to: originalURL }); return JSON.stringify(originalURL); });
  output += '\n// Operational sidecar: expose unchanged private read-only checks.\nexport { verifySuite, auditProducedCells, acceptedGrade, terminal };\n';
  return { output, changes };
}
export function build(directory) {
  const source = fs.readFileSync(ORIGINAL, 'utf8'), { output, changes } = transform(source);
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const target = path.join(directory, 'suite-exposed.mjs');
  fs.writeFileSync(target, output, { flag: 'wx' });
  const receipt = { schemaVersion: 1, originalPath: ORIGINAL, originalURL: pathToFileURL(ORIGINAL).href, originalSha256: sha(source), sidecarPath: target,
    sidecarSha256: sha(output), changes, appendedExports: ['verifySuite', 'auditProducedCells', 'acceptedGrade', 'terminal'], preservedOriginalModuleURL: true };
  fs.writeFileSync(path.join(directory, 'sidecar-transform.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}
export function ensureSidecar() {
  const directory = runtime().config.sidecarBuildDir, target = path.join(directory, 'suite-exposed.mjs');
  if (!fs.existsSync(directory)) { fs.mkdirSync(directory); build(directory); }
  const source = fs.readFileSync(ORIGINAL, 'utf8'), expected = transform(source).output;
  if (fs.readFileSync(target, 'utf8') !== expected) throw new Error('Configured mechanical sidecar differs');
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'sidecar-transform.json'), 'utf8'));
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  if (receipt.originalPath !== ORIGINAL || receipt.originalURL !== pathToFileURL(ORIGINAL).href || receipt.originalSha256 !== sha(source) || receipt.sidecarPath !== target || receipt.sidecarSha256 !== sha(expected)) throw new Error('Configured sidecar receipt differs');
  return target;
}
