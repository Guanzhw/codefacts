use std::fmt::Write as _;

use super::backend::{Backend, Location};
use super::policy::Page;

/// Reproduce the published head-only source page using verified explore ranges.
pub(super) fn read(
    backend: &Backend,
    location: &Location,
    number: usize,
    start: Option<usize>,
    budget: usize,
) -> Option<(String, Page)> {
    let first = start
        .map(u32::try_from)
        .transpose()
        .ok()?
        .unwrap_or(location.start);
    if !(location.start..=location.end).contains(&first) {
        return None;
    }
    let mut text = format!("[{number}] {}:{first}-{}\n", location.path, location.end);
    if text.len() >= budget {
        return None;
    }
    let source = backend
        .source_ranges(&location.path, &[(first, location.end)])
        .ok()?;
    let mut code = Vec::new();
    let mut lines = Vec::new();
    for line_number in first..=location.end {
        let Some(line) = source.get(&line_number) else {
            break;
        };
        if text.len() + line.len() + 1 > budget {
            break;
        }
        let (_, body) = line.split_once(':')?;
        code.push(body.strip_prefix(' ').unwrap_or(body));
        lines.push(line_number as usize);
        let _ = writeln!(text, "{line}");
    }
    if lines.is_empty() {
        return None;
    }
    let page = Page {
        path: location.path.clone(),
        code: code.join("\n"),
        lines,
    };
    Some((text, page))
}
