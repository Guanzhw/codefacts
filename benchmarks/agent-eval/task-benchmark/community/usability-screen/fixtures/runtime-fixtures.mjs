import fs from 'node:fs';
import path from 'node:path';

export async function prepareCommunitySlot({ task, dir }) {
  if (task.id === 'fixture-truncated-cell') { fs.writeFileSync(path.join(dir, 'cell.json'), '{'); process.exit(7); }
  if (task.id === 'fixture-slow-sibling') await new Promise(resolve => setTimeout(resolve, 1100));
  if (task.id === 'fixture-prepare-failure') throw new Error('deliberate source fixture failure');
  const root = path.join(dir, 'source'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.rs'), 'fn target() {}\n');
  return { root, entries: [], bridgeConfig: 'fixture', setup: { fixtureOnly: true } };
}
export function verifyCommunitySource() { return { verified: true, fixtureOnly: true }; }
export async function runDshAttempt() {
  return { status: 'attempt-failed', answer: '', timings: { promptedAtMs: 20, turnEndedAtMs: null }, toolCalls: [],
    exactTurnUsage: null, knownUsageLowerBound: { totalTokens: 3 }, usageAvailability: 'known-lower-bound' };
}
