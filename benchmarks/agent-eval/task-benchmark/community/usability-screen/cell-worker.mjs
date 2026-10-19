import fs from 'node:fs';
import path from 'node:path';
import { runCell } from './run.mjs';

const [manifestPath, cellId] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const frozen = JSON.parse(fs.readFileSync(path.join(manifest.evidenceDir, 'freeze.json'), 'utf8'));
const cell = frozen.schedule.find(value => value.id === cellId);
if (!cell) throw new Error(`Unknown frozen cell: ${cellId}`);
process.send?.({ type: 'ready', cellId, at: new Date().toISOString() });
// Parent validates the frozen runtime/source once before admission. Existing
// preparation verifies the per-cell copy; each worker owns its SDK/RPC loop.
await runCell(manifest, frozen, cell);
process.send?.({ type: 'result', cellId, cellFile: path.join(manifest.evidenceDir, 'attempts', cellId, 'cell.json') });
process.disconnect?.();
