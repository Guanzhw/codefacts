# Post-delivery correctness and evidence repair

Date: 2026-10-16. This unbudgeted goal follows the delivery audit at
`target/post-delivery-audit-20261016/AUDIT.md` in the original development
checkout. Baseline: main `f93740d697ed0aaf1d4654177ce441a5a17e3882`, native
0.2.0, plugin 0.2.1. Work takes place in the attached clean worktree; the
original checkout's 22 protected modified files and prior frozen evidence
remain preserved.

## Required behavior

1. Restore the intended type-reference extraction path in Go and languages
   with the same demonstrated capture mismatch. Return actual source uses,
   their enclosing owners and resolved or explicitly unresolved targets.
   Declaration names and primitive types must not manufacture references;
   genuine recursive uses remain references. Preserve existing definition,
   import and call behavior. Use a new extraction version so unchanged source
   does not silently retain the incomplete old index.
2. Make default `explore` partial freshness useful: report the actual omitted
   file counts and reasons within its total UTF-8 response budget. Unchanged
   files are not omissions. Preserve root, generation and source evidence.
   Keep the default three-tool surface and opt-in seven/one profiles.
   A real DSH reproduction additionally found repeated full rebuilding of
   successful unchanged files whenever a fresh index has an oversized file.
   Complete the forced-pass transition safely: keep omissions visible, retry
   unavailable files, reuse successful unchanged files, and never relabel old
   extraction facts as current when their source could not be reprocessed.
3. Measure the omitted published-0.2.0 old-state upgrade cost from immutable
   old-state originals through private copies. Separate startup/open, first
   response, no-change response, DB allocation/free pages and sidecars. Verify
   source, generation, FTS and public query behavior. The candidate extraction
   version change is a separate re-extraction cost, with its expected new facts
   and generation transition reported explicitly.
4. Correct active install/version/workflow documentation and completed queue
   items while preserving historical dated reports. Registry availability
   requires a successful direct readback; package metadata alone is not proof.
5. Repair the profile-evaluation evidence boundary. First freeze a recoverable
   current runtime and prove each profile's actual model-visible catalog and a
   substantive native MCP result in separate forced canaries. Then run a small,
   preregistered natural-choice comparison on the fixed repaired candidate,
   with the same model, source, ordinary tools, budgets and task prompts.
   Keep canary overhead separate. Freeze tasks, source anchors, rubric, order
   and accounting before data collection; use DSH Flash for independent trace
   and quality checks. Report all attempts, adoption, correctness, time and
   token/cache fields. Small exploratory samples cannot establish a winner or
   general productivity gains.

## Verification and delivery

- Obtain red/green fixtures and real stdio MCP verification for type-reference
  source locations, expand and type-only impact; verify old extraction state
  refreshes once even with unchanged source. Distinguish simulated metadata
  fixtures from retained historical databases.
- Exercise partial and clean indexes through the default MCP text surface,
  including minimum/default byte budgets and no-change refresh.
- Independently review the integrated diff. Use DSH with actual persisted
  `deepseek-v4.1-flash` model evidence for old/new runtime reproduction,
  upgrade verification, task traces and source-backed answer checking.
- Run relevant source/protocol tests, formatting, lint, package/version and
  license checks, followed by CI and an isolated installation of any released
  artifact. Source-built success and published-runtime success are separate.
- Preserve all previous 72 task outcomes and four accepted public performance
  misses. Do not rerun their campaigns to replace unfavorable observations.
  New measurements answer this goal's specific upgrade/extraction questions.
- Record exact source, binary and evidence identities with any reviewable PR
  and delivery result. No completion claim precedes its required checks.

