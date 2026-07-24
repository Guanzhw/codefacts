//! Optional, user-installed LSP enrichment.
//!
//! CodeFacts never installs or configures a language server. This module only
//! detects a small supported set on `PATH` and, for one `expand` request, uses
//! an isolated stdio session to ask for semantic reference locations. Results
//! remain query-scoped evidence; the SQLite fact store stays authoritative for
//! indexed static facts.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::types::{CodeNode, Language};

// A version check should be effectively instantaneous. Keep a missing or
// hung optional provider from dominating the first `expand` response.
const PROBE_TIMEOUT: Duration = Duration::from_millis(200);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);

const RUST_LANGUAGES: &[Language] = &[Language::Rust];
const TYPESCRIPT_LANGUAGES: &[Language] = &[
    Language::TypeScript,
    Language::Tsx,
    Language::JavaScript,
    Language::Jsx,
];

static PROVIDERS: &[LspProvider] = &[
    LspProvider {
        id: "rust-analyzer",
        command: "rust-analyzer",
        start_args: &[],
        probe_args: &["--version"],
        languages: RUST_LANGUAGES,
    },
    LspProvider {
        id: "typescript-language-server",
        command: "typescript-language-server",
        start_args: &["--stdio"],
        probe_args: &["--version"],
        languages: TYPESCRIPT_LANGUAGES,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LspMode {
    #[default]
    Auto,
    Off,
}

impl LspMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "off" => Some(Self::Off),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Off => "off",
        }
    }
}

#[derive(Debug)]
pub struct LspManager {
    mode: LspMode,
    availability: Mutex<HashMap<&'static str, LspAvailability>>,
}

#[derive(Debug, Clone)]
enum LspAvailability {
    Available,
    NotInstalled,
    Unusable(String),
}

#[derive(Debug, Clone, Copy)]
struct LspProvider {
    id: &'static str,
    command: &'static str,
    start_args: &'static [&'static str],
    probe_args: &'static [&'static str],
    languages: &'static [Language],
}

#[derive(Debug, Serialize)]
pub struct LspReport {
    pub mode: &'static str,
    pub servers: Vec<LspServerReport>,
    pub unsupported_languages: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct LspServerReport {
    pub provider: &'static str,
    pub command: &'static str,
    pub languages: Vec<&'static str>,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug)]
pub enum SemanticReferenceResult {
    Disabled,
    Unsupported {
        language: String,
    },
    Unavailable {
        provider: &'static str,
        message: String,
    },
    NotApplicable {
        provider: &'static str,
        message: String,
    },
    Failed {
        provider: &'static str,
        message: String,
    },
    Success {
        provider: &'static str,
        locations: Vec<LspLocation>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LspLocation {
    pub uri: String,
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
}

#[derive(Debug, Clone, Copy)]
struct LspPosition {
    line: u32,
    character: u32,
}

impl LspManager {
    pub fn new(mode: LspMode) -> Self {
        Self {
            mode,
            availability: Mutex::new(HashMap::new()),
        }
    }

    /// Describe optional providers without necessarily starting external
    /// processes. `map` uses `probe = false`; the first relevant `expand`
    /// request probes and caches availability.
    pub fn report<I>(&self, languages: I, probe: bool) -> LspReport
    where
        I: IntoIterator<Item = Language>,
    {
        let mut provider_ids = HashSet::new();
        let mut unsupported_languages = HashSet::new();
        for language in languages {
            if let Some(provider) = provider_for(language) {
                provider_ids.insert(provider.id);
            } else {
                unsupported_languages.insert(language.as_str().to_string());
            }
        }

        let mut unsupported_languages = unsupported_languages.into_iter().collect::<Vec<_>>();
        unsupported_languages.sort();
        let servers = if self.mode == LspMode::Off {
            Vec::new()
        } else {
            PROVIDERS
                .iter()
                .filter(|provider| provider_ids.contains(provider.id))
                .map(|provider| {
                    if probe {
                        self.server_report(provider)
                    } else {
                        LspServerReport {
                            provider: provider.id,
                            command: provider_command(provider),
                            languages: provider.languages.iter().map(Language::as_str).collect(),
                            status: "deferred",
                            detail: None,
                        }
                    }
                })
                .collect()
        };

        LspReport {
            mode: self.mode.as_str(),
            servers,
            unsupported_languages,
        }
    }

    pub fn references(&self, root: &Path, node: &CodeNode) -> SemanticReferenceResult {
        if self.mode == LspMode::Off {
            return SemanticReferenceResult::Disabled;
        }
        let Some(provider) = provider_for(node.language) else {
            return SemanticReferenceResult::Unsupported {
                language: node.language.as_str().to_string(),
            };
        };
        match self.availability_for(provider) {
            LspAvailability::Available => {}
            LspAvailability::NotInstalled => {
                return SemanticReferenceResult::Unavailable {
                    provider: provider.id,
                    message: format!("'{}' was not found on PATH", provider.command),
                }
            }
            LspAvailability::Unusable(detail) => {
                return SemanticReferenceResult::Unavailable {
                    provider: provider.id,
                    message: detail,
                }
            }
        }

        let source_path = root.join(&node.file_path);
        let source = match fs::read_to_string(&source_path) {
            Ok(source) => source,
            Err(_) => {
                return SemanticReferenceResult::Failed {
                    provider: provider.id,
                    message: "could not read the indexed symbol file".to_string(),
                }
            }
        };
        let Some(position) = symbol_position(&source, node) else {
            return SemanticReferenceResult::NotApplicable {
                provider: provider.id,
                message: "the indexed definition range did not contain the symbol identifier"
                    .to_string(),
            };
        };
        let root_uri = match path_to_file_uri(root) {
            Ok(uri) => uri,
            Err(message) => {
                return SemanticReferenceResult::Failed {
                    provider: provider.id,
                    message,
                }
            }
        };
        let source_uri = match path_to_file_uri(&source_path) {
            Ok(uri) => uri,
            Err(message) => {
                return SemanticReferenceResult::Failed {
                    provider: provider.id,
                    message,
                }
            }
        };

        let locations = match query_references(
            provider,
            &root_uri,
            &source_uri,
            node.language,
            &source,
            position,
        ) {
            Ok(locations) => locations,
            Err(message) => {
                return SemanticReferenceResult::Failed {
                    provider: provider.id,
                    message,
                }
            }
        };
        SemanticReferenceResult::Success {
            provider: provider.id,
            locations,
        }
    }

    fn server_report(&self, provider: &LspProvider) -> LspServerReport {
        let availability = self.availability_for(provider);
        let (status, detail) = match availability {
            LspAvailability::Available => ("available", None),
            LspAvailability::NotInstalled => ("not_installed", Some("not found on PATH".into())),
            LspAvailability::Unusable(detail) => ("unavailable", Some(detail)),
        };
        LspServerReport {
            provider: provider.id,
            command: provider_command(provider),
            languages: provider.languages.iter().map(Language::as_str).collect(),
            status,
            detail,
        }
    }

    fn availability_for(&self, provider: &LspProvider) -> LspAvailability {
        let mut availability = self
            .availability
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        availability
            .entry(provider.id)
            .or_insert_with(|| probe(provider))
            .clone()
    }
}

fn provider_for(language: Language) -> Option<&'static LspProvider> {
    PROVIDERS
        .iter()
        .find(|provider| provider.languages.contains(&language))
}

fn provider_command(provider: &LspProvider) -> &'static str {
    // npm installs the TypeScript server's Windows launcher as a `.cmd` file.
    // `std::process::Command` does not resolve a bare npm command through
    // PowerShell's script lookup, so select that executable explicitly.
    #[cfg(windows)]
    if provider.id == "typescript-language-server" {
        return "typescript-language-server.cmd";
    }
    provider.command
}

fn probe(provider: &LspProvider) -> LspAvailability {
    let mut child = match Command::new(provider_command(provider))
        .args(provider.probe_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LspAvailability::NotInstalled
        }
        Err(_) => {
            return LspAvailability::Unusable("the version probe could not start".to_string())
        }
    };

    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return LspAvailability::Available,
            Ok(Some(_)) => {
                return LspAvailability::Unusable(
                    "the version probe exited unsuccessfully".to_string(),
                )
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return LspAvailability::Unusable(format!(
                    "the version probe exceeded the {} ms budget",
                    PROBE_TIMEOUT.as_millis()
                ));
            }
            Err(_) => {
                return LspAvailability::Unusable(
                    "the version probe could not be observed".to_string(),
                )
            }
        }
    }
}

fn query_references(
    provider: &LspProvider,
    root_uri: &str,
    source_uri: &str,
    language: Language,
    source: &str,
    position: LspPosition,
) -> std::result::Result<Vec<LspLocation>, String> {
    let mut client = LspClient::start(provider)?;
    client.request(
        "initialize",
        json!({
            "processId": Value::Null,
            "clientInfo": { "name": "codefacts" },
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": "codefacts" }],
            "capabilities": {
                "general": { "positionEncodings": ["utf-16"] },
                "textDocument": { "references": { "dynamicRegistration": false } }
            }
        }),
    )?;
    client.notify("initialized", json!({}))?;
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": source_uri,
                "languageId": language_id(language),
                "version": 1,
                "text": source,
            }
        }),
    )?;
    let response = client.request(
        "textDocument/references",
        json!({
            "textDocument": { "uri": source_uri },
            "position": { "line": position.line, "character": position.character },
            "context": { "includeDeclaration": true }
        }),
    )?;
    Ok(parse_locations(&response))
}

fn language_id(language: Language) -> &'static str {
    match language {
        Language::TypeScript => "typescript",
        Language::Tsx => "typescriptreact",
        Language::JavaScript => "javascript",
        Language::Jsx => "javascriptreact",
        Language::Rust => "rust",
        _ => language.as_str(),
    }
}

struct LspClient {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<std::result::Result<Value, String>>,
    next_id: u64,
}

impl LspClient {
    fn start(provider: &LspProvider) -> std::result::Result<Self, String> {
        let mut child = Command::new(provider_command(provider))
            .args(provider.start_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "the language server could not start".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "the language server did not expose stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "the language server did not expose stdout".to_string())?;
        let (sender, responses) = mpsc::channel();
        thread::spawn(move || read_responses(stdout, sender));
        Ok(Self {
            child,
            stdin,
            responses,
            next_id: 1,
        })
    }

    fn request(&mut self, method: &str, params: Value) -> std::result::Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;

        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("LSP request '{method}' timed out"));
            }
            let message = self
                .responses
                .recv_timeout(remaining)
                .map_err(|_| format!("LSP request '{method}' timed out"))??;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!("LSP request '{method}' returned an error: {error}"));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| format!("LSP request '{method}' returned no result"));
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> std::result::Result<(), String> {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn send(&mut self, message: Value) -> std::result::Result<(), String> {
        write_message(&mut self.stdin, &message)
            .map_err(|_| "could not write to language server".to_string())
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        let _ = self.notify("exit", json!({}));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_responses(stdout: impl Read, sender: mpsc::Sender<std::result::Result<Value, String>>) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_message(&mut reader) {
            Ok(Some(message)) => {
                if sender.send(Ok(message)).is_err() {
                    return;
                }
            }
            Ok(None) => return,
            Err(error) => {
                let _ = sender.send(Err(error));
                return;
            }
        }
    }
}

fn write_message(output: &mut impl Write, message: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(message).expect("JSON values are serializable");
    write!(output, "Content-Length: {}\r\n\r\n", body.len())?;
    output.write_all(&body)?;
    output.flush()
}

fn read_message(reader: &mut impl BufRead) -> std::result::Result<Option<Value>, String> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|_| "could not read LSP headers".to_string())?;
        if bytes == 0 {
            return if content_length.is_none() {
                Ok(None)
            } else {
                Err("LSP stream ended before its header block finished".to_string())
            };
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| "LSP Content-Length was invalid".to_string())?,
                );
            }
        }
    }
    let content_length =
        content_length.ok_or_else(|| "LSP message omitted Content-Length".to_string())?;
    let mut body = vec![0; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|_| "LSP stream ended before its message body finished".to_string())?;
    serde_json::from_slice(&body)
        .map_err(|_| "LSP message contained invalid JSON".to_string())
        .map(Some)
}

fn parse_locations(value: &Value) -> Vec<LspLocation> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(parse_location)
        .collect()
}

fn parse_location(value: &Value) -> Option<LspLocation> {
    let uri = value
        .get("uri")
        .or_else(|| value.get("targetUri"))
        .and_then(Value::as_str)?
        .to_string();
    let range = value
        .get("range")
        .or_else(|| value.get("targetSelectionRange"))?;
    let start = range.get("start")?;
    let end = range.get("end")?;
    Some(LspLocation {
        uri,
        start_line: u32::try_from(start.get("line")?.as_u64()?).ok()?,
        start_character: u32::try_from(start.get("character")?.as_u64()?).ok()?,
        end_line: u32::try_from(end.get("line")?.as_u64()?).ok()?,
        end_character: u32::try_from(end.get("character")?.as_u64()?).ok()?,
    })
}

fn symbol_position(source: &str, node: &CodeNode) -> Option<LspPosition> {
    let start = usize::try_from(node.start_line.checked_sub(1)?).ok()?;
    let end = usize::try_from(node.end_line).ok()?;
    for (index, line) in source.lines().enumerate() {
        if index < start || index >= end {
            continue;
        }
        if let Some(byte_offset) = identifier_offset(line, &node.name) {
            return Some(LspPosition {
                line: u32::try_from(index).ok()?,
                character: u32::try_from(line[..byte_offset].encode_utf16().count()).ok()?,
            });
        }
    }
    None
}

fn identifier_offset(line: &str, name: &str) -> Option<usize> {
    if name.is_empty() {
        return None;
    }
    let mut start = 0;
    while let Some(found) = line[start..].find(name) {
        let offset = start + found;
        let end = offset + name.len();
        let before = line[..offset].chars().next_back();
        let after = line[end..].chars().next();
        if !before.is_some_and(identifier_character) && !after.is_some_and(identifier_character) {
            return Some(offset);
        }
        start = end;
    }
    None
}

fn identifier_character(character: char) -> bool {
    character == '_' || character == '$' || character.is_alphanumeric()
}

fn path_to_file_uri(path: &Path) -> std::result::Result<String, String> {
    let path = path
        .canonicalize()
        .map_err(|_| "could not create a file URI for the repository".to_string())?;
    let path = path.to_string_lossy();
    // `std::fs::canonicalize` returns a verbatim `\\?\` path on Windows.
    // That prefix is useful for local filesystem APIs but invalid in a file
    // URI, so remove it before normalizing the separators.
    #[cfg(windows)]
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path);
    let path = path.replace('\\', "/");
    let path = if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    };
    Ok(format!("file://{}", percent_encode_path(&path)))
}

pub fn path_from_file_uri(uri: &str) -> Option<PathBuf> {
    let path = uri.strip_prefix("file://")?;
    if !path.starts_with('/') {
        return None;
    }
    let path = percent_decode(path)?;
    #[cfg(windows)]
    let path = path
        .strip_prefix('/')
        .filter(|value| value.as_bytes().get(1) == Some(&b':'))
        .unwrap_or(&path);
    Some(PathBuf::from(path))
}

fn percent_encode_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/' | b':') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            let high = (high as char).to_digit(16)? as u8;
            let low = (low as char).to_digit(16)? as u8;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use tempfile::tempdir;

    fn node(name: &str) -> CodeNode {
        CodeNode {
            id: "function:src/lib.rs:target:1".to_string(),
            name: name.to_string(),
            qualified_name: None,
            kind: crate::types::NodeKind::Function,
            file_path: "src/lib.rs".to_string(),
            start_line: 1,
            end_line: 1,
            start_column: 0,
            end_column: 1,
            language: Language::Rust,
            body: None,
            documentation: None,
            exported: Some(true),
        }
    }

    #[test]
    fn lsp_mode_parsing_is_deliberately_small() {
        assert_eq!(LspMode::parse("auto"), Some(LspMode::Auto));
        assert_eq!(LspMode::parse("off"), Some(LspMode::Off));
        assert_eq!(LspMode::parse("required"), None);
    }

    #[test]
    fn deferred_lsp_report_is_compact() {
        let manager = LspManager::new(LspMode::Auto);
        let report = serde_json::to_value(manager.report([Language::Rust], false))
            .expect("serialize deferred LSP report");
        assert_eq!(report["mode"], "auto");
        assert!(report.get("behavior").is_none());
        assert_eq!(report["servers"][0]["status"], "deferred");
        assert!(report["servers"][0].get("detail").is_none());
    }

    #[test]
    fn version_probe_budget_stays_within_interactive_expand_expectations() {
        assert!(PROBE_TIMEOUT <= Duration::from_millis(250));
    }

    #[test]
    fn typescript_provider_uses_the_platform_launcher() {
        let provider = provider_for(Language::TypeScript).expect("TypeScript provider");
        #[cfg(windows)]
        assert_eq!(provider_command(provider), "typescript-language-server.cmd");
        #[cfg(not(windows))]
        assert_eq!(provider_command(provider), "typescript-language-server");
    }

    #[test]
    fn lsp_messages_round_trip_through_content_length_framing() {
        let original = json!({ "jsonrpc": "2.0", "id": 7, "result": [] });
        let mut bytes = Vec::new();
        write_message(&mut bytes, &original).expect("write test LSP message");
        let parsed = read_message(&mut BufReader::new(Cursor::new(bytes)))
            .expect("read framed LSP message")
            .expect("one message");
        assert_eq!(parsed, original);
    }

    #[test]
    fn semantic_position_uses_utf16_character_offsets() {
        let position =
            symbol_position("😀target() {}\n", &node("target")).expect("symbol position");
        assert_eq!(position.line, 0);
        assert_eq!(position.character, 2);
    }

    #[test]
    fn location_parser_accepts_standard_locations_and_location_links() {
        let locations = parse_locations(&json!([
            {"uri":"file:///repo/lib.rs","range":{"start":{"line":1,"character":2},"end":{"line":1,"character":8}}},
            {"targetUri":"file:///repo/other.rs","targetSelectionRange":{"start":{"line":3,"character":0},"end":{"line":3,"character":4}}}
        ]));
        assert_eq!(locations.len(), 2);
        assert_eq!(locations[1].uri, "file:///repo/other.rs");
    }

    #[test]
    fn file_uri_rejects_remote_hosts_and_decodes_spaces() {
        assert!(path_from_file_uri("file://server/share/lib.rs").is_none());
        assert_eq!(
            path_from_file_uri("file:///repo/my%20file.rs"),
            Some(PathBuf::from("/repo/my file.rs"))
        );
    }

    #[test]
    fn local_file_uri_round_trips_without_a_windows_verbatim_prefix() {
        let directory = tempdir().expect("temporary directory");
        let uri = path_to_file_uri(directory.path()).expect("file URI");
        assert!(uri.starts_with("file:///"));
        assert!(!uri.contains("//?/"));
        let restored = path_from_file_uri(&uri)
            .expect("local file URI")
            .canonicalize()
            .expect("restored local path");
        assert_eq!(
            restored,
            directory
                .path()
                .canonicalize()
                .expect("canonical directory")
        );
    }
}
