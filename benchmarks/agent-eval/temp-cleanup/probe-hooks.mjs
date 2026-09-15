// Evaluator-only preload. Run one selected fixture per injected-failure process.
// CF_PROBE_LOG is an external JSONL file: one record per test worker that
// actually creates a scoped fixture. The node:test controller writes no record.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import strictAssert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";

const mode = process.env.CF_PROBE_MODE ?? "normal";
const logPath = process.env.CF_PROBE_LOG;
if (!["normal", "assertion", "writer-setup", "file-setup"].includes(mode)) {
  throw new Error(`Unknown CF_PROBE_MODE: ${mode}`);
}
if (!logPath || !path.isAbsolute(logPath)) {
  throw new Error("CF_PROBE_LOG must be an absolute external log path");
}

const prefixes = new Set([
  "agentsession-token-",
  "agentsession-config-",
  "agentsession-runtime-log-",
  "agentsession-runtime-",
  "agentsession-instructions-",
  "agentsession-codex-zst-",
  "agentsession-codex-zst-bound-",
]);
const original = {
  mkdtempSync: fs.mkdtempSync,
  rmSync: fs.rmSync,
  writeFileSync: fs.writeFileSync,
  existsSync: fs.existsSync,
  exec: DatabaseSync.prototype.exec,
  close: DatabaseSync.prototype.close,
};
const environmentValue = () => ({
  present: Object.hasOwn(process.env, "XDG_CONFIG_HOME"),
  value: process.env.XDG_CONFIG_HOME ?? null,
});
const initialXdgConfigHome = environmentValue();
const created = [];
const removeCalls = [];
const closeEvents = [];
const writerRecords = [];
const writerByInstance = new WeakMap();
let pendingWriterFixture = null;
let injectionFired = false;
let injection = null;
let sequence = 0;

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function inject(sentinel, operation) {
  injectionFired = true;
  injection = { sentinel, operation, sequence: ++sequence };
  throw new Error(sentinel);
}

fs.mkdtempSync = function (prefix, ...args) {
  const result = Reflect.apply(original.mkdtempSync, this, [prefix, ...args]);
  if (typeof prefix === "string" && prefixes.has(path.basename(prefix))) {
    const directory = path.resolve(String(result));
    const entry = { prefix: path.basename(prefix), path: directory, sequence: ++sequence };
    created.push(entry);
    if (entry.prefix === "agentsession-token-") pendingWriterFixture = directory;
  }
  return result;
};

fs.rmSync = function (target, ...args) {
  const absolute = typeof target === "string" ? path.resolve(target) : String(target);
  const event = {
    path: absolute,
    sequence: ++sequence,
    owned: created.some((entry) => within(entry.path, absolute)),
    openWriters: writerRecords.filter((entry) => !entry.closed).map((entry) => entry.id),
    existedBefore: original.existsSync(target),
    succeeded: false,
  };
  removeCalls.push(event);
  try {
    const result = Reflect.apply(original.rmSync, this, [target, ...args]);
    event.succeeded = true;
    event.existsAfter = original.existsSync(target);
    return result;
  } catch (error) {
    event.errorCode = error?.code ?? null;
    event.errorMessage = String(error?.message ?? error);
    throw error;
  }
};

fs.writeFileSync = function (file, ...args) {
  if (mode === "file-setup" && !injectionFired && typeof file === "string"
    && created.some((entry) => within(entry.path, path.resolve(file)))) {
    inject("CF_EVAL_FILE_SETUP_FAILURE", "fs.writeFileSync");
  }
  return Reflect.apply(original.writeFileSync, this, [file, ...args]);
};

DatabaseSync.prototype.exec = function (...args) {
  if (pendingWriterFixture !== null) {
    const writer = {
      id: `writer-${writerRecords.length + 1}`,
      fixture: pendingWriterFixture,
      sequence: ++sequence,
      closed: false,
    };
    writerByInstance.set(this, writer);
    writerRecords.push(writer);
    pendingWriterFixture = null;
    if (mode === "writer-setup" && !injectionFired) {
      inject("CF_EVAL_WRITER_SETUP_FAILURE", "DatabaseSync.exec");
    }
  }
  return Reflect.apply(original.exec, this, args);
};

DatabaseSync.prototype.close = function (...args) {
  const writer = writerByInstance.get(this);
  const result = Reflect.apply(original.close, this, args);
  if (writer) {
    writer.closed = true;
    closeEvents.push({ writerId: writer.id, sequence: ++sequence, success: true });
  }
  return result;
};

const assertionMethods = [
  "ok", "equal", "notEqual", "deepEqual", "notDeepEqual", "strictEqual",
  "notStrictEqual", "deepStrictEqual", "notDeepStrictEqual", "throws",
  "doesNotThrow", "rejects", "doesNotReject", "match", "doesNotMatch",
  "ifError", "fail", "partialDeepStrictEqual",
];
for (const api of new Set([assert, strictAssert])) {
  for (const name of assertionMethods) {
    const originalAssertion = api[name];
    if (typeof originalAssertion !== "function") continue;
    api[name] = function (...args) {
      if (mode === "assertion" && created.length > 0 && !injectionFired) {
        inject("CF_EVAL_ASSERTION_FAILURE", `assert.${name}`);
      }
      return Reflect.apply(originalAssertion, this, args);
    };
  }
}

syncBuiltinESMExports();

process.on("exit", (exitCode) => {
  if (created.length === 0) return;
  const report = {
    schemaVersion: 1,
    pid: process.pid,
    mode,
    exitCode,
    initialXdgConfigHome,
    finalXdgConfigHome: environmentValue(),
    created: created.map((entry) => ({ ...entry, existsAtExit: original.existsSync(entry.path) })),
    removeCalls,
    writers: writerRecords,
    closeEvents,
    injectionFired,
    injection,
  };
  original.writeFileSync(logPath, `${JSON.stringify(report)}\n`, { flag: "a" });
});
