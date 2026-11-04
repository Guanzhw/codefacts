//! Fake-server tests verify the native protocol and lifecycle contract only.
//! Real-provider acceptance is separate; this fixture is not a Python analyzer.

use std::cell::Cell;
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};
use tempfile::{tempdir, TempDir};

const LIBRARY: &str = "# 😀 target elsewhere\r\ndef target():\r\n    return 1\r\ndef test_caller():\r\n    return target()\r\n";
const OTHER: &str = "from lib import target\r\nnote = \"😀\"; result = target()\r\n";

struct Fixture {
    work: TempDir,
    root: PathBuf,
    bin: PathBuf,
    audit: PathBuf,
    heartbeat: PathBuf,
    stopped: Cell<bool>,
}

impl Fixture {
    fn new(large: bool) -> Self {
        let work = tempdir().unwrap();
        let root = work.path().join("project");
        let bin = work.path().join("provider launchers");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&bin).unwrap();
        let library = if large {
            format!("{LIBRARY}# {}\r\n", "x".repeat(650_000))
        } else {
            LIBRARY.to_string()
        };
        fs::write(root.join("lib.py"), library).unwrap();
        fs::write(root.join("other.py"), OTHER).unwrap();
        let node = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("Node is a documented test/CI prerequisite");
        assert!(node.status.success());
        let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
        let server = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lsp-server.cjs");
        #[cfg(windows)]
        fs::write(
            bin.join("pyright-langserver.cmd"),
            format!("@\"{node}\" \"{}\" %*\r\n", server.display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let launcher = bin.join("pyright-langserver");
            let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
            fs::write(
                &launcher,
                format!(
                    "#!/bin/sh\nexec {} {} \"$@\"\n",
                    quote(&node),
                    quote(server.to_str().unwrap())
                ),
            )
            .unwrap();
            fs::set_permissions(launcher, fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self {
            root,
            bin,
            audit: work.path().join("provider.jsonl"),
            heartbeat: work.path().join("heartbeat"),
            work,
            stopped: Cell::new(false),
        }
    }

    fn audit(&self) -> Vec<Value> {
        fs::read_to_string(&self.audit)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn assert_processes_stopped(&self) {
        let pids: Vec<Pid> = self
            .audit()
            .iter()
            .filter_map(|event| event["pid"].as_u64().map(|pid| Pid::from_u32(pid as u32)))
            .collect();
        assert!(!pids.is_empty(), "the fixture must actually have started");
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut system = System::new();
            system.refresh_processes(ProcessesToUpdate::Some(&pids), true);
            // A Unix host without a subreaper can retain an already-dead
            // orphan zombie. It cannot execute or hold stdio pipes open.
            let running: Vec<_> = pids
                .iter()
                .filter(|pid| {
                    system
                        .process(**pid)
                        .is_some_and(|process| process.status() != ProcessStatus::Zombie)
                })
                .collect();
            if running.is_empty() {
                self.stopped.set(true);
                return;
            }
            assert!(
                Instant::now() < deadline,
                "provider processes remain: {running:?}"
            );
            thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.stopped.get() {
            return;
        }
        // Even an assertion failure must not leave the adversarial fixture
        // behind. Only PIDs written by this fixture are eligible for cleanup.
        for event in self.audit() {
            let Some(pid) = event["pid"].as_u64() else {
                continue;
            };
            #[cfg(unix)]
            {
                unsafe extern "C" {
                    fn kill(pid: i32, signal: i32) -> i32;
                }
                if let Ok(pid) = i32::try_from(pid) {
                    // SAFETY: this PID was recorded by our temporary fixture.
                    unsafe { kill(pid, 9) };
                }
            }
            #[cfg(windows)]
            {
                if let Ok(mut killer) = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    let deadline = Instant::now() + Duration::from_secs(2);
                    while Instant::now() < deadline {
                        if killer.try_wait().is_ok_and(|status| status.is_some()) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    let _ = killer.kill();
                }
            }
        }
    }
}

struct Mcp {
    child: Child,
    input: Option<ChildStdin>,
    responses: Receiver<String>,
    next_id: usize,
}

impl Mcp {
    fn new(fixture: &Fixture, mode: &str) -> Self {
        let mut paths = vec![fixture.bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let mut child = Command::new(env!("CARGO_BIN_EXE_codefacts"))
            .args(["mcp", "--root"])
            .arg(&fixture.root)
            .args(["--state"])
            .arg(fixture.work.path().join("facts.sqlite"))
            .args(["--lsp", "auto"])
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("CODEFACTS_TEST_LSP_MODE", mode)
            .env("CODEFACTS_TEST_LSP_AUDIT", &fixture.audit)
            .env("CODEFACTS_TEST_LSP_HEARTBEAT", &fixture.heartbeat)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, responses) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input: Some(input),
            responses,
            next_id: 0,
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let input = self.input.as_mut().unwrap();
        writeln!(
            input,
            "{}",
            json!({"jsonrpc":"2.0","id":self.next_id,"method":method,"params":params})
        )
        .unwrap();
        input.flush().unwrap();
        let line = self
            .responses
            .recv_timeout(Duration::from_secs(12))
            .expect("native MCP response must remain bounded");
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], self.next_id);
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }

    fn expand(&mut self, format: Option<&str>) -> Value {
        let mut arguments = json!({"symbol":"target","file_path":"lib.py","limit":20});
        if let Some(format) = format {
            arguments["format"] = json!(format);
        }
        self.request("tools/call", json!({"name":"expand","arguments":arguments}))
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            if self.child.try_wait().is_ok_and(|status| status.is_some()) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.child.try_wait().is_ok_and(|status| status.is_some()) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn structured(result: &Value) -> Value {
    assert_eq!(result["isError"], false, "{result}");
    let text = result["content"][0]["text"].as_str().unwrap();
    let body: Value = serde_json::from_str(text).unwrap();
    assert_eq!(body, result["structuredContent"]);
    body
}

fn static_facts_survive(body: &Value) {
    assert_eq!(body["definition"]["name"], "target");
    assert!(
        body["callers"].as_array().unwrap().iter().any(|edge| {
            edge["from"]["name"] == "test_caller" && edge["evidence"]["confidence"] == "static"
        }),
        "{body}"
    );
}

#[test]
fn native_optional_lsp_handles_reverse_requests_and_utf16_in_each_format() {
    for format in [Some("full"), Some("compact"), None] {
        let fixture = Fixture::new(false);
        let mut mcp = Mcp::new(&fixture, "success");
        let catalog = mcp.request("tools/list", json!({}));
        let mut names: Vec<_> = catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        names.sort_unstable();
        assert_eq!(names, ["expand", "explore", "impact"]);
        let result = mcp.expand(format);
        if format.is_some() {
            let body = structured(&result);
            static_facts_survive(&body);
            let semantic = &body["references"]["semantic"];
            assert_eq!(semantic["status"], "ok", "{body}");
            assert_eq!(semantic["provider"], "pyright");
            assert_eq!(semantic["position_encoding"], "utf-16");
            assert_eq!(semantic["workspace"]["mode"], "bounded_indexed_snapshot");
            assert_eq!(semantic["workspace"]["loaded_files"], 2);
            assert_eq!(semantic["workspace"]["omitted_files"], 0);
            assert_eq!(semantic["workspace"]["partial"], false);
            let locations = semantic["locations"].as_array().unwrap();
            assert_eq!(locations.len(), 3, "{semantic}");
            assert!(locations.iter().all(|location| {
                location["source_validation"] == "current_hash_and_utf16_range_verified"
            }));
            let unicode = locations
                .iter()
                .find(|location| location["evidence"]["file_path"] == "other.py")
                .unwrap();
            assert_eq!(unicode["evidence"]["start_line"], 2);
            let expected = OTHER
                .lines()
                .nth(1)
                .unwrap()
                .split("target(")
                .next()
                .unwrap()
                .encode_utf16()
                .count();
            assert_eq!(unicode["start_column"], expected);
            assert_eq!(unicode["end_column"], expected + 6);
        } else {
            assert_eq!(result["isError"], false);
            assert!(result.get("structuredContent").is_none());
            let text = result["content"][0]["text"].as_str().unwrap();
            for expected in ["pyright", "utf-16", "other.py:2", "test_caller"] {
                assert!(text.contains(expected), "missing {expected}: {text}");
            }
            assert!(text.len() <= 16_384);
        }
        let audit = fixture.audit();
        let replies: Vec<_> = audit
            .iter()
            .filter(|event| event["event"] == "reply")
            .collect();
        assert!(replies
            .iter()
            .any(|reply| reply["id"].is_number() && reply["result"] == json!([null, null])));
        assert!(replies
            .iter()
            .any(|reply| reply["id"] == "config-string" && reply["result"] == json!([null])));
        assert!(replies.iter().any(|reply| reply["id"] == "folders"
            && reply["result"]
                .as_array()
                .is_some_and(|folders| folders.len() == 1)));
        assert!(replies
            .iter()
            .any(|reply| reply["id"] == "edit" && reply["result"]["applied"] == false));
        assert!(audit
            .iter()
            .any(|event| event["method"] == "textDocument/references"
                && event["position"] == json!({"line":1,"character":4})));
        assert_eq!(
            fs::read_to_string(fixture.root.join("lib.py")).unwrap(),
            LIBRARY
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("other.py")).unwrap(),
            OTHER
        );
        drop(mcp);
        fixture.assert_processes_stopped();
    }
}

#[test]
fn native_optional_lsp_stable_snapshot_allows_semantic_continuation() {
    let fixture = Fixture::new(false);
    let mut mcp = Mcp::new(&fixture, "success");
    let mut cursor: Option<String> = None;
    let mut cursors = BTreeSet::new();
    let mut locations = BTreeSet::new();
    let mut generation = None;
    let mut pages = 0;
    loop {
        let mut arguments = json!({"symbol":"target","file_path":"lib.py",
            "section":"semantic","format":"full","limit":1});
        if let Some(cursor) = &cursor {
            arguments["cursor"] = json!(cursor);
        }
        let result = mcp.request("tools/call", json!({"name":"expand","arguments":arguments}));
        let page = structured(&result);
        assert_eq!(page["status"], "ok", "{page}");
        assert_eq!(page["section"], "semantic");
        let current_generation = page["freshness"]["generation"].as_u64().unwrap();
        assert_eq!(
            *generation.get_or_insert(current_generation),
            current_generation
        );
        let semantic = &page["references"]["semantic"];
        assert_eq!(semantic["status"], "ok", "{page}");
        assert_eq!(semantic["workspace"]["loaded_files"], 2);
        assert_eq!(semantic["workspace"]["partial"], false);
        let returned = semantic["locations"].as_array().unwrap();
        assert_eq!(returned.len(), 1);
        assert!(
            locations.insert(serde_json::to_string(&returned[0]).unwrap()),
            "continuations must never repeat a location"
        );
        pages += 1;
        let Some(next) = page["next"]["semantic"].as_str() else {
            break;
        };
        assert!(pages < 3, "three locations require exactly three pages");
        assert!(
            cursors.insert(next.to_owned()),
            "continuations must advance"
        );
        cursor = Some(next.to_owned());
    }
    assert_eq!(pages, 3);
    assert_eq!(locations.len(), 3);
    assert_eq!(
        fixture
            .audit()
            .iter()
            .filter(|event| event["event"] == "started")
            .count(),
        3,
        "each page must negotiate a fresh real stdio session"
    );
    drop(mcp);
    fixture.assert_processes_stopped();
}

#[test]
fn native_optional_lsp_failures_preserve_static_facts() {
    for (mode, status) in [
        ("unsupported", "not_applicable"),
        ("error", "failed"),
        ("out-of-bounds", "failed"),
        ("surrogate", "failed"),
        ("changed-source", "failed"),
    ] {
        let fixture = Fixture::new(false);
        let mut mcp = Mcp::new(&fixture, mode);
        let body = structured(&mcp.expand(Some("full")));
        static_facts_survive(&body);
        let semantic = &body["references"]["semantic"];
        assert_eq!(semantic["status"], status, "mode={mode}: {body}");
        assert!(semantic.get("locations").is_none(), "{semantic}");
        assert!(semantic["message"].is_string(), "{semantic}");
        if mode == "error" {
            assert!(semantic["message"]
                .as_str()
                .unwrap()
                .contains("fixture reference failure"));
            assert!(serde_json::to_string(semantic).unwrap().len() < 1500);
        }
        drop(mcp);
        fixture.assert_processes_stopped();
    }
}

#[test]
fn native_optional_lsp_blocked_write_is_bounded_and_terminates_descendants() {
    let fixture = Fixture::new(true);
    let mut mcp = Mcp::new(&fixture, "blocked-write");
    let started = Instant::now();
    let body = structured(&mcp.expand(Some("full")));
    assert!(started.elapsed() < Duration::from_secs(12));
    static_facts_survive(&body);
    let semantic = &body["references"]["semantic"];
    assert_eq!(semantic["status"], "failed", "{body}");
    assert!(
        semantic["message"].as_str().unwrap().contains("timed out"),
        "{semantic}"
    );
    let audit = fixture.audit();
    assert!(audit.iter().any(|event| event["event"] == "descendant"));
    assert!(!audit
        .iter()
        .any(|event| event["method"] == "textDocument/references"));
    drop(mcp);
    fixture.assert_processes_stopped();
    let heartbeat = fs::read(&fixture.heartbeat).expect("descendant actually ran");
    assert!(!heartbeat.is_empty());
    thread::sleep(Duration::from_millis(150));
    assert_eq!(fs::read(&fixture.heartbeat).unwrap(), heartbeat);
}
