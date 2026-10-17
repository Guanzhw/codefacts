import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSlot, COMMON } from './campaign.mjs';
import { createBridge } from '../bridge.mjs';
import { hash, writeJson } from '../rpc.mjs';
import { extractTrace } from './trace.mjs';

const sdkRoot = process.env.TASK_BENCHMARK_SDK_ROOT ?? 'C:/Users/QQ110/.dsh/profiles/web/node_modules/@modelcontextprotocol/sdk';
const enabled = fs.existsSync(path.join(sdkRoot, 'dist/cjs/client/index.js'));

test('real preparation and source bridge feed actual Context exposure into grading', { skip: !enabled }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-trace-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = path.join(dir, 'archive'); fs.mkdirSync(sourceRoot);
  const body = 'const actual = 1;\nconst unread = 2;\n';
  fs.writeFileSync(path.join(sourceRoot, 'x.js'), body);
  const entries = [{ path: 'x.js', bytes: Buffer.byteLength(body), sha256: hash(body), mode: '100644' }];
  const task = { id: 'ctx-fixture', cohort: 'context', instanceId: 'org__repo-1', repo: 'org/repo',
    baseCommit: 'a'.repeat(40), sourceRoot, manifestFile: path.join(dir, 'source.json'),
    language: 'javascript', split: 'pilot', prompt: 'Locate the actual variable.' };
  writeJson(task.manifestFile, { repo: task.repo, instanceId: task.instanceId, baseCommit: task.baseCommit, entries, digest: hash(entries) });
  const manifest = { campaignId: 'integration-fixture', evidenceDir: path.join(dir, 'campaign'),
    tasks: [task], arms: [{ id: 'ordinary' }], runtime: { node: process.execPath, sdkRoot, rg: process.execPath },
    model: { provider: 'opencode-go', id: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    timeoutMs: 1200000, maxOutputTokens: 32768 };
  const slot = { id: 'ctx-fixture-ordinary', taskId: task.id, cohort: 'context', arm: 'ordinary' };
  const frozen = { manifest, schedule: [slot] };
  const answer = JSON.stringify({ regions: [{ file_path: 'x.js', start_line: 1, end_line: 1 }], rationale: 'Read the definition.' });
  const meta = await runSlot(manifest, frozen, slot, { runDshAttempt: async options => {
    const bridge = await createBridge(JSON.parse(fs.readFileSync(options.bridgeConfig, 'utf8')));
    try {
      const result = await bridge.callTool({ name: 'source_read', arguments: { file_path: 'x.js', start_line: 1, end_line: 1 } });
      assert.equal(result.isError, undefined);
    } finally { await bridge.close(); }
    return { status: 'attempt-completed', answer, didInitialize: true, headerAudit: true,
      actualRequestHeaders: [{}], catalogs: [COMMON.map(name => ({ name: `mcp__repo__${name}` }))], toolCalls: [] };
  } });
  const trace = extractTrace({ root: sourceRoot, bridgeDir: meta.bridgeEvidenceDir,
    task: { instanceId: task.instanceId, repo: task.repo, baseCommit: task.baseCommit }, answer });
  assert.equal(meta.status, 'attempt-completed');
  assert.equal(trace.prediction.traj_data.pred_steps.length, 1);
  assert.deepEqual(trace.prediction.traj_data.pred_steps[0].spans['x.js'], [{ start: 1, end: 1 }]);
  assert.equal(trace.diagnostics.declarationStatus, 'valid');
});
