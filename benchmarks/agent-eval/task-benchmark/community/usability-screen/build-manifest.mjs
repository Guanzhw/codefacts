// One-time preparation from a frozen screen template and an existing community source pack.
// Reads no credentials or model logs. Output files are exclusive: choose a new identity and directory.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validate } from './run.mjs';
import { verifyCommunitySource } from '../prepare.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const TASKS = [
  ['ctx-cli__cli-3608', 'cli__cli-3608', '026b07d1cfbf23a3ccb4d4703a2496d65e177fcc'],
  ['ctx-nushell__nushell-12901', 'nushell__nushell-12901', '580c60bb821af25f838edafd8461bb206d3419f3'],
  ['ctx-sveltejs__svelte-3394', 'sveltejs__svelte-3394', 'bb9a9efec275084983117adee52718b5a35376b6'],
  ['ctx-mui__material-ui-34229', 'mui__material-ui-34229', 'fa62bf35e109ede215cb8cbae66ba4d6a30fef60'],
];
const MODELS = [['qwen', 'qwen3.8-flash'], ['claude', 'claude-haiku-5-5'], ['gpt', 'gpt-6-luna']];

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith('--') || !value || values.has(key)) throw new Error('Expected unique --name VALUE arguments');
    values.set(key, value);
  }
  const keys = ['--source-manifest', '--sources-root', '--candidate-exe', '--evidence-dir', '--output-dir', '--campaign-id', '--seed'];
  if (values.size !== keys.length || keys.some(key => !values.has(key))) throw new Error(`Usage: node build-manifest.mjs ${keys.map(key => `${key} VALUE`).join(' ')}`);
  for (const key of keys.slice(0, 5)) if (!path.isAbsolute(values.get(key))) throw new Error(`${key} must be an absolute path`);
  if (!/^[\w.-]+$/.test(values.get('--campaign-id'))) throw new Error('--campaign-id must contain only letters, digits, dot, underscore, or hyphen');
  return Object.fromEntries(keys.map(key => [key.slice(2).replaceAll('-', ''), values.get(key)]));
}

function prepare(options) {
  const manifest = structuredClone(read(options.sourcemanifest));
  if (manifest.templateOnly === true) throw new Error('Template-only manifest must be copied and configured before building');
  if (JSON.stringify(manifest.tasks.map(task => [task.id, task.instanceId, task.baseCommit])) !== JSON.stringify(TASKS) ||
      JSON.stringify(manifest.models.map(model => [model.key, model.id])) !== JSON.stringify(MODELS)) {
    throw new Error('Source manifest does not match the frozen task commits and model routes');
  }
  manifest.campaignId = options.campaignid;
  manifest.seed = options.seed;
  manifest.evidenceDir = options.evidencedir;
  const candidate = manifest.arms.find(arm => arm.id === 'candidate');
  if (!candidate) throw new Error('Source manifest has no candidate arm');
  candidate.executable = options.candidateexe;

  for (const task of manifest.tasks) {
    const taskRoot = path.join(options.sourcesroot, task.instanceId);
    task.sourceRoot = path.join(taskRoot, 'source');
    task.manifestFile = path.join(taskRoot, 'manifest.json');
    const source = read(task.manifestFile);
    if (source.repo !== task.repo || source.baseCommit !== task.baseCommit || source.instanceId !== task.instanceId ||
        !Array.isArray(source.entries) || source.digest !== digest(JSON.stringify(source.entries)) || source.digest !== task.sourceDigest) {
      throw new Error(`Source identity or digest mismatch ${task.id}`);
    }
    verifyCommunitySource(task.sourceRoot, source.entries, { exact: true });
    task.sourceDigest = source.digest;
    for (const gate of task.gates) {
      const file = path.join(task.sourceRoot, gate.file);
      const relative = path.relative(task.sourceRoot, file);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Gate escapes source root ${task.id}/${gate.id}`);
      const bytes = fs.readFileSync(file), lines = bytes.toString('utf8').split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      if (!Number.isSafeInteger(gate.start) || !Number.isSafeInteger(gate.end) || gate.start < 1 || gate.end < gate.start || gate.end > lines.length) {
        throw new Error(`Invalid gate range ${task.id}/${gate.id}`);
      }
      if (gate.sha256 !== digest(bytes)) throw new Error(`Gate source hash mismatch ${task.id}/${gate.id}`);
    }
  }
  validate(manifest);
  return manifest;
}

export function build(argv) {
  const options = argumentsFrom(argv), manifest = prepare(options);
  fs.mkdirSync(options.outputdir, { recursive: true });
  fs.mkdirSync(options.evidencedir, { recursive: true });
  for (const [name, value] of [['tasks.json', manifest.tasks], ['manifest.json', manifest]]) {
    fs.writeFileSync(path.join(options.outputdir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  return { campaignId: manifest.campaignId, seed: manifest.seed, tasks: manifest.tasks.map(task => task.instanceId),
    sourceDigests: manifest.tasks.map(task => task.sourceDigest), outputDir: options.outputdir, evidenceDir: manifest.evidenceDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(build(process.argv.slice(2)), null, 2));
}
