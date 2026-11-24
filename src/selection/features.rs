use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::policy::{Page, Row};

pub(super) static IDENTIFIER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z_][A-Za-z_0-9]*").unwrap());
pub(super) static DECLARATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:def|fn|func|function|class|struct|enum|trait|interface|const|let|type|var)\s+\*?\s*([A-Za-z_][A-Za-z_0-9]*)",
    )
    .unwrap()
});
pub(super) static QUALIFIED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:\.|::)\s*([A-Za-z_][A-Za-z_0-9]*)\s*\(").unwrap());

static WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9]+").unwrap());
static CALL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b([A-Za-z_][A-Za-z_0-9]*)\s*\(").unwrap());
static BODY_CALL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b([A-Za-z_][A-Za-z_0-9]*)\s*(?:(?:::)?<[^<>{}\n]+>\s*)?\(").unwrap()
});
static DECLARATION_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:def|fn|func|function|class|struct|enum|trait|interface)\s*\*?\s*$").unwrap()
});
static MEMBER_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[ \t]*(?:async|static|public|private|protected|get|set|override)\b)*[ \t]*$")
        .unwrap()
});
static RETURN_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:\breturn|=>)\s*(?:await\s+)?(?:\(\s*)*(?:[A-Za-z_][A-Za-z_0-9]*\s*(?:\?\.|\.|::|->)\s*)*$",
    )
    .unwrap()
});
static GENERIC_DECLARATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:def|fn|func|function|class|struct|enum|trait|interface)\s+\*?\s*[A-Za-z_][A-Za-z_0-9]*\s*<[^>{}\n]*$",
    )
    .unwrap()
});
static CODE_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"(?s)/\*.*?(?:\*/|\z)|//[^\n]*|\#[^\n]*"#,
        r#"|""".*?(?:"""|\z)|'''.*?(?:'''|\z)"#,
        r#"|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\.|[^\x60\\])*\x60"#,
    ))
    .unwrap()
});
static IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?m)^[ \t]*(?:from[ \t]+[.\w]+[ \t]+import\b|(?:pub[ \t]+)?use\s+",
        r"|(?P<import>import\b)|export[ \t]+[{*])[^\n;]*",
        r"|^[ \t]*(?:const|let|var)[ \t]+[^\n=]+=[ \t]*require[ \t]*\([^\n]*",
    ))
    .unwrap()
});
static QUOTED_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^(?:"([A-Za-z_][A-Za-z_0-9]*)"|'([A-Za-z_][A-Za-z_0-9]*)')$"#).unwrap()
});
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^\s*(?:(?:const|let|var|mut)\s+)?([A-Za-z_]\w*)",
        r"(?:\s*:[^=]+)?\s*=\s*(?:await\s+)?(?:[A-Za-z_]\w*\s*(?:\?\.|\.|::|->)\s*)*$",
    ))
    .unwrap()
});
static REASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:(?:const|let|var|mut)\s+)?([A-Za-z_]\w*)\s*=").unwrap()
});
static NAMED_ARGUMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*[A-Za-z_]\w*\s*=").unwrap());
static FIELD_WRITE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:self|this)\.[A-Za-z_]\w*\s*=").unwrap());

static KEYWORDS: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    "as async await break case catch class const continue default def defer do else enum except \
     false fn for foreach from func function if impl import in interface is let match mod move \
     mut new nil none null of package pass pub raise ref return self Self static struct super \
     switch then throw trait true try type unsafe use var void where while with yield"
        .split_ascii_whitespace()
        .collect()
});
static COMMON_WORDS: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    "about after all also always and any are back because been before both case does end even \
     expect expected first following for from get got had has have how inside into just last \
     left like line many may more most only option order out over report reports result return \
     returned returns right same see should since some still than that the their them then there \
     these they this those through two use used uses using value values want was way were what \
     when where which while will with without work works would"
        .split_ascii_whitespace()
        .collect()
});

fn camel_components(word: &str) -> impl Iterator<Item = &str> {
    let bytes = word.as_bytes();
    let boundaries = (1..bytes.len()).filter(move |&index| {
        let previous = bytes[index - 1];
        bytes[index].is_ascii_uppercase()
            && (previous.is_ascii_lowercase()
                || previous.is_ascii_digit()
                || (previous.is_ascii_uppercase()
                    && bytes.get(index + 1).is_some_and(u8::is_ascii_lowercase)))
    });
    let mut start = 0;
    boundaries
        .chain(std::iter::once(bytes.len()))
        .map(move |end| {
            let component = &word[start..end];
            start = end;
            component
        })
}

pub(super) fn terms(text: &str) -> HashSet<String> {
    WORDS
        .find_iter(text)
        .flat_map(|word| {
            let word = word.as_str();
            std::iter::once(word).chain(camel_components(word))
        })
        .filter(|word| word.len() >= 2)
        .map(str::to_ascii_lowercase)
        .collect()
}

pub(super) fn informative(text: &str) -> HashSet<String> {
    let mut words = terms(text);
    words.retain(|word| {
        !COMMON_WORDS.contains(word.as_str()) && !word.bytes().all(|byte| byte.is_ascii_digit())
    });
    words
}

pub(super) fn is_keyword(term: &str) -> bool {
    KEYWORDS.contains(term)
}

pub(super) fn is_declaration(kind: &str) -> bool {
    matches!(
        kind,
        "function"
            | "method"
            | "class"
            | "struct"
            | "enum"
            | "trait"
            | "interface"
            | "type_alias"
            | "constant"
            | "variable"
            | "constructor"
            | "field"
            | "module"
            | "macro"
    )
}

pub(super) fn is_callable(kind: &str) -> bool {
    matches!(kind, "function" | "method" | "constructor" | "macro")
}

pub(super) fn symbol_name(label: &str) -> &str {
    let (kind, display) = label.split_once(' ').unwrap_or((label, ""));
    let head = if is_declaration(kind) { display } else { label };
    let head = head.split(['(', '<']).next().unwrap_or_default();
    IDENTIFIER
        .find_iter(head)
        .last()
        .map_or("", |name| name.as_str())
}

fn components(text: &str) -> Vec<String> {
    WORDS
        .find_iter(text)
        .flat_map(|word| camel_components(word.as_str()))
        .map(str::to_ascii_lowercase)
        .collect()
}

pub(super) fn suffix_match(query: &str, name: &str) -> bool {
    let query = components(query);
    !query.is_empty() && components(name).ends_with(&query)
}

pub(super) fn posix_parts(path: &str) -> Vec<&str> {
    let root = if path.starts_with("//") && !path.starts_with("///") {
        Some("//")
    } else if path.starts_with('/') {
        Some("/")
    } else {
        None
    };
    root.into_iter()
        .chain(path.split('/').filter(|part| !matches!(*part, "" | ".")))
        .collect()
}

fn parts_name<'a>(parts: &[&'a str]) -> &'a str {
    parts
        .last()
        .copied()
        .filter(|part| !matches!(*part, "/" | "//"))
        .unwrap_or_default()
}

fn stem_and_suffix(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => name.split_at(dot),
        _ => (name, ""),
    }
}

pub(super) fn posix_stem(path: &str) -> &str {
    stem_and_suffix(parts_name(&posix_parts(path))).0
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PathKind {
    Impl,
    Test,
    Example,
    Documentation,
    Other,
}

pub(super) fn path_kind(path: Option<&str>, label: &str) -> PathKind {
    const TEST: &[&str] = &[
        "test",
        "tests",
        "testing",
        "testdata",
        "fixture",
        "fixtures",
        "snapshot",
        "snapshots",
    ];
    const EXAMPLE: &[&str] = &[
        "bench",
        "benches",
        "benchmark",
        "benchmarks",
        "demo",
        "demos",
        "example",
        "examples",
    ];
    const DOC: &[&str] = &["doc", "docs", "documentation"];

    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return PathKind::Other;
    };
    let relative = path.to_lowercase();
    let parts = posix_parts(&relative);
    let folders = &parts[..parts.len().saturating_sub(1)];
    let name = parts_name(&parts);
    let (stem, suffix) = stem_and_suffix(name);
    if folders.iter().any(|part| TEST.contains(part))
        || TEST.contains(&stem)
        || ["test_", "fixture_"]
            .iter()
            .any(|prefix| stem.starts_with(prefix))
        || ["_test", "_tests", ".test", ".spec", "_fixture"]
            .iter()
            .any(|suffix| stem.ends_with(suffix))
    {
        PathKind::Test
    } else if folders.iter().any(|part| EXAMPLE.contains(part))
        || EXAMPLE.contains(&stem)
        || stem.starts_with("example_")
    {
        PathKind::Example
    } else if folders.iter().any(|part| DOC.contains(part))
        || label.starts_with("heading ")
        || matches!(suffix, ".md" | ".rst" | ".adoc")
    {
        PathKind::Documentation
    } else if name.ends_with(".d.ts")
        || (label.starts_with("lexical ") && matches!(suffix, ".json" | ".toml" | ".yaml" | ".yml"))
    {
        PathKind::Other
    } else {
        PathKind::Impl
    }
}

pub(super) fn module_affinity(path: Option<&str>, anchor: Option<&str>) -> usize {
    let (Some(path), Some(anchor)) = (path, anchor) else {
        return 0;
    };
    if path.is_empty() || anchor.is_empty() {
        return 0;
    }
    let left = posix_parts(path);
    let right = posix_parts(anchor);
    let left_dirs = &left[..left.len().saturating_sub(1)];
    let right_dirs = &right[..right.len().saturating_sub(1)];
    left_dirs
        .iter()
        .zip(right_dirs)
        .take_while(|(left, right)| left == right)
        .take(3)
        .count()
        + usize::from(left == right)
}

pub(super) fn visible_calls(code: &str) -> HashSet<&str> {
    let declarations: HashSet<&str> = DECLARATION
        .captures_iter(code)
        .map(|capture| capture.get(1).unwrap().as_str())
        .collect();
    CALL.captures_iter(code)
        .map(|capture| capture.get(1).unwrap().as_str())
        .filter(|name| !declarations.contains(name) && !is_keyword(name))
        .collect()
}

// Keep byte offsets stable so captures in masked code can refer to the original excerpt.
fn blank_ranges(code: &str, ranges: impl IntoIterator<Item = Range<usize>>) -> String {
    let mut bytes = code.as_bytes().to_vec();
    for range in ranges {
        for byte in &mut bytes[range] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    }
    String::from_utf8(bytes).expect("masking complete spans preserves UTF-8")
}

fn clean_source(code: &str) -> String {
    let no_noise = blank_ranges(code, CODE_NOISE.find_iter(code).map(|noise| noise.range()));
    let imports = IMPORT.captures_iter(&no_noise).filter_map(|capture| {
        if capture.name("import").is_some_and(|keyword| {
            no_noise[keyword.end()..]
                .trim_start_matches([' ', '\t'])
                .starts_with('(')
        }) {
            return None;
        }
        Some(capture.get(0).unwrap().range())
    });
    blank_ranges(&no_noise, imports)
}

fn line_start(code: &str, offset: usize) -> usize {
    code[..offset].rfind('\n').map_or(0, |start| start + 1)
}

fn closing_for(character: u8) -> Option<u8> {
    match character {
        b'(' => Some(b')'),
        b'[' => Some(b']'),
        b'{' => Some(b'}'),
        _ => None,
    }
}

fn arguments(code: &str, start: usize) -> Option<(Vec<&str>, usize)> {
    let mut stack = Vec::new();
    let mut parts = Vec::new();
    let mut first = start;
    for (offset, byte) in code.as_bytes().iter().copied().enumerate().skip(start) {
        if let Some(closing) = closing_for(byte) {
            stack.push(closing);
        } else if stack.is_empty() && byte == b')' {
            parts.push(&code[first..offset]);
            return Some((parts, offset + 1));
        } else if stack.last() == Some(&byte) {
            stack.pop();
        } else if stack.is_empty() && byte == b',' {
            parts.push(&code[first..offset]);
            first = offset + 1;
        }
    }
    None
}

#[derive(Clone, Copy)]
struct CallSite<'a> {
    name: &'a str,
    head: usize,
    start: usize,
}

#[derive(Default)]
pub(super) struct Calls<'a> {
    pub(super) body: HashSet<&'a str>,
    pub(super) returning: HashSet<&'a str>,
    pub(super) boilerplate: HashSet<&'a str>,
    sites: Vec<CallSite<'a>>,
}

fn source_calls<'a>(code: &'a str, clean: &str) -> Calls<'a> {
    let mut calls = Calls::default();
    let mut declarations = HashSet::new();
    for capture in BODY_CALL.captures_iter(clean) {
        let matched = capture.get(0).unwrap();
        let name = &code[capture.get(1).unwrap().range()];
        if is_keyword(name) {
            continue;
        }
        let head = matched.start();
        let start = matched.end();
        let prefix = &clean[line_start(clean, head)..head];
        if DECLARATION_PREFIX.is_match(prefix)
            || (MEMBER_PREFIX.is_match(prefix)
                && arguments(clean, start).is_some_and(|(_, end)| {
                    clean[end..]
                        .trim_start_matches(|ch: char| ch != '\n' && ch.is_whitespace())
                        .starts_with('{')
                }))
        {
            declarations.insert(name);
            continue;
        }
        calls.body.insert(name);
        calls.sites.push(CallSite { name, head, start });
        if RETURN_PREFIX.is_match(prefix)
            || (prefix.trim().is_empty() && RETURN_PREFIX.is_match(clean[..head].trim_end()))
        {
            calls.returning.insert(name);
        }
    }

    let clean_names: HashSet<&str> = IDENTIFIER
        .find_iter(clean)
        .map(|name| name.as_str())
        .collect();
    calls.boilerplate = IDENTIFIER
        .find_iter(code)
        .map(|name| name.as_str())
        .filter(|name| !clean_names.contains(name))
        .chain(declarations)
        .filter(|name| !calls.body.contains(name))
        .collect();
    calls
}

fn omit_partial_docstring(code: &str) -> Option<String> {
    let bytes = code.as_bytes();
    let mut markers = Vec::new();
    let mut offset = 0;
    while offset + 3 <= bytes.len() {
        if matches!(&bytes[offset..offset + 3], b"\"\"\"" | b"'''")
            && (offset == 0 || bytes[offset - 1] != b'\\')
        {
            markers.push(offset);
            offset += 3;
        } else {
            offset += 1;
        }
    }
    if markers.len() % 2 == 0 {
        return None;
    }
    let first = markers[0];
    let start = line_start(code, first);
    let stop = first + 3 + code[first + 3..].find('\n')?;
    (code[start..stop].trim() == &code[first..first + 3])
        .then(|| blank_ranges(code, std::iter::once(0..stop)))
}

fn value_flow(clean: &str, sites: &[CallSite<'_>]) -> HashSet<String> {
    let mut definitions = HashMap::new();
    let mut consumed = HashSet::new();
    let mut processed = 0;
    for &CallSite { name, head, start } in sites {
        let line = line_start(clean, head);
        if line > processed {
            let mut next = processed;
            while let Some(overwrite) = REASSIGNMENT.captures_at(&clean[..line], next) {
                let statement = overwrite.get(0).unwrap();
                next = statement.end();
                if clean.as_bytes().get(next) != Some(&b'=') {
                    definitions.remove(overwrite.get(1).unwrap().as_str());
                }
            }
            processed = line;
        }
        let Some((parts, end)) = arguments(clean, start) else {
            continue;
        };
        for part in parts {
            let part = NAMED_ARGUMENT
                .find(part)
                .filter(|assignment| part.as_bytes().get(assignment.end()) != Some(&b'='))
                .map_or(part, |assignment| &part[assignment.end()..]);
            for symbol in IDENTIFIER.find_iter(part) {
                if let Some(&(callee, definition_end)) = definitions.get(symbol.as_str()) {
                    if head >= definition_end {
                        consumed.insert(String::from(callee));
                    }
                }
            }
        }
        if let Some(assignment) = ASSIGNMENT.captures(&clean[line..head]) {
            definitions.insert(assignment.get(1).unwrap().as_str(), (name, end));
            processed = processed.max(end);
        }
    }
    consumed
}

pub(super) struct PageContext<'a> {
    pub(super) page: &'a Page,
    pub(super) calls: Calls<'a>,
    pub(super) flow: HashSet<String>,
    clean: String,
}

impl<'a> PageContext<'a> {
    pub(super) fn new(page: &'a Page, flow: bool, clipped: bool) -> Self {
        let clean = clean_source(&page.code);
        let calls = source_calls(&page.code, &clean);
        let flow = if flow {
            let omitted = if clipped && page.path.ends_with(".py") {
                omit_partial_docstring(&page.code)
            } else {
                None
            };
            if let Some(omitted) = omitted {
                let clipped_clean = clean_source(&omitted);
                let clipped_calls = source_calls(&page.code, &clipped_clean);
                value_flow(&clipped_clean, &clipped_calls.sites)
            } else {
                value_flow(&clean, &calls.sites)
            }
        } else {
            HashSet::new()
        };
        Self {
            page,
            calls,
            flow,
            clean,
        }
    }
}

fn balanced_argument_end(code: &str, start: usize) -> Option<usize> {
    let mut expected = vec![b')'];
    for (offset, byte) in code.as_bytes().iter().copied().enumerate().skip(start) {
        if let Some(closing) = closing_for(byte) {
            expected.push(closing);
        } else if matches!(byte, b')' | b']' | b'}') {
            if expected.pop() != Some(byte) {
                return None;
            }
            if expected.is_empty() {
                return Some(offset);
            }
        } else if matches!(byte, b'\'' | b'"' | b'`') {
            return None;
        }
    }
    None
}

pub(super) fn argument_matches<'a>(
    context: &PageContext<'a>,
    symptom: &str,
) -> HashMap<&'a str, usize> {
    let symptom_names: HashSet<String> = IDENTIFIER
        .find_iter(symptom)
        .map(|name| name.as_str().to_ascii_lowercase())
        .filter(|name| !is_keyword(name) && !informative(name).is_empty())
        .collect();
    let sites = &context.calls.sites;
    if sites.is_empty() || symptom_names.is_empty() {
        return HashMap::new();
    }
    let clean = &context.clean;
    let spans: Vec<_> = sites
        .iter()
        .filter_map(|site| {
            let prefix = &clean[line_start(clean, site.head)..site.head];
            if GENERIC_DECLARATION.is_match(prefix) {
                return None;
            }
            balanced_argument_end(clean, site.start).map(|end| (site, end))
        })
        .collect();
    let tokens = IDENTIFIER
        .find_iter(clean)
        .map(|token| (token.start(), token.as_str()));
    let keys = CODE_NOISE
        .find_iter(&context.page.code)
        .filter_map(|token| {
            let quoted = QUOTED_KEY.captures(token.as_str())?;
            let name = quoted.get(1).or_else(|| quoted.get(2)).unwrap();
            let suffix = clean[token.end()..].trim_start();
            if clean[..token.start()].trim_end().ends_with(['{', ','])
                && suffix.starts_with(':')
                && !suffix.starts_with("::")
            {
                Some((token.start(), name.as_str()))
            } else {
                None
            }
        });

    let mut hits = vec![HashSet::new(); spans.len()];
    for (position, token) in tokens.chain(keys) {
        let name = token.to_ascii_lowercase();
        if !symptom_names.contains(&name)
            || sites
                .iter()
                .any(|site| (site.head..site.start).contains(&position))
        {
            continue;
        }
        // A token belongs to the innermost complete call whose arguments contain it.
        if let Some(index) = spans
            .iter()
            .rposition(|(site, end)| (site.start..*end).contains(&position))
        {
            hits[index].insert(name);
        }
    }
    let mut scores = HashMap::new();
    for ((site, _), hits) in spans.into_iter().zip(hits) {
        let previous = scores.entry(site.name).or_insert(0);
        *previous = (*previous).max(hits.len());
    }
    scores
}

fn word_forms(word: &str) -> Vec<String> {
    let mut forms = vec![word.to_owned()];
    if word.len() > 3 && !word.ends_with("ss") {
        if let Some(base) = word.strip_suffix('s') {
            forms.push(base.to_owned());
        }
    }
    for suffix in ["ing", "ed"] {
        if let Some(base) = word.strip_suffix(suffix).filter(|base| base.len() >= 3) {
            forms.push(base.to_owned());
            forms.push(format!("{base}e"));
        }
    }
    forms
}

pub(super) fn constructor_caller<'a>(
    rows: &'a [Row],
    anchor: &Row,
    page: &Page,
    symptom_words: &HashSet<String>,
) -> Option<&'a Row> {
    let kind = anchor.label.split(' ').next().unwrap_or_default();
    if kind != "constructor"
        && !matches!(
            symbol_name(&anchor.label),
            "__init__" | "__new__" | "constructor"
        )
    {
        return None;
    }
    let clean = clean_source(&page.code);
    if !FIELD_WRITE
        .find_iter(&clean)
        .any(|write| clean.as_bytes().get(write.end()) != Some(&b'='))
    {
        return None;
    }

    let symptom_forms: HashSet<String> = symptom_words
        .iter()
        .flat_map(|word| word_forms(word))
        .collect();
    let mut best = (0, 0);
    let mut candidates = HashMap::new();
    for row in rows {
        let (Some(path), Some(low), Some(high)) = (row.path.as_deref(), row.low, row.high) else {
            continue;
        };
        if path.is_empty()
            || path == page.path
            || high.saturating_sub(low) < 15
            || path_kind(Some(path), &row.label) != PathKind::Impl
            || !is_callable(row.label.split(' ').next().unwrap_or_default())
        {
            continue;
        }
        let name_words = informative(&components(symbol_name(&row.label)).join(" "));
        let affinity = module_affinity(Some(path), Some(&page.path));
        let overlap = name_words
            .iter()
            .filter(|word| {
                word_forms(word)
                    .iter()
                    .any(|form| symptom_forms.contains(form))
            })
            .count();
        if affinity == 0 || overlap == 0 || name_words.len() < 2 {
            continue;
        }
        let score = (overlap, affinity);
        if score > best {
            best = score;
            candidates.clear();
        }
        if score == best {
            candidates.insert((path, low, high), row);
        }
    }
    if candidates.len() == 1 {
        candidates.into_values().next()
    } else {
        None
    }
}
