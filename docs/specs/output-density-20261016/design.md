# Output density design

## Decision

For MCP workflows that accept a presentation format, an omitted `format` uses
the existing text-only Markdown presentation, matching the direct CLI. Explore
remains text-only. Explicit `compact` and `full` keep their current machine
schemas and transport behavior, including hash evidence and the JSON result in
both `content[0].text` and `structuredContent`.

The default Markdown is a purposeful reading projection, not a lossless export.
It reports each useful fact once, omits displayed SHA-256 values and routine
metadata, and reduces repeated locators, endpoint objects and test rows. It
retains repository identity, freshness/generation, partial-source reasons,
precise locations, uncertainty and relationship direction, active traversal
cutoffs, and exact usable cursors. Exploration returns a complete small owner
when it fits its existing allocation; otherwise it marks the bounded preview
and omitted lines clearly.

This choice follows an independent review of the current renderers and actual
responses: repeated facts and incomplete small-owner excerpts dominate the
presentation problems, while removing hashes alone explains only a small part
of the observed text. Byte savings are therefore not treated as evidence of
model-token or task savings.

## Boundaries

- Canonical fact storage, source hashing and verification, freshness state,
  generation, cursors, extraction, indexing, retrieval, ranking, graph traversal
  and the tool catalog do not change. No database migration is needed.
- A source definition span and a relationship site are separate evidence. Keep
  call-site occurrences, ambiguous-symbol IDs when needed, derivation,
  confidence/resolution, semantic status, source failures and exceptional
  freshness states.
- Fit responses using the final rendered UTF-8 text and existing workflow
  budgets: Explore remains 2,000–32,000 bytes and Expand remains capped at
  16,384 bytes. Preserve source truncation, relationship pagination and active
  traversal cutoffs as distinct states.
- The observable compatibility change is the omitted-format MCP response:
  callers that parse `structuredContent` must request `compact` or `full` on
  structured workflows. Explore remains text-only. Explicit machine formats
  must remain schema-equivalent to their previous behavior.
- Report byte deltas from before/after responses only. Smaller text does not by
  itself prove model-token savings, better answers or productivity gains.

## Verification targets

1. Exercise all seven workflows with omitted format, all CLI aliases, and
   explicit Compact/Full. Verify text-only default transport and unchanged
   explicit machine schemas, including hash fields and dual transport. Keep the
   default MCP profile at exactly Explore, Expand and Impact.
2. Check default text across orientation, query, focused/batched reads and the
   five legacy workflows: no raw source fingerprints; source locations,
   uncertainty, direction, partial failures, active cutoffs and cursors remain.
3. At 2,000, default and 32,000-byte Explore budgets, verify complete small
   owners when they fit, one locator per card, marked previews/omissions for
   larger owners, and no UTF-8 budget overflow.
4. Compare relationship occurrences, ambiguous IDs, impact witnesses and
   direction, test associations, map inventory counts, path hops, source
   truncation and cursor continuation against explicit Full results. No source
   or relationship fact may disappear only to make text shorter.
5. Record actual before/after UTF-8 and serialized-result bytes. Keep these
   separate from model-token or task-quality claims unless a real agent
   comparison measures those outcomes.

The implementation changes no extraction/index contracts; release and
published-runtime claims require separate versioned and public-artifact
verification.
