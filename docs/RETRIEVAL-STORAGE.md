# Derived lexical storage

`src/graph/retrieval.rs` owns the lazy derived schema. Format
`contentless-zlib-v1` stores each chunk's exact normalized source and path words
as two independent zlib-wrapped UTF-8 BLOBs, encoded at compression level 3.
`retrieval_fts` uses legacy FTS5 `content=''`, the existing `porter unicode61`
tokenizer, and the default column sizes and detail. Search still joins chunk
locations and uses the same BM25 weights, ordering, scope and limits.

The words are needed for future deletion: FTS5's special `delete` command must
receive the original rowid and original text. The owner decodes both fields,
supplies those exact terms, removes chunk metadata and updates file hashes in
one `GraphStore::with_transaction` operation. Nested operations join their
caller's transaction. Invalid zlib data, incomplete streams, trailing bytes,
checksum errors and invalid UTF-8 produce errors; no replacement terms are
substituted. SQLite's [delete contract](https://www.sqlite.org/fts5.html#the_delete_command)
explains why keeping the old words matters for postings and corpus statistics.

The first retrieval operation converts the old external-content schema in a
transaction. It streams the already stored normalized TEXT in rowid order,
recreates the derived FTS, preserves chunk IDs, locations and source hashes,
and writes the format marker last. It does not need source files during
conversion. A conversion error rolls back the DDL and rows. A failed first
write also rolls back its conversion; an outer transaction owns the rollback
when present. Unknown format markers fail explicitly.

The derived schema is not writable by older executables: their legacy inserts
and delete triggers reference the removed TEXT columns and error. An old search
may still read the current FTS, and the canonical fact schema remains openable.
An older executable can also recreate those incompatible triggers while reading.
Each new write retires exactly those two obsolete owned triggers inside its
write transaction before changing chunks. Ordinary new searches do not perform
that DDL. Writable downgrade requires a separately rebuilt derived index.

Conversion temporarily retains the old chunk table while constructing its
replacement and writes SQLite rollback/WAL state. Peak conversion space and
time require native measurement. Dropping the old table frees pages for reuse;
the existing database file need not get smaller. This migration does not run
`VACUUM` or change the canonical schema's space-reclamation policy. Fresh-index
storage savings measured by a separate Python prototype are not a measurement
of this Rust implementation or an existing full database after migration.

## Codec provenance

The direct dependency is exactly `flate2 1.1.10`, with defaults disabled and the
explicit `miniz_oxide` feature. The [versioned manifest](https://github.com/rust-lang/flate2-rs/blob/1.1.10/Cargo.toml)
declares Rust 1.67.0 and `MIT OR Apache-2.0`; the
[backend documentation](https://docs.rs/flate2/1.1.10/flate2/#implementation)
identifies miniz_oxide as its portable Rust backend. Explicit selection avoids
depending on a future change to `rust_backend`'s meaning. Application code uses
safe `ZlibEncoder` and `Decompress` APIs. Encoded bytes need not match the
Python prototype's zlib backend; the storage contract is exact decoded text.

The lockfile adds these packages, without changing existing versions:

| Package | Version | Declared license | Declared rust-version |
| --- | --- | --- | --- |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | 1.67.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | absent |
| crc32fast | 1.5.1 | MIT OR Apache-2.0 | 1.63 |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | absent |
| simd-adler32 | 0.3.10 | MIT | absent |

Versions, features and license declarations were checked against the exact
published crate sources and their Cargo manifests. An absent MSRV declaration
is missing evidence; the project Rust 1.91 gate still needs to run. The release
license audit and dependency notice packaging must include this locked codec
closure before publication.

## Verification

`src/graph/retrieval_storage_tests.rs` retains the legacy schema and operations
as an independent differential baseline. Checks compare complete ordered
matches, exact BM25 float bits, chunk IDs/locations, hashes, full synthetic
postings, document sizes and aggregate token-count records. Histories cover
replacement, deletion of the entire corpus, reused-rowid reinsertion, outer
rollback, a rejected hash write, malformed stored BLOBs, persistent reopen,
legacy conversion and conversion rollback. Canonical node/hash/generation
sentinels check the migration boundary. A frozen old-reader ensure/read followed
by new replacement and deletion checks trigger retirement, including rollback
of retirement when the hash write fails. Existing retrieval and protocol tests
continue to cover source verification, literal scopes and output behavior.

Run the Rust tests, project MSRV check, license audit, platform CI and native
installed-runtime validation before accepting this candidate. Performance,
existing-database physical shrink and whole-database savings remain unmeasured.
