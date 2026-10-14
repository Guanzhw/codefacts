# Design

Base the delivery worktree on published v0.1.17 and transplant preserved C09
source with a SHA256 manifest. Keep the original development checkout intact.
Retain v0.1.17's unchanged-refresh return and its full source-hash checks.

SQLite is canonical. Explore uses its existing request-local node catalog,
source-chunk FTS and <=500-key SQL hydration batches. Its text response bounds
UTF-8 bytes and attributes exact reads to verified current disk content.

Impact is breadth-first traversal over incoming Calls, References, Extends,
Implements and Imports edges whose two endpoints exist and whose stored
confidence is not heuristic. Imports may use exact `file:<path>` endpoints
backed by canonical file snapshots. An impact-only typed file anchor carries
the indexed source hash without an invented line span or persistent symbol/FTS
insertion; traversal continues through actual stored edges. Stored file-to-symbol
membership gaps remain explicit. Container nodes also expand their confirmed
outgoing Contains edges. Each transition counts as one graph hop; this differs
from CodeGraph's same-depth container expansion. Keep actual source->target
direction and the traversal direction in every witness. Canonical edge order determines a stable shortest
witness; cycles and repeated occurrences do not duplicate affected symbols.
Only reached symbols are returned, with distance and predecessor witness.
Test-associated symbols are the reached nodes marked by the existing extractor's
test classifier, with the same witness; they are not claimed to be runnable tests.
Depth is 1..10 (default 3), output nodes 1..50 (default 20), and examined edges
are bounded. Report actual traversal exhaustion separately from depth/output
cutoffs and preserve extractor confidence on every relationship.

MCP advertises seven tools. Existing exact-fact request/format contracts stay
valid. New explore is text-only; impact supports the existing compact/full/
Markdown presentation with explicit source hashes and bounds. A shared execution
entry point provides the CLI with the same argument validation, root selection,
refresh and output as MCP. CLI aliases node/callers/callees map to expand and
its corresponding sections. Exact symbols are selected by existing name/ID/
file resolution; ambiguity is exposed to the operator.

Direct CLI operations default to the current directory, external state and
readable text. MCP retains optional --root and per-request repository_root.
No daemon, watcher, repository configuration injection or internal model is
introduced. Initial five-workflow documentation is updated to the authorized
seven-tool release; provenance remains pinned to the upstream source actually
used. Benchmark methods and exact versions are recorded before final runs.
