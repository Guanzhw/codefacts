//! The two frozen source-selection policies from CodeFacts Navigation 0.1.0.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::str::FromStr;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::features::{
    argument_matches, constructor_caller, informative, is_callable, is_declaration, is_keyword,
    module_affinity, path_kind, posix_parts, posix_stem, suffix_match, symbol_name, terms,
    visible_calls, PageContext, PathKind, DECLARATION, IDENTIFIER, QUALIFIED,
};

const SEARCH_CAP: usize = 600;
const BASELINE_JSON: &str = include_str!("policies/baseline.json");
const CANDIDATE_JSON: &str = include_str!("policies/candidate.json");
static BASELINE: LazyLock<Decision> =
    LazyLock::new(|| serde_json::from_str(BASELINE_JSON).expect("frozen baseline policy"));
static CANDIDATE: LazyLock<Decision> =
    LazyLock::new(|| serde_json::from_str(CANDIDATE_JSON).expect("frozen candidate policy"));
static QUALIFIER_SEPARATOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"::|[.#/]").unwrap());
static PATH_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([a-z]{3,})(?:utils|helpers|types)$").unwrap());

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum PolicyName {
    #[default]
    Baseline,
    Candidate,
}

impl PolicyName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::Candidate => "candidate",
        }
    }
}

impl fmt::Display for PolicyName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for PolicyName {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "baseline" | "default" => Ok(Self::Baseline),
            "candidate" => Ok(Self::Candidate),
            _ => Err(format!(
                "unknown selection policy {value:?}. Expected baseline or candidate"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Mode {
    ExpandedSymbol,
    ExpandedExplore,
}

impl Mode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::ExpandedSymbol => "expanded-symbol",
            Self::ExpandedExplore => "expanded-explore",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct GateDecision {
    pub(super) gate: &'static str,
    pub(super) branch: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Origin {
    Initial,
    Search,
}

#[derive(Debug, Clone)]
pub(super) struct Row {
    pub(super) number: usize,
    pub(super) label: String,
    pub(super) path: Option<String>,
    pub(super) origin: Origin,
    pub(super) focus: String,
    pub(super) low: Option<usize>,
    pub(super) high: Option<usize>,
}

impl Row {
    fn range(&self) -> Option<(usize, usize)> {
        self.low.zip(self.high)
    }

    fn span(&self) -> Option<usize> {
        self.range().map(|(low, high)| high - low + 1)
    }

    fn kind(&self) -> &str {
        self.label.split(' ').next().unwrap_or("")
    }
}

#[derive(Debug, Clone)]
pub(super) struct Page {
    pub(super) path: String,
    pub(super) code: String,
    pub(super) lines: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Decision {
    Gate(GateNode),
    Apply(Policy),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GateNode {
    gate: Gate,
    then: Box<Decision>,
    otherwise: Box<Decision>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Gate {
    TopWide,
    TopCompact,
}

impl Gate {
    fn as_str(self) -> &'static str {
        match self {
            Self::TopWide => "top-wide",
            Self::TopCompact => "top-compact",
        }
    }

    fn matches(self, rows: &[Row]) -> bool {
        let Some(span) = rows.first().and_then(Row::span) else {
            return false;
        };
        match self {
            Self::TopWide => span > 24,
            Self::TopCompact => span <= 8,
        }
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Offset {
    Default,
    Middle,
    TailContext,
    BodyEnd,
    MiddleIfWide,
}

impl Offset {
    fn start(self, row: &Row) -> Option<usize> {
        let (low, high) = row.range()?;
        let start = match self {
            Self::Default => low,
            Self::Middle => low + (high - low) / 2,
            Self::TailContext => low.max(high.saturating_sub(7)),
            Self::BodyEnd => low.max(high.saturating_sub(15)),
            Self::MiddleIfWide if high - low >= 24 => low + (high - low) / 2,
            Self::MiddleIfWide => low,
        };
        (start != low).then_some(start)
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Pool {
    All,
    InitialFirst,
    NewFirst,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Followup {
    Off,
    Ranked,
    ArgumentMatch,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SecondStrategy {
    ConstructorContext,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
enum RowFeature {
    Implementation,
    Test,
    Example,
    Documentation,
    Match,
    Declaration,
    Call,
    Symptom,
    Novel,
    Search,
    Focused,
    BodyCall,
    ReturnCall,
    Boilerplate,
    EnclosingSymptom,
    SourceOverlap,
    CallableDefinition,
    QuerySuffix,
    ModuleAffinity,
    ValueFlow,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
enum TermFeature {
    Call,
    Qualified,
    Declaration,
    Symptom,
    Frequency,
    Specificity,
    ValueFlow,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Policy {
    mode: Mode,
    first_weights: HashMap<RowFeature, i32>,
    second_weights: HashMap<RowFeature, i32>,
    second_pool: Pool,
    first_offset: Offset,
    second_offset: Offset,
    followup: Followup,
    followup_weights: HashMap<TermFeature, i32>,
    second_strategy: Option<SecondStrategy>,
}

impl Policy {
    pub(super) fn choose(name: PolicyName, initial: &[Row]) -> (&'static Self, Vec<GateDecision>) {
        let mut decision = match name {
            PolicyName::Baseline => &*BASELINE,
            PolicyName::Candidate => &*CANDIDATE,
        };
        let mut path = Vec::new();
        loop {
            match decision {
                Decision::Apply(policy) => return (policy, path),
                Decision::Gate(node) => {
                    let (branch, next) = if node.gate.matches(initial) {
                        ("then", &node.then)
                    } else {
                        ("otherwise", &node.otherwise)
                    };
                    path.push(GateDecision {
                        gate: node.gate.as_str(),
                        branch,
                    });
                    decision = next;
                }
            }
        }
    }

    pub(super) fn mode(&self) -> Mode {
        self.mode
    }

    pub(super) fn first_rows<'a>(&self, initial: &'a [Row], symptom: &str) -> Vec<&'a Row> {
        let mut rows: Vec<_> = initial.iter().collect();
        Ranking::new(symptom, None, initial.iter()).rank(&mut rows, &self.first_weights);
        let mut seen = HashSet::new();
        rows.retain(|row| seen.insert(row.number));
        rows
    }

    pub(super) fn first_start(&self, row: &Row) -> Option<usize> {
        self.first_offset.start(row)
    }

    pub(super) fn context<'a>(
        &self,
        page: &'a Page,
        first_start: Option<usize>,
    ) -> PageContext<'a> {
        let flow = self
            .second_weights
            .get(&RowFeature::ValueFlow)
            .copied()
            .unwrap_or(0)
            != 0
            || self
                .followup_weights
                .get(&TermFeature::ValueFlow)
                .copied()
                .unwrap_or(0)
                != 0;
        PageContext::new(page, flow, first_start.is_some())
    }

    pub(super) fn constructor_read<'a>(
        &self,
        initial: &'a [Row],
        first: &Row,
        page: &Page,
        symptom: &str,
    ) -> Option<(&'a Row, Option<usize>)> {
        self.second_strategy.as_ref()?;
        let row = constructor_caller(initial, first, page, &informative(symptom))?;
        Some((row, Offset::MiddleIfWide.start(row)))
    }

    pub(super) fn followup_term(
        &self,
        context: &PageContext<'_>,
        query: &str,
        symptom: &str,
        remaining: usize,
    ) -> Option<String> {
        if self.followup == Followup::Off {
            return None;
        }

        let mut frequency: HashMap<&str, usize> = HashMap::new();
        let mut candidates = Vec::new();
        for name in IDENTIFIER
            .find_iter(&context.page.code)
            .map(|found| found.as_str())
        {
            let count = frequency.entry(name).or_default();
            if *count == 0 {
                candidates.push(name);
            }
            *count += 1;
        }

        let query = query.to_ascii_lowercase();
        let cap = SEARCH_CAP.min(remaining);
        candidates.retain(|term| {
            (self.followup != Followup::ArgumentMatch || context.calls.body.contains(term))
                && !is_keyword(term)
                && term.to_ascii_lowercase() != query
                && term.len() <= 120
                && "Search: \n".len() + term.len() <= cap
        });
        if candidates.is_empty() {
            return None;
        }

        let code = &context.page.code;
        let declarations: HashSet<_> = DECLARATION
            .captures_iter(code)
            .map(|c| c.get(1).unwrap().as_str())
            .collect();
        let calls = visible_calls(code);
        let qualified: HashSet<_> = QUALIFIED
            .captures_iter(code)
            .map(|c| c.get(1).unwrap().as_str())
            .collect();
        let symptom_words = informative(symptom);
        let argument_matches = if self.followup == Followup::ArgumentMatch {
            argument_matches(context, symptom)
        } else {
            HashMap::new()
        };

        // `min_by_key` retains the first occurrence when the scores tie.
        candidates
            .into_iter()
            .min_by_key(|term| {
                let score: i32 = self
                    .followup_weights
                    .iter()
                    .map(|(feature, weight)| {
                        let value = match feature {
                            TermFeature::Call => usize::from(calls.contains(term)),
                            TermFeature::Qualified => usize::from(qualified.contains(term)),
                            TermFeature::Declaration => usize::from(declarations.contains(term)),
                            TermFeature::Symptom => symptom_words
                                .intersection(&informative(term))
                                .count()
                                .min(3),
                            TermFeature::Frequency => frequency[term].min(4),
                            TermFeature::Specificity => (term.len() / 4).min(5),
                            TermFeature::ValueFlow => usize::from(context.flow.contains(*term)),
                        };
                        weight * value as i32
                    })
                    .sum();
                Reverse((argument_matches.get(term).copied().unwrap_or(0), score))
            })
            .map(str::to_owned)
    }

    pub(super) fn second_reads<'a>(
        &self,
        initial: &'a [Row],
        additional: &'a [Row],
        context: &PageContext<'_>,
        symptom: &str,
        first_row: &Row,
        first_start: Option<usize>,
    ) -> Vec<(&'a Row, Option<usize>)> {
        let ranking = Ranking::new(symptom, Some(context), initial.iter().chain(additional));
        let mut rows = match self.second_pool {
            Pool::NewFirst => additional.iter().chain(initial).collect::<Vec<_>>(),
            _ => initial.iter().chain(additional).collect(),
        };
        match self.second_pool {
            Pool::All => ranking.rank(&mut rows, &self.second_weights),
            Pool::InitialFirst | Pool::NewFirst => {
                let split = match self.second_pool {
                    Pool::InitialFirst => initial.len(),
                    _ => additional.len(),
                };
                let (front, back) = rows.split_at_mut(split);
                ranking.rank(front, &self.second_weights);
                ranking.rank(back, &self.second_weights);
            }
        }

        let mut seen = HashSet::new();
        rows.into_iter()
            .filter_map(|row| {
                if !seen.insert(row.number) {
                    return None;
                }
                let start = self.second_offset.start(row);
                let repeats = row.number == first_row.number
                    && (self.second_offset == Offset::Default
                        || row.low.is_none()
                        || start == first_start);
                (!repeats).then_some((row, start))
            })
            .collect()
    }
}

struct Ranking<'a, 'p> {
    symptom_words: HashSet<String>,
    context: Option<&'a PageContext<'p>>,
    calls: HashSet<&'p str>,
    enclosures: HashMap<Option<&'a str>, Vec<&'a Row>>,
}

impl<'a, 'p> Ranking<'a, 'p> {
    fn new(
        symptom: &str,
        context: Option<&'a PageContext<'p>>,
        rows: impl IntoIterator<Item = &'a Row>,
    ) -> Self {
        let mut enclosures: HashMap<_, Vec<_>> = HashMap::new();
        for row in rows {
            if row.low.is_some()
                && matches!(
                    row.kind(),
                    "class" | "struct" | "enum" | "trait" | "interface" | "module"
                )
            {
                enclosures.entry(row.path.as_deref()).or_default().push(row);
            }
        }
        Self {
            symptom_words: informative(symptom),
            context,
            calls: context.map_or_else(HashSet::new, |context| visible_calls(&context.page.code)),
            enclosures,
        }
    }

    fn rank(&self, rows: &mut [&Row], weights: &HashMap<RowFeature, i32>) {
        if !weights.is_empty() {
            rows.sort_by_cached_key(|row| Reverse(self.score(row, weights)));
        }
    }

    fn score(&self, row: &Row, weights: &HashMap<RowFeature, i32>) -> i32 {
        let name = symbol_name(&row.label);
        let page_path = self.context.map(|context| context.page.path.as_str());
        let path = row.path.as_deref().or(page_path);
        let kind = path_kind(path, &row.label);
        let described = format!("{} {}", row.label, row.path.as_deref().unwrap_or_default());
        weights
            .iter()
            .map(|(feature, weight)| {
                let value = match feature {
                    RowFeature::Implementation => usize::from(kind == PathKind::Impl),
                    RowFeature::Test => usize::from(kind == PathKind::Test),
                    RowFeature::Example => usize::from(kind == PathKind::Example),
                    RowFeature::Documentation => usize::from(kind == PathKind::Documentation),
                    RowFeature::Match if row.focus.eq_ignore_ascii_case(name) => 2,
                    RowFeature::Match => usize::from(
                        !terms(&row.focus).is_disjoint(&terms(&described))
                            || casefold_for_ascii_search(&row.label)
                                .contains(&row.focus.to_ascii_lowercase()),
                    ),
                    RowFeature::Declaration => usize::from(is_declaration(row.kind())),
                    RowFeature::Call => usize::from(self.calls.contains(name)),
                    RowFeature::Symptom => self
                        .symptom_words
                        .intersection(&informative(&described))
                        .count()
                        .min(4),
                    RowFeature::Novel => usize::from(
                        page_path.is_some()
                            && row.path.is_some()
                            && row.path.as_deref() != page_path,
                    ),
                    RowFeature::Search => usize::from(row.origin == Origin::Search),
                    RowFeature::Focused => row
                        .range()
                        .map_or(0, |(low, high)| 4usize.saturating_sub((high - low) / 8)),
                    RowFeature::BodyCall => usize::from(
                        self.context
                            .is_some_and(|context| context.calls.body.contains(name)),
                    ),
                    RowFeature::ReturnCall => usize::from(
                        self.context
                            .is_some_and(|context| context.calls.returning.contains(name)),
                    ),
                    RowFeature::Boilerplate => usize::from(
                        matches!(row.kind(), "import" | "export")
                            || row
                                .path
                                .as_deref()
                                .is_some_and(|path| path.ends_with(".d.ts"))
                            || self
                                .context
                                .is_some_and(|context| context.calls.boilerplate.contains(name)),
                    ),
                    RowFeature::EnclosingSymptom => self
                        .symptom_words
                        .intersection(&self.enclosing_words(row, path))
                        .count()
                        .min(4),
                    RowFeature::SourceOverlap => self.source_overlap(row),
                    RowFeature::CallableDefinition => {
                        usize::from(is_callable(row.kind()) && kind == PathKind::Impl)
                    }
                    RowFeature::QuerySuffix => {
                        usize::from(is_declaration(row.kind()) && suffix_match(&row.focus, name))
                    }
                    RowFeature::ModuleAffinity => module_affinity(path, page_path),
                    RowFeature::ValueFlow => usize::from(
                        self.context
                            .is_some_and(|context| context.flow.contains(name)),
                    ),
                };
                weight * value as i32
            })
            .sum()
    }

    fn source_overlap(&self, row: &Row) -> usize {
        let Some((low, high)) = row.range() else {
            return 0;
        };
        let Some(context) = self.context else {
            return 0;
        };
        if row.path.as_deref() != Some(context.page.path.as_str()) {
            return 0;
        }
        let overlap = context
            .page
            .lines
            .iter()
            .filter(|line| (low..=high).contains(line))
            .count();
        (4 * overlap + high - low) / (high - low + 1)
    }

    fn enclosing_words(&self, row: &Row, path: Option<&str>) -> HashSet<String> {
        let mut components = Vec::new();
        if let (true, Some((_, display))) = (is_declaration(row.kind()), row.label.split_once(' '))
        {
            let head = display.split(['(', '<']).next().unwrap_or_default();
            components.extend(QUALIFIER_SEPARATOR.split(head));
            components.pop();
        }
        if let Some(path) = path {
            let mut parts = posix_parts(path);
            parts.pop();
            components.extend(parts);
            let stem = posix_stem(path);
            components.push(stem);
            if let Some(suffix) = PATH_SUFFIX.captures(stem).and_then(|c| c.get(1)) {
                components.push(suffix.as_str());
            }
        }
        if let Some((low, high)) = row.range() {
            if let Some(enclosures) = self.enclosures.get(&row.path.as_deref()) {
                components.extend(enclosures.iter().filter_map(|other| {
                    let (start, end) = other.range()?;
                    (other.number != row.number
                        && start <= low
                        && high <= end
                        && (start < low || high < end))
                        .then(|| symbol_name(&other.label))
                }));
            }
        }
        informative(&components.join(" "))
    }
}

// The query grammar accepts ASCII only. Include the full case fold wherever it
// differs from lowercasing and either mapping can contribute to an ASCII match.
fn casefold_for_ascii_search(label: &str) -> String {
    let mut folded = String::with_capacity(label.len());
    for ch in label.chars() {
        let expansion = match ch {
            'ß' | 'ẞ' => "ss",
            'ŉ' => "ʼn",
            'ſ' => "s",
            'ǰ' => "j\u{030c}",
            'ẖ' => "h\u{0331}",
            'ẗ' => "t\u{0308}",
            'ẘ' => "w\u{030a}",
            'ẙ' => "y\u{030a}",
            'ẚ' => "aʾ",
            'ﬀ' => "ff",
            'ﬁ' => "fi",
            'ﬂ' => "fl",
            'ﬃ' => "ffi",
            'ﬄ' => "ffl",
            'ﬅ' | 'ﬆ' => "st",
            _ => {
                folded.extend(ch.to_lowercase());
                continue;
            }
        };
        folded.push_str(expansion);
    }
    folded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displayed_labels_preserve_ascii_case_fold_matches() {
        let folded = casefold_for_ascii_search("STRAẞE ﬃ ǰq");
        assert!(folded.contains("strasse ffi j"));
        assert!(!folded.contains("jq"));
    }
}
