# CodeFacts

CodeFacts is a local, verifiable code-facts service for coding agents. It answers compact structural questions from a SQLite fact store built from the repository source; it is not a repository chatbot, RAG product, agent, or automatic context injector.

The model decides what to do. CodeFacts supplies the source-backed facts needed to decide safely.

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

Out of scope for v1: editing, hooks, watchers, HTTP servers, dashboards, embeddings/vector search, reranking, security scans, Git analytics, agent memory, natural-language Q&A, and automated context injection.

## Upstream provenance

CodeFacts is derived from a deliberately reduced slice of [CodeGraph](https://github.com/suatkocar/codegraph) at revision `856739a1a528cfae9f9232566ae5c043ef8cfaf5`, which is MIT-licensed. See [UPSTREAM.md](UPSTREAM.md) for the derived components and exclusions. The upstream MIT copyright and license notice remain in [LICENSE](LICENSE).
