# Operator preparation

These commands prepare a new experiment from fixed inputs. They do not migrate
an existing freeze. Keep original data, source archives, grading records and
runtime receipts outside the model-visible source roots. Commands that acquire
or install software below are recipes; they were not rerun to validate this
delivery.

## Runtime and official environments

`environment-pins.json` records the observed Node, ripgrep, DSH, SDK, native
arm, Python and official upstream revisions. The two requirements files retain
the complete recorded Python package versions. Install into dedicated operator
environments using those Python versions. For example, after setting absolute
`COMMUNITY`, `CONTEXT_ENV`, `SWE_ENV`, `CONTEXT_OFFICIAL` and `SWE_OFFICIAL` paths
in Linux:

```sh
python3.11 -m venv "$CONTEXT_ENV"
"$CONTEXT_ENV/bin/python" -m pip install -r "$COMMUNITY/context-requirements.txt"
python3.12 -m venv "$SWE_ENV"
"$SWE_ENV/bin/python" -m pip install -r "$COMMUNITY/swe-requirements.txt"
git clone https://github.com/EuniAI/ContextBench "$CONTEXT_OFFICIAL"
git -C "$CONTEXT_OFFICIAL" checkout --detach 1436c28a8eb95496da4ea69ad458b9f8a8eb7d61
git clone https://github.com/SWE-bench/SWE-bench "$SWE_OFFICIAL"
git -C "$SWE_OFFICIAL" checkout --detach 02e7a74ffd0b707aab73d203fe87bdc7c76afc8e
"$SWE_ENV/bin/python" -m pip install --no-deps -e "$SWE_OFFICIAL"
```

Use Python 3.11.15 and 3.12.13 specifically; `python3.11`/`python3.12` above
must resolve to them. Retain version outputs and `pip freeze --all` for both
environments in a private runtime receipt. The Context evaluator loads the
official source directly, so its environment does not need an editable install.
`official.py` validates the pinned upstream revisions and evaluator file bytes.

Install the exact Node packages and platform binaries into task-owned paths.
The top-level versions alone do not pin transitive Node dependencies: preserve
the installation's lockfile, `npm ls --all --json`, package identities, versions
and binary checksums as runtime evidence. Include the **complete shared SDK
parent `node_modules`**, not just the SDK directory, in `upstreamRoots`, because
dependencies can be hoisted. The runner freezes all files in DSH/SDK/native
runtime and declared upstream trees. A fresh dependency resolution can differ
from the historical runtime even at the same top-level versions; report a new
runtime identity. No historical npm transitive lock is supplied here.

The completed Context campaign used DSH 0.2.0-rc.2; the current installation is
0.2.1-rc.2. Preserve each campaign's actual runtime identity. The Go route uses
`deepseek-v4.1-flash`; its remote backend revision is unavailable, so the
DeepSeek 1017 revision is not asserted.

## Export, acquire sources and build private Context baselines

First use `export-fixed-selection.py` as described in README. Copy
`operator.template.json` to a private operator config, replace every placeholder
with absolute paths for the actual host, and set a new campaign identity. The
`sourcesDir` and `sourceEvidenceDir` must be new. On the benchmark's Windows
runtime, keep `wsl-lx` and point `wsl`/`wslDistro` at the real WSL runtime.

```powershell
node community/operator.mjs --mode sources --config C:\eval\operator.json
node community/operator.mjs --mode sources --config C:\eval\operator.json --execute
```

The first command only plans; the second calls the existing source downloader
for all 24 fixed base commits, preserves modes and symlinks, verifies source
manifests, and retains archives and transport receipts. The downloader owns the
`mui/material` -> `mui/material-ui` fetch alias while manifests and public tasks
retain the official `mui/material` identity. Do not rerun against historical
source/evidence directories. Failed preparation stays as evidence; repair or
retry it explicitly through the existing API rather than inventing replacement
tasks.

Context scoring needs separate root-owned Git baselines on native WSL ext4.
Run `prepare-context-bases.py` **inside WSL as the same root identity used by
grading**, using Linux absolute paths and the installed Context Python. Let
`$DATA`, `$SOURCES`, `$SOURCE_EVIDENCE` refer to the exported data and downloaded
source/archive paths; `$BASES` must be a new directory beneath an existing
root-owned native `/tmp` parent:

```sh
"$CONTEXT_ENV/bin/python" "$COMMUNITY/prepare-context-bases.py" --data-dir "$DATA" --sources-dir "$SOURCES" --source-evidence-dir "$SOURCE_EVIDENCE" --out "$BASES"
"$CONTEXT_ENV/bin/python" "$COMMUNITY/prepare-context-bases.py" --data-dir "$DATA" --sources-dir "$SOURCES" --source-evidence-dir "$SOURCE_EVIDENCE" --out "$BASES" --execute
```

The script uses retained archives, checks their recorded identity, extracts
independent bytes, creates source-only synthetic Git commits with hooks and
filters disabled, and calls the existing official source-identity checker.
Its `context-bases.json` records actual synthetic commits and private roots.
Copy that object's entries into the grading template's `contextBases`; do not
substitute upstream commits for these synthetic commits. Per-task receipts
remain beside the private clones. The script was executed on all 12 real fixed
Context inputs into fresh root-owned native Linux baselines. The existing
checker verified source bytes, symlink targets and complete inventories; an
additional check matched filesystem executable/symlink modes and Git index
modes to every manifest entry. All 98,330 entries (98,329 regular files and one
symlink) passed. The first preparation attempt exposed a missing `.git/info`
directory with empty Git templates; the script now creates it explicitly.
The failed preparation and successful fresh retry were both retained.

## Model images and official grading images

Acquire original images and build the model images using the
[sanitation recipes](environment-recipes/README.md). Ten historical recipes
are available with portable build commands and their actual validation scopes;
the portable exports have received static checks only. Supply the resulting
verified local images to the operator. For each SWE task retain an inventory with original official
record.image tag, registry manifest digest, local image/config identity,
sanitized model image ID, isolation recipe, source-equivalence check and gold
and empty official control reports. The runner's `sandboxes[instance_id]` entry
must be `{"image":"sha256:<local-sanitized-image-id>","workspaceVerified":true}`.
This is the model image identity, distinct from the original official grading
tag in the private SWE record. Never rewrite that record to the sanitized image.
`swe-images.template.json` lists all 12 fixed SWE instances with the required
inventory fields. Its empty fields mean operator evidence is required, rather
than a claim about an existing host's images. Fill it from actual records and
controls, retain it privately, and pin it as an operator input. Copy admitted
sanitized IDs and `workspaceVerified` into the operator config's `sandboxes`.

The model image must contain its language toolchain and offline dependencies,
with embedded task history, gold/evaluator files and task build products
removed. Retain the original image for official grading. Inspect each image's
actual contents and validate its own recipe. All 12 per-task entries and controls are required for a full SWE cohort.
Missing, failed and unexecuted controls remain explicit. This delivery does not
claim that all SWE images or controls are ready.

Model `source_exec` containers run with network disabled and no Docker socket
or provider credentials, with 4 CPUs, 6 GiB RAM and a 1024-process/thread limit
shared by all three arms. Preflight found that Preact's unchanged parallel build
needs more than 512 tasks on this host; it passed at 1024 with about 2 GiB peak
memory and no OOM. This adjustment preceded the SWE freeze and model attempts.
The pinned official SWE harness has its own default
network and `SYS_ADMIN` behavior; do not describe official grading as offline
or as sharing the model sandbox policy.

## Build and freeze a new manifest

Fill `grading.template.json` with actual paths and Context bases. For Context
use the verified original Parquet; for SWE use the private selected JSONL.
Record real positive/negative control results and runtime receipts. Add those
receipt files, original/selected grading data and any image/source inventories
to operator `inputFiles`/`runtimeFiles`; include pinned official scorer and full
SDK parent trees in `upstreamRoots`. Existing grader config paths may be used
read-only to validate a newly generated manifest, but their historical freeze
must remain unchanged.

```powershell
node community/operator.mjs --mode manifest --config C:\eval\operator.json
node community/operator.mjs --mode manifest --config C:\eval\operator.json --execute
node community/campaign.mjs --manifest C:\eval\new-setup\manifest.json --mode freeze
```

Manifest generation requires existing 24 public rows, source manifests for the
selected cohort, grading configuration, runtime/receipt paths and, for SWE,
verified immutable model image IDs. It checks fixed selection/source identities
and invokes `validateManifest`. It writes only the new setup directory; it does
not freeze, inspect every source byte, run controls or invoke the model. The
freeze step performs complete source inventory and runtime pin checks.

Then use the README run/grade/summary commands. New Context grading uses
`tempfile.TemporaryDirectory` in the Linux runtime (normally `/tmp`) and records
its owner, mode and filesystem in `worktree-environment.json`. It removes the
current temporary checkout after saving results, including on evaluator errors.
Use native ext4 for that runtime. The historical output/temp symlink adapter is unnecessary for current
`official.py`; do not apply it to a new campaign. Before model work, run the
documented actual-source gold/empty Context controls and per-task SWE controls
and retain their official reports. Model and grading phase deadlines and all
failed attempts remain part of the new experiment evidence.
