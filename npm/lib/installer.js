'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { applyEdits, modify, parse, printParseErrorCode } = require('jsonc-parser');

const SERVER_NAME = 'codefacts';
const STARTUP_TIMEOUT_SECONDS = 120;
const STARTUP_TIMEOUT_MILLISECONDS = STARTUP_TIMEOUT_SECONDS * 1000;

const AGENTS = Object.freeze([
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    executable: 'codex',
    configKind: 'toml',
  }),
  Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    executable: 'claude',
    configKind: 'claude-cli',
  }),
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    executable: 'opencode',
    configKind: 'jsonc',
    propertyPath: ['mcp', SERVER_NAME],
  }),
  Object.freeze({
    id: 'cursor',
    label: 'Cursor',
    executable: 'cursor-agent',
    alternateExecutable: 'cursor',
    configKind: 'jsonc',
    propertyPath: ['mcpServers', SERVER_NAME],
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    executable: 'gemini',
    configKind: 'jsonc',
    propertyPath: ['mcpServers', SERVER_NAME],
  }),
]);

const AGENTS_BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

function codefactsMcpCommand(platform = process.platform) {
  const npxArguments = ['--yes', '--prefer-online', 'codefacts@latest', 'mcp'];
  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/d', '/s', '/c', ['npx', ...npxArguments].join(' ')],
    };
  }
  return { command: 'npx', args: npxArguments };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function codefactsTomlBlock(command) {
  const argumentsText = command.args.map(tomlString).join(', ');
  return [
    '# CodeFacts MCP entry added by `codefacts install`.',
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(command.command)}`,
    `args = [${argumentsText}]`,
    `startup_timeout_sec = ${STARTUP_TIMEOUT_SECONDS}`,
    '',
  ].join('\n');
}

function tableNameIsCodefacts(name) {
  const normalized = name.replace(/\s+/gu, '');
  return normalized === `mcp_servers.${SERVER_NAME}` ||
    normalized === `mcp_servers."${SERVER_NAME}"`;
}

function tableNameIsCodefactsChild(name) {
  const normalized = name.replace(/\s+/gu, '');
  return normalized.startsWith(`mcp_servers.${SERVER_NAME}.`) ||
    normalized.startsWith(`mcp_servers."${SERVER_NAME}".`);
}

function replaceCodexEntry(source, command) {
  const tables = [];
  const pattern = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/gmu;
  let match;
  while ((match = pattern.exec(source))) {
    tables.push({ start: match.index, name: match[1] });
  }

  const existingIndex = tables.findIndex((table) => tableNameIsCodefacts(table.name));
  const replacement = codefactsTomlBlock(command);
  if (existingIndex < 0) {
    if (!source) {
      return replacement;
    }
    const separator = source.endsWith('\n') ? '\n' : '\n\n';
    return `${source}${separator}${replacement}`;
  }

  let end = source.length;
  for (let index = existingIndex + 1; index < tables.length; index += 1) {
    if (tableNameIsCodefactsChild(tables[index].name)) {
      continue;
    }
    end = tables[index].start;
    break;
  }
  return `${source.slice(0, tables[existingIndex].start)}${replacement}${source.slice(end)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonc(source, filePath) {
  const text = source.trim() ? source : '{}\n';
  const errors = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const details = errors
      .map((error) => printParseErrorCode(error.error))
      .join(', ');
    throw new Error(`cannot update ${filePath}: invalid JSON/JSONC (${details})`);
  }
  if (!isPlainObject(value)) {
    throw new Error(`cannot update ${filePath}: the root value must be an object`);
  }
  return { text, value };
}

function ensureObjectPath(value, propertyPath, filePath) {
  let current = value;
  for (const segment of propertyPath.slice(0, -1)) {
    const next = current[segment];
    if (next === undefined) {
      return;
    }
    if (!isPlainObject(next)) {
      throw new Error(`cannot update ${filePath}: ${segment} must be an object`);
    }
    current = next;
  }
}

function updateJsoncEntry(source, filePath, propertyPath, entry) {
  const { text, value } = parseJsonc(source, filePath);
  ensureObjectPath(value, propertyPath, filePath);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(text, propertyPath, entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  return applyEdits(text, edits);
}

function entryForAgent(agentId, command) {
  if (agentId === 'opencode') {
    return {
      type: 'local',
      command: [command.command, ...command.args],
      enabled: true,
      timeout: STARTUP_TIMEOUT_MILLISECONDS,
    };
  }
  if (agentId === 'gemini') {
    return {
      command: command.command,
      args: command.args,
      timeout: STARTUP_TIMEOUT_MILLISECONDS,
      trust: false,
    };
  }
  return { command: command.command, args: command.args };
}

function resolveHomeDirectory(options = {}) {
  return options.homeDirectory || os.homedir();
}

function resolveCodexHome(homeDirectory, environment) {
  if (environment.CODEX_HOME && path.isAbsolute(environment.CODEX_HOME)) {
    return environment.CODEX_HOME;
  }
  return path.join(homeDirectory, '.codex');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveConfigPath(agentId, options = {}) {
  const homeDirectory = resolveHomeDirectory(options);
  const environment = options.env || process.env;
  if (agentId === 'codex') {
    return path.join(resolveCodexHome(homeDirectory, environment), 'config.toml');
  }
  if (agentId === 'cursor') {
    return path.join(homeDirectory, '.cursor', 'mcp.json');
  }
  if (agentId === 'gemini') {
    return path.join(homeDirectory, '.gemini', 'settings.json');
  }
  if (agentId === 'opencode') {
    const configDirectory = path.join(homeDirectory, '.config', 'opencode');
    const jsoncPath = path.join(configDirectory, 'opencode.jsonc');
    if (await exists(jsoncPath)) {
      return jsoncPath;
    }
    const jsonPath = path.join(configDirectory, 'opencode.json');
    if (await exists(jsonPath)) {
      return jsonPath;
    }
    return jsoncPath;
  }
  throw new Error(`no configuration path is defined for ${agentId}`);
}

async function readTextOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function commandAvailable(command, options = {}) {
  if (typeof options.commandAvailable === 'function') {
    return options.commandAvailable(command);
  }
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

async function detectAgents(options = {}) {
  const detections = [];
  for (const agent of AGENTS) {
    const commands = [agent.executable, agent.alternateExecutable].filter(Boolean);
    const executableFound = (await Promise.all(
      commands.map((command) => commandAvailable(command, options)),
    )).some(Boolean);
    let configurationFound = false;
    if (agent.configKind !== 'claude-cli') {
      const configPath = await resolveConfigPath(agent.id, options);
      configurationFound = await exists(configPath);
    }
    detections.push({
      ...agent,
      available: executableFound || configurationFound,
      executableFound,
      configurationFound,
    });
  }
  return detections;
}

function normalizeAgentIds(agentIds) {
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    throw new Error('select at least one coding agent');
  }
  const uniqueIds = [...new Set(agentIds)];
  for (const agentId of uniqueIds) {
    if (!AGENTS_BY_ID.has(agentId)) {
      throw new Error(`unsupported coding agent: ${agentId}`);
    }
  }
  return uniqueIds;
}

async function prepareInstall(agentIds, options = {}) {
  const ids = normalizeAgentIds(agentIds);
  const platform = options.platform || process.platform;
  const command = codefactsMcpCommand(platform);
  const plans = [];

  for (const agentId of ids) {
    const agent = AGENTS_BY_ID.get(agentId);
    if (agent.configKind === 'claude-cli') {
      if (!await commandAvailable(agent.executable, options)) {
        throw new Error('Claude Code was selected but the `claude` command was not found on PATH');
      }
      plans.push({
        kind: 'command',
        agentId,
        label: agent.label,
        command: agent.executable,
        args: ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', command.command, ...command.args],
      });
      continue;
    }

    const filePath = await resolveConfigPath(agentId, options);
    const before = await readTextOrEmpty(filePath);
    const after = agent.configKind === 'toml'
      ? replaceCodexEntry(before, command)
      : updateJsoncEntry(before, filePath, agent.propertyPath, entryForAgent(agentId, command));
    plans.push({
      kind: 'file',
      agentId,
      label: agent.label,
      filePath,
      before,
      after,
    });
  }
  return plans;
}

async function writeTextAtomically(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, contents, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function execute(command, args, options = {}) {
  if (typeof options.executeCommand === 'function') {
    return options.executeCommand(command, args);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code === null ? 1 : code));
  });
}

async function prefetchLatest(options = {}) {
  if (typeof options.prefetch === 'function') {
    await options.prefetch();
    return;
  }
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const exitCode = await execute(npxCommand, [
    '--yes',
    '--prefer-online',
    'codefacts@latest',
    '--install',
  ], options);
  if (exitCode !== 0) {
    throw new Error(`could not prefetch the latest CodeFacts release (exit code ${exitCode})`);
  }
}

async function applyInstall(plans, options = {}) {
  const applied = [];
  const orderedPlans = [...plans].sort((left, right) => Number(right.kind === 'command') - Number(left.kind === 'command'));
  for (const plan of orderedPlans) {
    if (plan.kind === 'command') {
      const exitCode = await execute(plan.command, plan.args, options);
      if (exitCode !== 0) {
        throw new Error(`${plan.label} rejected the CodeFacts MCP configuration (exit code ${exitCode})`);
      }
      applied.push({ ...plan, changed: true });
      continue;
    }
    if (plan.before !== plan.after) {
      await writeTextAtomically(plan.filePath, plan.after);
      applied.push({ ...plan, changed: true });
    } else {
      applied.push({ ...plan, changed: false });
    }
  }
  return applied;
}

function quoteForDisplay(value) {
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}

function renderPlan(plans, output) {
  output.write('\nCodeFacts will configure a user-wide, rootless MCP server:\n');
  for (const plan of plans) {
    if (plan.kind === 'command') {
      output.write(`  - ${plan.label}: ${[plan.command, ...plan.args].map(quoteForDisplay).join(' ')}\n`);
    } else {
      if (plan.before) {
        output.write(`  - ${plan.label}: replace its existing CodeFacts MCP entry in ${plan.filePath}\n`);
      } else {
        output.write(`  - ${plan.label}: create ${plan.filePath}\n`);
      }
    }
  }
  output.write('\nIt uses `npx --yes --prefer-online codefacts@latest mcp`. Each agent checks npm for a new release when it starts the MCP server.\n');
  output.write('No project files, instruction files, tool permissions, indexes, hooks, or background processes will be created.\n\n');
}

function parseSelection(answer, detectedAgents) {
  const normalized = answer.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    const automatic = detectedAgents.filter((agent) => agent.available).map((agent) => agent.id);
    if (automatic.length === 0) {
      throw new Error('no supported coding agents were detected; choose one by number or install its CLI first');
    }
    return automatic;
  }
  if (normalized === 'all') {
    return AGENTS.map((agent) => agent.id);
  }
  if (normalized === 'q' || normalized === 'quit') {
    return [];
  }
  const selected = normalized.split(/[\s,]+/u).filter(Boolean).map((item) => Number(item));
  if (selected.some((item) => !Number.isInteger(item) || item < 1 || item > AGENTS.length)) {
    throw new Error('enter agent numbers separated by commas, `auto`, `all`, or `q`');
  }
  return [...new Set(selected)].map((item) => AGENTS[item - 1].id);
}

async function runInteractiveInstall(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new Error('`codefacts install` is interactive; run it from a terminal with a TTY');
  }

  const detected = await detectAgents(options);
  output.write('CodeFacts can add its read-only MCP server to supported coding agents.\n\n');
  detected.forEach((agent, index) => {
    const status = agent.available ? 'detected' : 'not detected';
    output.write(`  ${index + 1}. ${agent.label} (${status})\n`);
  });
  output.write('\nSelect numbers separated by commas; press Enter for detected agents, use `all` for every supported agent, or `q` to cancel.\n');

  const prompt = typeof options.ask === 'function'
    ? null
    : readline.createInterface({ input, output });
  const ask = options.ask || ((question) => prompt.question(question));
  try {
    const selected = parseSelection(await ask('Agents: '), detected);
    if (selected.length === 0) {
      output.write('Installation cancelled.\n');
      return { cancelled: true, applied: [] };
    }
    const plans = await prepareInstall(selected, options);
    renderPlan(plans, output);
    const confirmation = (await ask('Apply these changes? [y/N] ')).trim().toLowerCase();
    if (confirmation !== 'y' && confirmation !== 'yes') {
      output.write('Installation cancelled; no configuration was changed.\n');
      return { cancelled: true, applied: [] };
    }
    output.write('\nPrefetching and checksum-verifying the current CodeFacts release before changing agent configuration…\n');
    await prefetchLatest(options);
    const applied = await applyInstall(plans, options);
    output.write('\nInstalled CodeFacts for: ');
    output.write(`${applied.filter((plan) => plan.changed).map((plan) => plan.label).join(', ') || 'none (already current)'}.\n`);
    output.write('Restart the selected coding agent(s) to load the MCP server.\n');
    return { cancelled: false, applied };
  } finally {
    prompt?.close();
  }
}

module.exports = {
  AGENTS,
  SERVER_NAME,
  STARTUP_TIMEOUT_MILLISECONDS,
  STARTUP_TIMEOUT_SECONDS,
  applyInstall,
  codefactsMcpCommand,
  detectAgents,
  entryForAgent,
  parseSelection,
  prefetchLatest,
  prepareInstall,
  replaceCodexEntry,
  resolveConfigPath,
  runInteractiveInstall,
  updateJsoncEntry,
};
