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
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use streaming_iterator::StreamingIterator;

use crate::indexer::parser::CodeParser;

use crate::types::{CodeNode, Language};

// A version check should be effectively instantaneous. Keep a missing or
// hung optional provider from dominating the first `expand` response.
const PROBE_TIMEOUT: Duration = Duration::from_millis(200);
// One shared deadline covers initialization, server requests, writes and refs.
const SESSION_TIMEOUT: Duration = Duration::from_secs(4);
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_WORKSPACE_FILES: usize = 64;
const MAX_WORKSPACE_BYTES: usize = 2 * 1024 * 1024;

const RUST_LANGUAGES: &[Language] = &[Language::Rust];
const PYTHON_LANGUAGES: &[Language] = &[Language::Python];
const GO_LANGUAGES: &[Language] = &[Language::Go];
const C_LANGUAGES: &[Language] = &[Language::C, Language::Cpp];
const BASH_LANGUAGES: &[Language] = &[Language::Bash];
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
        probe_args: Some(&["--version"]),
        languages: RUST_LANGUAGES,
    },
    LspProvider {
        id: "typescript-language-server",
        command: "typescript-language-server",
        start_args: &["--stdio"],
        probe_args: Some(&["--version"]),
        languages: TYPESCRIPT_LANGUAGES,
    },
    LspProvider {
        id: "pyright",
        command: "pyright-langserver",
        start_args: &["--stdio"],
        // pyright-langserver does not provide a portable version command.
        probe_args: None,
        languages: PYTHON_LANGUAGES,
    },
    LspProvider {
        id: "gopls",
        command: "gopls",
        start_args: &[],
        probe_args: Some(&["version"]),
        languages: GO_LANGUAGES,
    },
    LspProvider {
        id: "clangd",
        command: "clangd",
        start_args: &[
            "--background-index=false",
            "--clang-tidy=false",
            "--pch-storage=memory",
        ],
        probe_args: Some(&["--version"]),
        languages: C_LANGUAGES,
    },
    LspProvider {
        id: "bash-language-server",
        command: "bash-language-server",
        start_args: &["start"],
        probe_args: Some(&["--version"]),
        languages: BASH_LANGUAGES,
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
    probe_args: Option<&'static [&'static str]>,
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
        workspace: LspWorkspaceScope,
        deadline: Instant,
    },
}

#[derive(Debug, Serialize)]
pub struct LspWorkspaceScope {
    pub mode: &'static str,
    pub indexed_files: usize,
    pub loaded_files: usize,
    pub omitted_files: usize,
    pub loaded_bytes: usize,
    pub checked_files: usize,
    pub read_bytes: usize,
    pub max_files: usize,
    pub max_bytes: usize,
    pub partial: bool,
    pub readiness: &'static str,
}

#[derive(Debug)]
struct LspDocument {
    uri: String,
    language: Language,
    source: String,
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
    /// processes. `map` uses `probe = false`. Command probes never establish
    /// reference capability; each `expand` negotiates a real LSP session.
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

    pub(crate) fn needs_indexed_snapshot(&self, node: &CodeNode) -> bool {
        self.mode != LspMode::Off && provider_for(node.language).is_some()
    }

    pub fn references(
        &self,
        root: &Path,
        node: &CodeNode,
        file_hashes: &HashMap<String, String>,
    ) -> SemanticReferenceResult {
        let deadline = Instant::now() + SESSION_TIMEOUT;
        if self.mode == LspMode::Off {
            return SemanticReferenceResult::Disabled;
        }
        let Some(provider) = provider_for(node.language) else {
            return SemanticReferenceResult::Unsupported {
                language: node.language.as_str().to_string(),
            };
        };

        let (documents, mut workspace) =
            match workspace_documents(root, node, provider, file_hashes, deadline) {
                Ok(snapshot) => snapshot,
                Err(message) => {
                    return SemanticReferenceResult::Failed {
                        provider: provider.id,
                        message,
                    }
                }
            };
        let selected = &documents[0]; // The selected definition is always first.
        let Some(position) = symbol_position(&selected.source, node) else {
            return SemanticReferenceResult::NotApplicable {
                provider: provider.id,
                message:
                    "the indexed definition has no unique grammar name capture in its AST range"
                        .into(),
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

        let locations = match query_references(provider, &root_uri, &documents, position, deadline)
        {
            Ok((locations, readiness)) => {
                workspace.readiness = readiness;
                locations
            }
            Err(QueryError::Unavailable(message)) => {
                return SemanticReferenceResult::Unavailable {
                    provider: provider.id,
                    message,
                };
            }
            Err(QueryError::NotApplicable(message)) => {
                return SemanticReferenceResult::NotApplicable {
                    provider: provider.id,
                    message,
                };
            }
            Err(QueryError::Failed(message)) => {
                return SemanticReferenceResult::Failed {
                    provider: provider.id,
                    message,
                };
            }
        };
        SemanticReferenceResult::Success {
            provider: provider.id,
            locations,
            workspace,
            deadline,
        }
    }

    fn server_report(&self, provider: &LspProvider) -> LspServerReport {
        let availability = self.availability_for(provider);
        let (status, detail) = match availability {
            LspAvailability::Available => (
                "detected",
                Some("Command detected only; reference support is checked during expand.".into()),
            ),
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

fn workspace_documents(
    root: &Path,
    node: &CodeNode,
    provider: &LspProvider,
    file_hashes: &HashMap<String, String>,
    deadline: Instant,
) -> std::result::Result<(Vec<LspDocument>, LspWorkspaceScope), String> {
    let root = root
        .canonicalize()
        .map_err(|_| "could not resolve the indexed repository root".to_string())?;
    let mut candidates: Vec<_> = file_hashes
        .keys()
        .filter(|path| {
            *path == &node.file_path
                || CodeParser::detect_language(path)
                    .is_some_and(|language| provider.languages.contains(&language))
        })
        .collect();
    if !file_hashes.contains_key(&node.file_path) {
        return Err("the selected symbol has no indexed file snapshot".into());
    }
    candidates.sort_by_key(|path| (*path != &node.file_path, *path));
    let mut workspace = LspWorkspaceScope {
        mode: "bounded_indexed_snapshot",
        indexed_files: candidates.len(),
        loaded_files: 0,
        omitted_files: 0,
        loaded_bytes: 0,
        checked_files: 0,
        read_bytes: 0,
        max_files: MAX_WORKSPACE_FILES,
        max_bytes: MAX_WORKSPACE_BYTES,
        partial: false,
        readiness: "not_required",
    };
    let mut documents = Vec::new();
    for relative in candidates {
        if Instant::now() >= deadline {
            return Err("LSP session timed out while preparing indexed documents".into());
        }
        // Invalid/stale reads consume the same work budget as accepted docs.
        // One extra byte is permitted only to detect a file growing past it.
        if workspace.checked_files >= MAX_WORKSPACE_FILES
            || workspace.read_bytes >= MAX_WORKSPACE_BYTES
        {
            break;
        }
        workspace.checked_files += 1;
        let remaining = MAX_WORKSPACE_BYTES - workspace.read_bytes;
        let document = (|| {
            let path = Path::new(relative);
            if path.is_absolute()
                || path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return None;
            }
            let path = root.join(path).canonicalize().ok()?;
            if !path.starts_with(&root) {
                return None;
            }
            let file = fs::File::open(&path).ok()?;
            let metadata = file.metadata().ok()?;
            if !metadata.is_file() || metadata.len() > remaining as u64 {
                return None;
            }
            let mut bytes = Vec::new();
            let read_result = file.take(remaining as u64 + 1).read_to_end(&mut bytes);
            workspace.read_bytes += bytes.len();
            read_result.ok()?;
            if bytes.len() > remaining
                || hex::encode(Sha256::digest(&bytes)) != *file_hashes.get(relative)?
            {
                return None;
            }
            let source = String::from_utf8(bytes).ok()?;
            let uri = path_to_file_uri(&path).ok()?;
            Some(LspDocument {
                uri,
                source,
                language: if relative == &node.file_path {
                    node.language
                } else {
                    CodeParser::detect_language(relative)?
                },
            })
        })();
        if let Some(document) = document {
            workspace.loaded_bytes += document.source.len();
            documents.push(document);
        } else if relative == &node.file_path {
            return Err("the selected symbol file is changed, unreadable, outside the repository, or exceeds the LSP workspace budget".into());
        }
    }
    workspace.loaded_files = documents.len();
    workspace.omitted_files = workspace.indexed_files - documents.len();
    workspace.partial = workspace.omitted_files > 0;
    Ok((documents, workspace))
}

fn provider_for(language: Language) -> Option<&'static LspProvider> {
    PROVIDERS
        .iter()
        .find(|provider| provider.languages.contains(&language))
}

fn provider_command(provider: &LspProvider) -> &'static str {
    #[cfg(windows)]
    match provider.id {
        "typescript-language-server" => return "typescript-language-server.cmd",
        "pyright" => return "pyright-langserver.cmd",
        "bash-language-server" => return "bash-language-server.cmd",
        _ => {}
    }
    provider.command
}

fn provider_process(provider: &LspProvider) -> Command {
    let mut command = Command::new(provider_command(provider));
    if provider.id == "rust-analyzer" {
        command
            .env("CARGO_NET_OFFLINE", "true")
            .env("RUSTUP_AUTO_INSTALL", "0");
    }
    if provider.id == "gopls" {
        // Query-scoped policy only: never download a Go toolchain/module or
        // update the user's module files while locating references.
        let mut flags = std::env::var("GOFLAGS").unwrap_or_default();
        if !flags.is_empty() {
            flags.push(' ');
        }
        flags.push_str("-mod=readonly");
        command
            .env("GOTOOLCHAIN", "local")
            .env("GOPROXY", "off")
            .env("GOSUMDB", "off")
            .env("GOFLAGS", flags);
    }
    // An isolated group lets cleanup terminate npm wrappers and their server
    // descendants, including after a protocol timeout.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn command_on_path(command: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|directory| {
            let path = directory.join(command);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                path.is_file()
                    && path
                        .metadata()
                        .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
            }
            #[cfg(not(unix))]
            {
                path.is_file()
            }
        })
    })
}

fn probe(provider: &LspProvider) -> LspAvailability {
    let Some(args) = provider.probe_args else {
        return if command_on_path(provider_command(provider)) {
            LspAvailability::Available
        } else {
            LspAvailability::NotInstalled
        };
    };
    let mut child = match provider_process(provider)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LspAvailability::NotInstalled
        }
        Err(_) => return LspAvailability::Unusable("the command probe could not start".into()),
    };
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return LspAvailability::Available,
            Ok(Some(_)) => {
                return LspAvailability::Unusable("the command probe exited unsuccessfully".into())
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = terminate_process_tree(child, Instant::now() + CLEANUP_TIMEOUT);
                return LspAvailability::Unusable(format!(
                    "the command probe exceeded the {} ms budget",
                    PROBE_TIMEOUT.as_millis()
                ));
            }
            Err(_) => {
                let _ = terminate_process_tree(child, Instant::now() + CLEANUP_TIMEOUT);
                return LspAvailability::Unusable("the command probe could not be observed".into());
            }
        }
    }
}

#[derive(Debug)]
enum QueryError {
    Unavailable(String),
    NotApplicable(String),
    Failed(String),
}

impl From<String> for QueryError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

fn reference_capability(initialize: &Value) -> std::result::Result<(), QueryError> {
    let capabilities = &initialize["capabilities"];
    if !matches!(
        capabilities.get("referencesProvider"),
        Some(Value::Bool(true) | Value::Object(_))
    ) {
        return Err(QueryError::NotApplicable(
            "the language server did not advertise reference support".into(),
        ));
    }
    // UTF-16 is the protocol default. clangd also uses the legacy extension.
    for encoding in [
        capabilities.get("positionEncoding"),
        initialize.get("offsetEncoding"),
    ]
    .into_iter()
    .flatten()
    {
        if encoding.as_str() != Some("utf-16") {
            return Err(QueryError::NotApplicable(
                "the language server selected an unsupported position encoding; UTF-16 is required"
                    .into(),
            ));
        }
    }
    Ok(())
}

fn query_references(
    provider: &LspProvider,
    root_uri: &str,
    documents: &[LspDocument],
    position: LspPosition,
    deadline: Instant,
) -> std::result::Result<(Vec<LspLocation>, &'static str), QueryError> {
    let mut client = LspClient::start(provider, root_uri, deadline)?;
    let result = (|| {
        let initialize = client.session.request(
            "initialize",
            json!({
                "processId": Value::Null,
                "clientInfo": { "name": "codefacts" },
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "codefacts" }],
                "capabilities": initialization_capabilities(provider),
                "initializationOptions": initialization_options(provider),
            }),
        )?;
        reference_capability(&initialize)?;
        client.session.notify("initialized", json!({}))?;
        client.session.prepare_readiness()?;
        for document in documents {
            client.session.notify("textDocument/didOpen", json!({
                "textDocument": { "uri": document.uri, "languageId": language_id(document.language),
                    "version": 1, "text": document.source }
            }))?;
        }
        let readiness = client.session.wait_for_readiness(provider.id, documents)?;
        let response = client.session.request(
            "textDocument/references",
            json!({
                "textDocument": { "uri": documents[0].uri },
                "position": { "line": position.line, "character": position.character },
                "context": { "includeDeclaration": true }
            }),
        )?;
        Ok((parse_locations(&response)?, readiness))
    })();
    client.finish().map_err(QueryError::Failed)?;
    result
}

fn initialization_capabilities(provider: &LspProvider) -> Value {
    let mut capabilities = json!({
        "general": { "positionEncodings": ["utf-16"] },
        "offsetEncoding": ["utf-16"],
        "workspace": { "configuration": true, "workspaceFolders": true, "applyEdit": false },
        "textDocument": { "references": { "dynamicRegistration": false } },
        "experimental": { "serverStatusNotification": true }
    });
    if provider.id == "bash-language-server" {
        // bash-language-server awaits client configuration during initialized,
        // retaining only the last didOpen until that await resolves. Its
        // initialization options carry this session's read-only settings;
        // skipping optional configuration avoids losing the primed documents.
        capabilities["workspace"]
            .as_object_mut()
            .expect("workspace capabilities object")
            .remove("configuration");
    }
    capabilities
}

fn initialization_options(provider: &LspProvider) -> Value {
    if provider.id == "rust-analyzer" {
        json!({ "checkOnSave": false, "check": { "enable": false },
            "cargo": { "buildScripts": { "enable": false }, "extraArgs": ["--frozen"],
                "extraEnv": { "CARGO_NET_OFFLINE": "true", "RUSTUP_AUTO_INSTALL": "0" } },
            "procMacro": { "enable": false } })
    } else if provider.id == "bash-language-server" {
        // InitializationOptionsSchema takes these fields directly, unlike
        // workspace/configuration's enclosing bashIde section.
        json!({ "backgroundAnalysisMaxFiles": 0, "shellcheckPath": "",
            "shfmt": { "path": "" }, "enableSourceErrorDiagnostics": false,
            "explainshellEndpoint": "" })
    } else {
        Value::Null
    }
}

fn language_id(language: Language) -> &'static str {
    match language {
        Language::TypeScript => "typescript",
        Language::Tsx => "typescriptreact",
        Language::JavaScript => "javascript",
        Language::Jsx => "javascriptreact",
        Language::Rust => "rust",
        Language::Bash => "shellscript",
        _ => language.as_str(),
    }
}

type Outbound = (Value, SyncSender<std::result::Result<(), String>>);

struct LspClient {
    child: Option<Child>,
    session: LspSession,
    io_threads: Vec<thread::JoinHandle<()>>,
}

struct LspSession {
    writer: Option<SyncSender<Outbound>>,
    responses: Option<Receiver<std::result::Result<Value, String>>>,
    next_id: u64,
    deadline: Instant,
    workspace_folders: Value,
    ready: Readiness,
    configuration: Value,
}

#[derive(Default)]
struct Readiness {
    opened_documents: HashSet<String>,
    diagnostics: HashSet<String>,
    rust_busy_seen: bool,
    rust_quiescent: bool,
    rust_health: Option<String>,
}

impl LspClient {
    fn start(
        provider: &LspProvider,
        root_uri: &str,
        deadline: Instant,
    ) -> std::result::Result<Self, QueryError> {
        if Instant::now() >= deadline {
            return Err(QueryError::Failed(
                "LSP session timed out before starting its provider".into(),
            ));
        }
        let root = path_from_file_uri(root_uri)
            .ok_or_else(|| QueryError::Failed("invalid repository file URI".into()))?;
        let mut child = provider_process(provider)
            .current_dir(root)
            .args(provider.start_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                QueryError::Unavailable(if error.kind() == std::io::ErrorKind::NotFound {
                    format!("'{}' was not found on PATH", provider_command(provider))
                } else {
                    "the language server could not start".into()
                })
            })?;
        let Some(stdin) = child.stdin.take() else {
            let _ = terminate_process_tree(child, Instant::now() + CLEANUP_TIMEOUT);
            return Err(QueryError::Failed(
                "the language server did not expose stdin".into(),
            ));
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = terminate_process_tree(child, Instant::now() + CLEANUP_TIMEOUT);
            return Err(QueryError::Failed(
                "the language server did not expose stdout".into(),
            ));
        };
        let (sender, responses) = mpsc::sync_channel(4);
        let reader_thread = thread::spawn(move || read_responses(stdout, sender));
        let (writer, outgoing) = mpsc::sync_channel(1);
        let writer_thread = thread::spawn(move || write_requests(stdin, outgoing));
        Ok(Self {
            child: Some(child),
            io_threads: vec![reader_thread, writer_thread],
            session: LspSession {
                writer: Some(writer),
                responses: Some(responses),
                next_id: 1,
                deadline,
                workspace_folders: json!([{ "uri": root_uri, "name": "codefacts" }]),
                ready: Readiness::default(),
                configuration: if provider.id == "rust-analyzer" {
                    json!({ "rust-analyzer": initialization_options(provider) })
                } else {
                    Value::Null
                },
            },
        })
    }
}

impl LspSession {
    fn remaining(&self) -> std::result::Result<Duration, String> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err("LSP session timed out".into())
        } else {
            Ok(remaining)
        }
    }

    fn request(&mut self, method: &str, params: Value) -> std::result::Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            let remaining = self.remaining()?;
            let message = self
                .responses
                .as_ref()
                .ok_or("LSP session closed")?
                .recv_timeout(remaining)
                .map_err(|error| match error {
                    RecvTimeoutError::Timeout => format!("LSP session timed out during '{method}'"),
                    RecvTimeoutError::Disconnected => {
                        format!("LSP stream closed during '{method}'")
                    }
                })??;
            // Requests from the server have their own id namespace. They can
            // have the same numeric id as our outstanding client request.
            if message.get("method").is_some() {
                self.server_request(&message)?;
                continue;
            }
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                let code = error
                    .get("code")
                    .and_then(Value::as_i64)
                    .map_or(String::new(), |code| format!(" ({code})"));
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unspecified server error");
                let message = &message[..message.floor_char_boundary(512.min(message.len()))];
                return Err(format!(
                    "LSP request '{method}' returned an error{code}: {message}"
                ));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| format!("LSP request '{method}' returned no result"));
        }
    }

    fn server_request(&mut self, message: &Value) -> std::result::Result<(), String> {
        let Some(id) = message.get("id") else {
            match message.get("method").and_then(Value::as_str) {
                Some("textDocument/publishDiagnostics") => {
                    let params = &message["params"];
                    if params["diagnostics"].is_array()
                        && params
                            .get("version")
                            .is_none_or(|version| version.as_i64() == Some(1))
                    {
                        if let Some(uri) = params["uri"].as_str() {
                            if self.ready.opened_documents.contains(uri) {
                                self.ready.diagnostics.insert(uri.to_string());
                            }
                        }
                    }
                }
                Some("experimental/serverStatus") => {
                    let params = &message["params"];
                    if let Some(quiescent) = params["quiescent"].as_bool() {
                        self.ready.rust_busy_seen |= !quiescent;
                        self.ready.rust_quiescent = quiescent;
                        self.ready.rust_health = params["health"].as_str().map(str::to_owned);
                    }
                }
                _ => {}
            }
            return Ok(());
        };
        let response = match message.get("method").and_then(Value::as_str) {
            Some("workspace/configuration") => {
                let items = message["params"]["items"].as_array();
                let values = items
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| {
                                item["section"]
                                    .as_str()
                                    .and_then(|section| {
                                        section
                                            .split('.')
                                            .try_fold(&self.configuration, |value, key| {
                                                value.get(key)
                                            })
                                    })
                                    .cloned()
                                    .unwrap_or(Value::Null)
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                json!({ "jsonrpc": "2.0", "id": id, "result": values })
            }
            Some("workspace/workspaceFolders") => {
                json!({ "jsonrpc": "2.0", "id": id, "result": self.workspace_folders })
            }
            Some(
                "client/registerCapability"
                | "client/unregisterCapability"
                | "window/workDoneProgress/create",
            ) => {
                // Acknowledge protocol bookkeeping only. No edits, watchers,
                // commands or future dynamic providers are installed.
                json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null })
            }
            Some("workspace/applyEdit") => json!({ "jsonrpc": "2.0", "id": id, "result": {
                "applied": false, "failureReason": "CodeFacts LSP sessions are read-only"
            } }),
            _ => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not supported by read-only CodeFacts LSP client" } })
            }
        };
        self.send(response)
    }

    fn prepare_readiness(&mut self) -> std::result::Result<(), String> {
        // Discard already observed/queued initialization events before priming.
        // Bound draining so a noisy optional server cannot postpone didOpen.
        for _ in 0..16 {
            self.remaining()?;
            let message = match self
                .responses
                .as_ref()
                .ok_or("LSP session closed")?
                .try_recv()
            {
                Ok(message) => message?,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("LSP stream closed before document priming".into())
                }
            };
            if message.get("method").is_some() {
                self.server_request(&message)?;
            }
        }
        self.ready = Readiness::default();
        Ok(())
    }

    fn wait_for_readiness(
        &mut self,
        provider: &str,
        documents: &[LspDocument],
    ) -> std::result::Result<&'static str, String> {
        if !matches!(provider, "clangd" | "rust-analyzer") {
            return Ok("not_required");
        }
        self.ready.opened_documents = documents
            .iter()
            .map(|document| document.uri.clone())
            .collect();
        loop {
            if provider == "clangd"
                && documents
                    .iter()
                    .all(|document| self.ready.diagnostics.contains(&document.uri))
            {
                return Ok("opened_documents_diagnostics");
            }
            if provider == "rust-analyzer" && self.ready.rust_busy_seen && self.ready.rust_quiescent
            {
                if self.ready.rust_health.as_deref() == Some("ok") {
                    return Ok("observed_healthy_quiescence");
                }
                return Err("rust-analyzer reported a non-healthy quiescent workspace".into());
            }
            let message = self
                .responses
                .as_ref()
                .ok_or("LSP session closed")?
                .recv_timeout(self.remaining()?)
                .map_err(|error| match error {
                    RecvTimeoutError::Timeout => {
                        "LSP session timed out waiting for provider readiness".to_string()
                    }
                    RecvTimeoutError::Disconnected => {
                        "LSP stream closed before provider readiness".to_string()
                    }
                })??;
            if message.get("method").is_some() {
                self.server_request(&message)?;
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> std::result::Result<(), String> {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn send(&self, message: Value) -> std::result::Result<(), String> {
        let (sender, acknowledged) = mpsc::sync_channel(1);
        let mut outbound = (message, sender);
        loop {
            let remaining = self.remaining()?;
            match self
                .writer
                .as_ref()
                .ok_or("LSP session closed")?
                .try_send(outbound)
            {
                Ok(()) => break,
                Err(TrySendError::Disconnected(_)) => return Err("LSP writer closed".into()),
                Err(TrySendError::Full(value)) => {
                    outbound = value;
                    thread::sleep(remaining.min(Duration::from_millis(1)));
                }
            }
        }
        acknowledged
            .recv_timeout(self.remaining()?)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => "LSP session timed out while writing".to_string(),
                RecvTimeoutError::Disconnected => {
                    "LSP writer closed before acknowledging a message".to_string()
                }
            })?
    }
}

impl LspClient {
    fn finish(&mut self) -> std::result::Result<(), String> {
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        let process_result = self
            .child
            .take()
            .map_or(Ok(()), |child| terminate_process_tree(child, deadline));
        // Disconnect bounded I/O queues before waiting for threads: a reader
        // can otherwise be blocked sending a notification nobody will read.
        self.session.writer.take();
        self.session.responses.take();
        while self.io_threads.iter().any(|handle| !handle.is_finished())
            && Instant::now() < deadline
        {
            thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(1)),
            );
        }
        let mut threads_finished = true;
        for handle in self.io_threads.drain(..) {
            if handle.is_finished() {
                let _ = handle.join();
            } else {
                threads_finished = false;
            } // Detach instead of blocking Drop.
        }
        process_result?;
        if threads_finished {
            Ok(())
        } else {
            Err("LSP cleanup could not confirm I/O thread termination within its budget".into())
        }
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        // Never write protocol messages or join a blocked I/O thread in Drop.
        let _ = self.finish();
    }
}

fn reap_until(mut child: Child, deadline: Instant) -> std::result::Result<(), String> {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if Instant::now() < deadline => thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(1)),
            ),
            _ => {
                // Reaping a killed OS process can still be delayed. Keep that
                // wait off the query thread and report cleanup as incomplete.
                thread::spawn(move || {
                    let _ = child.wait();
                });
                return Err("LSP cleanup could not reap a process within its budget".into());
            }
        }
    }
}

fn terminate_process_tree(mut child: Child, deadline: Instant) -> std::result::Result<(), String> {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // SAFETY: Each child was placed in its own process group with the
        // child's pid as pgid. It has not been reaped here; a negative pid
        // targets that group, including ordinary language-server descendants.
        if let Ok(pid) = i32::try_from(child.id()) {
            unsafe {
                kill(-pid, 9);
            } // SIGKILL on supported Unix targets.
        }
    }
    #[cfg(windows)]
    let tree_result = {
        let mut command = Command::new("taskkill");
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut result =
            Err("LSP cleanup could not confirm Windows process-tree termination".to_string());
        if let Ok(mut killer) = command
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            loop {
                match killer.try_wait() {
                    Ok(Some(status)) => {
                        if status.success() {
                            result = Ok(());
                        }
                        break;
                    }
                    Ok(None) if Instant::now() < deadline => thread::sleep(
                        deadline
                            .saturating_duration_since(Instant::now())
                            .min(Duration::from_millis(1)),
                    ),
                    _ => {
                        let _ = killer.kill();
                        let _ = reap_until(killer, deadline);
                        break;
                    }
                }
            }
        }
        result
    };
    let _ = child.kill();
    let result = reap_until(child, deadline);
    #[cfg(windows)]
    tree_result?;
    result
}

fn write_requests(mut stdin: impl Write, outgoing: Receiver<Outbound>) {
    while let Ok((message, acknowledged)) = outgoing.recv() {
        let result = write_message(&mut stdin, &message)
            .map_err(|_| "could not write to language server".to_string());
        let failed = result.is_err();
        let _ = acknowledged.send(result);
        if failed {
            break;
        }
    }
}

fn read_responses(stdout: impl Read, sender: SyncSender<std::result::Result<Value, String>>) {
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
    if body.len() > MAX_MESSAGE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "LSP message exceeded the size limit",
        ));
    }
    write!(output, "Content-Length: {}\r\n\r\n", body.len())?;
    output.write_all(&body)?;
    output.flush()
}

fn read_header_line(
    reader: &mut impl BufRead,
    budget: usize,
) -> std::result::Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|_| "could not read LSP headers".to_string())?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("LSP stream ended before its header block finished".into())
            };
        }
        let count = available
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len() + count > budget {
            return Err("LSP headers exceeded the size limit".into());
        }
        let finished = available[count - 1] == b'\n';
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        if finished {
            return Ok(Some(line));
        }
    }
}

fn read_message(reader: &mut impl BufRead) -> std::result::Result<Option<Value>, String> {
    let mut content_length = None;
    let mut header_bytes = 0;
    loop {
        let Some(line) = read_header_line(reader, MAX_HEADER_BYTES - header_bytes)? else {
            return if header_bytes == 0 {
                Ok(None)
            } else {
                Err("LSP stream ended before its header block finished".into())
            };
        };
        header_bytes += line.len();
        let line =
            std::str::from_utf8(&line).map_err(|_| "LSP header was not UTF-8".to_string())?;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                if content_length.is_some() {
                    return Err("LSP message repeated Content-Length".into());
                }
                let length = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "LSP Content-Length was invalid".to_string())?;
                if length > MAX_MESSAGE_BYTES {
                    return Err("LSP message exceeded the size limit".into());
                }
                content_length = Some(length);
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

fn parse_locations(value: &Value) -> std::result::Result<Vec<LspLocation>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let values = value
        .as_array()
        .ok_or_else(|| "LSP references result was not an array or null".to_string())?;
    let mut locations = values
        .iter()
        .map(|value| {
            parse_location(value)
                .ok_or_else(|| "LSP references result contained an invalid location".to_string())
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    locations.sort_by(|a, b| {
        (
            &a.uri,
            a.start_line,
            a.start_character,
            a.end_line,
            a.end_character,
        )
            .cmp(&(
                &b.uri,
                b.start_line,
                b.start_character,
                b.end_line,
                b.end_character,
            ))
    });
    locations.dedup();
    Ok(locations)
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
    let location = LspLocation {
        uri,
        start_line: u32::try_from(start.get("line")?.as_u64()?).ok()?,
        start_character: u32::try_from(start.get("character")?.as_u64()?).ok()?,
        end_line: u32::try_from(end.get("line")?.as_u64()?).ok()?,
        end_character: u32::try_from(end.get("character")?.as_u64()?).ok()?,
    };
    ((location.start_line, location.start_character) <= (location.end_line, location.end_character))
        .then_some(location)
}

fn symbol_position(source: &str, node: &CodeNode) -> Option<LspPosition> {
    let start = tree_sitter::Point::new(
        usize::try_from(node.start_line.checked_sub(1)?).ok()?,
        usize::try_from(node.start_column).ok()?,
    );
    let end = tree_sitter::Point::new(
        usize::try_from(node.end_line.checked_sub(1)?).ok()?,
        usize::try_from(node.end_column).ok()?,
    );
    if start >= end {
        return None;
    }
    let lines: Vec<_> = source.split('\n').collect();
    lines.get(start.row)?.get(..start.column)?;
    lines.get(end.row)?.get(..end.column)?;
    // Reuse the same grammar/query as indexing. A receiver, return type or
    // decorator can spell the same name inside the AST range; textual search
    // cannot identify which token declared this particular symbol.
    let tree = CodeParser::new().parse(source, node.language).ok()?;
    let query = CodeParser::cached_query(node.language).ok()?;
    let names = query.capture_names();
    let mut cursor = tree_sitter::QueryCursor::new();
    cursor.set_point_range(start..end);
    let mut matches = cursor.matches(&query, tree.root_node(), source.as_bytes());
    let mut positions = HashSet::new();
    while let Some(matched) = matches.next() {
        if !matched.captures.iter().any(|capture| {
            names[capture.index as usize].starts_with("definition.")
                && capture.node.start_position() == start
                && capture.node.end_position() == end
        }) {
            continue;
        }
        for capture in matched.captures {
            if names[capture.index as usize] == "name"
                && capture.node.utf8_text(source.as_bytes()).ok()? == node.name
            {
                let point = capture.node.start_position();
                if start <= point && point < end {
                    positions.insert(capture.node.start_byte());
                }
            }
        }
    }
    if positions.len() != 1 {
        return None;
    }
    lsp_position_at_byte(source, positions.into_iter().next()?)
}

fn lsp_position_at_byte(source: &str, byte_offset: usize) -> Option<LspPosition> {
    let prefix = source.get(..byte_offset)?;
    let mut line = 0u32;
    let mut character = 0u32;
    let mut previous_cr = false;
    // LSP logical lines include lone CR. Tree-sitter rows only count LF,
    // so convert the accurate name capture's byte offset independently.
    for value in prefix.chars() {
        match value {
            '\r' => {
                line = line.checked_add(1)?;
                character = 0;
            }
            '\n' => {
                if !previous_cr {
                    line = line.checked_add(1)?;
                }
                character = 0;
            }
            _ => character = character.checked_add(value.len_utf16() as u32)?,
        }
        previous_cr = value == '\r';
    }
    Some(LspPosition { line, character })
}

fn path_to_file_uri(path: &Path) -> std::result::Result<String, String> {
    let path = path
        .canonicalize()
        .map_err(|_| "could not create a file URI for the repository".to_string())?;
    let path = path
        .to_str()
        .ok_or_else(|| "file URI requires a UTF-8 path".to_string())?;
    // Canonical Windows paths can be verbatim. UNC authorities are not part
    // of this local-only contract and must never become a fake /UNC/ path.
    #[cfg(windows)]
    let path = {
        if path.starts_with(r"\\?\UNC\") || path.starts_with(r"\\") && !path.starts_with(r"\\?\") {
            return Err("UNC file URIs are not supported".into());
        }
        path.strip_prefix(r"\\?\")
            .unwrap_or(path)
            .replace('\\', "/")
    };
    #[cfg(not(windows))]
    let path = path.to_string();
    let path = if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    };
    Ok(format!("file://{}", percent_encode_path(&path)))
}

pub fn path_from_file_uri(uri: &str) -> Option<PathBuf> {
    let path = uri.strip_prefix("file://")?;
    if !path.starts_with('/') || path.contains(['#', '?']) {
        return None;
    }
    let path = percent_decode(path)?;
    if path.contains('\0') {
        return None;
    }
    #[cfg(windows)]
    if path.starts_with("//") || path.starts_with(r"/\") {
        return None;
    }
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
            is_local: false,
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
        let source = "/* 😀 */ fn target() {}\n";
        let mut definition = node("target");
        definition.start_column = source.find("fn target").unwrap() as u32;
        definition.end_column = source.trim_end().len() as u32;
        let position = symbol_position(source, &definition).expect("symbol position");
        assert_eq!(position.line, 0);
        assert_eq!(position.character, 12);
    }

    #[test]
    fn semantic_position_counts_lone_cr_and_mixed_logical_lines() {
        for (source, expected_line, expected_character) in [
            ("fn a() {}\rfn target() {}", 1, 3),
            (
                "fn a() {}\nfn b() {}\r\nfn c() {}\r/* 😀 */ fn target() {}\n",
                3,
                12,
            ),
        ] {
            let definition =
                extracted_definition(source, Language::Rust, crate::types::NodeKind::Function);
            let position = symbol_position(source, &definition).expect("grammar name position");
            assert_eq!(position.line, expected_line, "{source:?}");
            assert_eq!(position.character, expected_character, "{source:?}");
        }
        assert!(lsp_position_at_byte("😀", 1).is_none());
    }

    #[test]
    fn location_parser_accepts_standard_locations_and_location_links() {
        let locations = parse_locations(&json!([
            {"uri":"file:///repo/lib.rs","range":{"start":{"line":1,"character":2},"end":{"line":1,"character":8}}},
            {"targetUri":"file:///repo/other.rs","targetSelectionRange":{"start":{"line":3,"character":0},"end":{"line":3,"character":4}}}
        ])).expect("valid reference locations");
        assert_eq!(locations.len(), 2);
        assert_eq!(locations[1].uri, "file:///repo/other.rs");
    }

    #[test]
    fn reference_order_is_independent_of_lsp_response_order() {
        let locations = json!([
            {"uri":"file:///repo/b.ts","range":{"start":{"line":1,"character":2},"end":{"line":1,"character":8}}},
            {"uri":"file:///repo/a.ts","range":{"start":{"line":3,"character":5},"end":{"line":3,"character":9}}},
            {"uri":"file:///repo/a.ts","range":{"start":{"line":3,"character":1},"end":{"line":3,"character":4}}}
        ]);
        let mut reordered = locations.as_array().unwrap().clone();
        reordered.reverse();
        let forward = parse_locations(&locations).expect("forward locations");
        let backward = parse_locations(&Value::Array(reordered)).expect("backward locations");
        let positions = |items: Vec<LspLocation>| {
            items
                .into_iter()
                .map(|loc| {
                    (
                        loc.uri,
                        loc.start_line,
                        loc.start_character,
                        loc.end_line,
                        loc.end_character,
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(positions(forward), positions(backward));
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
    #[test]
    fn provider_table_covers_the_six_optional_servers() {
        let manager = LspManager::new(LspMode::Auto);
        let report = manager.report(
            [
                Language::Rust,
                Language::TypeScript,
                Language::Tsx,
                Language::JavaScript,
                Language::Jsx,
                Language::Python,
                Language::Go,
                Language::C,
                Language::Cpp,
                Language::Bash,
                Language::Ruby,
            ],
            false,
        );
        assert_eq!(report.servers.len(), 6);
        assert_eq!(report.unsupported_languages, vec!["ruby"]);
        assert!(report
            .servers
            .iter()
            .all(|server| server.status == "deferred"));
        assert_eq!(
            provider_for(Language::Go).unwrap().probe_args,
            Some(&["version"][..])
        );
        assert!(provider_for(Language::Python).unwrap().probe_args.is_none());
        assert_eq!(language_id(Language::Bash), "shellscript");
        #[cfg(windows)]
        {
            assert_eq!(
                provider_command(provider_for(Language::Python).unwrap()),
                "pyright-langserver.cmd"
            );
            assert_eq!(
                provider_command(provider_for(Language::Bash).unwrap()),
                "bash-language-server.cmd"
            );
        }
    }

    #[test]
    fn initialize_requires_references_and_utf16() {
        for capabilities in [
            json!({}),
            json!({"referencesProvider":false}),
            json!({"referencesProvider":null}),
        ] {
            assert!(matches!(
                reference_capability(&json!({"capabilities":capabilities})),
                Err(QueryError::NotApplicable(_))
            ));
        }
        for supported in [json!(true), json!({"workDoneProgress":true})] {
            assert!(reference_capability(
                &json!({"capabilities":{"referencesProvider":supported}})
            )
            .is_ok());
        }
        for encoding in ["utf-8", "utf-32"] {
            assert!(reference_capability(
                &json!({"capabilities":{"referencesProvider":true,"positionEncoding":encoding}})
            )
            .is_err());
            assert!(reference_capability(
                &json!({"capabilities":{"referencesProvider":true},"offsetEncoding":encoding})
            )
            .is_err());
        }
        assert!(reference_capability(&json!({"capabilities":{"referencesProvider":true,"positionEncoding":"utf-16"},"offsetEncoding":"utf-16"})).is_ok());
    }

    fn mock_session(messages: Vec<Value>) -> (LspSession, std::sync::Arc<Mutex<Vec<Value>>>) {
        let captured = std::sync::Arc::new(Mutex::new(Vec::new()));
        let output = captured.clone();
        let (writer, outgoing) = mpsc::sync_channel::<Outbound>(1);
        thread::spawn(move || {
            while let Ok((message, acknowledged)) = outgoing.recv() {
                output.lock().unwrap().push(message);
                let _ = acknowledged.send(Ok(()));
            }
        });
        let (sender, responses) = mpsc::sync_channel(4);
        thread::spawn(move || {
            for message in messages {
                if sender.send(Ok(message)).is_err() {
                    break;
                }
            }
        });
        (
            LspSession {
                writer: Some(writer),
                responses: Some(responses),
                next_id: 1,
                deadline: Instant::now() + SESSION_TIMEOUT,
                workspace_folders: json!([{"uri":"file:///repo","name":"codefacts"}]),
                ready: Readiness::default(),
                configuration: Value::Null,
            },
            captured,
        )
    }

    #[test]
    fn server_requests_cannot_collide_with_client_responses_or_apply_edits() {
        let (mut session, captured) = mock_session(vec![
            json!({"jsonrpc":"2.0","id":1,"method":"workspace/configuration","params":{"items":[{"section":"python"},{}]}}),
            json!({"jsonrpc":"2.0","id":"folders","method":"workspace/workspaceFolders"}),
            json!({"jsonrpc":"2.0","id":"register","method":"client/registerCapability","params":{"registrations":[]}}),
            json!({"jsonrpc":"2.0","id":2,"method":"workspace/applyEdit","params":{"edit":{"changes":{}}}}),
            json!({"jsonrpc":"2.0","id":"command","method":"workspace/executeCommand"}),
            json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{}}),
            json!({"jsonrpc":"2.0","id":1,"result":{"capabilities":{"referencesProvider":true}}}),
        ]);
        let deadline = session.deadline;
        let result = session
            .request("initialize", json!({}))
            .expect("client initialize response");
        assert_eq!(result["capabilities"]["referencesProvider"], true);
        assert_eq!(
            session.deadline, deadline,
            "server requests must not reset the session budget"
        );
        let sent = captured.lock().unwrap();
        assert_eq!(sent.len(), 6);
        assert_eq!(sent[1]["id"], 1);
        assert_eq!(sent[1]["result"], json!([null, null]));
        assert_eq!(
            sent[2]["result"],
            json!([{"uri":"file:///repo","name":"codefacts"}])
        );
        assert!(sent[3]["result"].is_null());
        assert_eq!(sent[4]["result"]["applied"], false);
        assert_eq!(sent[5]["error"]["code"], -32601);
    }

    #[test]
    fn session_deadline_covers_blocked_writes_and_never_resets() {
        let (writer, _outgoing) = mpsc::sync_channel(1);
        let (_sender, responses) = mpsc::sync_channel(1);
        let session = LspSession {
            writer: Some(writer),
            responses: Some(responses),
            next_id: 1,
            deadline: Instant::now() + Duration::from_millis(10),
            workspace_folders: json!([]),
            ready: Readiness::default(),
            configuration: Value::Null,
        };
        assert!(session
            .notify("textDocument/didOpen", json!({}))
            .unwrap_err()
            .contains("timed out"));
        assert!(session
            .notify("initialized", json!({}))
            .unwrap_err()
            .contains("timed out"));
    }

    #[test]
    fn protocol_errors_are_not_empty_semantic_successes() {
        assert!(parse_locations(&json!({"locations":[]})).is_err());
        assert!(parse_locations(&json!([{"uri":"file:///repo/lib.rs","range":{"start":{"line":3,"character":1},"end":{"line":1,"character":2}}}])).is_err());
        assert!(parse_locations(&json!([{"uri":"file:///repo/lib.rs"}])).is_err());
        assert!(parse_locations(&Value::Null).unwrap().is_empty());
        for frame in [
            b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n[]".to_vec(),
            format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE_BYTES + 1).into_bytes(),
            vec![b'x'; MAX_HEADER_BYTES + 1],
            b"Content-Length: 1\r\n\r\n!".to_vec(),
        ] {
            assert!(read_message(&mut BufReader::new(Cursor::new(frame))).is_err());
        }
    }

    #[test]
    fn semantic_position_is_confined_to_the_ast_byte_range() {
        let source = "target(); /* 😀 */ fn target() {} target();\r\n";
        let mut definition = node("target");
        definition.start_column = source.find("fn target").unwrap() as u32;
        definition.end_column = source.find("{} ").unwrap() as u32 + 2;
        let position = symbol_position(source, &definition).expect("AST-contained definition");
        let expected_byte = source.find("fn target").unwrap() + 3;
        assert_eq!(
            position.character as usize,
            source[..expected_byte].encode_utf16().count()
        );
        definition.end_column = definition.start_column + 2;
        assert!(symbol_position(source, &definition).is_none());
        definition.start_column = 14; // Inside the emoji's UTF-8 encoding.
        assert!(symbol_position(source, &definition).is_none());
    }

    #[test]
    fn semantic_position_honors_multiline_end_columns() {
        let mut definition = node("target");
        definition.start_line = 2;
        definition.end_line = 3;
        definition.start_column = 0;
        definition.end_column = 1;
        assert!(symbol_position("target();\nfn other() {\n}  target();\n", &definition).is_none());
        assert!(symbol_position("target();\nfn target() {\n}  target();\n", &definition).is_some());
    }

    #[test]
    fn file_uri_special_characters_round_trip() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("a space # % é.rs");
        fs::write(&path, "").unwrap();
        let uri = path_to_file_uri(&path).unwrap();
        assert!(
            uri.contains("%20")
                && uri.contains("%23")
                && uri.contains("%25")
                && uri.contains("%C3%A9")
        );
        assert_eq!(
            path_from_file_uri(&uri).unwrap().canonicalize().unwrap(),
            path.canonicalize().unwrap()
        );
        for invalid in [
            "file:///bad%GG",
            "file:///bad%FF",
            "file:///bad%00",
            "file:///bad#fragment",
            "file:///bad?query",
        ] {
            assert!(path_from_file_uri(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn unix_file_uri_preserves_literal_backslashes() {
        let directory = tempdir().unwrap();
        let path = directory.path().join(r"literal\name.rs");
        fs::write(&path, "").unwrap();
        let uri = path_to_file_uri(&path).unwrap();
        assert!(uri.contains("literal%5Cname.rs"));
        assert_eq!(
            path_from_file_uri(&uri).unwrap(),
            path.canonicalize().unwrap()
        );
    }

    fn extracted_definition(
        source: &str,
        language: Language,
        kind: crate::types::NodeKind,
    ) -> CodeNode {
        let tree = CodeParser::new()
            .parse(source, language)
            .expect("fixture parses");
        crate::indexer::extractor::Extractor::extract_nodes(&tree, "fixture", language, source)
            .expect("fixture extraction")
            .into_iter()
            .find(|node| node.name == "target" && node.kind == kind)
            .expect("target definition")
    }

    #[test]
    fn definition_name_capture_disambiguates_receivers_types_and_decorators() {
        use crate::types::NodeKind;
        for (source, language, kind, token) in [
            ("package p\ntype T struct {}\nfunc (target *T) target() {}\n", Language::Go, NodeKind::Method, "target()"),
            ("typedef struct target target;\n", Language::C, NodeKind::TypeAlias, "target;"),
            ("struct target { int x; };\nstruct target target(void) { struct target value = {0}; return value; }\n", Language::C, NodeKind::Function, "target(void)"),
            ("class T { get target() { return 1; } }\n", Language::TypeScript, NodeKind::Method, "target()"),
            ("@target\ndef target():\n    pass\n", Language::Python, NodeKind::Function, "target():"),
        ] {
            let node = extracted_definition(source, language, kind);
            let position = symbol_position(source, &node).expect("unique grammar name capture");
            let offset = source.find(token).unwrap();
            let before = &source[..offset];
            assert_eq!(position.line as usize, before.bytes().filter(|&byte| byte == b'\n').count(), "{language}: {source}");
            assert_eq!(position.character as usize, before.rsplit('\n').next().unwrap().encode_utf16().count(), "{language}: {source}");
        }
        let source = "class T { get get() { return 1; } }\n";
        let tree = CodeParser::new()
            .parse(source, Language::TypeScript)
            .unwrap();
        let definition = crate::indexer::extractor::Extractor::extract_nodes(
            &tree,
            "fixture.ts",
            Language::TypeScript,
            source,
        )
        .unwrap()
        .into_iter()
        .find(|node| node.name == "get" && node.kind == NodeKind::Method)
        .unwrap();
        let position =
            symbol_position(source, &definition).expect("getter identifier, not keyword");
        assert_eq!(position.character as usize, source.find("get()").unwrap());
    }

    #[test]
    fn server_error_data_cannot_overflow_optional_semantic_messages() {
        let (mut session, _) = mock_session(vec![json!({
            "id":1,"error":{"code":-32603,"message":"é".repeat(2000),"data":"x".repeat(32_000)}
        })]);
        let error = session
            .request("textDocument/references", json!({}))
            .unwrap_err();
        assert!(
            error.len() < 640,
            "bounded optional error: {} bytes",
            error.len()
        );
        assert!(error.contains("-32603"));
        assert!(!error.contains("xxxxx"));
    }

    fn snapshot_file(root: &Path, name: &str, source: &str, hashes: &mut HashMap<String, String>) {
        fs::write(root.join(name), source).unwrap();
        hashes.insert(name.into(), hex::encode(Sha256::digest(source.as_bytes())));
    }

    fn python_snapshot_node(path: &str) -> CodeNode {
        let mut definition = node("target");
        definition.language = Language::Python;
        definition.file_path = path.into();
        definition
    }

    #[test]
    fn priming_uses_only_verified_indexed_provider_files_with_target_first() {
        let directory = tempdir().unwrap();
        let mut hashes = HashMap::new();
        snapshot_file(
            directory.path(),
            "z.py",
            "def target(): pass\n",
            &mut hashes,
        );
        snapshot_file(directory.path(), "a.py", "target()\n", &mut hashes);
        snapshot_file(directory.path(), "changed.py", "old", &mut hashes);
        fs::write(directory.path().join("changed.py"), "new").unwrap();
        snapshot_file(directory.path(), "other.rs", "fn target() {}", &mut hashes);
        fs::write(directory.path().join("not-indexed.py"), "target()").unwrap();
        let node = python_snapshot_node("z.py");
        let (documents, workspace) = workspace_documents(
            directory.path(),
            &node,
            provider_for(Language::Python).unwrap(),
            &hashes,
            Instant::now() + SESSION_TIMEOUT,
        )
        .unwrap();
        assert_eq!(workspace.indexed_files, 3);
        assert_eq!((workspace.loaded_files, workspace.omitted_files), (2, 1));
        assert!(workspace.partial);
        assert!(documents[0].uri.ends_with("/z.py"));
        assert!(documents[1].uri.ends_with("/a.py"));
        assert_eq!(
            workspace.loaded_bytes,
            documents.iter().map(|doc| doc.source.len()).sum::<usize>()
        );
        assert_eq!(workspace.mode, "bounded_indexed_snapshot");
    }

    #[test]
    fn priming_file_count_and_source_byte_limits_are_explicit() {
        let directory = tempdir().unwrap();
        let mut hashes = HashMap::new();
        snapshot_file(directory.path(), "zz-target.py", "target=1\n", &mut hashes);
        for index in 0..65 {
            snapshot_file(
                directory.path(),
                &format!("file-{index:02}.py"),
                "x=1\n",
                &mut hashes,
            );
        }
        let node = python_snapshot_node("zz-target.py");
        let (documents, scope) = workspace_documents(
            directory.path(),
            &node,
            provider_for(Language::Python).unwrap(),
            &hashes,
            Instant::now() + SESSION_TIMEOUT,
        )
        .unwrap();
        assert_eq!(
            (scope.indexed_files, scope.loaded_files, scope.omitted_files),
            (66, 64, 2)
        );
        assert!(scope.partial && documents[0].uri.ends_with("/zz-target.py"));
        assert_eq!((scope.max_files, scope.max_bytes), (64, 2 * 1024 * 1024));
        let large = "#".repeat(MAX_WORKSPACE_BYTES);
        hashes.clear();
        snapshot_file(directory.path(), "zz-target.py", &large, &mut hashes);
        snapshot_file(directory.path(), "a.py", "x", &mut hashes);
        let (_, scope) = workspace_documents(
            directory.path(),
            &node,
            provider_for(Language::Python).unwrap(),
            &hashes,
            Instant::now() + SESSION_TIMEOUT,
        )
        .unwrap();
        assert_eq!(
            (scope.loaded_files, scope.loaded_bytes, scope.omitted_files),
            (1, MAX_WORKSPACE_BYTES, 1)
        );
        assert!(scope.partial);
    }

    #[test]
    fn priming_never_omits_the_selected_file_or_uses_a_stale_snapshot() {
        let directory = tempdir().unwrap();
        let mut hashes = HashMap::new();
        let node = python_snapshot_node("target.py");
        let provider = provider_for(Language::Python).unwrap();
        assert!(workspace_documents(
            directory.path(),
            &node,
            provider,
            &hashes,
            Instant::now() + SESSION_TIMEOUT
        )
        .is_err());
        snapshot_file(directory.path(), "target.py", "old", &mut hashes);
        fs::write(directory.path().join("target.py"), "new").unwrap();
        assert!(workspace_documents(
            directory.path(),
            &node,
            provider,
            &hashes,
            Instant::now() + SESSION_TIMEOUT
        )
        .is_err());
        snapshot_file(
            directory.path(),
            "target.py",
            &"x".repeat(MAX_WORKSPACE_BYTES + 1),
            &mut hashes,
        );
        assert!(workspace_documents(
            directory.path(),
            &node,
            provider,
            &hashes,
            Instant::now() + SESSION_TIMEOUT
        )
        .is_err());
        assert!(
            workspace_documents(directory.path(), &node, provider, &hashes, Instant::now())
                .unwrap_err()
                .contains("timed out")
        );
        assert!(!LspManager::new(LspMode::Off).needs_indexed_snapshot(&node));
        assert!(LspManager::new(LspMode::Auto).needs_indexed_snapshot(&node));
    }

    #[test]
    #[cfg(unix)]
    fn priming_excludes_indexed_symlinks_that_escape_the_repository() {
        let directory = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let mut hashes = HashMap::new();
        snapshot_file(
            directory.path(),
            "target.py",
            "def target(): pass",
            &mut hashes,
        );
        fs::write(outside.path().join("outside.py"), "target()").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("outside.py"),
            directory.path().join("escape.py"),
        )
        .unwrap();
        hashes.insert("escape.py".into(), hex::encode(Sha256::digest(b"target()")));
        let (_, scope) = workspace_documents(
            directory.path(),
            &python_snapshot_node("target.py"),
            provider_for(Language::Python).unwrap(),
            &hashes,
            Instant::now() + SESSION_TIMEOUT,
        )
        .unwrap();
        assert_eq!((scope.loaded_files, scope.omitted_files), (1, 1));
        assert!(scope.partial);
    }

    fn ready_documents() -> Vec<LspDocument> {
        ["file:///repo/lib.c", "file:///repo/use.c"]
            .into_iter()
            .map(|uri| LspDocument {
                uri: uri.into(),
                language: Language::C,
                source: String::new(),
            })
            .collect()
    }

    #[test]
    fn clangd_readiness_requires_valid_diagnostics_for_each_opened_document() {
        let (mut session, _) = mock_session(vec![
            json!({"method":"textDocument/publishDiagnostics","params":{"uri":"file:///outside/noise.c","version":1,"diagnostics":[]}}),
            json!({"method":"textDocument/publishDiagnostics","params":{"uri":"file:///repo/lib.c","version":0,"diagnostics":[]}}),
            json!({"method":"textDocument/publishDiagnostics","params":{"uri":"file:///repo/use.c","version":1,"diagnostics":[]}}),
            json!({"method":"textDocument/publishDiagnostics","params":{"uri":"file:///repo/lib.c","diagnostics":[]}}),
        ]);
        assert_eq!(
            session
                .wait_for_readiness("clangd", &ready_documents())
                .unwrap(),
            "opened_documents_diagnostics"
        );
        assert_eq!(session.ready.diagnostics.len(), 2);
        assert!(!session
            .ready
            .diagnostics
            .contains("file:///outside/noise.c"));
        let (mut incomplete, _) = mock_session(vec![
            json!({"method":"textDocument/publishDiagnostics","params":{"uri":"file:///repo/lib.c","version":1,"diagnostics":[]}}),
        ]);
        assert!(incomplete
            .wait_for_readiness("clangd", &ready_documents())
            .is_err());
    }

    #[test]
    fn rust_readiness_requires_a_healthy_busy_to_quiescent_transition() {
        let (mut session, _) = mock_session(vec![
            json!({"method":"experimental/serverStatus","params":{"quiescent":true,"health":"ok"}}),
            json!({"method":"experimental/serverStatus","params":{"quiescent":false,"health":"ok"}}),
            json!({"method":"experimental/serverStatus","params":{"quiescent":true,"health":"ok"}}),
        ]);
        assert_eq!(
            session
                .wait_for_readiness("rust-analyzer", &ready_documents())
                .unwrap(),
            "observed_healthy_quiescence"
        );
        let (mut warning, _) = mock_session(vec![
            json!({"method":"experimental/serverStatus","params":{"quiescent":false,"health":"ok"}}),
            json!({"method":"experimental/serverStatus","params":{"quiescent":true,"health":"warning"}}),
        ]);
        assert!(warning
            .wait_for_readiness("rust-analyzer", &ready_documents())
            .unwrap_err()
            .contains("non-healthy"));
        let (mut no_busy, _) = mock_session(vec![
            json!({"method":"experimental/serverStatus","params":{"quiescent":true,"health":"ok"}}),
        ]);
        assert!(no_busy
            .wait_for_readiness("rust-analyzer", &ready_documents())
            .is_err());
    }

    #[test]
    fn rust_configuration_keeps_read_only_initialization_options() {
        let provider = provider_for(Language::Rust).unwrap();
        let options = initialization_options(provider);
        assert_eq!(options["checkOnSave"], false);
        assert_eq!(options["check"]["enable"], false);
        assert_eq!(options["cargo"]["buildScripts"]["enable"], false);
        assert_eq!(options["cargo"]["extraArgs"], json!(["--frozen"]));
        assert_eq!(options["procMacro"]["enable"], false);
        let (mut session, captured) = mock_session(Vec::new());
        session.configuration = json!({"rust-analyzer":options});
        session.server_request(&json!({"id":"config","method":"workspace/configuration","params":{"items":[{"section":"rust-analyzer"},{"section":"rust-analyzer.checkOnSave"},{"section":"unknown"}]}})).unwrap();
        let sent = captured.lock().unwrap();
        assert_eq!(sent[0]["result"][0], options);
        assert_eq!(sent[0]["result"][1], false);
        assert!(sent[0]["result"][2].is_null());
    }

    #[test]
    fn bash_initialization_uses_direct_options_without_async_configuration() {
        let provider = provider_for(Language::Bash).unwrap();
        let capabilities = initialization_capabilities(provider);
        assert!(capabilities["workspace"].get("configuration").is_none());
        assert_eq!(
            capabilities["general"]["positionEncodings"],
            json!(["utf-16"])
        );
        assert_eq!(capabilities["workspace"]["applyEdit"], false);
        for other in PROVIDERS.iter().filter(|other| other.id != provider.id) {
            assert_eq!(
                initialization_capabilities(other)["workspace"]["configuration"],
                true
            );
        }
        let options = initialization_options(provider);
        assert!(options.get("bashIde").is_none());
        assert_eq!(options["backgroundAnalysisMaxFiles"], 0);
        assert_eq!(options["shellcheckPath"], "");
        assert_eq!(options["shfmt"]["path"], "");
        assert_eq!(options["enableSourceErrorDiagnostics"], false);
        assert_eq!(options["explainshellEndpoint"], "");
    }

    #[test]
    fn initialization_readiness_is_reset_before_opening_documents() {
        let (mut session, _) = mock_session(Vec::new());
        session.ready.rust_busy_seen = true;
        session.ready.rust_quiescent = true;
        session.ready.rust_health = Some("ok".into());
        session
            .ready
            .diagnostics
            .insert("file:///repo/lib.c".into());
        // Keep a sender alive while the bounded drain sees an empty queue.
        let (_sender, responses) = mpsc::sync_channel(1);
        session.responses = Some(responses);
        session.prepare_readiness().unwrap();
        assert!(!session.ready.rust_busy_seen && !session.ready.rust_quiescent);
        assert!(session.ready.diagnostics.is_empty() && session.ready.rust_health.is_none());
    }
}
