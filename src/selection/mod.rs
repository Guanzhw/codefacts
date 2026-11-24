//! Source selection with the two published navigation policies.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::{Builder, TempDir};

mod backend;
mod excerpt;
mod features;
mod policy;

use backend::{menu_text, Backend, Location};
use policy::{Mode, Origin, Page, Policy, PolicyName, Row};

const EVIDENCE_BYTES: usize = 4_200;
const MENU_BYTES: usize = 2_000;
const READ_BYTES: usize = 1_500;
const SEARCH_BYTES: usize = 600;

/// Select up to two verified source excerpts without writing to the source root.
pub fn select(root: &Path, query: &str, symptom: &str, policy: &str) -> Result<Value, String> {
    let policy: PolicyName = policy.parse()?;
    let query = normalize_whitespace(query);
    if !valid_query(&query) {
        return Err("expected a searchable initial query".into());
    }
    let symptom_display = normalize_whitespace(symptom);
    if symptom_display.is_empty() {
        return Err("expected a nonempty symptom".into());
    }
    let symptom_line = format!("Observed behavior: {symptom_display}\n");
    let search_bytes = "Search: \n".len() + query.len();
    if search_bytes > MENU_BYTES || symptom_line.len() + search_bytes > EVIDENCE_BYTES {
        return Err("the symptom and search heading exceed the evidence budget".into());
    }

    let started = Instant::now();
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("selection root must be a directory".into());
    }
    let index = temporary_index(&root)?;
    let backend = Backend::open(&root, &index.path().join("index.sqlite"))
        .map_err(|error| error.to_string())?;
    let (menu, initial) = render_menu(
        &backend,
        &query,
        false,
        &BTreeMap::new(),
        EVIDENCE_BYTES - symptom_line.len(),
        MENU_BYTES,
        Origin::Initial,
    )?;
    let (selected, decisions) = Policy::choose(policy, &initial);
    let start = symptom_line + &menu;
    let mut routing = json!({
        "gate": decisions[0].gate,
        "branch": decisions[0].branch,
        "action": "start",
        "mode": "legacy-baseline",
        "bytes": start.len(),
        "stream_sha256": stream_digest(&start),
        "elapsed_seconds": started.elapsed().as_secs_f64(),
    });
    if matches!(policy, PolicyName::Candidate) {
        routing["path"] = json!(decisions);
    }

    let mut session = Session {
        backend,
        steps: vec![json!({"action": "start", "bytes": start.len(), "accepted": true})],
        evidence: start,
        pages: Vec::new(),
    };
    let first = selected
        .first_rows(&initial, symptom)
        .into_iter()
        .find_map(|row| {
            let offset = selected.first_start(row);
            session.read(row, offset).map(|page| (row, page, offset))
        });
    if let Some((row, page, offset)) = first.filter(|_| session.remaining() > 0) {
        let companion = selected
            .constructor_read(&initial, row, &page, symptom)
            .and_then(|(row, start)| session.read(row, start));
        if companion.is_none() && session.remaining() > 0 {
            let context = selected.context(&page, offset);
            let additional = selected
                .followup_term(&context, &query, symptom, session.remaining())
                .map(|term| session.search(&term, selected.mode(), &initial))
                .unwrap_or_default();
            if session.remaining() > 0 {
                for (candidate, start) in
                    selected.second_reads(&initial, &additional, &context, symptom, row, offset)
                {
                    if session.read(candidate, start).is_some() {
                        break;
                    }
                }
            }
        }
    }

    Ok(json!({
        "symptom": symptom,
        "query": query,
        "evidence": session.evidence,
        "pages": session.pages,
        "bytes": session.evidence.len(),
        "elapsed_seconds": started.elapsed().as_secs_f64(),
        "steps": session.steps,
        "stream_sha256": stream_digest(&session.evidence),
        "mode": selected.mode().as_str(),
        "routing": routing,
    }))
}

struct Session {
    backend: Backend,
    evidence: String,
    pages: Vec<String>,
    steps: Vec<Value>,
}

impl Session {
    fn remaining(&self) -> usize {
        EVIDENCE_BYTES - self.evidence.len()
    }

    fn read(&mut self, row: &Row, start: Option<usize>) -> Option<Page> {
        let mut step = json!({"action": "read", "id": row.number});
        if let Some(start) = start {
            step["start_line"] = json!(start);
        }
        let result = row_location(row).and_then(|location| {
            excerpt::read(
                &self.backend,
                &location,
                row.number,
                start,
                self.remaining().min(READ_BYTES),
            )
        });
        step["accepted"] = json!(result.is_some());
        step["bytes"] = json!(result.as_ref().map_or(0, |(text, _)| text.len()));
        self.steps.push(step);
        result.map(|(text, page)| {
            self.evidence.push_str(&text);
            self.pages.push(text);
            page
        })
    }

    fn search(&mut self, term: &str, mode: Mode, initial: &[Row]) -> Vec<Row> {
        let known = initial
            .iter()
            .filter_map(|row| row_location(row).map(|location| (row.number, location)))
            .collect();
        let result = render_menu(
            &self.backend,
            term,
            matches!(mode, Mode::ExpandedSymbol),
            &known,
            self.remaining(),
            SEARCH_BYTES,
            Origin::Search,
        );
        self.steps.push(json!({
            "action": "search",
            "term": term,
            "accepted": result.is_ok(),
            "bytes": result.as_ref().map_or(0, |(text, _)| text.len()),
        }));
        result.map_or_else(
            |_| Vec::new(),
            |(text, rows)| {
                self.evidence.push_str(&text);
                rows
            },
        )
    }
}

fn render_menu(
    backend: &Backend,
    query: &str,
    symbol: bool,
    known: &BTreeMap<usize, Location>,
    budget: usize,
    cap: usize,
    origin: Origin,
) -> Result<(String, Vec<Row>), String> {
    let cards = backend
        .candidates(query, symbol)
        .map_err(|error| error.to_string())?;
    let (menu, rows) = menu_text(cards, query, known, budget, cap, origin)?;
    for row in &rows {
        if let Some(path) = &row.path {
            backend
                .validate_source(path)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok((menu, rows))
}

fn row_location(row: &Row) -> Option<Location> {
    Some(Location {
        path: row.path.clone()?,
        start: row.low?.try_into().ok()?,
        end: row.high?.try_into().ok()?,
    })
}

fn stream_digest(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

// Python's split() also treats the four ASCII information separators as whitespace.
fn normalize_whitespace(text: &str) -> String {
    text.split(|ch: char| ch.is_whitespace() || ('\u{001c}'..='\u{001f}').contains(&ch))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn valid_query(query: &str) -> bool {
    let mut bytes = query.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"_ :.+/<>,#-".contains(&byte))
}

fn temporary_index(root: &Path) -> Result<TempDir, String> {
    let system_temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let parent = if system_temp.starts_with(root) {
        root.parent()
            .ok_or("no temporary index location outside the selection root")?
    } else {
        &system_temp
    };
    let mut builder = Builder::new();
    builder.prefix("codefacts-select-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder
        .tempdir_in(parent)
        .map_err(|error| error.to_string())
}
