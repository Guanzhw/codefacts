import { cp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const npmDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return 'Usage: node stage-package.mjs --version <version> --output <directory>';
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!['--version', '--output'].includes(flag) || !value || options[flag]) {
      throw new Error(usage());
    }
    options[flag] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error(usage());
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const outputDirectory = resolve(options['--output']);
const packageMetadata = JSON.parse(await readFile(resolve(npmDirectory, 'package.json'), 'utf8'));
if (packageMetadata.version !== options['--version']) {
  throw new Error(
    `npm package version (${packageMetadata.version}) does not match release version (${options['--version']})`,
  );
}

await rm(outputDirectory, { recursive: true, force: true });
await cp(npmDirectory, outputDirectory, {
  recursive: true,
  filter: (source) => !['node_modules', '.npm', 'test'].includes(source.split(/[\\/]/).at(-1)),
});
process.stdout.write(`Staged CodeFacts npm package in ${outputDirectory}.\n`);
