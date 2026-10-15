# Design

Add a `Default` MCP profile beside the existing `All` and `Explore` variants.
Its three names reuse the current definitions and handlers. Parse only
`default|all|explore`; avoid additional names or a generic operation router.
Both native startup and public `serve()` choose `ToolProfile::default()`.
Keep the explicit `All` in direct service/CLI execution. Retain the current
early allowlist check and existing protocol envelopes.

The three workflows remain distinct: explore supplies lexical discovery and
current source ranges; expand supplies a selected symbol and relationship
sections; impact supplies bounded reverse static dependents and witnesses.
Full `map`, `search`, `outline` and shortest `path` requests remain available
through the all-tools configuration or CLI. Fewer schemas do not establish
equivalent capabilities; ordinary source-reading fallback stays available to
every experimental arm.

Native attribution identified persistence as 4,210 ms of a 5,606 ms private
cold diagnostic. The first storage change retires `idx_edges_source`, covered
by the existing `(source_id,type)` prefix, and normalizes duplicate edge location
metadata. Keep the source/type and unique-occurrence indexes. Remove the retired
index from both schema creation and existing-state migration.

Add `edges.location_in_columns INTEGER NOT NULL DEFAULT 0`. Legacy rows retain
flag zero and their existing properties; fresh typed writes set one, omit the
two `filePath`/`line` JSON keys and hydrate those canonical string values from
their first-class columns. The old writer already overrides caller values with
these canonical locations, including when input metadata is absent. All other
metadata and legacy presence/type behavior remain unchanged. Keep the marker
outside the JSON namespace, filter during serialization without cloning a
whole map, and set it on conflict updates too. No extraction-version bump,
source reparse, mass legacy rewrite or automatic compaction is introduced.
Existing files may gain reusable free pages without shrinking; measure that
separately from fresh-state size. Full metadata and query parity remain gates.

The task experiment uses a frozen source snapshot and independent gold rubric
outside the agent's repository. Existing Codex runner usage accounting is
reused where valid for the pinned runtime. Profile selection is the sole
intentional arm difference. Separate readiness, formal attempts, grading and
aggregation; audit actual calls and source citations before interpreting costs.
Independent contract review found one rubric dispatcher-name error; the corrected
gold names the actual `call_tool` function. Full source-gold review and actual
runtime readiness remain gates before formal task dispatch.

The first actual CLI readiness attempt exposed a Windows helper-directory lock
failure: MCP worked but ordinary source reads failed. Preserve that failed setup
and its usage. The amended harness uses the current host's per-process execution
permissions with logical read-only task instructions, source-hash checks and
command audits; it does not claim OS read-only filesystem isolation. Disable
Web and image generation using the verified current settings, then audit the
actual common core catalog and each native MCP profile. Persist raw process
output and timing before parsing/enriching rollout data so failures retain usage.

Evidence root: `D:\WorkSpace\codefacts\target\mcp-simplification-20261015`.
Published v0.1.18 is copied into `baseline/codefacts-v018.exe` with a checksum
receipt. Original target evidence and source snapshots remain preserved.
