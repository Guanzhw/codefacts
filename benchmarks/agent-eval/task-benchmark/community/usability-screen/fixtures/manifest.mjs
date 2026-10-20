import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
export function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-screen-manifest-fixture-'));
  const tasks = ['cli__cli-3608', 'nushell__nushell-12901', 'sveltejs__svelte-3394', 'mui__material-ui-34229'].map((instanceId, index) => {
    const sourceRoot = path.join(root, instanceId, 'source'); fs.mkdirSync(sourceRoot, { recursive: true });
    const files = [`src/${index}.rs`, `tests/${index}.rs`, `src/extra-${index}.rs`];
    const entries = files.map(file => {
      const bytes = `fixture ${instanceId} ${file}\n`;
      fs.mkdirSync(path.dirname(path.join(sourceRoot, file)), { recursive: true }); fs.writeFileSync(path.join(sourceRoot, file), bytes);
      return { path: file, bytes: Buffer.byteLength(bytes), sha256: digest(Buffer.from(bytes)) };
    });
    const source = { repo: instanceId, baseCommit: String(index + 1).padStart(40, '0'), instanceId, entries };
    source.digest = digest(JSON.stringify(entries));
    const manifestFile = path.join(root, instanceId, 'manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify(source));
    return { id: `ctx-${instanceId}`, instanceId, cohort: 'context', repo: source.repo, baseCommit: source.baseCommit,
      sourceRoot, manifestFile, sourceDigest: source.digest,
      prompt: `Issue ${instanceId}. Investigation: explain the production behavior and regression coverage.`,
      gates: files.map((file, gateIndex) => ({ id: `gate-${gateIndex}`, file, start: 1, end: 1,
        criterion: `Explain behavior in ${file}.`, sha256: entries[gateIndex].sha256 })) };
  });
  const manifest = { schemaVersion: 1, campaignId: 'fixture-screen', seed: 'fixture-seed', evidenceDir: path.join(root, 'evidence'),
    concurrency: 4, timeoutMs: 360000, maxOutputTokens: 16384,
    runtime: { node: process.execPath, rg: path.join(root, 'missing-rg'), dshRoot: path.join(root, 'missing-dsh'),
      sdkRoot: path.join(root, 'missing-sdk'), contextSourceMode: 'copy', contextGitMode: 'boundary-only' },
    arms: [{ id: 'ordinary' }, { id: 'codefacts022', executable: path.join(root, 'missing-baseline.exe') },
      { id: 'candidate', executable: path.join(root, 'missing-candidate.exe') }, { id: 'codegraph', node: path.join(root, 'missing-cg-node'), cli: path.join(root, 'missing-cg.js') }],
    models: [['qwen', 'qwen3.8-flash'], ['claude', 'claude-haiku-5-5'], ['gpt', 'gpt-6-luna']].map(([key, id]) => ({ key, id, provider: 'opencode-go', reasoningEffort: 'high' })), tasks };
  return { root, manifest };
}
