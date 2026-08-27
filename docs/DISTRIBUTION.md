# Online distribution

CodeFacts is online-installable but remains local-first. The network is used
only to obtain a versioned executable; all source parsing, SQLite indexing, and
MCP JSON-RPC stay on the user's machine. A hosted HTTP MCP service would need
access to a user's private working tree and is intentionally outside this
project's contract.

## What users run

```text
npx -y codefacts@0.1.12 mcp --root .
```

The optional `--root` is a default project for existing single-project MCP
configurations. A rootless `npx -y codefacts@0.1.12 mcp` server accepts an
explicit `repository_root` in each read-only tool call and creates a separate
external SQLite state file for each selected project.

For an interactive, user-wide coding-agent installation, use
`npx --yes --prefer-online codefacts@latest install`. That is intentionally a
different policy from this version-pinned distribution example: it writes a
rootless MCP command that asks npm to check `latest` at each agent startup.
Shared, offline, and reproducible configurations should stay version-pinned.

The `codefacts` npm package contains no source indexer. It is a Node.js
launcher that:

1. maps the local OS/architecture to one platform package;
2. resolves that package from npm's installed optional dependencies;
3. verifies its version, platform metadata, executable, and embedded SHA-256;
   and
4. starts the native binary with inherited stdio, forwarding `mcp --root ...`.

The launcher is intentionally a thin distribution layer, not a second MCP
server. Its status messages use stderr so they cannot corrupt the JSON-RPC
stream on stdout.

## Release artifacts

Every `v<version>` tag builds these direct-download assets:

| Platform | npm package | Direct-download asset |
| --- | --- | --- |
| Windows x64 | `@acetamido/codefacts-win32-x64` | `codefacts-windows-x86_64.exe` |
| macOS x64 | `@acetamido/codefacts-darwin-x64` | `codefacts-macos-x86_64` |
| macOS arm64 | `@acetamido/codefacts-darwin-arm64` | `codefacts-macos-aarch64` |
| Linux x64 | `@acetamido/codefacts-linux-x64` | `codefacts-linux-x86_64` |
| Linux arm64 | `@acetamido/codefacts-linux-arm64` | `codefacts-linux-aarch64` |

The Release also contains `LICENSE` and `SHA256SUMS` for users who need a
direct-download channel. The release workflow stages and publishes one npm
platform package for each target before publishing the main `codefacts`
launcher. Each platform package carries its native executable, `os`/`cpu`
metadata, exact version, and SHA-256.

## Trust model

The npm packages are the installation trust root. They are versioned and
published with npm provenance. The platform package's embedded SHA-256 rejects
replacement or tampered bytes after installation; a compromised npm package
can still change its expected hash, so users should pin versions and inspect
provenance when reproducibility matters. The launcher has no runtime network
download or GitHub Release fallback.

For air-gapped installs, transfer the main package and the matching platform
package tarball, then install both with npm. Unsupported operating systems and
installations made with `--no-optional` fail explicitly with the package that
is missing.

## Publishing a release

Before creating a tag:

1. Use an npm account that can publish the public package name `codefacts` and
   add a granular `NPM_TOKEN` repository secret for the bootstrap release.
   npm requires a package to exist before a Trusted Publisher can be configured.
   After the first publish, configure npm Trusted Publishing for
   `Guanzhw/codefacts` and `.github/workflows/release.yml`, verify an OIDC
   release, then revoke the bootstrap token. The workflow supports both paths.
2. Keep `Cargo.toml`, `npm/package.json`, and `server.json` on the same semantic
   version. `node npm/scripts/check-release-version.mjs` enforces this.
3. Verify the launcher locally with `node --test npm/test/*.test.mjs` and
   stage a platform package with `node npm/scripts/stage-platform-package.mjs`.

Then create and push a matching tag, for example `v0.1.12`. The workflow audits
licenses, tests the Rust project, builds all assets, creates the GitHub Release
with `SHA256SUMS`, publishes all platform npm packages, and publishes the main
launcher with provenance. A tag must not be considered an online-installable
release until the GitHub Release and every npm package publish job succeeds.
The npm publish step compares each local tarball's SHA-512 integrity with any
existing immutable registry version, so an interrupted run can resume safely;
it fails if an existing version has different bytes.

## MCP Registry

`server.json` describes the same npm package as the stdio server
`io.github.guanzhw/codefacts`. It declares `npx -y codefacts@<version> mcp`,
not a remote endpoint. Once the package is public, publish this metadata with
the official `mcp-publisher` after authenticating as the GitHub owner:

```text
mcp-publisher login github
mcp-publisher publish
```

The MCP Registry is a discovery and standardized-install-metadata service; it
does not host the executable or turn CodeFacts into a remote SaaS.
