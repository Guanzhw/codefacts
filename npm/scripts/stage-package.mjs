import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const npmDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return 'Usage: node stage-package.mjs --version <version> --checksums <SHA256SUMS> --output <directory>';
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!['--version', '--checksums', '--output'].includes(flag) || !value || options[flag]) {
      throw new Error(usage());
    }
    options[flag] = value;
  }
  if (Object.keys(options).length !== 3) {
    throw new Error(usage());
  }
  return options;
}

function parseChecksums(text) {
  const assets = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const match = line.match(/^([a-f0-9]{64})\s+\*?([^\s]+)$/i);
    if (!match) {
      throw new Error(`invalid SHA256SUMS line: ${line}`);
    }
    const [, checksum, assetName] = match;
    if (assets[assetName]) {
      throw new Error(`duplicate SHA256SUMS asset: ${assetName}`);
    }
    assets[assetName] = checksum.toLowerCase();
  }
  if (Object.keys(assets).length === 0) {
    throw new Error('SHA256SUMS must contain at least one asset');
  }
  return Object.fromEntries(Object.entries(assets).sort(([left], [right]) => left.localeCompare(right)));
}

const options = parseArguments(process.argv.slice(2));
const outputDirectory = resolve(options['--output']);
const checksumFile = resolve(options['--checksums']);
const packageMetadata = JSON.parse(await readFile(resolve(npmDirectory, 'package.json'), 'utf8'));
const platformAssets = JSON.parse(await readFile(resolve(npmDirectory, 'assets.json'), 'utf8'));
if (packageMetadata.version !== options['--version']) {
  throw new Error(
    `npm package version (${packageMetadata.version}) does not match release version (${options['--version']})`,
  );
}

const assets = parseChecksums(await readFile(checksumFile, 'utf8'));
const expectedAssetNames = Object.values(platformAssets)
  .map((asset) => asset.assetName)
  .sort();
const suppliedAssetNames = Object.keys(assets).sort();
if (JSON.stringify(suppliedAssetNames) !== JSON.stringify(expectedAssetNames)) {
  throw new Error(
    `SHA256SUMS must contain exactly the supported release assets: ${expectedAssetNames.join(', ')}`,
  );
}
await rm(outputDirectory, { recursive: true, force: true });
await cp(npmDirectory, outputDirectory, {
  recursive: true,
  filter: (source) => !['node_modules', '.npm', 'test'].includes(source.split(/[\\/]/).at(-1)),
});
await writeFile(
  resolve(outputDirectory, 'checksums.json'),
  `${JSON.stringify({ version: options['--version'], assets }, null, 2)}\n`,
);
process.stdout.write(`Staged checksum-pinned npm package in ${outputDirectory}.\n`);
