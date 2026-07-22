# CodeFacts

CodeFacts is a local, source-backed MCP server for repository structure and
static relationships. This npm package is a small, dependency-free launcher:
it downloads a checksum-verified native binary from the matching GitHub Release
and then runs that binary locally over stdio.

It never uploads the repository being indexed.

## Install and prefetch

Use a fixed version in MCP configuration:

```sh
npx -y codefacts@0.1.6 --install
```

The command prints the cached binary path. It is optional but recommended before
the first MCP connection, because a cold download can exceed an MCP client's
startup timeout.

## Run

```sh
npx -y codefacts@0.1.6 mcp --root .
```

`--root` is a default project, not a limit on the MCP server. To inspect
several local projects from one read-only server, start it without `--root` and
pass an absolute `repository_root` argument to every `map`, `search`,
`outline`, `expand`, or `path` call. Each selected project gets its own
external index and every result reports `freshness.repository_root`.

The launcher supports Windows x64, macOS x64/arm64, and Linux x64/arm64.
It writes download progress only to stderr; stdout remains reserved for JSON-RPC.

See the [project README](https://github.com/Guanzhw/codefacts#readme) for
Claude Code and OpenCode configurations, trust model, cache controls, and
manual binary installation.
