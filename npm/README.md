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

`--root` is a default project, not a limit on the MCP server. To inspect
several local projects from one read-only server, start it without `--root` and
pass an absolute `repository_root` argument to every `map`, `search`,
`outline`, `expand`, or `path` call. Each selected project gets its own
external index and every result reports `freshness.repository_root`.

The launcher supports Windows x64, macOS x64/arm64, and Linux x64/arm64.
It writes status only to stderr; stdout remains reserved for JSON-RPC.

See the [project README](https://github.com/Guanzhw/codefacts#readme) for
Claude Code and OpenCode configurations, trust model, and manual binary
installation.
