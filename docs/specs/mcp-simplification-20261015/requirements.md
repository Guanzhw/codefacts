# Three default MCP workflows and index efficiency

The user authorized an unbudgeted delivery goal on 2026-10-15: simplify the
default MCP menu to `explore`, `expand`, and `impact`, compare seven/three/one
tools on actual agent tasks, and improve cold indexing and state disk use.
Continue the established validated-release and installed-plugin workflow.
The planned release is v0.2.0: its intentional default MCP menu change is
documented with `--tools all` as the explicit seven-workflow configuration.

## Product contract

- `codefacts mcp` and `--tools default` expose exactly the three workflows.
  `--tools all` retains all seven; existing `--tools explore` retains one.
  The public MCP `serve()` convenience entry follows the same default.
- One allowlist governs both discovery and execution, across legacy and modern
  protocols. An unavailable tool fails before selecting or indexing a project.
- Direct CLI commands, including `node`, `callers`, `callees`, `map`, `search`,
  `outline`, and `path`, retain their existing contracts. Their execution uses
  the full service independently of the MCP menu.
- Keep current source hashes, freshness, generation/cursor checks, source spans,
  bounded output, relationship direction/confidence and partial evidence.
  Simplification changes the entry points, not the meaning of existing facts.
- Update native/npm help, README, installer examples and plugin skill guidance
  where their advertised defaults are affected. Explain opting into `all`.
  Keep catalog ordering deterministic; preserve the existing all-tools order.

## Actual task comparison

Freeze one experiment candidate binary, complete agent runtime, model/effort, source manifests,
tasks, independent grading rubrics, common prompt, three configurations and
execution order before formal calls. Use one binary for all arms; only the
selected MCP profile varies. Native/MCP parity does not prove agent benefit.

The planned primary campaign is eight real-repository, read-only tasks across
the preserved Go, JavaScript, Rust and CodeFacts/Markdown corpora, three arms
and three balanced repetitions (72 attempts). Label reused diagnostic sources
as such. Use `gpt-6.1-sol` at medium reasoning after real availability readiness.
Each arm has the same ordinary source-reading shell tools; CodeFacts CLI/SQL,
other profiles, external agents/network and evaluation artifacts are excluded
from task execution. Guidance is identical and allows natural tool choice.

Readiness must establish source reads, substantive MCP facts, the actual
three-profile catalogs, usable runtime helpers and provider usage records.
Preserve readiness costs separately. Count every formal failure, timeout and
repair attempt. Grade source-backed completeness and critical errors before
revealing efficiency metrics. Freeze an actionable wrong-tool classification;
multiple useful calls alone are not wrong selections.

Report acceptance/full correctness, missed criteria, tool use/adoption, wrong
selections, total input/output/cached tokens, output volume and wall time.
Cached input is a subset of input; reasoning is not counted twice. Report
tokens/time per correct completion using costs of all attempts. Compare matched
correct task pairs and the full fixed workload; retain failures and variation.
No general editing-productivity claim follows from read-only source tasks.
Resolve reproducible capability or correctness losses before release; report
stochastic quality/cost tradeoffs without declaring a winner from tokens alone.

Before any formal task attempt, separate this comparison from native performance
release acceptance. Candidate `425b46b7` from source `f02493d` has passed source,
fact, protocol, readiness and independent analysis review; its native performance
result remains 56/57, overall FAIL. It may serve as the single fixed binary for
all 72 task attempts while the remaining refresh-tail issue is investigated.
Keep every task, profile, prompt, source, model, scoring rule and attempt cost
unchanged. Label quantitative results with this experiment candidate; later
builds require their own measurements even when their facts and schemas agree.
The existing 57 native release gates remain unchanged. Any diagnostic quiet
period pauses dispatch after a completed balanced three-slot block, before
allocating the next slot; immediate failure stops and no-retry rules still apply.

## Cold indexing and storage

Use an immutable private copy of published v0.1.18 Windows binary SHA256
`5443e4ed0e244dd646e02af6d9aecd67b1a8b690c711aaad013cf51dd6760b56`
and the existing four frozen source manifests. New diagnosis and runs belong
under `target/mcp-simplification-20261015`; preserve all previous campaigns.
Attribute table/index bytes and cold phases before selecting optimizations.

Before final timing freeze binary/source hashes, workloads, sampling and order.
Use fresh external state/private source copies, three interleaved cold rounds,
20 warm samples per case and 30 paired edit/restore samples per medium/Go arm.
Run performance campaigns alone; report OS-cache conditions and compiler
differences. Record process cold wall time, index pipeline time, live and closed
DB/WAL/SHM bytes, peak memory, warm P50/P95 and changed-file P95.

Primary Go gates versus newly measured published v0.1.18 are cold wall median
ratio <=0.90 and fresh closed-state disk ratio <=0.90; stretch targets are 0.80
and 0.75. Other cold cases, existing warm queries, paired medium/Go refresh and
sampled peak memory should remain within 1.10. New Go explore/impact warm P95
remains <=1000 ms. Preserve failing candidates; any repeated final campaign
requires a changed candidate or an explicit diagnosed environmental failure.

All source facts, edge occurrences and hydrated metadata must remain equivalent.
Verify FTS/ranking/paging and old v0.1.18 state upgrade with unchanged source
hashes and generation. Report upgrade cost and allocated/free disk separately;
fresh-state savings do not establish shrinkage of existing files. Do not remove
heuristic relationships, confidence evidence or supported files to save space.

## Release and acceptance

Independently review contract, storage correctness and final implementation.
Root inspects the final diff and primary receipts. Run appropriate source,
protocol, CLI, launcher, license and platform checks, then publish verified
improvements, update plugin guidance, and validate fresh installed CLI/MCP and
the actual installed plugin configuration. Keep each channel's evidence and
remaining limitations explicit. Preserve the original dirty C09 checkout.
