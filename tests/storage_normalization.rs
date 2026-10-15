use std::{collections::HashMap, fs};

use codefacts::{
    db::{converters::row_to_code_edge, schema::initialize_database},
    graph::store::GraphStore,
    indexer::pipeline::{IndexOptions, IndexingPipeline},
    types::{CodeEdge, EdgeKind},
};
use rusqlite::{params, types::Value as SqlValue, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn edge(line: u32, metadata: Option<HashMap<String, String>>) -> CodeEdge {
    CodeEdge {
        source: "source".into(),
        target: format!("target-{line}"),
        kind: EdgeKind::Calls,
        file_path: "src/调用.ts".into(),
        line,
        target_name: Some("run".into()),
        metadata,
    }
}

#[test]
fn every_edge_writer_preserves_the_previous_complete_metadata_contract() {
    for writer in ["single", "batch", "file", "occurrences"] {
        let directory = tempdir().unwrap();
        let db = directory.path().join("facts.sqlite");
        let store = GraphStore::new(db.to_str().unwrap()).unwrap();
        let edges = vec![
            edge(0, None),
            edge(1, Some(HashMap::new())),
            edge(
                2,
                Some(HashMap::from([
                    ("filePath".into(), "caller-supplied/path".into()),
                    ("line".into(), "0099".into()),
                    (
                        "location_in_columns".into(),
                        "ordinary user metadata".into(),
                    ),
                    ("confidence".into(), "heuristic".into()),
                    ("resolution".into(), "polymorphic".into()),
                    ("candidate_count".into(), "34".into()),
                    ("candidates_truncated".into(), "true".into()),
                    ("object".into(), "接收器".into()),
                    ("call_form".into(), "member".into()),
                    ("custom".into(), "{\"line\":null}".into()),
                ])),
            ),
        ];
        // Existing occurrence rows exercise the conflict-update path as well
        // as fresh inserts. Old rows keep their complete property envelope.
        let raw = Connection::open(&db).unwrap();
        raw.pragma_update(None, "foreign_keys", "OFF").unwrap();
        for item in &edges {
            raw.execute(
                "INSERT INTO edges (source_id,target_id,type,file_path,line,properties)
                 VALUES (?1,?2,'calls',?3,?4,?5)",
                params![item.source, item.target, item.file_path, item.line,
                    json!({"filePath":item.file_path,"line":item.line.to_string(),"old":"removed by update"}).to_string()],
            )
            .unwrap();
        }
        match writer {
            "single" => {
                for item in &edges {
                    store.upsert_edge(item).unwrap();
                }
            }
            "batch" => store.upsert_edges(&edges).unwrap(),
            "file" => store
                .replace_file_data(&edges[0].file_path, &[], &edges)
                .unwrap(),
            "occurrences" => store.replace_edge_occurrences(&[], &edges).unwrap(),
            _ => unreachable!(),
        }
        let actual = store.get_all_edges().unwrap();
        for (item, hydrated) in edges.iter().zip(actual) {
            let mut expected = item.clone();
            let metadata = expected.metadata.get_or_insert_with(HashMap::new);
            metadata.insert("filePath".into(), item.file_path.clone());
            metadata.insert("line".into(), item.line.to_string());
            assert_eq!(
                serde_json::to_value(hydrated).unwrap(),
                serde_json::to_value(expected).unwrap(),
                "writer {writer}"
            );
        }
        let stored = raw
            .prepare("SELECT properties,location_in_columns FROM edges ORDER BY line")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(stored.len(), edges.len());
        for (properties, flag) in stored {
            let properties: Value = serde_json::from_str(&properties).unwrap();
            assert_eq!(flag, 1);
            assert!(properties.get("filePath").is_none());
            assert!(properties.get("line").is_none());
        }
    }
}

#[test]
fn unflagged_external_rows_preserve_location_values_map_presence_and_json_types() {
    let conn = initialize_database(":memory:").unwrap();
    let cases = [
        (None, "actual.ts", 3, None, "actual.ts", 3),
        (Some(json!({})), "actual.ts", 3, None, "actual.ts", 3),
        (
            Some(json!({"context":"kept"})),
            "actual.ts",
            3,
            Some(json!({"context":"kept"})),
            "actual.ts",
            3,
        ),
        (
            Some(json!({"filePath":"legacy.ts"})),
            "",
            0,
            Some(json!({"filePath":"legacy.ts"})),
            "legacy.ts",
            0,
        ),
        (
            Some(json!({"line":"0081"})),
            "",
            0,
            Some(json!({"line":"0081"})),
            "",
            81,
        ),
        (
            Some(json!({"filePath":"other.ts","line":"0099","location_in_columns":"custom"})),
            "actual.ts",
            3,
            Some(json!({"filePath":"other.ts","line":"0099","location_in_columns":"custom"})),
            "actual.ts",
            3,
        ),
        (
            Some(json!({"confidence":7,"filePath":"legacy.ts"})),
            "actual.ts",
            3,
            None,
            "actual.ts",
            3,
        ),
        (Some(json!({"line":null})), "", 0, None, "", 0),
    ];
    for (index, (properties, path, line, metadata, expected_path, expected_line)) in
        cases.into_iter().enumerate()
    {
        conn.execute(
            "INSERT INTO edges (source_id,target_id,type,file_path,line,properties) VALUES ('source',?1,'external_kind',?2,?3,?4)",
            params![format!("target-{index}"), path, line, properties.map(|value|value.to_string())],
        ).unwrap();
        let actual = conn
            .query_row(
                "SELECT * FROM edges WHERE target_id=?1",
                [format!("target-{index}")],
                row_to_code_edge,
            )
            .unwrap();
        assert_eq!(actual.file_path, expected_path);
        assert_eq!(actual.line, expected_line);
        assert_eq!(actual.kind, EdgeKind::References);
        assert_eq!(
            actual
                .metadata
                .map(|value| serde_json::to_value(value).unwrap()),
            metadata
        );
    }
}

fn rows(conn: &Connection, sql: &str) -> Vec<Vec<SqlValue>> {
    let mut statement = conn.prepare(sql).unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| (0..columns).map(|index| row.get(index)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn v18_storage_upgrade_keeps_facts_fts_hashes_and_generation_without_a_source_pass() {
    let repository = tempdir().unwrap();
    fs::create_dir(repository.path().join(".git")).unwrap();
    let source = "package fixture\nfunc Hello() {}\n";
    fs::write(repository.path().join("main.go"), source).unwrap();
    let state = tempdir().unwrap();
    let db = state.path().join("facts.sqlite");
    let conn = initialize_database(db.to_str().unwrap()).unwrap();
    conn.execute_batch(
        "ALTER TABLE edges DROP COLUMN location_in_columns;
         CREATE INDEX idx_edges_source ON edges(source_id);
         UPDATE index_metadata SET value='42' WHERE key='generation';
         UPDATE index_metadata SET value='0' WHERE key='full_reindex_required';
         INSERT INTO nodes (id,type,name,file_path,start_line,end_line,language,signature,metadata)
           VALUES ('hello','function','Hello','main.go',2,2,'go','func Hello() {}','{\"body\":\"func Hello() {}\"}');
         INSERT INTO edges (source_id,target_id,type,file_path,line,target_name,properties)
           VALUES ('hello','hello','calls','main.go',2,'Hello','{\"filePath\":\"custom.ts\",\"line\":\"0099\",\"custom\":\"retained\"}');",
    ).unwrap();
    conn.execute(
        "INSERT INTO file_hashes (file_path,content_hash,language) VALUES ('main.go',?1,'go')",
        [format!("{:x}", Sha256::digest(source.as_bytes()))],
    )
    .unwrap();
    let queries = [
        "SELECT * FROM nodes ORDER BY id",
        "SELECT id,source_id,target_id,type,file_path,line,target_name,properties FROM edges ORDER BY id",
        "SELECT * FROM file_hashes ORDER BY file_path",
        "SELECT * FROM index_metadata ORDER BY key",
        "SELECT rowid,rank FROM fts_nodes WHERE fts_nodes MATCH 'Hello' ORDER BY rank,rowid",
    ];
    let before: Vec<_> = queries.iter().map(|query| rows(&conn, query)).collect();
    let edge_before = conn
        .query_row(
            "SELECT *,0 AS location_in_columns FROM edges",
            [],
            row_to_code_edge,
        )
        .unwrap();
    drop(conn);

    let store = GraphStore::new(db.to_str().unwrap()).unwrap();
    assert!(!store.full_reindex_required().unwrap());
    assert_eq!(store.generation().unwrap(), 42);
    let result = IndexingPipeline::new(&store)
        .index_directory(&IndexOptions {
            root_dir: repository.path().to_path_buf(),
            incremental: true,
        })
        .unwrap();
    assert_eq!(result.files_indexed, 0);
    assert_eq!(result.files_unchanged, 1);
    assert_eq!(result.relationships_rebound, 0);
    assert_eq!(store.generation().unwrap(), 42);
    let edge_after = store.get_all_edges().unwrap().remove(0);
    assert_eq!(
        serde_json::to_value(edge_before).unwrap(),
        serde_json::to_value(edge_after).unwrap()
    );
    drop(store);
    let migrated = Connection::open(&db).unwrap();
    let after: Vec<_> = queries.iter().map(|query| rows(&migrated, query)).collect();
    assert_eq!(before, after);
    assert_eq!(
        migrated
            .query_row("SELECT location_in_columns FROM edges", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        migrated
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_edges_source'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
