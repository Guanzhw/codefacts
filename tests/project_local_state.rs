use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::Path, process::Command};
use tempfile::tempdir;

fn query(
    root: &Path,
    user_storage: &Path,
    state_dir: Option<&Path>,
    state: Option<&Path>,
) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_codefacts"));
    command
        .current_dir(root)
        .args(["search", "visible", "--format", "full", "--lsp", "off"])
        .env_remove("CODEFACTS_STATE_DIR")
        .env("LOCALAPPDATA", user_storage)
        .env("HOME", user_storage);
    if let Some(dir) = state_dir {
        command.env("CODEFACTS_STATE_DIR", dir);
    }
    if let Some(path) = state {
        command.arg("--state").arg(path);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn cli_default_is_local_excludes_state_sources_and_rebuilds() {
    let project = tempdir().unwrap();
    let user_storage = tempdir().unwrap();
    fs::write(project.path().join("lib.rs"), "pub fn visible() {}\n").unwrap();
    fs::create_dir(project.path().join(".codefacts")).unwrap();
    // Explicitly unignore the hidden directory to exercise the unconditional exclusion.
    fs::write(
        project.path().join(".ignore"),
        "!.codefacts/\n!.codefacts/**\n",
    )
    .unwrap();
    fs::write(
        project.path().join(".codefacts/hidden.rs"),
        "pub fn visible() {}\n",
    )
    .unwrap();
    let result = query(project.path(), user_storage.path(), None, None);
    assert_eq!(result["results"].as_array().unwrap().len(), 1);
    assert_eq!(result["results"][0]["name"], "visible");
    assert!(project.path().join(".codefacts/index.sqlite").is_file());
    assert_eq!(fs::read_dir(user_storage.path()).unwrap().count(), 0);

    fs::remove_dir_all(project.path().join(".codefacts")).unwrap();
    let rebuilt = query(project.path(), user_storage.path(), None, None);
    assert_eq!(rebuilt["results"][0]["name"], "visible");
    assert!(project.path().join(".codefacts/index.sqlite").is_file());
    assert_eq!(fs::read_dir(user_storage.path()).unwrap().count(), 0);
}

#[test]
fn cli_storage_overrides_preserve_hashed_names_and_explicit_state_precedence() {
    let project = tempdir().unwrap();
    let user_storage = tempdir().unwrap();
    let state_dir = tempdir().unwrap();
    let explicit_dir = tempdir().unwrap();
    fs::write(project.path().join("lib.rs"), "pub fn visible() {}\n").unwrap();
    let root = project.path().canonicalize().unwrap();
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    let hashed = state_dir
        .path()
        .join(format!("{}.sqlite", hex::encode(&digest[..12])));
    let explicit = explicit_dir.path().join("chosen.sqlite");

    query(
        project.path(),
        user_storage.path(),
        Some(state_dir.path()),
        Some(&explicit),
    );
    assert!(explicit.is_file());
    assert!(!hashed.exists());
    assert!(!project.path().join(".codefacts").exists());

    let result = query(
        project.path(),
        user_storage.path(),
        Some(state_dir.path()),
        None,
    );
    assert_eq!(result["results"][0]["name"], "visible");
    assert!(hashed.is_file());
    assert!(!project.path().join(".codefacts").exists());
    assert_eq!(fs::read_dir(user_storage.path()).unwrap().count(), 0);
}

#[test]
fn local_database_and_live_sidecars_share_the_index_directory() {
    let project = tempdir().unwrap();
    fs::write(project.path().join("lib.rs"), "pub fn visible() {}\n").unwrap();
    let database = project.path().join(".codefacts/index.sqlite");
    let facts = codefacts::service::CodeFacts::open(&project, &database).unwrap();
    facts.refresh().unwrap();
    for file in ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"] {
        assert!(database.parent().unwrap().join(file).is_file(), "{file}");
    }
}
