import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), inventory = path.join(here, 'SOURCE-INVENTORY.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const excluded = new Set(['validation/synthetic', 'rolling-suite-controller-v3/synthetic-fixtures']);
function files(directory = here, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const relative = prefix + entry.name, absolute = path.join(directory, entry.name);
    if (relative === 'SOURCE-INVENTORY.json' || excluded.has(relative)) return [];
    if (entry.isDirectory()) return files(absolute, relative + '/');
    if (!entry.isFile()) throw new Error('Unexpected source entry: ' + relative);
    return [{ path: relative, sha256: sha(fs.readFileSync(absolute)) }];
  });
}
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--write') {
  const value = { schemaVersion: 1, kind: 'portable-controller-source-inventory', excludedGeneratedDirectories: [...excluded], files: files() };
  fs.writeFileSync(inventory, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ files: value.files.length, manifestSha256: sha(fs.readFileSync(inventory)) }));
} else if (argv.length === 2 && argv[0] === '--verify' && /^[a-f0-9]{64}$/.test(argv[1])) {
  const bytes = fs.readFileSync(inventory);
  if (sha(bytes) !== argv[1]) throw new Error('Source inventory trusted hash differs');
  const value = JSON.parse(bytes);
  if (value.schemaVersion !== 1 || JSON.stringify(value.files) !== JSON.stringify(files())) throw new Error('Delivered source file membership or hashes differ');
  console.log(JSON.stringify({ status: 'verified', files: value.files.length, manifestSha256: argv[1] }));
} else throw new Error('Usage: node source-inventory.mjs --write | --verify TRUSTED_RAW_MANIFEST_SHA256');
