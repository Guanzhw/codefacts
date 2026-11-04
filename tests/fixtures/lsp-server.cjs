// A protocol/lifecycle fixture, never evidence of real Python language support.
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');

const mode = process.env.CODEFACTS_TEST_LSP_MODE;
const audit = process.env.CODEFACTS_TEST_LSP_AUDIT;
const heartbeat = process.env.CODEFACTS_TEST_LSP_HEARTBEAT;
const record = (event) => fs.appendFileSync(audit, JSON.stringify(event) + '\n');
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
record({ event: 'started', pid: process.pid });
let initialization;
const replies = new Map();
const documents = new Map();
let blocked = false;
let bytes = Buffer.alloc(0);

if (mode === 'blocked-write') {
  // Ordinary inherited process-group membership matters: cleanup must include
  // this descendant, not just the npm-style launcher and server parent.
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const file = process.argv[1];
    fs.appendFileSync(file, 'tick\\n');
    setInterval(() => fs.appendFileSync(file, 'tick\\n'), 40);
  `, heartbeat], { stdio: 'ignore' });
  record({ event: 'descendant', pid: child.pid });
}

function initialized() {
  send({ id: initialization.id, result: { capabilities: {
    referencesProvider: mode !== 'unsupported', positionEncoding: 'utf-16',
  } } });
  if (mode === 'blocked-write') {
    blocked = true;
    process.stdin.pause();
    setInterval(() => {}, 1000);
  }
}

function handle(message) {
  if (message.method) {
    record({ event: 'request', method: message.method, id: message.id,
      position: message.params?.position, uri: message.params?.textDocument?.uri });
  } else {
    record({ event: 'reply', ...message });
  }
  if (message.method === 'initialize') {
    initialization = message;
    if (mode === 'success') {
      // Server request IDs have an independent namespace. The numeric ID here
      // intentionally collides with the pending client initialize request.
      send({ id: message.id, method: 'workspace/configuration',
        params: { items: [{ section: 'python' }, { section: 'unconfigured' }] } });
      send({ id: 'config-string', method: 'workspace/configuration',
        params: { items: [{ section: 'python.analysis' }] } });
      send({ id: 'folders', method: 'workspace/workspaceFolders', params: {} });
      send({ id: 'edit', method: 'workspace/applyEdit', params: { edit: { changes: {
        [`${message.params.rootUri}/lib.py`]: [{ range: {
          start: { line: 0, character: 0 }, end: { line: 0, character: 0 },
        }, newText: 'not allowed' }],
      } } } });
    } else initialized();
    return;
  }
  if (!message.method && mode === 'success') {
    replies.set(message.id, message);
    if (replies.size === 4) initialized();
    return;
  }
  if (message.method === 'textDocument/didOpen') {
    documents.set(message.params.textDocument.uri, message.params.textDocument.text);
    return;
  }
  if (message.method !== 'textDocument/references') return;
  if (mode === 'error') {
    send({ id: message.id, error: { code: -32603, message: 'fixture reference failure',
      data: { ignored: 'x'.repeat(100_000) } } });
    return;
  }
  const selected = message.params.textDocument.uri;
  const location = (uri, line, character) => ({ uri, range: {
    start: { line, character }, end: { line, character: character + 6 },
  } });
  let locations = [];
  for (const [uri, text] of documents) {
    const lines = text.split(/\r\n|\n/);
    for (let line = 0; line < lines.length; line++) {
      if (lines[line].startsWith('#') || lines[line].startsWith('from ')) continue;
      const character = lines[line].indexOf('target(');
      if (character >= 0) locations.push(location(uri, line, character));
    }
  }
  if (mode === 'out-of-bounds') locations = [location(selected, 999, 0)];
  if (mode === 'surrogate') {
    const [uri, text] = [...documents].find(([, text]) => text.includes('note ='));
    const line = text.split(/\r\n|\n/)[1];
    locations = [location(uri, 1, line.indexOf('😀') + 1)];
  }
  if (mode === 'changed-source') {
    // This explicit adversarial fixture is confined to its temporary project.
    // It tests that a provider cannot attach an old indexed hash to new bytes.
    fs.appendFileSync(fileURLToPath(selected), '# changed during query\r\n');
  }
  record({ event: 'references', count: locations.length });
  send({ id: message.id, result: locations });
}

process.stdin.on('data', (chunk) => {
  if (blocked) return;
  bytes = Buffer.concat([bytes, chunk]);
  while (!blocked) {
    const headerEnd = bytes.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const match = /Content-Length: (\d+)/i.exec(bytes.subarray(0, headerEnd).toString());
    if (!match) process.exit(2);
    const end = headerEnd + 4 + Number(match[1]);
    if (bytes.length < end) return;
    const message = JSON.parse(bytes.subarray(headerEnd + 4, end));
    bytes = bytes.subarray(end);
    handle(message);
  }
});
