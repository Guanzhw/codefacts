//! Derived lexical recall over caller-verified source, with original line locations.
//!
//! These tables are disposable and independent of the canonical fact schema. A
//! match is a candidate location; callers must verify its file hash and read the
//! actual source before returning evidence.

use std::collections::{HashMap, HashSet};
use std::io::Write;

use flate2::{write::ZlibEncoder, Compression, Decompress, FlushDecompress, Status};
use rusqlite::params;

use crate::error::{CodeFactsError, Result};

use super::store::{split_identifier, GraphStore};

const CHUNK_LINES: usize = 40;
const CHUNK_OVERLAP: usize = 6;
const MAX_QUERY_TERMS: usize = 24;
pub(crate) const MAX_QUERY_CHARS: usize = 8192;
const MAX_MATCHES: usize = 256;
const STORAGE_FORMAT: &str = "contentless-zlib-v1";
// Older executables sharing this database can recreate these owned triggers.
// Retire them inside each write transaction, before any chunk mutation.
const RETIRE_LEGACY_TRIGGERS: &str = "
DROP TRIGGER IF EXISTS retrieval_chunks_ai;
DROP TRIGGER IF EXISTS retrieval_chunks_ad;
";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS retrieval_files (
    file_path TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL
);
CREATE TABLE retrieval_chunks (
    id INTEGER PRIMARY KEY,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    source_words_zlib BLOB NOT NULL,
    path_words_zlib BLOB NOT NULL
);
CREATE INDEX idx_retrieval_chunks_file ON retrieval_chunks(file_path);
CREATE VIRTUAL TABLE retrieval_fts USING fts5(
    source_words, path_words,
    content='',
    tokenize='porter unicode61'
);
CREATE TABLE retrieval_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    storage_format TEXT NOT NULL
);
";

/// A ranked source-chunk location, without a stored source payload.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceMatch {
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    /// Positive relevance weight: higher scores rank first.
    pub score: f64,
}

impl GraphStore {
    fn retrieval_schema_is_current(&self) -> Result<bool> {
        let has_marker: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'retrieval_metadata')",
            [],
            |row| row.get(0),
        )?;
        if !has_marker {
            return Ok(false);
        }
        let format: String = self.conn.query_row(
            "SELECT storage_format FROM retrieval_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        if format != STORAGE_FORMAT {
            return Err(CodeFactsError::Other(format!(
                "unsupported retrieval storage format: {format}"
            )));
        }
        Ok(true)
    }

    fn ensure_retrieval_schema(&self) -> Result<()> {
        if self.retrieval_schema_is_current()? {
            return Ok(());
        }
        self.with_transaction(|store| {
            if store.retrieval_schema_is_current()? {
                return Ok(());
            }
            let legacy: bool = store.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'retrieval_chunks')",
                [],
                |row| row.get(0),
            )?;
            if legacy {
                store.conn.execute_batch(RETIRE_LEGACY_TRIGGERS)?;
                store.conn.execute_batch(
                    "DROP TABLE retrieval_fts;
                     ALTER TABLE retrieval_chunks RENAME TO retrieval_chunks_legacy;
                     DROP INDEX idx_retrieval_chunks_file;",
                )?;
            }
            store.conn.execute_batch(SCHEMA)?;
            if legacy {
                // Convert the exact stored words, without rereading source or
                // changing chunk IDs, locations, or the caller-verified hashes.
                // Stream rows to bound migration memory to one chunk at a time.
                {
                    let mut statement = store.conn.prepare(
                        "SELECT id, file_path, start_line, end_line, source_words, path_words \
                         FROM retrieval_chunks_legacy ORDER BY id",
                    )?;
                    let mut rows = statement.query([])?;
                    while let Some(row) = rows.next()? {
                        let source_words: String = row.get(4)?;
                        let path_words: String = row.get(5)?;
                        store.insert_retrieval_chunk(
                            Some(row.get(0)?),
                            &row.get::<_, String>(1)?,
                            (row.get(2)?, row.get(3)?),
                            &source_words,
                            &path_words,
                        )?;
                    }
                }
                // Freed pages can be reused; dropping the old storage does not
                // shrink the database file or run a global VACUUM.
                store
                    .conn
                    .execute_batch("DROP TABLE retrieval_chunks_legacy")?;
            }
            store.conn.execute(
                "INSERT INTO retrieval_metadata (id, storage_format) VALUES (1, ?1)",
                [STORAGE_FORMAT],
            )?;
            Ok(())
        })
    }

    fn insert_retrieval_chunk(
        &self,
        id: Option<i64>,
        file_path: &str,
        line_bounds: (u32, u32),
        source_words: &str,
        path_words: &str,
    ) -> Result<()> {
        let source_blob = compress_words(source_words)?;
        let path_blob = compress_words(path_words)?;
        self.conn
            .prepare_cached(
                "INSERT INTO retrieval_chunks \
             (id, file_path, start_line, end_line, source_words_zlib, path_words_zlib) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?
            .execute(params![
                id,
                file_path,
                line_bounds.0,
                line_bounds.1,
                source_blob,
                path_blob
            ])?;
        let id = self.conn.last_insert_rowid();
        self.conn
            .prepare_cached(
                "INSERT INTO retrieval_fts (rowid, source_words, path_words) VALUES (?1, ?2, ?3)",
            )?
            .execute(params![id, source_words, path_words])?;
        Ok(())
    }

    fn delete_retrieval_chunks(&self, file_path: &str) -> Result<()> {
        {
            let mut statement = self.conn.prepare_cached(
                "SELECT id, source_words_zlib, path_words_zlib FROM retrieval_chunks \
                 WHERE file_path = ?1 ORDER BY id",
            )?;
            let mut rows = statement.query([file_path])?;
            let mut delete = self.conn.prepare_cached(
                "INSERT INTO retrieval_fts (retrieval_fts, rowid, source_words, path_words) \
                 VALUES ('delete', ?1, ?2, ?3)",
            )?;
            while let Some(row) = rows.next()? {
                let id: i64 = row.get(0)?;
                let source_words = decompress_words(&row.get::<_, Vec<u8>>(1)?)?;
                let path_words = decompress_words(&row.get::<_, Vec<u8>>(2)?)?;
                // Legacy contentless FTS requires the exact original terms to
                // remove both postings and the BM25 corpus token counts.
                delete.execute(params![id, source_words, path_words])?;
            }
        }
        self.conn.execute(
            "DELETE FROM retrieval_chunks WHERE file_path = ?1",
            [file_path],
        )?;
        Ok(())
    }

    /// Hashes of sources currently represented in the derived lexical index.
    pub fn retrieval_hashes(&self) -> Result<HashMap<String, String>> {
        self.ensure_retrieval_schema()?;
        let mut statement = self
            .conn
            .prepare_cached("SELECT file_path, source_hash FROM retrieval_files")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    /// Replace a file's recall chunks atomically using caller-hash-verified source.
    pub fn upsert_retrieval_source(&self, file_path: &str, hash: &str, source: &str) -> Result<()> {
        let lines: Vec<&str> = source.lines().collect();
        let path_words = normalize_words(file_path);
        self.with_transaction(|store| {
            store.ensure_retrieval_schema()?;
            store.conn.execute_batch(RETIRE_LEGACY_TRIGGERS)?;
            store.delete_retrieval_chunks(file_path)?;
            let mut start = 0;
            while start < lines.len() {
                let end = (start + CHUNK_LINES).min(lines.len());
                let source_words = normalize_words(&lines[start..end].join("\n"));
                store.insert_retrieval_chunk(
                    None,
                    file_path,
                    ((start + 1) as u32, end as u32),
                    &source_words,
                    &path_words,
                )?;
                if end == lines.len() {
                    break;
                }
                start += CHUNK_LINES - CHUNK_OVERLAP;
            }
            store.conn.execute(
                "INSERT INTO retrieval_files (file_path, source_hash) VALUES (?1, ?2) \
                 ON CONFLICT(file_path) DO UPDATE SET source_hash = excluded.source_hash",
                params![file_path, hash],
            )?;
            Ok(())
        })
    }

    /// Remove both a file's recall chunks and its recorded source hash.
    pub fn delete_retrieval_source(&self, file_path: &str) -> Result<()> {
        self.with_transaction(|store| {
            store.ensure_retrieval_schema()?;
            store.conn.execute_batch(RETIRE_LEGACY_TRIGGERS)?;
            store.delete_retrieval_chunks(file_path)?;
            store.conn.execute(
                "DELETE FROM retrieval_files WHERE file_path = ?1",
                [file_path],
            )?;
            Ok(())
        })
    }

    /// Recall bounded chunks using safe OR terms from a natural-language task.
    ///
    /// Results use BM25 over source words and identifier-expanded paths, then
    /// file path and line for deterministic ties. `path_prefix` names an exact
    /// file or a directory; SQL wildcard characters in paths remain literal.
    pub fn search_retrieval(
        &self,
        query: &str,
        path_prefix: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SourceMatch>> {
        self.ensure_retrieval_schema()?;
        let terms = query_terms(query);
        if terms.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let expression = terms
            .iter()
            .map(|term| format!("\"{term}\""))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut statement = self.conn.prepare_cached(
            "SELECT c.file_path, c.start_line, c.end_line, -bm25(retrieval_fts, 1.0, 0.5) \
             FROM retrieval_fts JOIN retrieval_chunks c ON c.id = retrieval_fts.rowid \
             WHERE retrieval_fts MATCH ?1 \
             AND (?2 IS NULL OR c.file_path = ?2 \
                  OR substr(c.file_path, 1, length(rtrim(?2, '/')) + 1) = rtrim(?2, '/') || '/') \
             ORDER BY bm25(retrieval_fts, 1.0, 0.5), c.file_path, c.start_line \
             LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![expression, path_prefix, limit.min(MAX_MATCHES) as u32],
            |row| {
                Ok(SourceMatch {
                    file_path: row.get(0)?,
                    start_line: row.get(1)?,
                    end_line: row.get(2)?,
                    score: row.get(3)?,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn compress_words(words: &str) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(3));
    encoder.write_all(words.as_bytes())?;
    Ok(encoder.finish()?)
}

/// Stored bytes are a boundary: reject truncated, trailing, checksum-invalid,
/// or non-UTF-8 data rather than supply incorrect old terms to FTS deletion.
fn decompress_words(bytes: &[u8]) -> Result<String> {
    let mut decoder = Decompress::new(true);
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let before_in = decoder.total_in();
        let before_out = decoder.total_out();
        let status = decoder
            .decompress(
                &bytes[before_in as usize..],
                &mut buffer,
                FlushDecompress::None,
            )
            .map_err(|error| {
                CodeFactsError::Other(format!("invalid retrieval zlib data: {error}"))
            })?;
        let produced = (decoder.total_out() - before_out) as usize;
        output.extend_from_slice(&buffer[..produced]);
        if status == Status::StreamEnd {
            if decoder.total_in() != bytes.len() as u64 {
                return Err(CodeFactsError::Other(
                    "trailing bytes in retrieval zlib data".into(),
                ));
            }
            return String::from_utf8(output).map_err(|error| {
                CodeFactsError::Other(format!("invalid retrieval UTF-8 data: {error}"))
            });
        }
        if before_in == decoder.total_in() && produced == 0 {
            return Err(CodeFactsError::Other(
                "incomplete retrieval zlib data".into(),
            ));
        }
    }
}

/// Identifier-expanded lexical text shared by indexing and excerpt selection.
pub(crate) fn normalize_words(text: &str) -> String {
    text.split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|word| !word.is_empty())
        .map(split_identifier)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Safe bounded lexical task terms shared by recall and excerpt selection.
pub(crate) fn query_terms(query: &str) -> Vec<String> {
    let bounded: String = query.chars().take(MAX_QUERY_CHARS).collect();
    let normalized = normalize_words(&bounded);
    let mut seen = HashSet::new();
    normalized
        .split_whitespace()
        .filter(|term| !is_task_filler(term))
        .filter(|term| seen.insert((*term).to_string()))
        .take(MAX_QUERY_TERMS)
        .map(str::to_string)
        .collect()
}

fn is_task_filler(term: &str) -> bool {
    matches!(
        term,
        "a" | "an"
            | "and"
            | "are"
            | "as"
            | "at"
            | "be"
            | "been"
            | "but"
            | "by"
            | "can"
            | "could"
            | "did"
            | "do"
            | "does"
            | "for"
            | "from"
            | "had"
            | "has"
            | "have"
            | "how"
            | "i"
            | "if"
            | "in"
            | "into"
            | "is"
            | "it"
            | "its"
            | "me"
            | "my"
            | "of"
            | "on"
            | "or"
            | "our"
            | "should"
            | "so"
            | "some"
            | "that"
            | "the"
            | "their"
            | "them"
            | "there"
            | "these"
            | "they"
            | "this"
            | "those"
            | "to"
            | "us"
            | "was"
            | "we"
            | "were"
            | "what"
            | "when"
            | "where"
            | "which"
            | "who"
            | "why"
            | "will"
            | "with"
            | "would"
            | "you"
            | "your"
            | "please"
            | "find"
            | "show"
            | "locate"
            | "explain"
            | "tell"
            | "looking"
            | "look"
            | "want"
            | "need"
            | "code"
            | "function"
            | "functions"
            | "method"
            | "methods"
            | "class"
            | "classes"
            | "repo"
            | "repository"
            | "project"
            | "implementation"
            | "implemented"
    )
}

#[cfg(test)]
#[path = "retrieval_storage_tests.rs"]
mod storage_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn store() -> GraphStore {
        GraphStore::from_connection(Connection::open_in_memory().unwrap())
    }

    #[test]
    fn natural_task_retrieves_comment_body_and_identifier_words() {
        let store = store();
        store
            .upsert_retrieval_source(
                "src/PaymentService.rs",
                "hash",
                "fn retryPayment() {\n    // jitter before reconnecting the socket\n    let delay = exponential_backoff();\n}",
            )
            .unwrap();
        for query in [
            "Please show me where the code implements jitter before reconnecting",
            "how does exponential backoff work in this repository",
            "payment service retry",
            "retryPayment",
            "reconnection socket",
        ] {
            let matches = store.search_retrieval(query, None, 10).unwrap();
            assert_eq!(matches.len(), 1, "{query}");
            assert_eq!(matches[0].file_path, "src/PaymentService.rs");
            assert_eq!((matches[0].start_line, matches[0].end_line), (1, 4));
            assert!(matches[0].score > 0.0);
        }
    }

    #[test]
    fn scope_is_literal_and_rank_order_is_repeatable() {
        let store = store();
        for path in ["src/payment_%/b.rs", "src/payment_%/a.rs", "tests/a.rs"] {
            store
                .upsert_retrieval_source(path, "hash", "fn chargeAccount() {}")
                .unwrap();
        }
        let matches = store
            .search_retrieval("charge account", Some("src/payment_%/"), 10)
            .unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].file_path, "src/payment_%/a.rs");
        assert_eq!(matches[1].file_path, "src/payment_%/b.rs");
        assert_eq!(
            matches,
            store
                .search_retrieval("charge account", Some("src/payment_%/"), 10)
                .unwrap()
        );
        assert_eq!(store.search_retrieval("charge", None, 1).unwrap().len(), 1);
    }

    #[test]
    fn scope_filters_directory_boundaries_before_limit_and_accepts_exact_files() {
        let store = store();
        for (path, source) in [
            ("src/foobar/a.rs", "needle"),
            ("src/foo_bar/a.rs", "needle"),
            ("src/foo/a.rs", "needle unrelated words"),
            ("src/foo/a.rs.extra", "needle"),
            ("src/foo_%/a.rs", "needle"),
            ("src/foo_other/a.rs", "needle"),
        ] {
            store.upsert_retrieval_source(path, "hash", source).unwrap();
        }
        let scoped = store
            .search_retrieval("needle", Some("src/foo"), 10)
            .unwrap();
        assert_eq!(
            scoped
                .iter()
                .map(|m| m.file_path.as_str())
                .collect::<Vec<_>>(),
            ["src/foo/a.rs.extra", "src/foo/a.rs"]
        );
        assert_eq!(
            store
                .search_retrieval("needle", Some("src/foo"), 1)
                .unwrap()[0]
                .file_path,
            "src/foo/a.rs.extra"
        );
        let exact = store
            .search_retrieval("needle", Some("src/foo/a.rs"), 1)
            .unwrap();
        assert_eq!(exact[0].file_path, "src/foo/a.rs");
        let literal = store
            .search_retrieval("needle", Some("src/foo_%"), 10)
            .unwrap();
        assert_eq!(literal.len(), 1);
        assert_eq!(literal[0].file_path, "src/foo_%/a.rs");
    }

    #[test]
    fn replacement_and_delete_remove_old_terms_and_hashes() {
        let store = store();
        store
            .upsert_retrieval_source("a.rs", "old", "nectarine")
            .unwrap();
        store
            .upsert_retrieval_source("a.rs", "new", "apricot")
            .unwrap();
        assert!(store
            .search_retrieval("nectarine", None, 10)
            .unwrap()
            .is_empty());
        assert_eq!(
            store.search_retrieval("apricot", None, 10).unwrap().len(),
            1
        );
        assert_eq!(store.retrieval_hashes().unwrap()["a.rs"], "new");
        store.delete_retrieval_source("a.rs").unwrap();
        assert!(store
            .search_retrieval("apricot", None, 10)
            .unwrap()
            .is_empty());
        assert!(store.retrieval_hashes().unwrap().is_empty());
    }

    #[test]
    fn chunks_preserve_line_bounds_and_overlap() {
        let store = store();
        let mut lines = vec!["unrelated"; 75];
        lines[36] = "boundaryneedle";
        lines[74] = "lastneedle";
        store
            .upsert_retrieval_source("a.rs", "hash", &format!("{}\n", lines.join("\r\n")))
            .unwrap();
        let matches = store.search_retrieval("boundaryneedle", None, 10).unwrap();
        assert_eq!(matches.len(), 2);
        let mut bounds = matches
            .iter()
            .map(|m| (m.start_line, m.end_line))
            .collect::<Vec<_>>();
        bounds.sort_unstable();
        assert_eq!(bounds, [(1, 40), (35, 74)]);
        let last = store.search_retrieval("lastneedle", None, 10).unwrap();
        assert_eq!((last[0].start_line, last[0].end_line), (69, 75));
    }

    #[test]
    fn query_syntax_is_data_and_queries_are_bounded() {
        let store = store();
        store
            .upsert_retrieval_source("a.rs", "hash", "apricot")
            .unwrap();
        assert_eq!(
            store
                .search_retrieval("\"apricot\" OR * NOT )", None, 10)
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .search_retrieval("\"*(){}:-", None, 10)
            .unwrap()
            .is_empty());
        assert!(store
            .search_retrieval("please show me the code", None, 10)
            .unwrap()
            .is_empty());
        assert!(store
            .search_retrieval("apricot", None, 0)
            .unwrap()
            .is_empty());
        let long = (0..100)
            .map(|i| format!("term{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(query_terms(&long).len(), MAX_QUERY_TERMS);
    }

    #[test]
    fn empty_source_records_hash_without_fabricating_lines() {
        let store = store();
        store
            .upsert_retrieval_source("EmptySource.rs", "hash", "")
            .unwrap();
        assert_eq!(store.retrieval_hashes().unwrap()["EmptySource.rs"], "hash");
        assert!(store
            .search_retrieval("empty source", None, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn failed_replacement_preserves_previous_chunks_and_hash() {
        let store = store();
        store
            .upsert_retrieval_source("a.rs", "old", "nectarine")
            .unwrap();
        store
            .conn
            .execute_batch(
                "CREATE TRIGGER reject_retrieval_hash BEFORE UPDATE ON retrieval_files \
             BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
            )
            .unwrap();
        assert!(store
            .upsert_retrieval_source("a.rs", "new", "apricot")
            .is_err());
        assert_eq!(store.retrieval_hashes().unwrap()["a.rs"], "old");
        assert_eq!(
            store.search_retrieval("nectarine", None, 10).unwrap().len(),
            1
        );
        assert!(store
            .search_retrieval("apricot", None, 10)
            .unwrap()
            .is_empty());
    }
}
