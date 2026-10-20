//! Differential checks against the pre-compression external-content contract.

use super::*;
use rusqlite::{Connection, OptionalExtension};

// Frozen pre-compression schema and write/search operations. Keeping this
// independent of the new storage helpers catches BM25 corpus-count drift.
const LEGACY_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS retrieval_files (file_path TEXT PRIMARY KEY, source_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retrieval_chunks (
    id INTEGER PRIMARY KEY, file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
    source_words TEXT NOT NULL, path_words TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_file ON retrieval_chunks(file_path);
CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(
    source_words, path_words, content='retrieval_chunks', content_rowid='id',
    tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS retrieval_chunks_ai AFTER INSERT ON retrieval_chunks BEGIN
    INSERT INTO retrieval_fts(rowid, source_words, path_words)
    VALUES (new.id, new.source_words, new.path_words);
END;
CREATE TRIGGER IF NOT EXISTS retrieval_chunks_ad AFTER DELETE ON retrieval_chunks BEGIN
    INSERT INTO retrieval_fts(retrieval_fts, rowid, source_words, path_words)
    VALUES ('delete', old.id, old.source_words, old.path_words);
END;
";

fn legacy_store() -> GraphStore {
    let store = GraphStore::from_connection(Connection::open_in_memory().unwrap());
    store.conn.execute_batch(LEGACY_SCHEMA).unwrap();
    store
}

fn legacy_upsert(store: &GraphStore, file: &str, hash: &str, source: &str) -> Result<()> {
    let lines: Vec<&str> = source.lines().collect();
    let path_words = normalize_words(file);
    store.with_transaction(|store| {
        store
            .conn
            .execute("DELETE FROM retrieval_chunks WHERE file_path = ?1", [file])?;
        let mut statement = store.conn.prepare_cached(
            "INSERT INTO retrieval_chunks \
             (file_path, start_line, end_line, source_words, path_words) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        let mut start = 0;
        while start < lines.len() {
            let end = (start + 40).min(lines.len());
            statement.execute(params![
                file,
                (start + 1) as u32,
                end as u32,
                normalize_words(&lines[start..end].join("\n")),
                path_words
            ])?;
            if end == lines.len() {
                break;
            }
            start += 34;
        }
        store.conn.execute(
            "INSERT INTO retrieval_files (file_path, source_hash) VALUES (?1, ?2) \
             ON CONFLICT(file_path) DO UPDATE SET source_hash = excluded.source_hash",
            params![file, hash],
        )?;
        Ok(())
    })
}

fn legacy_delete(store: &GraphStore, file: &str) -> Result<()> {
    store.with_transaction(|store| {
        store
            .conn
            .execute("DELETE FROM retrieval_chunks WHERE file_path = ?1", [file])?;
        store
            .conn
            .execute("DELETE FROM retrieval_files WHERE file_path = ?1", [file])?;
        Ok(())
    })
}

fn legacy_search(store: &GraphStore, query: &str, scope: Option<&str>) -> Vec<SourceMatch> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return Vec::new();
    }
    let expression = terms
        .iter()
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>()
        .join(" OR ");
    let mut statement = store
        .conn
        .prepare(
            "SELECT c.file_path, c.start_line, c.end_line, -bm25(retrieval_fts, 1.0, 0.5) \
         FROM retrieval_fts JOIN retrieval_chunks c ON c.id = retrieval_fts.rowid \
         WHERE retrieval_fts MATCH ?1 \
         AND (?2 IS NULL OR c.file_path = ?2 \
              OR substr(c.file_path, 1, length(rtrim(?2, '/')) + 1) = rtrim(?2, '/') || '/') \
         ORDER BY bm25(retrieval_fts, 1.0, 0.5), c.file_path, c.start_line LIMIT 96",
        )
        .unwrap();
    let rows = statement
        .query_map(params![expression, scope], |row| {
            Ok(SourceMatch {
                file_path: row.get(0)?,
                start_line: row.get(1)?,
                end_line: row.get(2)?,
                score: row.get(3)?,
            })
        })
        .unwrap();
    rows.collect::<rusqlite::Result<_>>().unwrap()
}

fn hashes(store: &GraphStore) -> HashMap<String, String> {
    store
        .conn
        .prepare("SELECT file_path, source_hash FROM retrieval_files")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn locations(store: &GraphStore) -> Vec<(i64, String, u32, u32)> {
    store
        .conn
        .prepare("SELECT id, file_path, start_line, end_line FROM retrieval_chunks ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn assert_equivalent(legacy: &GraphStore, compressed: &GraphStore) {
    for (query, scope) in [
        ("retryPayment jitter", None),
        ("nectarine apricot", None),
        ("payments service", None),
        ("reconnection café résumé", None),
        ("boundaryneedle", None),
        ("keyword", None),
        ("apricot", Some("src/payment_%")),
        ("apricot", Some("src/payment_%/a.rs")),
        ("apricot", Some("missing")),
        ("*(){}", None),
    ] {
        let expected = legacy_search(legacy, query, scope);
        let actual = compressed.search_retrieval(query, scope, 96).unwrap();
        assert_eq!(actual, expected, "{query} {scope:?}");
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(actual.score.to_bits(), expected.score.to_bits());
        }
    }
    assert_eq!(locations(compressed), locations(legacy));
    assert_eq!(compressed.retrieval_hashes().unwrap(), hashes(legacy));
    let fts_state = |store: &GraphStore| {
        let aggregate: Option<Vec<u8>> = store
            .conn
            .query_row(
                "SELECT block FROM retrieval_fts_data WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        let docsize: Vec<(i64, Vec<u8>)> = store
            .conn
            .prepare("SELECT id, sz FROM retrieval_fts_docsize ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        store
            .conn
            .execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS temp.retrieval_vocab \
             USING fts5vocab(main, retrieval_fts, instance)",
            )
            .unwrap();
        let postings: Vec<(String, i64, String, i64)> = store
            .conn
            .prepare("SELECT term, doc, col, offset FROM temp.retrieval_vocab ORDER BY term, doc, col, offset")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        (aggregate, docsize, postings)
    };
    assert_eq!(fts_state(compressed), fts_state(legacy));
    legacy
        .conn
        .execute(
            "INSERT INTO retrieval_fts(retrieval_fts, rank) VALUES ('integrity-check', 1)",
            [],
        )
        .unwrap();
    compressed
        .conn
        .execute(
            "INSERT INTO retrieval_fts(retrieval_fts) VALUES ('integrity-check')",
            [],
        )
        .unwrap();
}

fn corpus() -> Vec<(&'static str, String)> {
    let mut long = vec!["nectarine jitter retryPayment café résumé".to_string(); 76];
    long[36] = "boundaryneedle".into();
    // One line larger than the decoder's output buffer exercises streaming.
    long[75] = "keyword ".repeat(1400);
    vec![
        ("src/payment_%/a.rs", long.join("\r\n")),
        ("src/payment_%/b.rs", "apricot reconnect socket".into()),
        (
            "src/payments/Service.rs",
            "apricot apricot nectarine".into(),
        ),
        ("README.md", "# Payment service\nreconnection jitter".into()),
        ("empty.rs", String::new()),
        ("punctuation.rs", "!!\n__".into()),
    ]
}

#[test]
fn bm25_postings_and_hashes_match_legacy_through_mutations_rollback_and_reopen() {
    let legacy = legacy_store();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("retrieval.db");
    let mut compressed = GraphStore::from_connection(Connection::open(&path).unwrap());
    for (file, source) in corpus() {
        legacy_upsert(&legacy, file, "initial", &source).unwrap();
        compressed
            .upsert_retrieval_source(file, "initial", &source)
            .unwrap();
    }
    assert_equivalent(&legacy, &compressed);
    legacy_upsert(&legacy, "src/payment_%/a.rs", "changed", "apricot jitter").unwrap();
    compressed
        .upsert_retrieval_source("src/payment_%/a.rs", "changed", "apricot jitter")
        .unwrap();
    assert_equivalent(&legacy, &compressed);
    for (file, _) in corpus() {
        legacy_delete(&legacy, file).unwrap();
        compressed.delete_retrieval_source(file).unwrap();
        assert_equivalent(&legacy, &compressed);
    }
    for (file, source) in corpus() {
        legacy_upsert(&legacy, file, "reinserted", &source).unwrap();
        compressed
            .upsert_retrieval_source(file, "reinserted", &source)
            .unwrap();
    }
    assert_equivalent(&legacy, &compressed);
    let result: Result<()> = compressed.with_transaction(|store| {
        store.upsert_retrieval_source("README.md", "rolled-back", "apricot")?;
        store.delete_retrieval_source("src/payment_%/a.rs")?;
        Err(CodeFactsError::Other("fixture rollback".into()))
    });
    assert!(result.is_err());
    assert_equivalent(&legacy, &compressed);
    for store in [&legacy, &compressed] {
        store
            .conn
            .execute_batch(
                "CREATE TRIGGER reject_retrieval_hash BEFORE UPDATE ON retrieval_files \
             BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
            )
            .unwrap();
    }
    assert!(legacy_upsert(&legacy, "README.md", "failed", "apricot").is_err());
    assert!(compressed
        .upsert_retrieval_source("README.md", "failed", "apricot")
        .is_err());
    assert_equivalent(&legacy, &compressed);
    drop(compressed);
    compressed = GraphStore::from_connection(Connection::open(&path).unwrap());
    assert_equivalent(&legacy, &compressed);
}

#[test]
fn malformed_stored_words_abort_delete_and_replacement_without_partial_fts_changes() {
    let legacy = legacy_store();
    let compressed = GraphStore::from_connection(Connection::open_in_memory().unwrap());
    for (file, source) in corpus() {
        legacy_upsert(&legacy, file, "initial", &source).unwrap();
        compressed
            .upsert_retrieval_source(file, "initial", &source)
            .unwrap();
    }
    let (id, original): (i64, Vec<u8>) = compressed
        .conn
        .query_row(
            "SELECT id, source_words_zlib FROM retrieval_chunks WHERE start_line = 35",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let mut trailing = original.clone();
    trailing.push(0);
    let mut checksum = original.clone();
    *checksum.last_mut().unwrap() ^= 1;
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(3));
    encoder.write_all(&[0xff]).unwrap();
    for malformed in [
        Vec::new(),
        original[..original.len() - 1].to_vec(),
        trailing,
        checksum,
        encoder.finish().unwrap(),
    ] {
        compressed
            .conn
            .execute(
                "UPDATE retrieval_chunks SET source_words_zlib = ?1 WHERE id = ?2",
                params![malformed, id],
            )
            .unwrap();
        assert!(compressed
            .delete_retrieval_source("src/payment_%/a.rs")
            .is_err());
        assert!(compressed
            .upsert_retrieval_source("src/payment_%/a.rs", "failed", "apricot")
            .is_err());
        assert_equivalent(&legacy, &compressed);
        let retained: Vec<u8> = compressed
            .conn
            .query_row(
                "SELECT source_words_zlib FROM retrieval_chunks WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, malformed);
    }
    compressed
        .conn
        .execute(
            "UPDATE retrieval_chunks SET source_words_zlib = ?1 WHERE id = ?2",
            params![original, id],
        )
        .unwrap();
    compressed
        .delete_retrieval_source("src/payment_%/a.rs")
        .unwrap();
    legacy_delete(&legacy, "src/payment_%/a.rs").unwrap();
    assert_equivalent(&legacy, &compressed);
}

#[test]
fn migration_preserves_exact_words_locations_hashes_and_canonical_state_on_reopen() {
    let legacy = legacy_store();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("migration.db");
    let old = GraphStore::new(path.to_str().unwrap()).unwrap();
    old.conn.execute_batch(LEGACY_SCHEMA).unwrap();
    old.conn
        .execute_batch(
            "UPDATE index_metadata SET value = '7' WHERE key = 'generation';
         INSERT INTO file_hashes (file_path, content_hash, language, indexed_at)
         VALUES ('canonical.rs', 'canonical-hash', 'rust', 123);
         INSERT INTO nodes (id, type, name, file_path, start_line, end_line, language)
         VALUES ('canonical-node', 'function', 'sentinel', 'canonical.rs', 2, 4, 'rust');",
        )
        .unwrap();
    for (file, source) in corpus() {
        legacy_upsert(&legacy, file, "old-hash", &source).unwrap();
        legacy_upsert(&old, file, "old-hash", &source).unwrap();
    }
    drop(old);
    let migrated = GraphStore::from_connection(Connection::open(&path).unwrap());
    assert_eq!(migrated.retrieval_hashes().unwrap(), hashes(&legacy));
    assert_equivalent(&legacy, &migrated);
    assert_eq!(migrated.generation().unwrap(), 7);
    let canonical: (String, String, i64) = migrated.conn.query_row(
        "SELECT content_hash, language, indexed_at FROM file_hashes WHERE file_path = 'canonical.rs'",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(canonical, ("canonical-hash".into(), "rust".into(), 123));
    let node: (String, u32, u32) = migrated
        .conn
        .query_row(
            "SELECT name, start_line, end_line FROM nodes WHERE id = 'canonical-node'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(node, ("sentinel".into(), 2, 4));
    let mut statement = legacy
        .conn
        .prepare("SELECT id, source_words, path_words FROM retrieval_chunks ORDER BY id")
        .unwrap();
    let mut rows = statement.query([]).unwrap();
    while let Some(row) = rows.next().unwrap() {
        let id: i64 = row.get(0).unwrap();
        let words: (Vec<u8>, Vec<u8>) = migrated
            .conn
            .query_row(
                "SELECT source_words_zlib, path_words_zlib FROM retrieval_chunks WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            decompress_words(&words.0).unwrap(),
            row.get::<_, String>(1).unwrap()
        );
        assert_eq!(
            decompress_words(&words.1).unwrap(),
            row.get::<_, String>(2).unwrap()
        );
    }
    legacy_delete(&legacy, "src/payment_%/a.rs").unwrap();
    migrated
        .delete_retrieval_source("src/payment_%/a.rs")
        .unwrap();
    legacy_upsert(&legacy, "README.md", "updated", "apricot").unwrap();
    migrated
        .upsert_retrieval_source("README.md", "updated", "apricot")
        .unwrap();
    assert_equivalent(&legacy, &migrated);
    drop(migrated);
    let reopened = GraphStore::from_connection(Connection::open(&path).unwrap());
    assert_equivalent(&legacy, &reopened);
}

#[test]
fn migration_errors_and_failed_first_write_restore_legacy_schema_and_index() {
    let legacy = legacy_store();
    let candidate = legacy_store();
    for (file, source) in corpus() {
        legacy_upsert(&legacy, file, "old", &source).unwrap();
        legacy_upsert(&candidate, file, "old", &source).unwrap();
    }
    let assert_legacy_schema = || {
        let count: i64 = candidate.conn.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name IN ('retrieval_metadata', 'retrieval_chunks_legacy')",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 0);
        let triggers: i64 = candidate.conn.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name IN ('retrieval_chunks_ai', 'retrieval_chunks_ad')",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(triggers, 2);
        assert_eq!(locations(&legacy), locations(&candidate));
        assert_eq!(hashes(&legacy), hashes(&candidate));
        assert_eq!(
            legacy_search(&legacy, "jitter apricot", None),
            legacy_search(&candidate, "jitter apricot", None)
        );
    };
    let rollback: Result<()> = candidate.with_transaction(|store| {
        store.retrieval_hashes()?;
        assert_equivalent(&legacy, store);
        Err(CodeFactsError::Other("fixture migration rollback".into()))
    });
    assert!(rollback.is_err());
    assert_legacy_schema();
    let original: String = candidate
        .conn
        .query_row(
            "SELECT source_words FROM retrieval_chunks WHERE id = 2",
            [],
            |row| row.get(0),
        )
        .unwrap();
    candidate
        .conn
        .execute(
            "UPDATE retrieval_chunks SET source_words = X'ff' WHERE id = 2",
            [],
        )
        .unwrap();
    assert!(candidate.retrieval_hashes().is_err());
    assert_legacy_schema();
    candidate
        .conn
        .execute(
            "UPDATE retrieval_chunks SET source_words = ?1 WHERE id = 2",
            [original],
        )
        .unwrap();
    candidate
        .conn
        .execute_batch(
            "CREATE TRIGGER reject_retrieval_hash BEFORE UPDATE ON retrieval_files \
         BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
        )
        .unwrap();
    assert!(candidate
        .upsert_retrieval_source("README.md", "failed", "apricot")
        .is_err());
    assert_legacy_schema();
    candidate
        .conn
        .execute_batch("DROP TRIGGER reject_retrieval_hash")
        .unwrap();
    assert_equivalent(&legacy, &candidate);
}

#[test]
fn unknown_storage_format_is_an_explicit_error() {
    let store = GraphStore::from_connection(Connection::open_in_memory().unwrap());
    store
        .upsert_retrieval_source("a.rs", "hash", "apricot")
        .unwrap();
    store
        .conn
        .execute(
            "UPDATE retrieval_metadata SET storage_format = 'future-v2'",
            [],
        )
        .unwrap();
    assert!(store
        .retrieval_hashes()
        .unwrap_err()
        .to_string()
        .contains("future-v2"));
    assert!(store.search_retrieval("apricot", None, 10).is_err());
    assert!(store.delete_retrieval_source("a.rs").is_err());
    assert!(store
        .upsert_retrieval_source("a.rs", "new", "nectarine")
        .is_err());
    assert_eq!(hashes(&store)["a.rs"], "hash");
}

#[test]
fn new_writes_retire_legacy_triggers_recreated_by_an_old_reader() {
    let legacy = legacy_store();
    let compressed = GraphStore::from_connection(Connection::open_in_memory().unwrap());
    for (file, source) in corpus() {
        legacy_upsert(&legacy, file, "initial", &source).unwrap();
        compressed
            .upsert_retrieval_source(file, "initial", &source)
            .unwrap();
    }
    for replacement in [true, false] {
        // The old lazy ensure runs even on hashes/search. It can recreate its
        // triggers without detecting the new chunk column layout.
        compressed.conn.execute_batch(LEGACY_SCHEMA).unwrap();
        assert_eq!(hashes(&compressed), hashes(&legacy));
        assert_eq!(
            legacy_search(&compressed, "jitter apricot", None),
            legacy_search(&legacy, "jitter apricot", None)
        );
        let count: i64 = compressed.conn.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name IN ('retrieval_chunks_ai', 'retrieval_chunks_ad')",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 2);
        if replacement {
            compressed
                .conn
                .execute_batch(
                    "CREATE TRIGGER reject_retrieval_hash BEFORE UPDATE ON retrieval_files \
                 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
                )
                .unwrap();
            assert!(compressed
                .upsert_retrieval_source("src/payment_%/a.rs", "failed", "apricot")
                .is_err());
            assert_equivalent(&legacy, &compressed);
            let retained: i64 = compressed.conn.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name IN ('retrieval_chunks_ai', 'retrieval_chunks_ad')",
                [], |row| row.get(0),
            ).unwrap();
            assert_eq!(retained, 2);
            compressed
                .conn
                .execute_batch("DROP TRIGGER reject_retrieval_hash")
                .unwrap();
            compressed
                .upsert_retrieval_source("src/payment_%/a.rs", "changed", "apricot jitter")
                .unwrap();
            legacy_upsert(&legacy, "src/payment_%/a.rs", "changed", "apricot jitter").unwrap();
        } else {
            compressed
                .delete_retrieval_source("src/payment_%/a.rs")
                .unwrap();
            legacy_delete(&legacy, "src/payment_%/a.rs").unwrap();
        }
        assert_equivalent(&legacy, &compressed);
        let count: i64 = compressed.conn.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name IN ('retrieval_chunks_ai', 'retrieval_chunks_ad')",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 0);
    }
}
