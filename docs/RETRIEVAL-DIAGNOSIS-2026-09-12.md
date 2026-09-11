# Retrieval diagnosis — 2026-09-12

The offline replay found vocabulary, ranking and excerpt-coverage gaps. It did
not find missing identifier splitting, and it did not measure an improvement
in agent correctness or token efficiency. Product behavior remains unchanged.

## Method and evidence

The [12 cases](../benchmarks/agent-eval/retrieval-replay-cases.json) were frozen
in `de9bcde` before execution. The repaired binary is the same archived
`2e725c9b3947545aecce845ba7fdd41d58e8fd456743d0cd9da2d34355ce7576`
used in the value screen. The two source snapshots and their revisions are
recorded in the [results](../benchmarks/agent-eval/retrieval-replay-results.json).

Execution used two map preflights and twelve search calls, with
`detail=context`, `context_limit=1`, `limit=5`. Both roots were fresh. The parent
independently verified the binary/case hashes, all returned fact source hashes,
and every returned excerpt (11) against the actual source bytes and line ranges.
No evaluation model was invoked and no failed query was retried.

These are diagnostic queries based on known tasks, not held-out recall cases.
Only the first five candidates were inspected; absence there is not absence
from the full index. The one-context setting differs from earlier runs that
requested three contexts, so this replay is not an agent before/after comparison.

## Findings

| Query | Observed bounded result | Implication |
| --- | --- | --- |
| `relationship extraction` | Empty | Reproduces the agent's unsuccessful discovery query. |
| `extraction` | Extraction-version constant first; no `extract_edges` in top five | The word form does not reliably lead to the needed implementation. |
| `extract` | `Extractor` first; no `extract_edges` in top five | Shortening the query yields candidates but does not by itself find the target in this page. |
| `extract edges` | Test helper first; `extract_edges` fourth | The target is in the page, but only the top helper receives a source excerpt. |
| `extract_edges` | Production method first, full lines 390–478 returned | Exact identifier discovery works; the callee alone cannot establish the caller's error propagation. |
| `index_directory` | Correct method first; excerpt 145–235, definition ends 467 | Required lines 326–373 are outside the 4 KiB initial excerpt. Truncation is correctly disclosed. |
| `GraphStore with_transaction` | `GraphStore` first, `with_transaction` second | With one context entry, the struct gets source while the requested method does not. |
| `with transaction` | `with_transaction` first | Split-word lookup already works in this control. |
| `getRuntimeProtocol` | Correct function first, full lines 89–135 returned | Exact identifier control also works in OpenSession. |
| `runtime protocol` | Error class first; `getRuntimeProtocol` absent from top five | Rephrasing a known identifier changes ranking and context selection. |
| `protocol unavailable` | `ContentAccess` first, error class second | A behavior phrase can reasonably match types or errors; task relevance cannot be inferred from a non-empty result alone. |

`relationship` alone returned the relationship-limit constant first. A generic
word producing many hits is not a successful substitute for the original query.

The exact `extract_edges` response included two callers, both test helpers;
it did not include the production `index_directory` caller whose source invokes
`Extractor::extract_edges` at lines 341–349. This is a gap in the relationship
evidence returned in this replay. Its extraction/resolution cause has not been
isolated, so following the returned callers cannot yet be assumed sufficient.

The implementation already indexes split identifier words in `name_tokens`
(`src/graph/store.rs:359-390`) and tests camel/snake component lookup
(`src/graph/store.rs:2594-2629`). Query terms become quoted prefixes joined by
AND (`src/service.rs:1484-1489`). A longer word such as `extraction` is not
automatically reduced to `extract`; changing vocabulary is also different from
splitting an identifier. These mechanisms explain why adding another splitter
would not address the observed gaps.

`definition_source` takes the beginning of a definition up to its byte budget
and reports the returned end line and truncation (`src/service.rs:1212-1255`).
The missing late branch is a verified coverage limitation, not stale data or
silent truncation. Increasing the global byte limit would increase every long
excerpt's cost without evidence that it improves task outcomes.

## Prepared comprehension diagnostic

The [evidence pack](../benchmarks/agent-eval/failure-evidence-pack.md) contains
226 source lines, exact file hashes, the original question, and a neutral
wording that does not presuppose a successful incomplete-index response.
It includes both failure paths, refresh propagation and accurately scoped
transaction regression coverage. It is investigator-selected source, not a
CodeFacts retrieval result, and has not been passed to an evaluation model.

If this diagnostic is separately scheduled, each run receives only its assigned
question and the same source blocks. It can test comprehension with supplied
evidence and wording sensitivity. A retrieval intervention requires a separate
contemporaneous comparison; neither an oracle pack nor the old failing answer
alone establishes that a search change causes better answers.

## Decision and next gate

Do not add duplicate identifier splitting, hardcoded query synonyms, or a larger
default excerpt. First use offline independent cases to evaluate whether a narrow
ranking change can put an explicitly requested member ahead of its container or
test helper, preserving controls that intentionally ask for those other symbols.
Also isolate the absent production call-site evidence before assuming relationship
navigation can replace source search. For long definitions, verify an existing
source-read continuation at confirmed locations before adding another option.

The next gate requires both a relevant candidate and the evidence needed for
the question; top-five presence alone is insufficient. Record false promotions,
coverage and text bytes alongside first relevant rank. Only after a concrete
candidate improves independent cases should a small agent experiment be frozen.
This diagnosis does not reopen the larger campaign or claim a new product win.

## Accounting

The twelve search text-content blocks contain 94,658 UTF-8 bytes in total;
the two map blocks contain 8,068. These count the text block once, not the whole
JSON-RPC envelope, duplicate structured content, model input tokens or billing.
They do not measure agent context occupancy. The raw archived response bundle
also contains transport/metadata fields and is retained separately.

Zero evaluation-model invocations means the replay itself needed no model run;
engineering analysis and artifact preparation still consume model resources.
