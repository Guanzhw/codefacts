# CodeFacts

CodeFacts is a local, source-backed MCP server for repository structure and
static relationships. This npm package is a small launcher that resolves the
matching platform-specific optional dependency and runs its native binary
locally over stdio.

It never uploads the repository being indexed.

## Interactive agent install

```sh
npx --yes --prefer-online codefacts@latest install
```

The interactive installer detects and configures Codex, Claude Code, OpenCode,
Cursor, and Gemini CLI after showing the changes and receiving confirmation. It
only writes the selected agent's `codefacts` MCP entry; it never creates project
files, instructions, permissions, hooks, indexes, or background processes.
Before it writes a selected configuration, it verifies the installed native
package; a verification failure leaves agent configuration unchanged.

Those entries run `npx --yes --prefer-online codefacts@latest mcp`, which makes
npm check for the current `latest` package when the agent starts its MCP server.
The platform binary is installed by npm's optional dependency resolution. Use
a fixed `codefacts@<version>` manual configuration for offline or reproducible
setups.

## Verify the installed binary

```sh
npx --yes --prefer-online codefacts@latest --install
```

This optional command prints the installed platform binary path and verifies
its package metadata and SHA-256. It performs no GitHub Release download.

## Run

```sh
npx --yes --prefer-online codefacts@latest mcp --root .
```

MCP defaults to `explore`, `expand`, and `impact`; `--tools default` selects
the same profile. Use `mcp --tools all` for all seven workflows, including
`map`, `search`, `outline`, and `path`, or `mcp --tools explore` for exploration
alone. Existing MCP configurations that call those four exact-fact tools should
append `--tools all` and restart the server. Direct CLI commands retain every
workflow.

`--root` is a default project, not a limit on the MCP server. To inspect
several local projects from one read-only server, start it without `--root` and
pass an absolute `repository_root` argument to every enabled tool call. Each
selected project gets its own external index. Exact-fact and impact results
report `freshness.repository_root`; exploration identifies its root in the text
header.

### MCP response formats

MCP calls default to concise, agent-readable Markdown text, matching the direct
CLI. The default response is in `content[0].text` and has no duplicate
`structuredContent`; `explore` is always text-only. The presentation omits raw
source hashes and routine or repeated fields while retaining freshness,
partial-source reasons, exact locations, uncertainty, relationship direction,
active cutoffs, and continuation cursors. A small exploration owner is shown
in full when it fits; otherwise the text marks the preview and omitted lines.

Clients that parse `structuredContent` should pass `format: "compact"` or
`format: "full"` on structured workflows. These explicit modes preserve their
existing machine schemas and hash evidence. `explore` remains text-only. For
example, an `expand` call that needs a structured result should include
`"format": "compact"` with its usual symbol and section arguments.

The launcher supports Windows x64, macOS x64/arm64, and Linux x64/arm64.
It writes status only to stderr; MCP stdout remains reserved for JSON-RPC.

## Direct navigation commands

```sh
npx --yes codefacts@latest node <symbol> --file <file> --root <repository>
npx --yes codefacts@latest callers <symbol> --root <repository>
npx --yes codefacts@latest callees <symbol> --root <repository>
npx --yes codefacts@latest explore <code-terms> --root <repository>
npx --yes codefacts@latest impact <symbol> --max-depth 3 --root <repository>
```

Direct queries default to the current directory, external index state and
readable Markdown. Use `--format compact` or `--format full` for JSON;
`explore` returns bounded text. Same-name symbols return disambiguation candidates;
select an exact ID or add `--file`. Run `<command> --help` for options.

## Static evidence and optional language servers

Direct callers are one-hop static relationships; inspect confidence and receiver
resolution before treating a same-name candidate as a confirmed call. Returned
`tests` are statically associated symbols, not coverage or a complete runnable
list. `impact` follows bounded confirmed stored relationships; inspect depth,
node and work cutoffs. An exhausted indexed subgraph is not complete runtime
impact. Use source and relevant tests to confirm dynamic behavior.

`--lsp auto` can use separately installed `rust-analyzer`,
`typescript-language-server` (JavaScript/TypeScript), `pyright-langserver`
(Python), `gopls` (Go), `clangd` (C/C++) and `bash-language-server` (Bash).
CodeFacts does not install them. Python's independent `pyright` type-checking
command is not the language-server entry point. `--lsp off` keeps static
analysis without starting providers. Actual semantic reference status is
reported separately; it does not upgrade heuristic calls or change static
impact relationships. Provider-supplied references are not a guarantee of type
binding; Bash name matching can still need source confirmation. See the project
README for requirements and validation.

See the [project README](https://github.com/Guanzhw/codefacts#readme) for
Claude Code and OpenCode configurations, trust model, and manual binary
installation.
