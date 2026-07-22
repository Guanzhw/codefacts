import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse } from 'jsonc-parser';

const require = createRequire(import.meta.url);
const installer = require('../lib/installer.js');

async function temporaryHome(context) {
  const directory = await mkdtemp(join(tmpdir(), 'codefacts-installer-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('uses a latest package spec with an immediate npm update check', () => {
  assert.deepEqual(installer.codefactsMcpCommand('linux'), {
    command: 'npx',
    args: ['--yes', '--prefer-online', 'codefacts@latest', 'mcp'],
  });
  assert.deepEqual(installer.codefactsMcpCommand('win32'), {
    command: 'cmd',
    args: ['/d', '/s', '/c', 'npx --yes --prefer-online codefacts@latest mcp'],
  });
});

test('replaces only the CodeFacts table in a Codex TOML configuration', () => {
  const source = [
    'model = "gpt-5"',
    '',
    '[mcp_servers.codefacts]',
    'command = "old-command"',
    '',
    '[mcp_servers.codefacts.env]',
    'OLD = "1"',
    '',
    '[mcp_servers.other]',
    'command = "other"',
    '',
  ].join('\n');
  const updated = installer.replaceCodexEntry(source, installer.codefactsMcpCommand('linux'));

  assert.match(updated, /model = "gpt-5"/);
  assert.match(updated, /\[mcp_servers\.other\][\s\S]*command = "other"/);
  assert.match(updated, /command = "npx"/);
  assert.match(updated, /--prefer-online/);
  assert.doesNotMatch(updated, /old-command|OLD =/);
  assert.equal((updated.match(/\[mcp_servers\.codefacts\]/g) || []).length, 1);
});

test('adds an OpenCode entry without discarding JSONC comments or unrelated settings', () => {
  const source = [
    '{',
    '  // Preserve this comment.',
    '  "plugin": ["example"],',
    '}',
    '',
  ].join('\n');
  const entry = installer.entryForAgent('opencode', installer.codefactsMcpCommand('linux'));
  const updated = installer.updateJsoncEntry(source, 'opencode.jsonc', ['mcp', 'codefacts'], entry);
  const errors = [];
  const parsed = parse(updated, errors, { allowTrailingComma: true, disallowComments: false });

  assert.equal(errors.length, 0);
  assert.match(updated, /Preserve this comment/);
  assert.deepEqual(parsed.plugin, ['example']);
  assert.deepEqual(parsed.mcp.codefacts, entry);
});

test('resolves agent configuration paths without trusting a malformed CODEX_HOME', async (context) => {
  const homeDirectory = await temporaryHome(context);
  const opencodeDirectory = join(homeDirectory, '.config', 'opencode');
  const expectedJsoncPath = join(opencodeDirectory, 'opencode.jsonc');
  const expectedJsonPath = join(opencodeDirectory, 'opencode.json');

  assert.equal(
    await installer.resolveConfigPath('codex', {
      homeDirectory,
      env: { CODEX_HOME: 'relative-path-is-not-a-config-home' },
    }),
    join(homeDirectory, '.codex', 'config.toml'),
  );
  assert.equal(await installer.resolveConfigPath('opencode', { homeDirectory }), expectedJsoncPath);
  await (await import('node:fs/promises')).mkdir(opencodeDirectory, { recursive: true });
  await writeFile(expectedJsonPath, '{}\n');
  assert.equal(await installer.resolveConfigPath('opencode', { homeDirectory }), expectedJsonPath);
  await writeFile(expectedJsoncPath, '{\n  // preferred when present\n}\n');
  assert.equal(await installer.resolveConfigPath('opencode', { homeDirectory }), expectedJsoncPath);
  assert.equal(
    await installer.resolveConfigPath('cursor', { homeDirectory }),
    join(homeDirectory, '.cursor', 'mcp.json'),
  );
  assert.equal(
    await installer.resolveConfigPath('gemini', { homeDirectory }),
    join(homeDirectory, '.gemini', 'settings.json'),
  );
});

test('detects an existing agent configuration or an available agent executable', async (context) => {
  const homeDirectory = await temporaryHome(context);
  const cursorPath = join(homeDirectory, '.cursor', 'mcp.json');
  await (await import('node:fs/promises')).mkdir(dirname(cursorPath), { recursive: true });
  await writeFile(cursorPath, '{}\n');

  const agents = await installer.detectAgents({
    homeDirectory,
    commandAvailable: async (command) => command === 'gemini',
  });
  const byId = Object.fromEntries(agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.cursor.configurationFound, true);
  assert.equal(byId.cursor.available, true);
  assert.equal(byId.gemini.executableFound, true);
  assert.equal(byId.gemini.available, true);
  assert.equal(byId.claude.available, false);
});

test('plans and applies direct agent configurations with the automatic update launcher', async (context) => {
  const homeDirectory = await temporaryHome(context);
  const opencodePath = join(homeDirectory, '.config', 'opencode', 'opencode.jsonc');
  await (await import('node:fs/promises')).mkdir(dirname(opencodePath), { recursive: true });
  await writeFile(opencodePath, '{\n  // user configuration\n  "plugin": ["notice"]\n}\n');

  const plans = await installer.prepareInstall(['codex', 'opencode', 'cursor', 'gemini'], {
    homeDirectory,
    platform: 'linux',
  });
  assert.deepEqual(plans.map((plan) => plan.agentId), ['codex', 'opencode', 'cursor', 'gemini']);
  assert.ok(plans.every((plan) => plan.kind === 'file'));

  const applied = await installer.applyInstall(plans);
  assert.ok(applied.every((plan) => plan.changed));

  const codex = await readFile(join(homeDirectory, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /\[mcp_servers\.codefacts\]/);
  assert.match(codex, /codefacts@latest/);
  assert.match(codex, /startup_timeout_sec = 120/);

  const opencode = await readFile(opencodePath, 'utf8');
  const cursor = await readFile(join(homeDirectory, '.cursor', 'mcp.json'), 'utf8');
  const gemini = await readFile(join(homeDirectory, '.gemini', 'settings.json'), 'utf8');
  const opencodeErrors = [];
  const opencodeConfig = parse(opencode, opencodeErrors, { allowTrailingComma: true, disallowComments: false });
  assert.equal(opencodeErrors.length, 0);
  assert.match(opencode, /user configuration/);
  assert.deepEqual(opencodeConfig.plugin, ['notice']);
  assert.deepEqual(opencodeConfig.mcp.codefacts.command, ['npx', '--yes', '--prefer-online', 'codefacts@latest', 'mcp']);
  assert.deepEqual(JSON.parse(cursor).mcpServers.codefacts.args, ['--yes', '--prefer-online', 'codefacts@latest', 'mcp']);
  assert.equal(JSON.parse(gemini).mcpServers.codefacts.trust, false);
});

test('uses the Claude Code CLI only after it is selected', async (context) => {
  const homeDirectory = await temporaryHome(context);
  const plans = await installer.prepareInstall(['claude'], {
    homeDirectory,
    platform: 'win32',
    commandAvailable: async (command) => command === 'claude',
  });
  assert.deepEqual(plans, [{
    kind: 'command',
    agentId: 'claude',
    label: 'Claude Code',
    command: 'claude',
    args: [
      'mcp', 'add', '--scope', 'user', 'codefacts', '--',
      'cmd', '/d', '/s', '/c', 'npx --yes --prefer-online codefacts@latest mcp',
    ],
  }]);

  const executed = [];
  const applied = await installer.applyInstall(plans, {
    executeCommand: async (command, args) => {
      executed.push({ command, args });
      return 0;
    },
  });
  assert.equal(applied[0].changed, true);
  assert.deepEqual(executed, [{ command: 'claude', args: plans[0].args }]);
});

test('does not change agent configuration until the interactive confirmation', async (context) => {
  const homeDirectory = await temporaryHome(context);
  const output = { isTTY: true, write: () => undefined };
  const input = { isTTY: true };
  const replies = ['1', 'n'];

  const result = await installer.runInteractiveInstall({
    homeDirectory,
    input,
    output,
    ask: async () => replies.shift(),
    commandAvailable: async () => true,
  });

  assert.equal(result.cancelled, true);
  await assert.rejects(readFile(join(homeDirectory, '.codex', 'config.toml')));
});

test('applies the selected interactive installation after confirmation', async (context) => {
  const homeDirectory = await temporaryHome(context);
  const output = { isTTY: true, write: () => undefined };
  const input = { isTTY: true };
  const replies = ['1', 'yes'];

  const result = await installer.runInteractiveInstall({
    homeDirectory,
    input,
    output,
    ask: async () => replies.shift(),
    commandAvailable: async () => true,
    platform: 'linux',
    prefetch: async () => undefined,
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.applied.length, 1);
  assert.match(
    await readFile(join(homeDirectory, '.codex', 'config.toml'), 'utf8'),
    /npx[\s\S]*codefacts@latest/,
  );
});

test('does not update agent configuration when release prefetch fails', async (context) => {
  const homeDirectory = await temporaryHome(context);
  const output = { isTTY: true, write: () => undefined };
  const input = { isTTY: true };
  const replies = ['1', 'y'];

  await assert.rejects(
    installer.runInteractiveInstall({
      homeDirectory,
      input,
      output,
      ask: async () => replies.shift(),
      commandAvailable: async () => true,
      prefetch: async () => {
        throw new Error('network unavailable');
      },
    }),
    /network unavailable/,
  );
  await assert.rejects(readFile(join(homeDirectory, '.codex', 'config.toml')));
});

test('parses explicit, automatic, and cancelled agent selections', () => {
  const detected = [
    { id: 'codex', available: true },
    { id: 'claude', available: false },
    { id: 'opencode', available: true },
    { id: 'cursor', available: false },
    { id: 'gemini', available: false },
  ];
  assert.deepEqual(installer.parseSelection('', detected), ['codex', 'opencode']);
  assert.deepEqual(installer.parseSelection('1, 3, 1', detected), ['codex', 'opencode']);
  assert.deepEqual(installer.parseSelection('q', detected), []);
  assert.throws(() => installer.parseSelection('0', detected), /enter agent numbers/);
});
