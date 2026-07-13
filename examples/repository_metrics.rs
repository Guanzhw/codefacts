//! Reproducible repository-level CodeFacts performance measurements.
//!
//! This development example is intentionally separate from the deployed MCP
//! binary. It writes no state into the target repository: all SQLite files and
//! one-file-change fixtures live in RAII-managed temporary directories.
//!
//! Run with:
//! `cargo run --release --example repository_metrics -- --root <repo> --codefacts-bin <release-codefacts-binary> --samples 20 --output <report.json>`

use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use codefacts::indexer::parser::CodeParser;
use codefacts::service::CodeFacts;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sysinfo::{get_current_pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tempfile::{Builder, TempDir};

const DEFAULT_QUERIES: &str = include_str!("../benchmarks/queries.json");
const COPY_SKIP_DIRECTORIES: &[&str] = &[
    ".git",
    "node_modules",
    "vendor",
    "third_party",
    "__pycache__",
    ".venv",
    "venv",
    "target",
    "build",
    "dist",
    ".next",
    ".nuxt",
    ".output",
    ".cache",
];
const MAX_INDEXABLE_FILE_SIZE: u64 = 2 * 1024 * 1024;

type BenchResult<T> = Result<T, Box<dyn Error>>;

#[derive(Debug)]
struct Arguments {
    root: PathBuf,
    codefacts_bin: PathBuf,
    output: Option<PathBuf>,
    queries: Option<PathBuf>,
    samples: usize,
}

#[derive(Debug, Deserialize)]
struct QueryFile {
    schema_version: u32,
    queries: Vec<BenchmarkQuery>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct BenchmarkQuery {
    name: String,
    query: String,
}

#[derive(Debug, Serialize)]
struct BenchReport {
    schema_version: u32,
    repository: String,
    platform: Platform,
    samples_per_metric: usize,
    cold_index: TimingSummary,
    no_change_refresh: TimingSummary,
    one_file_refresh: OneFileRefresh,
    sqlite_after_cold_index: DatabaseSize,
    peak_process_memory: PeakMemory,
    mcp_search: McpSearchMetrics,
    notes: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
struct Platform {
    operating_system: &'static str,
    architecture: &'static str,
    available_parallelism: Option<usize>,
}

#[derive(Debug, Serialize)]
struct TimingSummary {
    samples: usize,
    min_ms: f64,
    median_ms: f64,
    p95_ms: f64,
    max_ms: f64,
}

#[derive(Debug, Serialize)]
struct OneFileRefresh {
    timing: TimingSummary,
    copied_regular_files: usize,
    copied_indexable_file_candidates: usize,
    indexed_files_after_change: usize,
    note: &'static str,
}

#[derive(Debug, Serialize)]
struct DatabaseSize {
    total_bytes: u64,
    files: Vec<DatabaseFile>,
}

#[derive(Debug, Serialize)]
struct DatabaseFile {
    name: String,
    bytes: u64,
}

#[derive(Debug)]
struct CopyStats {
    regular_files: usize,
    indexable_file_candidates: usize,
}

#[derive(Debug, Serialize)]
struct PeakMemory {
    bytes: Option<u64>,
    semantics: &'static str,
}

#[derive(Debug, Serialize)]
struct McpSearchMetrics {
    server_binary: String,
    first_request: FirstRequest,
    warm_requests: Vec<QueryTiming>,
    note: &'static str,
}

#[derive(Debug, Serialize)]
struct FirstRequest {
    query_name: String,
    query: String,
    duration_ms: f64,
}

#[derive(Debug, Serialize)]
struct QueryTiming {
    name: String,
    query: String,
    timing: TimingSummary,
}

fn main() -> BenchResult<()> {
    let arguments = parse_arguments()?;
    let root = arguments.root.canonicalize()?;
    if !root.is_dir() {
        return Err(error(format!(
            "--root is not a directory: {}",
            root.display()
        )));
    }
    if !arguments.codefacts_bin.is_file() {
        return Err(error(format!(
            "--codefacts-bin must point to a release CodeFacts executable: {}",
            arguments.codefacts_bin.display()
        )));
    }

    let queries = load_queries(arguments.queries.as_deref())?;
    let sampler = PeakMemorySampler::start();
    let (cold_index, sqlite_after_cold_index) = measure_cold_index(&root, arguments.samples)?;
    let no_change_refresh = measure_no_change_refresh(&root, arguments.samples)?;
    let one_file_refresh = measure_one_file_refresh(&root, arguments.samples)?;
    let mcp_search =
        measure_mcp_search(&root, &arguments.codefacts_bin, &queries, arguments.samples)?;
    let peak_process_memory = sampler.stop();

    let report = BenchReport {
        schema_version: 1,
        repository: root.to_string_lossy().into_owned(),
        platform: Platform {
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            available_parallelism: thread::available_parallelism().ok().map(usize::from),
        },
        samples_per_metric: arguments.samples,
        cold_index,
        no_change_refresh,
        one_file_refresh,
        sqlite_after_cold_index,
        peak_process_memory,
        mcp_search,
        notes: vec![
            "Cold indexing uses a new external SQLite database for every sample; filesystem caches are not forcibly dropped.",
            "One-file refresh is measured in an ignored-file-respecting temporary copy and does not alter the target repository.",
            "Warm MCP requests include the no-change refresh required by the public CodeFacts contract.",
        ],
    };
    let rendered = serde_json::to_string_pretty(&report)?;
    match arguments.output {
        Some(path) => fs::write(path, rendered)?,
        None => println!("{rendered}"),
    }
    Ok(())
}

fn parse_arguments() -> BenchResult<Arguments> {
    let mut arguments = std::env::args_os().skip(1);
    let mut root = None;
    let mut codefacts_bin = None;
    let mut output = None;
    let mut queries = None;
    let mut samples = 10;

    while let Some(argument) = arguments.next() {
        match argument.to_string_lossy().as_ref() {
            "--root" => root = Some(next_path(&mut arguments, "--root")?),
            "--codefacts-bin" => {
                codefacts_bin = Some(next_path(&mut arguments, "--codefacts-bin")?)
            }
            "--output" => output = Some(next_path(&mut arguments, "--output")?),
            "--queries" => queries = Some(next_path(&mut arguments, "--queries")?),
            "--samples" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| error("--samples requires a positive integer"))?;
                samples = value
                    .to_string_lossy()
                    .parse()
                    .map_err(|_| error("--samples requires a positive integer"))?;
            }
            "--help" | "-h" => return Err(error(usage())),
            other => return Err(error(format!("unknown argument '{other}'.\n{}", usage()))),
        }
    }

    if samples < 3 {
        return Err(error("--samples must be at least 3 so P95 is meaningful"));
    }
    Ok(Arguments {
        root: root.ok_or_else(|| error(format!("--root is required\n{}", usage())))?,
        codefacts_bin: codefacts_bin
            .ok_or_else(|| error(format!("--codefacts-bin is required\n{}", usage())))?,
        output,
        queries,
        samples,
    })
}

fn next_path(
    arguments: &mut impl Iterator<Item = std::ffi::OsString>,
    name: &str,
) -> BenchResult<PathBuf> {
    arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| error(format!("{name} requires a path")))
}

fn usage() -> &'static str {
    "Usage: cargo run --release --example repository_metrics -- --root <repository> --codefacts-bin <release-codefacts-binary> [--samples <count>] [--queries <query-config.json>] [--output <report.json>]"
}

fn load_queries(path: Option<&Path>) -> BenchResult<Vec<BenchmarkQuery>> {
    let source = match path {
        Some(path) => fs::read_to_string(path)?,
        None => DEFAULT_QUERIES.to_string(),
    };
    let query_file: QueryFile = serde_json::from_str(&source)?;
    if query_file.schema_version != 1 {
        return Err(error(format!(
            "unsupported benchmark query schema version {}",
            query_file.schema_version
        )));
    }
    if query_file.queries.is_empty()
        || query_file
            .queries
            .iter()
            .any(|query| query.name.trim().is_empty() || query.query.trim().is_empty())
    {
        return Err(error(
            "benchmark queries need non-empty names and query strings",
        ));
    }
    Ok(query_file.queries)
}

fn measure_cold_index(root: &Path, samples: usize) -> BenchResult<(TimingSummary, DatabaseSize)> {
    let temporary = short_tempdir()?;
    let mut durations = Vec::with_capacity(samples);
    let mut first_database_size = None;

    for sample in 0..samples {
        let state = temporary.path().join(format!("cold-{sample}.sqlite"));
        let facts = CodeFacts::open(root, &state)?;
        let started = Instant::now();
        let _ = facts.map()?;
        durations.push(started.elapsed());
        if first_database_size.is_none() {
            first_database_size = Some(database_size(&state)?);
        }
    }

    Ok((
        summarize(&durations),
        first_database_size.expect("at least one cold-index sample"),
    ))
}

fn measure_no_change_refresh(root: &Path, samples: usize) -> BenchResult<TimingSummary> {
    let temporary = short_tempdir()?;
    let facts = CodeFacts::open(root, temporary.path().join("steady.sqlite"))?;
    let _ = facts.map()?;
    measure_samples(samples, || {
        let _ = facts.refresh()?;
        Ok(())
    })
}

fn measure_one_file_refresh(root: &Path, samples: usize) -> BenchResult<OneFileRefresh> {
    let mut durations = Vec::with_capacity(samples);
    let mut copied_regular_files = None;
    let mut copied_indexable_file_candidates = None;
    let mut indexed_files_after_change = None;

    for _ in 0..samples {
        let temporary = short_tempdir()?;
        let copy_root = temporary.path().join("r");
        let copied = copy_repository(root, &copy_root)?;
        let changed_file = first_supported_file(&copy_root)?;
        let facts = CodeFacts::open(&copy_root, temporary.path().join("change.sqlite"))?;
        let _ = facts.map()?;
        OpenOptions::new()
            .append(true)
            .open(changed_file)?
            .write_all(b"\n// codefacts benchmark source change\n")?;
        let started = Instant::now();
        let refreshed = facts.refresh()?;
        durations.push(started.elapsed());
        if refreshed.files_indexed == 0 {
            return Err(error(
                "one-file benchmark change was not detected by the index",
            ));
        }
        copied_regular_files.get_or_insert(copied.regular_files);
        copied_indexable_file_candidates.get_or_insert(copied.indexable_file_candidates);
        indexed_files_after_change.get_or_insert(refreshed.files_indexed);
    }

    Ok(OneFileRefresh {
        timing: summarize(&durations),
        copied_regular_files: copied_regular_files.expect("at least one one-file sample"),
        copied_indexable_file_candidates: copied_indexable_file_candidates
            .expect("at least one one-file sample"),
        indexed_files_after_change: indexed_files_after_change
            .expect("at least one one-file sample"),
        note: "Any source change triggers a complete static relationship rebind; this is not a cheap per-file update.",
    })
}

fn measure_mcp_search(
    root: &Path,
    codefacts_bin: &Path,
    queries: &[BenchmarkQuery],
    samples: usize,
) -> BenchResult<McpSearchMetrics> {
    let temporary = short_tempdir()?;
    let mut client = McpClient::start(codefacts_bin, root, &temporary.path().join("mcp.sqlite"))?;
    client.initialize()?;

    let first_query = &queries[0];
    let first_request = FirstRequest {
        query_name: first_query.name.clone(),
        query: first_query.query.clone(),
        duration_ms: client.search(&first_query.query)?.as_secs_f64() * 1_000.0,
    };

    let mut warm_requests = Vec::with_capacity(queries.len());
    for query in queries {
        let timing = measure_samples(samples, || {
            let _ = client.search(&query.query)?;
            Ok(())
        })?;
        warm_requests.push(QueryTiming {
            name: query.name.clone(),
            query: query.query.clone(),
            timing,
        });
    }
    client.finish()?;

    Ok(McpSearchMetrics {
        server_binary: codefacts_bin.to_string_lossy().into_owned(),
        first_request,
        warm_requests,
        note: "First request includes initial indexing. Warm requests use one persistent stdio server and include the public no-change refresh before FTS search.",
    })
}

fn measure_samples(
    samples: usize,
    mut operation: impl FnMut() -> BenchResult<()>,
) -> BenchResult<TimingSummary> {
    let mut durations = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = Instant::now();
        operation()?;
        durations.push(started.elapsed());
    }
    Ok(summarize(&durations))
}

fn summarize(durations: &[Duration]) -> TimingSummary {
    let mut milliseconds: Vec<f64> = durations
        .iter()
        .map(|duration| duration.as_secs_f64() * 1_000.0)
        .collect();
    milliseconds.sort_by(f64::total_cmp);
    let p95_index = ((milliseconds.len() as f64 * 0.95).ceil() as usize).saturating_sub(1);
    TimingSummary {
        samples: milliseconds.len(),
        min_ms: milliseconds[0],
        median_ms: milliseconds[(milliseconds.len() - 1) / 2],
        p95_ms: milliseconds[p95_index],
        max_ms: *milliseconds.last().expect("non-empty duration set"),
    }
}

fn database_size(state: &Path) -> BenchResult<DatabaseSize> {
    let mut files = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let path = PathBuf::from(format!("{}{}", state.display(), suffix));
        if let Ok(metadata) = fs::metadata(&path) {
            files.push(DatabaseFile {
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string(),
                bytes: metadata.len(),
            });
        }
    }
    Ok(DatabaseSize {
        total_bytes: files.iter().map(|file| file.bytes).sum(),
        files,
    })
}

fn copy_repository(source: &Path, destination: &Path) -> BenchResult<CopyStats> {
    let walker = WalkBuilder::new(source)
        .standard_filters(true)
        .filter_entry(|entry| {
            if entry
                .file_type()
                .is_some_and(|file_type| file_type.is_dir())
            {
                if let Some(name) = entry.file_name().to_str() {
                    return !COPY_SKIP_DIRECTORIES.contains(&name);
                }
            }
            true
        })
        .build();

    let mut copied = CopyStats {
        regular_files: 0,
        indexable_file_candidates: 0,
    };
    for entry in walker {
        let entry = entry?;
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }
        let relative = entry.path().strip_prefix(source)?;
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(entry.path(), target)?;
        copied.regular_files += 1;
        if CodeParser::is_supported(&entry.path().to_string_lossy())
            && fs::metadata(entry.path())
                .is_ok_and(|metadata| metadata.len() <= MAX_INDEXABLE_FILE_SIZE)
        {
            copied.indexable_file_candidates += 1;
        }
    }
    Ok(copied)
}

fn first_supported_file(root: &Path) -> BenchResult<PathBuf> {
    let walker = WalkBuilder::new(root)
        .standard_filters(true)
        .filter_entry(|entry| {
            if entry
                .file_type()
                .is_some_and(|file_type| file_type.is_dir())
            {
                if let Some(name) = entry.file_name().to_str() {
                    return !COPY_SKIP_DIRECTORIES.contains(&name);
                }
            }
            true
        })
        .build();
    for entry in walker {
        let entry = entry?;
        let path = entry.path();
        if entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
            && CodeParser::is_supported(&path.to_string_lossy())
        {
            return Ok(path.to_path_buf());
        }
    }
    Err(error(
        "repository has no supported source or Markdown file to mutate",
    ))
}

fn short_tempdir() -> io::Result<TempDir> {
    Builder::new().prefix("cfb-").tempdir()
}

struct McpClient {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl McpClient {
    fn start(codefacts_bin: &Path, root: &Path, state: &Path) -> BenchResult<Self> {
        let mut child = Command::new(codefacts_bin)
            .args(["mcp", "--root"])
            .arg(root)
            .args(["--state"])
            .arg(state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| error("could not open CodeFacts stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| error("could not open CodeFacts stdout"))?;
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    fn initialize(&mut self) -> BenchResult<()> {
        let id = self.next_request_id();
        let _ = self.request(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": { "protocolVersion": "2024-11-05", "capabilities": {} }
        }))?;
        Ok(())
    }

    fn search(&mut self, query: &str) -> BenchResult<Duration> {
        let started = Instant::now();
        let id = self.next_request_id();
        let response = self.request(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": "search", "arguments": { "query": query } }
        }))?;
        if response
            .get("result")
            .and_then(|result| result.get("isError"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(error(format!("MCP search returned an error: {response}")));
        }
        Ok(started.elapsed())
    }

    fn request(&mut self, request: Value) -> BenchResult<Value> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| error("MCP client stdin is closed"))?;
        writeln!(stdin, "{request}")?;
        stdin.flush()?;

        let mut response = String::new();
        if self.stdout.read_line(&mut response)? == 0 {
            return Err(error("CodeFacts MCP server closed stdout before replying"));
        }
        let response: Value = serde_json::from_str(&response)?;
        if let Some(error_value) = response.get("error") {
            return Err(error(format!("MCP JSON-RPC error: {error_value}")));
        }
        Ok(response)
    }

    fn next_request_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn finish(mut self) -> BenchResult<()> {
        drop(self.stdin.take());
        let status = self.child.wait()?;
        if !status.success() {
            return Err(error(format!("CodeFacts MCP exited with {status}")));
        }
        Ok(())
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct PeakMemorySampler {
    running: Arc<AtomicBool>,
    peak_bytes: Arc<AtomicU64>,
    handle: JoinHandle<()>,
}

impl PeakMemorySampler {
    fn start() -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let peak_bytes = Arc::new(AtomicU64::new(0));
        let thread_running = Arc::clone(&running);
        let thread_peak_bytes = Arc::clone(&peak_bytes);
        let handle = thread::spawn(move || {
            let Ok(pid) = get_current_pid() else {
                return;
            };
            let pids = [pid];
            let mut system = System::new();
            loop {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&pids),
                    false,
                    ProcessRefreshKind::nothing().with_memory(),
                );
                if let Some(process) = system.process(pid) {
                    thread_peak_bytes.fetch_max(process.memory(), Ordering::Relaxed);
                }
                if !thread_running.load(Ordering::Relaxed) {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
        });
        Self {
            running,
            peak_bytes,
            handle,
        }
    }

    fn stop(self) -> PeakMemory {
        self.running.store(false, Ordering::Relaxed);
        let _ = self.handle.join();
        let bytes = self.peak_bytes.load(Ordering::Relaxed);
        PeakMemory {
            bytes: (bytes > 0).then_some(bytes),
            semantics: "Sampled benchmark-process resident memory; on Windows this is working-set-like resident memory. The spawned MCP server is not included.",
        }
    }
}

fn error(message: impl Into<String>) -> Box<dyn Error> {
    io::Error::other(message.into()).into()
}

#[cfg(test)]
mod tests {
    use super::summarize;
    use std::time::Duration;

    #[test]
    fn summary_uses_nearest_rank_p95() {
        let durations = (1..=20).map(Duration::from_millis).collect::<Vec<_>>();
        let summary = summarize(&durations);
        assert_eq!(summary.median_ms, 10.0);
        assert_eq!(summary.p95_ms, 19.0);
    }
}
