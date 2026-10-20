import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, verifyPackage } from './core.mjs';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.argv.length === 4, 'Usage: node verify.mjs MANIFEST SHA256');
    console.log(JSON.stringify(verifyPackage(path.resolve(process.argv[2]), process.argv[3]), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
