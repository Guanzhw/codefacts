import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadCommunitySources } from './prepare.mjs';
import { validateManifest } from './campaign.mjs';
import { hash } from '../rpc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const absolute = (value, name) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
};
const args = process.argv.slice(2);
const execute = args.at(-1) === '--execute';
if (execute) args.pop();
if (args.length !== 4 || args[0] !== '--mode' || !['sources', 'manifest'].includes(args[1]) || args[2] !== '--config') {
  throw new Error('Usage: --mode sources|manifest --config ABS [--execute] (default: read-only plan)');
}
const configPath = absolute(args[3], 'config');
const config = read(configPath);
const selectionFile = path.join(here, 'selection-fixed-24.json');
const selection = read(selectionFile);
const sourcesDir = absolute(config.sourcesDir, 'sourcesDir');
const sourceEvidenceDir = absolute(config.sourceEvidenceDir, 'sourceEvidenceDir');

if (args[1] === 'sources') {
  if (fs.existsSync(sourcesDir) || fs.existsSync(sourceEvidenceDir)) throw new Error('Source and download evidence directories must both be new');
  if (execute) {
    const results = await downloadCommunitySources(selection, {
      sourcesDir, evidenceDir: sourceEvidenceDir, concurrency: 2,
      symlinkStrategy: config.runtime.symlinkStrategy,
      wsl: config.runtime.wsl, wslDistro: config.runtime.wslDistro,
    });
    if (results.some(row => !row.eligible)) throw new Error('Source preparation incomplete; inspect retained receipts');
  }
  console.log(JSON.stringify({ mode: 'sources', execute, tasks: selection.selections.length }));
} else {
  if (!['context', 'swe'].includes(config.cohort)) throw new Error('cohort must be context or swe');
  const dataDir = absolute(config.dataDir, 'dataDir');
  const setupDir = absolute(config.setupDir, 'setupDir');
  const gradingConfigFile = absolute(config.gradingConfigFile, 'gradingConfigFile');
  if (fs.existsSync(setupDir)) throw new Error('setupDir must be new');
  const grading = read(gradingConfigFile);
  const publicFile = path.join(dataDir, 'public-tasks.jsonl');
  const rows = fs.readFileSync(publicFile, 'utf8').trim().split('\n').map(JSON.parse);
  if (rows.length !== 24) throw new Error('Expected all 24 fixed public task inputs');
  for (const fixed of selection.selections) {
    const row = rows.find(row => row.dataset === fixed.dataset && row.id === fixed.id);
    if (!row || ['repo', 'base_commit', 'language', 'split'].some(key => row[key] !== fixed[key])) throw new Error('Public task differs from fixed selection');
  }
  const dataset = config.cohort === 'context' ? 'contextbench' : 'swebench_multilingual';
  const tasks = selection.selections.filter(row => row.dataset === dataset).map(fixed => {
    const row = rows.find(row => row.dataset === dataset && row.id === fixed.id);
    const manifestFile = path.join(sourcesDir, dataset, row.id, 'manifest.json');
    const source = read(manifestFile);
    if (source.repo !== row.repo || source.baseCommit !== row.base_commit || source.instanceId !== row.id || source.digest !== hash(source.entries)) throw new Error('Source manifest identity differs from fixed task');
    const task = {
      id: `${config.cohort === 'context' ? 'ctx' : 'swe'}-${row.id}`, instanceId: row.id,
      cohort: config.cohort, language: row.language, split: row.split,
      prompt: row.problem_statement, repo: row.repo, baseCommit: row.base_commit,
      sourceRoot: path.join(sourcesDir, dataset, row.id, 'source'), manifestFile,
    };
    if (config.cohort === 'context' && !grading.contextBases?.[task.id]) throw new Error(`Missing private Context baseline: ${task.id}`);
    if (config.cohort === 'swe') task.sandbox = config.sandboxes?.[row.id];
    return task;
  });
  if (!grading.grading?.[config.cohort]) throw new Error('Missing official grading settings for cohort');
  const manifest = {
    schemaVersion: 1, campaignId: config.campaignId,
    evidenceDir: path.join(setupDir, 'campaign'), selectionFile,
    runtime: config.runtime, model: { provider: 'opencode-go', id: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    concurrency: 1, timeoutMs: 1200000, maxOutputTokens: 32768,
    arms: config.arms, tasks,
    evaluation: {
      inputFiles: [configPath, gradingConfigFile, publicFile, ...config.inputFiles],
      upstreamRoots: config.upstreamRoots, runtimeFiles: config.runtimeFiles,
    },
  };
  validateManifest(manifest);
  if (execute) {
    fs.mkdirSync(setupDir, { recursive: true });
    fs.writeFileSync(path.join(setupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(setupDir, 'preparation-receipt.json'), JSON.stringify({
      status: 'manifest-validated', tasks: tasks.length, cohort: config.cohort,
      configPath, sourceInventoryChecked: false,
      nextGate: 'campaign freeze verifies complete source inventory and runtime pins; environment controls remain required',
    }, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ mode: 'manifest', execute, status: 'manifest-validated', tasks: tasks.length }));
}
