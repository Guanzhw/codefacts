# CodeFacts

> Local, verifiable code facts for coding agents.

CodeFacts is a local, verifiable code-facts service for coding agents. It
answers compact structural questions from a SQLite fact store built from the
repository source; it is not a repository chatbot, RAG product, agent, or
automatic context injector.

> The model decides what to do. CodeFacts supplies the source-backed facts
> needed to decide safely.

## Why CodeFacts exists

Coding agents routinely need a small set of repository facts before they can
make a good decision: where a symbol is defined, which callers reach it, which
files form a boundary, and whether a claimed relationship is actually present
in source. General chat, grep dumps, and semantic retrieval are all useful in
their places, but none is a dependable authority for those structural claims.
They can be stale, broad, unauditable, or simply plausible rather than true.

CodeFacts treats a repository more like a database than a document collection.
It parses source into attributable, source-backed facts and returns only a
bounded answer with evidence. That gives an agent enough ground truth to plan
well without trying to replace the agent's judgment.

## Inspiration and philosophy

CodeFacts began as a deliberately subtractive implementation inspired by
[CodeGraph](https://github.com/suatkocar/codegraph). It retains the useful
foundation—parsing, normalized facts, incremental indexing, SQLite, FTS, and
stdio MCP transport—while rejecting the broad product surface that would turn
it into another autonomous coding agent or repository chatbot.

Its philosophy is intentionally narrow:

- **Facts before prose.** Structural claims come from indexed source spans,
  not embeddings or generated summaries.
- **Models reason; tools prove.** CodeFacts supplies evidence and relationships.
  The calling model keeps responsibility for decisions and edits.
- **Small tools compose better.** Five stable, read-only MCP workflows are
  easier to learn, test, and trust than a long catalog of overlapping actions.
- **Uncertainty is data.** Static analysis does not imply runtime certainty;
  unresolved or heuristic relationships are labeled rather than overstated.
- **Local and non-invasive by default.** No account, daemon, watcher, hook,
  generated instruction file, or repository mutation is required.
- **Freshness is part of correctness.** Source hashes drive incremental refresh,
  and every response reports fresh evidence rather than silently serving a
  stale index.

## MCP surface

Version 1 deliberately exposes exactly five read-only tools:

| Tool | Purpose |
| --- | --- |
| `map` | Repository structure, explicit language file/symbol counts, deferred LSP-provider status, and bounded unresolved-reference evidence. |
| `search` | Indexed symbols, endpoints, and Markdown documentation headings through FTS; optionally narrow by kind, path prefix, or local-detail scope and continue on one snapshot. |
| `outline` | Symbols or headings in one file, with optional kind/local-detail filtering and snapshot-bound continuation. |
| `expand` | One definition plus static callers, candidate polymorphic callees, references, related tests, Markdown section text, and optional semantic references. |
| `path` | A shortest bounded static calls path between confirmed symbols, with optional endpoint file-path disambiguation. |

Every result is bounded, includes file/line/hash evidence, and refreshes the incremental index before answering. Its `freshness` object includes the canonical `repository_root` and fact-store `generation`, so a caller can verify that the facts belong to the intended project. A `no_static_path` result never claims that runtime execution is unreachable.

All five tools accept an optional `repository_root` project directory. It
selects (and, on first use, indexes) that project's independent external SQLite
fact store for the current call. A server started with `--root` uses that root
when the field is omitted; a rootless server requires `repository_root` on
every call and never guesses from its working directory. File paths such as
`file_path`, `path_prefix`, and `from_file_path` remain relative to the
selected project. Results never merge unrelated projects: each response's
`freshness.repository_root` identifies the source snapshot, and `path` only
traverses static relationships within that selected project.

`search` accepts optional `kind`, `path_prefix`, `scope`, and non-negative
`offset`; `outline` accepts `kind`, `scope`, and `offset`. `scope` defaults to
`top_level`, which suppresses variables declared inside functions or methods;
use `scope: "all"` for implementation detail. Both return an opaque `next_cursor` when another
bounded page exists. Supplying that cursor prevents mixed-snapshot pagination:
if source changes between pages, the server returns `stale_cursor` and asks the
client to restart. `next_offset` remains available for legacy clients, but it
cannot provide that snapshot guarantee. `path` accepts `from_file_path` and `to_file_path`
to distinguish same-named symbols. If the shortest confirmed path is longer
than the requested response limit, it returns `path_too_long` with its length
instead of sending an oversized path or claiming that no static path exists.

`map.unresolved_references` reports the count plus at most 20 source-backed
unresolved import/reference samples. It describes a static-analysis gap; it
does not establish that a target is absent at runtime.

`map.files_with_facts` is the number of indexed files that currently own at
least one fact, while `map.indexed_files` is every successfully parsed,
supported source file. `map.files_indexed_this_refresh` is only the number
parsed during the latest refresh. `language_file_counts` and
`language_symbol_counts` make the two language measures explicit; legacy
`languages` is the file-count alias.

## Install

CodeFacts is distributed online as a small npm launcher plus a native GitHub
Release asset. The launcher downloads the matching release binary once,
verifies its SHA-256 against the checksum embedded in the versioned npm package,
and runs it locally over stdio. It does not upload the repository being indexed.

### Online install (published releases)

After a tagged release is published, prefetch its native binary before adding
the MCP server. Node.js 18 or later is the only installation prerequisite; Rust
is not required.

```powershell
npx -y codefacts@0.1.6 --install
```

The command prints the local binary path. Pin the version in a shared MCP
configuration so a future npm release cannot silently change the executable
that starts in a coding session. `@latest` is acceptable for an interactive
upgrade, but not the default for a checked-in project configuration.

The launcher supports Windows x64, macOS x64/arm64, and Linux x64/arm64.
Its first download can take longer than a normal MCP startup, so prefetch it or
use the 120-second timeout shown below. Download status goes to stderr only;
stdio stdout remains valid JSON-RPC.

### Build from source

Before the first published npm release, or when a source build is preferred:

```powershell
cargo build --release --locked
```

On Windows, the resulting executable is
`target\release\codefacts.exe`. On macOS and Linux it is
`target/release/codefacts`. Put it in a stable location or use its absolute
path in the MCP configuration below. The examples use `C:\Tools\codefacts.exe`;
on macOS or Linux, use the equivalent absolute path such as
`/usr/local/bin/codefacts`. Release assets use the same `codefacts` command.

### Claude Code

For a project-local online configuration, put this `.mcp.json` in the
repository that you want Claude Code to inspect:

```json
{
  "mcpServers": {
    "codefacts": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "codefacts@0.1.6",
        "mcp",
        "--root",
        "${CLAUDE_PROJECT_DIR:-.}"
      ],
      "timeout": 120000
    }
  }
}
```

Claude Code sets `CLAUDE_PROJECT_DIR` for local MCP servers, so the same config
follows the project root. Project-scoped MCP servers require your approval on
first use. Alternatively, add a fixed repository root from the CLI:

```powershell
claude mcp add --scope project --transport stdio codefacts -- npx -y codefacts@0.1.6 mcp --root D:\WorkSpace\your-repository
claude mcp get codefacts
```

### OpenCode

Add this `opencode.json` to the root of the repository to inspect. OpenCode
resolves the local server `cwd` from that workspace, so `--root .` indexes that
repository rather than the CodeFacts checkout.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codefacts": {
      "type": "local",
      "command": ["npx", "-y", "codefacts@0.1.6", "mcp", "--root", "."],
      "cwd": ".",
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

For user-wide configuration, place the same `mcp` entry in
`~/.config/opencode/opencode.json` and set `cwd`/`--root` to the repository you
want to index. Verify the connection with:

```text
opencode mcp list
```

### Codex

For a fixed project, register a clearly named entry with an explicit root and
a startup timeout that allows the first verified launcher download:

```powershell
codex mcp add codefacts-opensession -- cmd /c npx -y codefacts@0.1.6 mcp --root D:\WorkSpace\OpenSession
```

Then set `startup_timeout_sec = 120` (or higher) for that named
`[mcp_servers.codefacts-opensession]` entry in `%USERPROFILE%\.codex\config.toml`,
and verify it before use:

```powershell
codex mcp list
```

For a user-wide server that needs to inspect several projects, omit `--root`:

```powershell
codex mcp add codefacts -- cmd /c npx -y codefacts@0.1.6 mcp
```

Then pass the absolute target directory in every tool call, for example
`map({"repository_root":"D:\\WorkSpace\\OpenSession"})` or
`search({"repository_root":"D:\\WorkSpace\\OpenSession","query":"ProviderAdapter"})`.
The first request for a root builds or refreshes only that project's external
index; subsequent requests reuse it for the lifetime of the MCP process.
CodeFacts does not infer a project from the server working directory. The MCP
result's `freshness.repository_root` remains the final evidence of scope; if it
does not match the repository being evaluated, discard the result.

### Cache, trust, and offline use

The launcher verifies the cached binary against its embedded SHA-256 before
every start. Its default cache is `%LOCALAPPDATA%\CodeFacts\bin` on Windows,
`~/Library/Caches/codefacts/bin` on macOS, and
`${XDG_CACHE_HOME:-~/.cache}/codefacts/bin` on Linux. Set
`CODEFACTS_CACHE_DIR` to move that cache (for example to a pre-populated CI
cache). `CODEFACTS_DOWNLOAD_BASE_URL` can point at a trusted internal mirror
that serves the same versioned asset names; the embedded checksum still has to
match.

An air-gapped machine can pre-populate that cache from a verified Release asset
or use a source-built binary directly. Details of the artifact names, checksum
chain, npm provenance, and release setup are in
[docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

## Run as an MCP server

The server uses newline-delimited JSON-RPC over stdio. Its SQLite state is external to the indexed repository by default.

```text
codefacts mcp --root D:\WorkSpace\your-repository
```

To select projects per tool call instead, start without a default root:

```text
codefacts mcp
```

Each `map`, `search`, `outline`, `expand`, and `path` call must then include an
absolute `repository_root`, such as:

```json
{"repository_root":"D:\\WorkSpace\\your-repository","query":"Handler"}
```

Use `--state` to select an explicit external database location for the default
`--root` project:

```text
codefacts mcp --root D:\WorkSpace\your-repository --state D:\CodeFactsState\your-repository.sqlite
```

`--state` intentionally requires `--root`; dynamically selected projects use
separate default external state files, keyed by their canonical root. Set
`CODEFACTS_STATE_DIR` to choose their parent directory.

### Optional LSP enrichment

`codefacts mcp` defaults to `--lsp auto`. It never installs or configures a
language server; it detects a separately installed supported server on `PATH`
and uses an isolated stdio session only while expanding a matching symbol.
`map` lists relevant providers as `deferred` without launching external
processes; `expand` performs and caches the availability probe only for a
matching supported symbol. `expand.references.semantic`
returns separately labeled semantic locations when the request succeeds.

The initial providers are `rust-analyzer` for Rust and
`typescript-language-server` for TypeScript/JavaScript. TypeScript projects
need a compatible `typescript` installation that provides `tsserver`; a local
workspace installation takes precedence. Use `--lsp off` to prevent all LSP
probing and child processes while retaining the same static facts.

No repository hooks, watchers, background server, generated agent instructions, or prompt injection are installed or started.

For development from source, run `cargo build --release`; published builds are
intended to be a single native binary for Windows, macOS, and Linux.

Tagged releases build Windows x64, macOS x64/arm64, and Linux x64/arm64
binaries after a dependency-license audit and publish a checksum-pinned npm
launcher. Ordinary commits never publish a release. The optional
`server.json` is ready for publication to the official MCP Registry after the
npm package exists; registry metadata is discovery information, not a hosted
CodeFacts service.

## Storage model and scope

Source is parsed into normalized SQLite facts: symbols, static relationships, file hashes, unresolved references, and a derived FTS index. Tree-sitter is the extractor for supported code languages; Markdown uses a small deterministic extractor for headings, lexical heading hierarchy, bounded section text/ranges, and same-document anchor links. It intentionally does not claim full Markdown semantics for tables, images, front matter, or arbitrary cross-file links. FTS is discovery only: every returned structural claim comes from a stored fact with source evidence.

An unchanged repository is hash-skipped. When a source file changes, CodeFacts
reparses only changed source files, then rebinds affected source-spelled static
relationships and re-resolves derived imports against the current fact store.
Each call site remains an independent relationship fact, so evidence does not
overwrite an earlier call at a different line.

Endpoint facts use AST call/annotation nodes for conservative known routing receivers (for example, `app.get("/path", handler)`, template and regular-expression route patterns, and `@GetMapping("/path")`). Query-parameter access such as `searchParams.get("page")` is not an endpoint. Endpoint handlers are returned as `endpoint-ast` / `heuristic` candidates when they match indexed functions or methods.

NodeNext runtime specifiers such as `import "./config.js"` resolve to indexed
TypeScript sources (`.ts`, `.tsx`, or `.d.ts`) when the exact JavaScript file
is absent. Receiver dispatch with multiple matching methods is returned as a
bounded `heuristic` relationship with `resolution: "polymorphic"`; it is
visible in `expand` but deliberately excluded from `path`, which only follows
confirmed static calls. Rust test facts include source-derived `#[test]` and
framework attributes such as `#[tokio::test]`, as well as functions under
`mod tests`.

Performance measurement is documented in [docs/PERFORMANCE.md](docs/PERFORMANCE.md). Its development-only runner reports cold indexing, no-change refresh, one-file relationship rebind, SQLite disk size, benchmark-process memory, and first/P95 stdio MCP search latency without altering the repository under test.

An evidence snapshot comparing the five workflows with CodeMapper on five local repositories is in [docs/CODEMAPPER-COMPARISON.md](docs/CODEMAPPER-COMPARISON.md).

Out of scope for v1: editing, hooks, watchers, HTTP servers, dashboards, embeddings/vector search, reranking, security scans, Git analytics, agent memory, natural-language Q&A, and automated context injection.

## Upstream provenance

CodeFacts is derived from a deliberately reduced slice of [CodeGraph](https://github.com/suatkocar/codegraph) at revision `856739a1a528cfae9f9232566ae5c043ef8cfaf5`, which is MIT-licensed. See [UPSTREAM.md](UPSTREAM.md) for the derived components and exclusions. The upstream MIT copyright and license notice remain in [LICENSE](LICENSE).
