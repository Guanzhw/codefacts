# Online distribution

CodeFacts is online-installable but remains local-first. The network is used
only to obtain a versioned executable; all source parsing, SQLite indexing, and
MCP JSON-RPC stay on the user's machine. A hosted HTTP MCP service would need
access to a user's private working tree and is intentionally outside this
project's contract.

## What users run

```text
npx -y codefacts@0.1.8 mcp --root .
```

The optional `--root` is a default project for existing single-project MCP
configurations. A rootless `npx -y codefacts@0.1.8 mcp` server accepts an
explicit `repository_root` in each read-only tool call and creates a separate
external SQLite state file for each selected project.

For an interactive, user-wide coding-agent installation, use
`npx --yes --prefer-online codefacts@latest install`. That is intentionally a
different policy from this version-pinned distribution example: it writes a
rootless MCP command that asks npm to check `latest` at each agent startup.
Shared, offline, and reproducible configurations should stay version-pinned.

The `codefacts` npm package contains no source indexer. It is a Node.js
launcher that:

1. maps the local OS/architecture to one named GitHub Release asset;
2. reads that asset's SHA-256 embedded in the same versioned npm package;
3. downloads the asset to a versioned user cache if no verified cache exists;
4. verifies the cached executable before every invocation; and
5. starts the native binary with inherited stdio, forwarding `mcp --root ...`.

The launcher is intentionally a thin distribution layer, not a second MCP
server. Its status messages use stderr so they cannot corrupt the JSON-RPC
stream on stdout.

## Release artifacts

Every `v<version>` tag builds these direct-download assets:

| Platform | Asset |
| --- | --- |
| Windows x64 | `codefacts-windows-x86_64.exe` |
| macOS x64 | `codefacts-macos-x86_64` |
| macOS arm64 | `codefacts-macos-aarch64` |
| Linux x64 | `codefacts-linux-x86_64` |
| Linux arm64 | `codefacts-linux-aarch64` |

The Release also contains `LICENSE` and `SHA256SUMS`. The release workflow
stages a temporary copy of `npm/`, replacing its placeholder `checksums.json`
with hashes from that exact file, then publishes that staged package. The
committed placeholder is deliberately unusable for download: it prevents a
source checkout from silently trusting an unpinned release asset.

## Trust model

The npm package is the initial trust root. It should remain small, versioned,
and published with npm provenance. Its only installer dependency is the
MIT-licensed `jsonc-parser`, used to preserve comments and unrelated fields
when the interactive installer updates JSONC agent configuration. The embedded
SHA-256 means a compromised or mutable GitHub Release asset is rejected unless
its contents match the hash shipped with the npm package. Conversely, a
compromised npm package can change the expected hash, so users should pin
package versions and inspect provenance for upgrades when reproducibility is
required.

The launcher uses an exclusive cache lock and an atomic rename to avoid two
MCP clients publishing a partial download into the same cache. The verified
binary cache lives outside the indexed repository:

- Windows: `%LOCALAPPDATA%\CodeFacts\bin`
- macOS: `~/Library/Caches/codefacts/bin`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/codefacts/bin`

Set `CODEFACTS_CACHE_DIR` to a different cache directory. Set
`CODEFACTS_DOWNLOAD_BASE_URL` only for a trusted mirror that has the same
versioned names and bytes; checksum verification remains active. Air-gapped
systems can pre-populate the cache from a verified asset or configure the
native binary directly instead of using `npx`.

## Publishing a release

Before creating the first tag:

1. Use an npm account that can publish the public package name `codefacts` and
   add a granular `NPM_TOKEN` repository secret for the bootstrap release.
   npm requires a package to exist before a Trusted Publisher can be configured.
   After the first publish, configure npm Trusted Publishing for
   `Guanzhw/codefacts` and `.github/workflows/release.yml`, verify an OIDC
   release, then revoke the bootstrap token. The workflow supports both paths.
2. Keep `Cargo.toml`, `npm/package.json`, and `server.json` on the same semantic
   version. `node npm/scripts/check-release-version.mjs` enforces this.
3. Verify the launcher locally with `node --test npm/test/*.test.mjs`. That
   test creates a release-like binary asset, runs `npm pack`, installs it into
   a clean prefix without scripts, then completes a real stdio MCP handshake
   and source-backed search through the launcher.

Then create and push a matching tag, for example `v0.1.8`. The workflow audits
licenses, tests the Rust project, builds all assets, creates the GitHub Release
with `SHA256SUMS`, stages a checksum-pinned npm tarball, and publishes it with
provenance. A tag must not be considered an online-installable release until
both the GitHub Release and `npm publish` jobs succeed.

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
