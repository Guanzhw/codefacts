import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const npmDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return 'Usage: node stage-platform-package.mjs --version <version> --platform <platform-key> --binary <path> --output <directory>';
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!['--version', '--platform', '--binary', '--output'].includes(flag) || !value || options[flag]) {
      throw new Error(usage());
    }
    options[flag] = value;
  }
  if (Object.keys(options).length !== 4) {
    throw new Error(usage());
  }
  return options;
}

function sha256(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.once('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('end', () => resolveHash(hash.digest('hex')));
  });
}

const options = parseArguments(process.argv.slice(2));
const outputDirectory = resolve(options['--output']);
const binaryPath = resolve(options['--binary']);
const packageMetadata = JSON.parse(await readFile(resolve(npmDirectory, 'package.json'), 'utf8'));
const platformAssets = JSON.parse(await readFile(resolve(npmDirectory, 'assets.json'), 'utf8'));
const asset = platformAssets[options['--platform']];
if (!asset) {
  throw new Error(`unsupported platform key: ${options['--platform']}`);
}
if (packageMetadata.version !== options['--version']) {
  throw new Error(
    `npm package version (${packageMetadata.version}) does not match release version (${options['--version']})`,
  );
}
await stat(binaryPath);
const checksum = await sha256(binaryPath);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(binaryPath, resolve(outputDirectory, asset.executableName));
if (asset.os !== 'win32') {
  // Artifact downloads do not preserve executable bits on every runner.
  await chmod(resolve(outputDirectory, asset.executableName), 0o755);
}
await cp(resolve(npmDirectory, 'LICENSE'), resolve(outputDirectory, 'LICENSE'));
await writeFile(
  resolve(outputDirectory, 'README.md'),
  `# ${asset.packageName}\n\nNative CodeFacts ${options['--platform']} binary for CodeFacts ${options['--version']}.\n`,
);
await writeFile(
  resolve(outputDirectory, 'package.json'),
  `${JSON.stringify({
    name: asset.packageName,
    version: options['--version'],
    description: `CodeFacts native binary for ${options['--platform']}`,
    license: 'MIT',
    repository: packageMetadata.repository,
    os: [asset.os],
    cpu: [asset.cpu],
    files: [asset.executableName, 'README.md', 'LICENSE'],
    codefacts: {
      platform: options['--platform'],
      assetName: asset.assetName,
      executableName: asset.executableName,
      sha256: checksum,
    },
  }, null, 2)}\n`,
);
process.stdout.write(`Staged ${asset.packageName}@${options['--version']} in ${outputDirectory}.\n`);
