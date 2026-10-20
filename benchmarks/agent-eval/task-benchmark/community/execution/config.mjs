import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CONFIG_MODULE = fileURLToPath(import.meta.url);
export const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fields = ['suitePath', 'frameworkDir', 'guardModule', 'sidecarBuildDir', 'runtimeVolumePath', 'evidenceVolumePath'];

export function loadConfig(argv) {
  if (argv[0] !== '--config' || typeof argv[1] !== 'string' || !path.isAbsolute(argv[1])) throw new Error('Required first pair: --config ABS_CONFIG');
  const configArgument = argv[1], configPath = path.resolve(configArgument);
  const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (value.schemaVersion !== 1 || Object.keys(value).some(key => key !== 'schemaVersion' && !fields.includes(key))) throw new Error('Invalid controller configuration schema');
  const config = { schemaVersion: 1 };
  for (const key of fields) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error('Required configuration path: ' + key);
    config[key] = path.resolve(path.dirname(configPath), value[key]);
  }
  for (const file of [config.suitePath, path.join(config.frameworkDir, 'suite.mjs'), config.guardModule]) if (!fs.statSync(file).isFile()) throw new Error('Configuration source must be a file: ' + file);
  for (const directory of [config.frameworkDir, config.runtimeVolumePath, config.evidenceVolumePath]) if (!fs.statSync(directory).isDirectory()) throw new Error('Configuration directory required: ' + directory);
  const identity = { configPath, configSha256: sha(configPath), configModuleSha256: sha(CONFIG_MODULE), resolved: config };
  return { config: Object.freeze(config), identity, configPath, configArgument, args: argv.slice(2) };
}

let current;
export function runtime() { return current ??= loadConfig(process.argv.slice(2)); }
export function withConfig(args) { return ['--config', runtime().configArgument, ...args]; }
export function assertConfigIdentity(identity) {
  const active = runtime();
  if (sha(active.configPath) !== active.identity.configSha256 || sha(CONFIG_MODULE) !== active.identity.configModuleSha256 || JSON.stringify(identity) !== JSON.stringify(active.identity)) throw new Error('Approved controller configuration differs');
}
