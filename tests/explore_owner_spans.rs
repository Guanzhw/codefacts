use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use tempfile::tempdir;

#[test]
fn parser_owner_spans_keep_cli_and_mcp_usable() {
    for (path, source, heading) in [
        (
            "headers.py",
            "def userid():\n    return \"中文\" # request headers\n    # userid\n",
            "headers.py:1-3 | function userid",
        ),
        (
            "headers.py",
            "def userid():\r\n    return \"中文\" # request headers\r\n    # userid\r\n",
            "headers.py:1-3 | function userid",
        ),
        (
            "headers.py",
            "def userid():\n    return \"中文\" # request headers\r\n    # userid\r\n",
            "headers.py:1-3 | function userid",
        ),
        (
            "headers.c",
            "#define userid(x) ((x)+1)\n",
            "headers.c:1-2 | function userid",
        ),
    ] {
        let root = tempdir().unwrap();
        let state = tempdir().unwrap();
        fs::write(root.path().join(path), source).unwrap();
        let query = "userid,userId,user_id,DI headers,request headers";
        let cli = Command::new(env!("CARGO_BIN_EXE_codefacts"))
            .args(["explore", query, "--root"])
            .arg(root.path())
            .arg("--state")
            .arg(state.path().join("cli.sqlite"))
            .args(["--lsp", "off"])
            .output()
            .unwrap();
        assert!(
            cli.status.success(),
            "{}",
            String::from_utf8_lossy(&cli.stderr)
        );
        assert!(cli.stderr.is_empty());
        let text = String::from_utf8(cli.stdout).unwrap();
        assert!(text.contains(heading), "{text}");
        for (index, line) in source.lines().enumerate() {
            assert!(text.contains(&format!("{}: {line}\n", index + 1)), "{text}");
        }

        let mut child = Command::new(env!("CARGO_BIN_EXE_codefacts"))
            .args(["mcp", "--root"])
            .arg(root.path())
            .arg("--state")
            .arg(state.path().join("mcp.sqlite"))
            .args(["--lsp", "off"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        for request in [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
                "name":"explore","arguments":{"query":query}}}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
                "name":"explore","arguments":{}}}),
        ] {
            writeln!(input, "{request}").unwrap();
        }
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());
        let responses: Vec<Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 4, "{responses:?}");
        for (index, response) in responses.iter().enumerate() {
            assert_eq!(response["id"], index + 1);
        }
        assert_eq!(responses[1]["result"]["isError"], false);
        let discovered = responses[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(discovered.contains(heading), "{discovered}");
        assert!(!discovered.contains("Source gaps"));
        assert!(responses[2]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "explore"));
        assert_eq!(responses[3]["result"]["isError"], false);
        assert!(responses[3]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(source.lines().next().unwrap()));
    }
}
