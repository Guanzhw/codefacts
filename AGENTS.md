# CodeFacts

## Mission

CodeFacts is a local, verifiable code-facts service for coding agents.
It gives agents compact, source-backed answers about a repository's structure
and relationships. It is not an autonomous agent, a repository chatbot, a
RAG product, or an automatic prompt-injection system.

The intended contract is:

> Models decide what to do. CodeFacts supplies the exact code facts needed
> to decide safely.

## Product Philosophy

- Treat source code as structured data. The canonical representation is a
  relational fact store, initially SQLite, rather than embedding vectors or a
  proprietary opaque index.
- Parse source into attributable facts: file snapshots, symbols, scopes,
  definitions, references, imports, calls, tests, and selected change facts.
  Every derived fact records its source file, byte or line range, source hash,
  extractor, and confidence where resolution is uncertain.
- A call graph is a relation, not a separate product category. Store edges in
  relational tables and use recursive queries or graph algorithms internally
  when they are the clearest implementation.
- FTS is an allowed derived index for exact keyword and identifier discovery.
  Vector search, if ever added, is opt-in candidate recall only. It must never
  be the source of truth or produce an uncited structural claim.
- Prefer a small, stable MCP surface over a large catalog of atomic tools.
  The agent should compose verified facts; the tool should not try to replace
  the agent's planning or reasoning.
- Default to local, deterministic, offline behavior. Do not require Docker,
  Python, an embedding API, a model download, a daemon, or an account.
- Do not silently alter the user's repository. No default hooks, generated
  CLAUDE.md/AGENTS.md files, Git hooks, watchers, background servers, or
  prompt injection. Index state belongs outside the repository unless the user
  explicitly chooses otherwise.
- Windows is a first-class target, alongside macOS and Linux. Installation
  must not require users to install Rust or compile a CLI themselves.

## Read-only workflows

The native runtime exposes these read-only MCP workflows:

1. `map` — repository structure, language mix, and high-level symbol counts.
2. `search` — symbols, endpoints, and documentation headings; not raw grep.
3. `outline` — symbols or headings in one file.
4. `expand` — a symbol's definition, callers, callees, references, and test-associated symbols.
5. `path` — the shortest static relationship path between confirmed symbols.
6. `explore` — bounded lexical source discovery, repository orientation and
   explicit source-range reads with current hashes.
7. `impact` — bounded transitive static dependents and test-associated symbols,
   with witness relationships and explicit traversal cutoffs.

Direct CLI entry points expose these workflows. `node`, `callers`, and `callees`
use `expand` and its sections. A direct CLI query may select its current directory;
MCP requires an explicit per-request root or a configured default.

Each result must be bounded, token-aware, and include evidence locations.
Empty or uncertain results must say so plainly; an empty static path never
claims runtime unreachability.

Out of scope for v1: code editing, security scanning, code health scoring,
Git analytics, dashboard/UI, natural-language Q&A, persistent agent memory,
automatic context injection, automatic hooks, embeddings, and reranking.

## Architecture Boundaries

```text
source files (+ optional LSP facts)
  -> parsers and extractors
  -> SQLite code facts
  -> derived FTS index
  -> stdio MCP tools
```

LSP is a potential high-quality extractor for type-aware languages, not a
replacement for the CodeFacts fact store. Any future vector index is a
parallel derived index below the MCP layer and may only return candidates that
are verified against stored facts and source spans before they are returned.

Keep the deployable runtime as a single native stdio binary whenever practical.
The Claude Code plugin should only start that binary and ship concise skill
guidance; it must not add a second intelligence layer.

## Correctness and Performance

- Correctness precedes breadth. Add a language or relation only with fixtures
  that check the returned fact and source span.
- Model dynamic-language uncertainty explicitly. Use confidence and resolution
  evidence instead of pretending all edges are exact.
- Detect stale indexes through source hashes and report freshness in every MCP
  response. Never return stale facts silently.
- Benchmark cold index, no-change refresh, one-file refresh, disk use, peak
  memory, and P95 MCP query latency on small, medium, and dependency-heavy
  repositories. Exclude ignored dependency trees by default.
- Test the MCP protocol end to end, not only internal query functions.

## Upstream Reuse

CodeGraph may be used as an implementation reference or fork because it is
MIT-licensed. Preserve required copyright and license notices, document every
upstream-derived component, pin the exact upstream revision, and run a
dependency-license audit before publishing releases.

Do not inherit CodeGraph's product surface by default. Keep only components
that serve the CodeFacts contract, especially parsing, normalized facts,
incremental indexing, SQLite storage, FTS, and stdio MCP transport.

## Working Practices

- Make narrow changes and preserve the product boundaries above. Reject feature
  additions that turn the project into an agent, a RAG system, or a general
  repository-management suite.
- Verify behavior with real repositories and protocol-level tests. Report the
  evidence, not a plausible explanation.
- Use `pi` as an optional second opinion for non-trivial design reviews,
  implementation reviews, and pre-commit risk scans. Invoke it through WSL
  with interactive Zsh so `~/.zshrc` loads the required environment:

  ```powershell
  wsl.exe -d Ubuntu -- zsh -ic '/home/qq110/.npm-global/bin/pi --provider opencode-go --model glm-5.2 -p "Review the current CodeFacts diff for correctness, scope drift, and risks."'
  ```

  Treat its output as advisory and verify every claim against the source and
  real behavior. Use `deepseek-v4-flash` for fast focused checks,
  `deepseek-v4-pro` for substantive implementation work, and `glm-5.2` for
  every `pi` review, including implementation, design, and pre-commit reviews.
