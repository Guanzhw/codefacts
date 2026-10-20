# Benchmark design

## Two estimands

`guided-use` measures a configured workflow: the first repository inspection
uses the supplied navigation tool when one exists; otherwise it uses ordinary
source tools. Later navigation is free. The first assistant step containing any
repository tool call must include a native call for a treatment. Parallel calls
within that step are allowed. At least one native call must succeed and return
a location from the frozen source manifest; errors and later retries remain in
cost. An ordinary attempt must inspect source using the common tools. These
trace predicates are audited separately from blind answer grading. A treatment
that fails them is nonadherent and cannot support a tool-use benefit claim.

`natural-choice` makes navigation optional in all arms. Preserve native non-use
as an adoption result. Keep the conditions separate; do not select successful
tool users from natural runs as a causal subgroup.

## Initial campaign

- Six independently authored tasks, two each for router JavaScript, globset
  Rust and GitHub CLI Go; each has four required criteria and critical errors.
- Four arms: ordinary, CodeFacts 0.1.7, CodeFacts 0.2.2 and CodeGraph 1.6.2.
- Three repetitions in guided-use and one in natural-choice: 96 scored attempts.
- Fresh isolated DSH process, home, session and private source/index state for
  every attempt. Native menus are recorded at protocol startup and audited
  against every model-visible request header.
- Scored model attempts run serially. Rotate arm position deterministically
  within task/repetition blocks. Preparation and independent grading may run
  concurrently; stop preparation workload before timing model attempts.
  Task wall time includes provider and process scheduling delays during the
  attempt; waiting before launch is outside the clock.
- Same `deepseek-v4.1-flash`, `opencode-go`, high reasoning and per-generation
  output setting. No campaign or per-task token ceiling. A ten-minute execution
  timeout preserves incomplete attempts and their observed usage.

## Source tools and treatment surface

All arms receive the same bounded `source_search`, `source_read` and
`source_list`, implementing ordinary ripgrep/file operations. The isolated SDK
profile provides no shell, skills, subagents or other repository access. This
is a controlled source-investigation environment, not a claim about every
general-purpose coding-agent configuration.

The bridge starts no native server for ordinary. CodeFacts 0.1.7 exposes its five
historical tools; 0.2.2 uses its default explore/impact/expand menu; CodeGraph
uses its actual `codegraph_explore`. Preserve native payloads and schemas except
for binding root selectors to the assigned snapshot. Record server instructions
and any bridge presentation changes. Forward literal native server instructions
so each tool retains its supplied guidance. Model-visible tool catalogs and
instructions contribute to real task token usage.

## Setup, timing and tokens

Installation is a prerequisite. Measure native index preparation separately,
then run tasks against prepared indexes. Task wall time includes DSH startup,
MCP startup, all model requests and tools through process completion. Report
setup plus task execution as separate measured stages and provide explicit
reuse-count amortization; do not call a sum a measured cold-model run.

DSH/pi-ai reports uncached input separately from cache read/write buckets.
Authoritative provider total is the primary processed-token measure. Reconcile
all request attempts and terminal turn usage. Include every HTTP/model attempt
once, including failed or retried attempts; deduplicate only repeated event
representations of the same attempt. Cached input and reasoning output are
subsets, not extra tokens added to
an already authoritative total. Missing buckets or interrupted requests remain
unknown; available values may form a labeled lower bound.

## Quality and audit

Freeze prompts and oracle before readiness model calls. Native zero-model
preparation and a separate four-arm model readiness canary precede the scored
schedule. Preserve setup/canary costs separately. A valid but wrong answer stays
in task cost; an environment failure is classified explicitly.

Blind graders receive task/oracle/source and anonymized answers, without arm,
tool trace, token or time values. A separate trace audit checks tool exposure,
actual native use, model identity, usage completeness and source preservation.
Lock grades before efficiency aggregation. Report all attempts, correctness,
coverage, eligible matched pairs, medians and totals; avoid universal savings
claims from this convenience sample or provider-cache behavior.
