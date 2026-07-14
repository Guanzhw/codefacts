#!/usr/bin/env node

'use strict';

const {
  PACKAGE_VERSION,
  ensureBinary,
  runBinary,
} = require('../lib/launcher');

const USAGE = `CodeFacts ${PACKAGE_VERSION}

Usage:
  codefacts --install
  codefacts mcp [--root <repository>] [--state <external-sqlite-path>]

The launcher downloads a checksum-verified native binary on first use and
runs it locally. Progress is written only to stderr so MCP stdout remains
valid JSON-RPC.`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (command === '--version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  if (command === '--install') {
    if (args.length !== 1) {
      throw new Error('--install does not accept additional arguments');
    }
    const binary = await ensureBinary();
    process.stdout.write(`${binary}\n`);
    return;
  }

  const binary = await ensureBinary();
  process.exitCode = await runBinary(binary, args);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codefacts: ${message}\n`);
  process.exitCode = 1;
});
