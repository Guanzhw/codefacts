# SWE model-image recipes

These ten recipes preserve the sanitation instructions actually used in the
historical local environment. Nine Dockerfiles replace only their immutable
`FROM` value with the required `OFFICIAL_IMAGE` build argument. Preact3010 also
composes its actual config-only `ENV HOME=/home/nonroot` and `USER 1000:1000`
instructions after unchanged sanitation; its historical followup had identical
rootfs layers. Vue's sanitizer
and dependency directory list are byte-for-byte copies. The portable recipes
have received static checks; they have not been built or run in this export.

`recipes.json` maps each public instance to its recipe and recorded image
identities. Registry tag/index digest, platform manifest digest, registry
config digest, and historically loaded image identity are separate fields.
Historical locally loaded identities can differ from registry config digests.
A fresh acquisition/build must record its own identities and acceptance
results. Historical model IDs identify observations, not downloadable images
or expected reproducible output IDs.

## Acquire and build

Run these commands in the operator's Linux Docker environment. Set `RECIPES`
to this directory's absolute Linux path. This concrete Preact3562 example
uses the recorded platform manifest digest; use the corresponding row from
`recipes.json` for each other task. Image acquisition requires network access;
the subsequent sanitation build does not.

```sh
RECIPES=/absolute/path/to/community/environment-recipes
OFFICIAL_TAG=swebench/sweb.eval.x86_64.preactjs_1776_preact-3562:latest
REGISTRY_REF=swebench/sweb.eval.x86_64.preactjs_1776_preact-3562@sha256:d007ec55602bf6a425a9063e26075fc40a9e7747e478572712b83da10131958f
MODEL_TAG=codefacts-community/preact-3562-sanitized:local
docker pull --platform linux/amd64 "$REGISTRY_REF"
docker tag "$REGISTRY_REF" "$OFFICIAL_TAG"
OFFICIAL_IMAGE=$(docker image inspect --format '{{.Id}}' "$OFFICIAL_TAG")
docker image inspect "$OFFICIAL_IMAGE" > original-image-inspect.private.json
docker build --pull=false --network=none \
  --build-arg OFFICIAL_IMAGE="$OFFICIAL_IMAGE" \
  -f "$RECIPES/node/preact-3562.Dockerfile" \
  -t "$MODEL_TAG" "$RECIPES/node"
docker image inspect --format '{{.Id}}' "$MODEL_TAG"
```

Retain the original grading tag and immutable original image. The grader uses
the original official `record.image`; model `sandboxes[instance_id].image`
uses the newly verified sanitized config ID. Save acquisition, original/source
inventory, recipe hashes, build output and model identity in a private runtime
receipt. Verify acquired source bytes and modes against canonical source
before claiming source equivalence. Historical Caddy4774 (345 files) and
Axios5085 (178 files) original HEAD and filesystem inventories now match
canonical bytes and normalized modes.

For Go/Rust recipes, replace `-f` with the row's recipe path and use that
recipe's parent directory as the build context. For Vue use
`-f "$RECIPES/vue/core-11899/Dockerfile"` and the context
`"$RECIPES/vue/core-11899"`; its two COPY inputs must be included. Build context
contains recipe inputs only. Docker ARG receives an acquired immutable local
`sha256:` image config ID. No default image is chosen by the Dockerfile.

## Retained runtime and source mounting

| Family | Actual sanitation and retained dependencies |
| --- | --- |
| Go: Caddy4774/5995, Terraform35543 | Removes embedded `/testbed`, task Go compilation cache and root startup; retains compiler, GCC, Git and downloaded third-party module cache. |
| Rust: Tokio6603, Coreutils6690, Nushell12901 | Removes embedded `/testbed` including task `target`, and root startup. Tokio also removes its observed temporary compilation probe. Preserves Rust/Cargo, registry and Nushell's third-party reedline Git dependency. Login PATH fragment exposes the installed Cargo toolchain to `bash -lc`. |
| Node: Axios5085, Preact3562/3010 | Keeps only `/testbed/node_modules` and toolchain/browser dependencies; removes embedded project files and each recipe's observed startup/cache artifacts. Declares one dependency VOLUME. |
| Vue11899 | Keeps exactly 17 inventoried node_modules trees, their ancestor directories and third-party pnpm layout; removes other project files, compiler-sfc dist, Git, logs, history and V8 cache; replaces shell startup with inert comments. Declares 17 dependency VOLUMEs. |

Prepare canonical source through existing `prepareCommunitySlot` using an
independent copy and a synthetic single commit with no remotes. Existing
`startSandbox` binds that Windows-backed source RW at `/testbed` and `.git` RO.
Docker populates the declared image VOLUMEs into new per-container anonymous
volumes over the source bind. Docker automatically creates empty host
mountpoint directories, including Vue's nested paths. No host dependency copy
or manual precreation of these directories is needed. Dependencies and symlink
layout stay native inside the volumes. Verify host mountpoints stay empty and
dependency paths do not enter the submitted patch.

Use the current model sandbox defaults: network none, 4 CPU quota, 6GiB,
1024 processes/threads, dropped capabilities and no-new-privileges. Inspect the
actual mount/isolation configuration, source write and Git write rejection,
retained dependency identities, absence of embedded project/evaluator material,
and clean source patch after checks. After normal and timeout runs remove the
owned container and anonymous volumes through existing cleanup, then verify
their absence. Keep the inventory and controls outside model source roots.
Official grading uses its own upstream resource/network behavior.

## Historical observations and fresh validation

These are scopes actually exercised on the historical images, rather than
results of the exported parameterized Dockerfiles. All ten original-image
positive/negative controls recorded `gold resolved=true`, `empty resolved=false`
and no infrastructure failure. Caddy4774's controls were checked separately
from its compile-only model validation.

| Instance | Historical model check and result |
| --- | --- |
| Caddy4774 | `go test -run ^$ ./modules/caddyhttp/reverseproxy`: compile-only, passed; historical 2CPU/2GiB/512 PIDs. Normal/timeout cleanup checks also passed. Canonical source/image byte and mode comparison passed. |
| Caddy5995 | `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local GOMAXPROCS=4 go test -count=1 -v ./caddyconfig/caddyfile ./modules/caddyhttp/rewrite`: 21 cases passed. |
| Terraform35543 | `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local GOMAXPROCS=4 go test -count=1 -v ./internal/terraform -run ^TestContext2Validate_ -timeout 240s`: 81 cases passed. |
| Tokio6603 | `timeout 600s cargo test --offline -j4 -p tokio --features full --test sync_mpsc`: 88 passed at historical512 PIDs. Separate all-target metadata check lacked addr2line0.25.1. |
| Coreutils6690 | `timeout 600s cargo test --offline --locked -j4 -p uu_cp --lib`: 4 passed. |
| Nushell12901 | `timeout 600s cargo test --offline --locked -j4 -p nu-engine -p nu-protocol --lib`: 59 passed. |
| Preact3562 | `npm run build`, `npm run test:mocha`, `npm run test:ts`, `npm run test:karma -- --grep=test/browser/render.test.js`: build passed, Mocha29 passed, TypeScript16 passed/2pending, browser67 completed at1024 PIDs. Old512-task run hit EAGAIN. |
| Preact3010 | Same four standard npm commands as3562: build passed, Mocha29 passed, TypeScript16 passed/2pending, browser65 completed at1024 PIDs with USER1000:1000 and HOME=/home/nonroot. Babel reported an unwritable cache and disabled caching; commands still passed. Earlier root-user npm failures remain historical evidence. |
| Axios5085 | `npm run test:mocha`:96 passed,4 failed: HTTP400 expectation, Unix socket ENOTSUP on Windows bind, HTTPS timeout, external DNS while offline. Normal/timeout cleanup passed. Canonical source/image byte and mode comparison passed. |
| Vue11899 | `pnpm exec vitest run -c vitest.unit.config.ts packages/reactivity/__tests__/effect.spec.ts --maxWorkers=4 --minWorkers=1` and `pnpm check`: 70 pristine reactivity tests and full repository TypeScript noEmit passed. Fresh Windows bind slot verified all17 volumes and automatic host mountpoints, with owned cleanup. |

Run the corresponding scoped checks on each newly built image through the
existing real sandbox; retain failures and unsupported coverage. Windows source
bind mounts do not support filesystem Unix-domain sockets, as observed by
Axios. Focused tests do not establish a passing full upstream suite. Fill the
existing `swe-images.template.json` with actual new inventory, source comparison,
isolation and private original-image control receipts; then set
`workspaceVerified` only from those new checks and freeze a new campaign.

Both Docusaurus images were not loaded at this recipe snapshot.
Their pending entries in `recipes.json` carry no ready claim. Keep private
controls, selected grading records, evaluator reports and host configuration
outside this public recipe directory.
