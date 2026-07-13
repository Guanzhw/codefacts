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
| `map` | Repository structure, language mix, and high-level symbol counts. |
| `search` | Indexed symbols, endpoints, and Markdown documentation headings through FTS. |
| `outline` | Symbols or headings in one file. |
| `expand` | One definition plus static callers, callees, references, and related tests. |
| `path` | A shortest bounded static calls path between confirmed symbols. |

Every result is bounded, includes file/line/hash evidence, and refreshes the incremental index before answering. A `no_static_path` result never claims that runtime execution is unreachable.

## Install

Until a tagged release asset is available, build the native binary from source:

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

For a project-local configuration, put this `.mcp.json` in the repository that
you want Claude Code to inspect. Replace the executable path with your own.

```json
{
  "mcpServers": {
    "codefacts": {
      "type": "stdio",
      "command": "C:\\Tools\\codefacts.exe",
      "args": ["mcp", "--root", "${CLAUDE_PROJECT_DIR:-.}"]
    }
  }
}
```

Claude Code sets `CLAUDE_PROJECT_DIR` for local MCP servers, so the same config
follows the project root. Project-scoped MCP servers require your approval on
first use. Alternatively, add a fixed repository root from the CLI:

```powershell
claude mcp add --scope project --transport stdio codefacts -- C:\Tools\codefacts.exe mcp --root D:\WorkSpace\your-repository
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
      "command": ["C:\\Tools\\codefacts.exe", "mcp", "--root", "."],
      "cwd": ".",
      "enabled": true,
      "timeout": 30000
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

## Run as an MCP server

The server uses newline-delimited JSON-RPC over stdio. Its SQLite state is external to the indexed repository by default.

```text
codefacts mcp --root D:\WorkSpace\your-repository
```

Use `--state` to select an explicit external database location:

```text
codefacts mcp --root D:\WorkSpace\your-repository --state D:\CodeFactsState\your-repository.sqlite
```

No repository hooks, watchers, background server, generated agent instructions, or prompt injection are installed or started.

For development from source, run `cargo build --release`; published builds are intended to be a single native binary for Windows, macOS, and Linux.

Tagged releases build Windows, macOS, and Linux binaries in GitHub Actions after a dependency-license audit of the locked dependency graph. The release workflow does not publish automatically from ordinary commits.

## Storage model and scope

Source is parsed into normalized SQLite facts: symbols, static relationships, file hashes, unresolved references, and a derived FTS index. Tree-sitter is the extractor for supported code languages; Markdown headings use a small deterministic extractor. FTS is discovery only: every returned structural claim comes from a stored fact with source evidence.

An unchanged repository is hash-skipped. When a source file changes, CodeFacts rebuilds the static relationship snapshot before answering so cross-file calls and imports are not partially resolved.

Endpoint facts currently recognize conservative common route literals (for example, `.get("/path", handler)` and `@GetMapping("/path")`). They are explicitly returned with `endpoint-pattern` / `heuristic` evidence; direct route handler and middleware identifiers appear as heuristic references when they match indexed functions or methods.

Performance measurement is documented in [docs/PERFORMANCE.md](docs/PERFORMANCE.md). Its development-only runner reports cold indexing, no-change refresh, one-file relationship rebind, SQLite disk size, benchmark-process memory, and first/P95 stdio MCP search latency without altering the repository under test.

An evidence snapshot comparing the five workflows with CodeMapper on five local repositories is in [docs/CODEMAPPER-COMPARISON.md](docs/CODEMAPPER-COMPARISON.md).

Out of scope for v1: editing, hooks, watchers, HTTP servers, dashboards, embeddings/vector search, reranking, security scans, Git analytics, agent memory, natural-language Q&A, and automated context injection.

## Upstream provenance

CodeFacts is derived from a deliberately reduced slice of [CodeGraph](https://github.com/suatkocar/codegraph) at revision `856739a1a528cfae9f9232566ae5c043ef8cfaf5`, which is MIT-licensed. See [UPSTREAM.md](UPSTREAM.md) for the derived components and exclusions. The upstream MIT copyright and license notice remain in [LICENSE](LICENSE).
