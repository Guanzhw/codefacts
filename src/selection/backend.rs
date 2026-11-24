//! Adapter for the evidence visible to the published navigation policies.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path};

use serde::Deserialize;

use super::normalize_whitespace;
use super::policy::{Origin, Row};
use crate::error::{CodeFactsError, Result};
use crate::lsp::LspMode;
use crate::service::{CodeFacts, ExploreOptions, ExploreRead, SymbolScope};

const EXPLORE_BYTES: usize = 32_000;
const SYMBOL_LIMIT: usize = 50;
const MENU_ROWS: usize = 28;
const EMPTY_MENU: &str = "No selectable results.\n";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct Location {
    pub path: String,
    pub start: u32,
    pub end: u32,
}

pub(super) struct Candidate {
    location: Location,
    label: String,
}

pub(super) struct Backend {
    facts: CodeFacts,
}

#[derive(Deserialize)]
struct SymbolPage {
    results: Vec<Symbol>,
}

#[derive(Deserialize)]
struct Symbol {
    name: String,
    qualified_name: Option<String>,
    kind: String,
    evidence: SymbolEvidence,
}

#[derive(Deserialize)]
struct SymbolEvidence {
    file_path: String,
    start_line: u32,
    end_line: u32,
}

impl Backend {
    pub fn open(repo: &Path, index: &Path) -> Result<Self> {
        let facts = CodeFacts::open_with_lsp(repo, index, LspMode::Off)?;
        Ok(Self { facts })
    }

    pub fn candidates(&self, query: &str, symbol: bool) -> Result<Vec<Candidate>> {
        if symbol {
            let page: SymbolPage =
                serde_json::from_value(self.facts.search_with_page_scope_options(
                    query,
                    None,
                    None,
                    SymbolScope::All,
                    0,
                    None,
                    Some(SYMBOL_LIMIT),
                )?)?;
            let cards: Vec<_> = page
                .results
                .into_iter()
                .filter_map(|entry| {
                    let evidence = entry.evidence;
                    let location =
                        location(evidence.file_path, evidence.start_line, evidence.end_line)?;
                    let name = entry
                        .qualified_name
                        .filter(|name| !name.is_empty())
                        .unwrap_or(entry.name);
                    let name = normalize_whitespace(&name);
                    let label = format!("{} {name}", entry.kind);
                    Some(Candidate { location, label })
                })
                .collect();
            if !cards.is_empty() {
                return Ok(cards);
            }
        }

        // Read only the headings that fit in the native explore presentation.
        // This retains the published menu's ordering and source budget behavior.
        let response = self.facts.explore(ExploreOptions {
            query: Some(query),
            max_bytes: Some(EXPLORE_BYTES),
            ..Default::default()
        })?;
        Ok(response
            .split(['\n', '\r'])
            .filter_map(|line| {
                let (path, start, end, label) = source_heading(line)?;
                Some(Candidate {
                    location: location(path.to_owned(), start, end)?,
                    label: label.to_owned(),
                })
            })
            .collect())
    }

    pub fn validate_source(&self, path: &str) -> Result<()> {
        let root = self.facts.root();
        if relative_source_path(path) {
            let target = root.join(path).canonicalize()?;
            if target.starts_with(root) && target.is_file() {
                return Ok(());
            }
        }
        Err(CodeFactsError::Other(
            "Source path must resolve to a file inside the repository.".into(),
        ))
    }

    pub fn source_ranges(
        &self,
        path: &str,
        ranges: &[(u32, u32)],
    ) -> Result<BTreeMap<u32, String>> {
        self.validate_source(path)?;
        let reads = ranges
            .iter()
            .map(|&(start, end)| ExploreRead {
                file_path: path.to_owned(),
                start_line: Some(start),
                end_line: Some(end),
            })
            .collect::<Vec<_>>();
        let response = self.facts.explore(ExploreOptions {
            reads: Some(&reads),
            max_bytes: Some(EXPLORE_BYTES),
            ..Default::default()
        })?;

        let mut source = BTreeMap::new();
        let mut inside = false;
        // The reference CLI adapter used universal newlines. Empty pieces from
        // splitting a CRLF pair do not match headings or numbered source lines.
        for line in response.split(['\n', '\r']) {
            if let Some((heading_path, _, _, _)) = source_heading(line) {
                inside = heading_path == path;
            } else if inside {
                let number = source_line_number(line).filter(|number| {
                    ranges
                        .iter()
                        .any(|&(start, end)| (start..=end).contains(number))
                });
                if let Some(number) = number {
                    source.insert(number, line.to_owned());
                }
            }
        }
        Ok(source)
    }
}

fn relative_source_path(path: &str) -> bool {
    let mut components = Path::new(path).components();
    components
        .clone()
        .any(|part| matches!(part, Component::Normal(_)))
        && components.all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
}

fn location(path: String, start: u32, end: u32) -> Option<Location> {
    (start > 0 && start <= end && relative_source_path(&path)).then_some(Location {
        path,
        start,
        end,
    })
}

fn source_heading(line: &str) -> Option<(&str, u32, u32, &str)> {
    let value = line.strip_prefix("## ")?;
    // A heading label can itself contain the separator, and paths can contain colons.
    value
        .rmatch_indices(" | ")
        .find_map(|(delimiter, separator)| {
            let label = value.get(delimiter + separator.len()..)?;
            let (path, span) = value[..delimiter].rsplit_once(':')?;
            let (start, end) = span.split_once('-')?;
            if label.is_empty() || path.is_empty() {
                return None;
            }
            Some((path, decimal(start)?, decimal(end)?, label))
        })
}

fn source_line_number(line: &str) -> Option<u32> {
    let (number, text) = line.split_once(':')?;
    if text.is_empty() || text.starts_with(' ') {
        decimal(number)
    } else {
        None
    }
}

fn decimal(text: &str) -> Option<u32> {
    if text.bytes().all(|byte| byte.is_ascii_digit()) {
        text.parse().ok()
    } else {
        None
    }
}

pub(super) fn menu_text(
    cards: Vec<Candidate>,
    query: &str,
    known: &BTreeMap<usize, Location>,
    budget: usize,
    cap: usize,
    origin: Origin,
) -> std::result::Result<(String, Vec<Row>), String> {
    let budget = budget.min(cap);
    let mut text = format!("Search: {query}\n");
    if text.len() > budget {
        return Err("The remaining byte budget cannot fit this search heading.".into());
    }

    let ids: HashMap<_, _> = known.iter().map(|(&number, span)| (span, number)).collect();
    let mut serial = known.last_key_value().map_or(1, |(&number, _)| number + 1);
    let mut shown = HashSet::new();
    let mut rows = Vec::new();
    for Candidate { location, label } in cards {
        if !shown.insert(location.clone()) {
            continue;
        }
        let existing = ids.get(&location).copied();
        let number = existing.unwrap_or(serial);
        let Location { path, start, end } = location;
        let title = format!("[{number}] {path}:{start}-{end} | {label}\n");
        if title.len() > budget - text.len() {
            break;
        }
        text.push_str(&title);
        if existing.is_none() {
            serial += 1;
        }
        rows.push(Row {
            number,
            label,
            path: Some(path),
            origin,
            focus: query.to_owned(),
            low: Some(start as usize),
            high: Some(end as usize),
        });
        if rows.len() == MENU_ROWS {
            break;
        }
    }
    if rows.is_empty() && EMPTY_MENU.len() <= budget - text.len() {
        text.push_str(EMPTY_MENU);
    }
    Ok((text, rows))
}
