use std::fs;

use codefacts::{lsp::LspMode, service::CodeFacts};
use rusqlite::Connection;
use tempfile::tempdir;

const TOO_LARGE: usize = 2 * 1024 * 1024 + 1;

fn marker(database: &std::path::Path) -> String {
    Connection::open(database)
        .unwrap()
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'full_reindex_required'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

fn downgrade(database: &std::path::Path) {
    Connection::open(database)
        .unwrap()
        .execute(
            "UPDATE index_metadata SET value = '9' WHERE key = 'fact_extraction_version'",
            [],
        )
        .unwrap();
}

#[test]
fn directory_walk_failure_preserves_the_last_verified_snapshot() {
    let workspace = tempdir().unwrap();
    let repository = workspace.path().join("repository");
    let relocated = workspace.path().join("relocated");
    fs::create_dir(&repository).unwrap();
    fs::write(
        repository.join("target.py"),
        "def target():\n    return 1\n",
    )
    .unwrap();
    fs::write(
        repository.join("caller.py"),
        "from target import target\n\ndef caller():\n    return target()\n",
    )
    .unwrap();
    let database = workspace.path().join("facts.sqlite");
    let facts = CodeFacts::open_with_lsp(&repository, &database, LspMode::Off).unwrap();
    let first = facts.map().unwrap();
    assert_eq!(first["indexed_files"], 2);
    assert!(first["relationships"].as_u64().unwrap() > 0);

    let conn = Connection::open(&database).unwrap();
    let snapshot = || {
        [
            "SELECT * FROM nodes ORDER BY id",
            "SELECT * FROM edges ORDER BY id",
            "SELECT * FROM file_hashes ORDER BY file_path",
            "SELECT * FROM unresolved_refs ORDER BY id",
            "SELECT * FROM index_metadata ORDER BY key",
        ]
        .map(|query| {
            let mut statement = conn.prepare(query).unwrap();
            let columns = statement.column_count();
            statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|column| row.get::<_, rusqlite::types::Value>(column))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        })
    };
    let before = snapshot();

    // A missing root produces a real walker error on every supported platform.
    // Keep SQLite outside that root so its prior facts remain inspectable.
    fs::rename(&repository, &relocated).unwrap();
    let result = facts.map();
    fs::rename(&relocated, &repository).unwrap();
    let error = result.expect_err("discovery failure must abort the read workflow");
    let message = error.to_string();
    assert!(
        message.contains("Failed to discover source files"),
        "{message}"
    );
    assert!(
        message.contains(&facts.root().display().to_string()),
        "{message}"
    );
    assert_eq!(snapshot(), before);

    let recovered = facts.map().unwrap();
    assert_eq!(recovered["freshness"]["status"], "fresh");
    assert_eq!(
        recovered["freshness"]["generation"],
        first["freshness"]["generation"]
    );
    assert_eq!(recovered["files_indexed_this_refresh"], 0);
    assert_eq!(recovered["indexed_files"], 2);
    assert_eq!(recovered["symbols"], first["symbols"]);
    assert_eq!(recovered["relationships"], first["relationships"]);
    assert_eq!(snapshot(), before);
}

#[test]
fn fresh_partial_reuses_verified_files_and_retries_omissions() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    let database = state.path().join("facts.sqlite");
    let valid = repository.path().join("valid.py");
    fs::write(&valid, "def before():\n    return 1\n").unwrap();
    fs::write(repository.path().join("large.py"), "x".repeat(TOO_LARGE)).unwrap();
    fs::write(repository.path().join("unreadable.py"), [0xff, 0xfe]).unwrap();
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    let first = facts.refresh().unwrap();
    assert_eq!(first.status, "partial");
    assert_eq!(first.files_indexed, 1);
    assert_eq!(first.files_too_large, 1);
    assert_eq!(first.files_unreadable, 1);
    for _ in 0..2 {
        let next = facts.refresh().unwrap();
        assert_eq!(next.status, "partial");
        assert_eq!(next.files_indexed, 0);
        assert_eq!(next.files_unchanged, 1);
        assert_eq!(next.files_too_large, 1);
        assert_eq!(next.files_unreadable, 1);
        assert_eq!(next.generation, first.generation);
    }
    assert_eq!(marker(&database), "0");
    drop(facts);
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    let reopened = facts.refresh().unwrap();
    assert_eq!(reopened.files_indexed, 0);
    assert_eq!(reopened.files_unchanged, 1);
    assert_eq!(reopened.generation, first.generation);

    // Content hashing remains the owning freshness check even in a partial snapshot.
    let modified_time = fs::metadata(&valid).unwrap().modified().unwrap();
    assert_eq!(
        "def before():\n    return 1\n".len(),
        "def afterX():\n    return 2\n".len()
    );
    fs::write(&valid, "def afterX():\n    return 2\n").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&valid)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified_time))
        .unwrap();
    assert_eq!(
        fs::metadata(&valid).unwrap().modified().unwrap(),
        modified_time
    );
    let edited = facts.outline("valid.py", Some(100)).unwrap();
    assert_eq!(edited["freshness"]["files_indexed"], 1);
    assert!(edited.to_string().contains("afterX"));
    assert!(!edited.to_string().contains("before"));

    fs::write(
        repository.path().join("large.py"),
        "def recovered():\n    pass\n",
    )
    .unwrap();
    let recovered = facts.refresh().unwrap();
    assert_eq!(recovered.files_indexed, 1);
    assert_eq!(recovered.files_unchanged, 1);
    assert_eq!(recovered.files_unreadable, 1);
    assert_eq!(recovered.files_too_large, 0);
    assert_eq!(recovered.generation, first.generation + 2);
    fs::remove_file(repository.path().join("unreadable.py")).unwrap();
    let complete = facts.refresh().unwrap();
    assert_eq!(complete.status, "fresh");
    assert_eq!(complete.files_indexed, 0);
    assert_eq!(complete.generation, recovered.generation);
    fs::remove_file(&valid).unwrap();
    let removed = facts.refresh().unwrap();
    assert_eq!(removed.files_indexed, 0);
    assert_eq!(removed.generation, recovered.generation + 1);
    assert!(facts.outline("valid.py", Some(100)).unwrap()["symbols"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn partial_migration_discards_unverifiable_old_facts_then_retries_only_omissions() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    let database = state.path().join("facts.sqlite");
    for (file, name) in [
        ("valid.py", "retained"),
        ("large.py", "old_large"),
        ("unreadable.py", "old_unreadable"),
        ("deleted.py", "old_deleted"),
    ] {
        fs::write(
            repository.path().join(file),
            format!("def {name}():\n    pass\n"),
        )
        .unwrap();
    }
    let generation = {
        let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
        facts.refresh().unwrap().generation
    };
    downgrade(&database);
    fs::write(repository.path().join("large.py"), "x".repeat(TOO_LARGE)).unwrap();
    fs::write(repository.path().join("unreadable.py"), [0xff, 0xfe]).unwrap();
    fs::remove_file(repository.path().join("deleted.py")).unwrap();
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    assert_eq!(marker(&database), "1");
    let migrated = facts.refresh().unwrap();
    assert_eq!(migrated.status, "partial");
    assert_eq!(migrated.files_indexed, 1);
    assert_eq!(migrated.files_too_large, 1);
    assert_eq!(migrated.files_unreadable, 1);
    assert_eq!(migrated.generation, generation + 1);
    assert_eq!(marker(&database), "0");
    let conn = Connection::open(&database).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM nodes WHERE name LIKE 'old_%'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM file_hashes", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    for path in ["large.py", "unreadable.py", "deleted.py"] {
        let outline = facts.outline(path, Some(100)).unwrap();
        assert!(
            outline["symbols"].as_array().unwrap().is_empty(),
            "{outline}"
        );
        assert_eq!(outline["freshness"]["files_indexed"], 0);
        assert_eq!(outline["freshness"]["generation"], migrated.generation);
        assert_eq!(outline["freshness"]["status"], "partial");
    }
    fs::write(
        repository.path().join("unreadable.py"),
        "def recovered():\n    pass\n",
    )
    .unwrap();
    let recovered = facts.refresh().unwrap();
    assert_eq!(recovered.files_indexed, 1);
    assert_eq!(recovered.files_unchanged, 1);
    assert_eq!(recovered.files_too_large, 1);
    assert_eq!(recovered.generation, migrated.generation + 1);
    assert!(facts
        .outline("unreadable.py", Some(100))
        .unwrap()
        .to_string()
        .contains("recovered"));
}

#[test]
fn migration_with_only_failed_old_sources_removes_them_once() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    let database = state.path().join("facts.sqlite");
    fs::write(
        repository.path().join("old.py"),
        "def old_fact():\n    pass\n",
    )
    .unwrap();
    let generation = {
        let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
        facts.refresh().unwrap().generation
    };
    downgrade(&database);
    fs::write(repository.path().join("old.py"), [0xff, 0xfe]).unwrap();
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    let migrated = facts.outline("old.py", Some(100)).unwrap();
    assert_eq!(migrated["freshness"]["generation"], generation + 1);
    assert!(migrated["symbols"].as_array().unwrap().is_empty());
    assert_eq!(marker(&database), "0");
    let unchanged = facts.refresh().unwrap();
    assert_eq!(unchanged.files_indexed, 0);
    assert_eq!(unchanged.files_unreadable, 1);
    assert_eq!(unchanged.generation, generation + 1);
}

#[test]
fn partial_migration_rolls_back_pruning_replacements_marker_and_generation_together() {
    let repository = tempdir().unwrap();
    let state = tempdir().unwrap();
    let database = state.path().join("facts.sqlite");
    fs::write(
        repository.path().join("valid.py"),
        "def before():\n    pass\n",
    )
    .unwrap();
    fs::write(
        repository.path().join("failed.py"),
        "def old_fact():\n    pass\n",
    )
    .unwrap();
    let generation = {
        let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
        facts.refresh().unwrap().generation
    };
    downgrade(&database);
    fs::write(
        repository.path().join("valid.py"),
        "def afterX():\n    pass\n",
    )
    .unwrap();
    fs::write(repository.path().join("failed.py"), [0xff, 0xfe]).unwrap();
    let facts = CodeFacts::open_with_lsp(repository.path(), &database, LspMode::Off).unwrap();
    let conn = Connection::open(&database).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER abort_partial_migration BEFORE UPDATE OF value ON index_metadata
         WHEN OLD.key = 'generation'
         BEGIN SELECT RAISE(ABORT, 'injected partial migration failure'); END;",
    )
    .unwrap();
    assert!(facts
        .refresh()
        .unwrap_err()
        .to_string()
        .contains("injected partial migration failure"));
    assert_eq!(marker(&database), "1");
    assert_eq!(
        conn.query_row(
            "SELECT value FROM index_metadata WHERE key = 'generation'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        generation.to_string()
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM file_hashes", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM nodes WHERE name IN ('old_fact', 'before')",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM nodes WHERE name = 'afterX'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    conn.execute_batch("DROP TRIGGER abort_partial_migration")
        .unwrap();
    let recovered = facts.refresh().unwrap();
    assert_eq!(recovered.files_indexed, 1);
    assert_eq!(recovered.files_unreadable, 1);
    assert_eq!(recovered.generation, generation + 1);
    assert_eq!(marker(&database), "0");
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM nodes WHERE name IN ('old_fact', 'before')",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
