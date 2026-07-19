//! Small deterministic Markdown section extractor.
//!
//! Documentation headings remain a deliberately small CodeFacts surface: the
//! extractor records ATX headings, their lexical hierarchy, bounded section
//! text, and same-document anchor links.  It does not try to become a general
//! Markdown renderer or a semantic parser for tables, images, or prose.

use std::collections::HashMap;

use crate::types::{make_node_id, CodeEdge, CodeNode, EdgeKind, Language, NodeKind};

const MAX_INDEXED_SECTION_BODY_LEN: usize = 4 * 1024;

pub struct MarkdownExtraction {
    pub nodes: Vec<CodeNode>,
    pub edges: Vec<CodeEdge>,
}

struct HeadingRecord {
    level: usize,
    anchor: String,
    node: CodeNode,
}

/// Extract section facts from one Markdown or MDX document.
pub fn extract_markdown(file_path: &str, source: &str) -> MarkdownExtraction {
    let lines = source.lines().collect::<Vec<_>>();
    let mut headings = Vec::new();
    let mut in_fenced_code = false;

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if is_fence(trimmed) {
            in_fenced_code = !in_fenced_code;
            continue;
        }
        if in_fenced_code {
            continue;
        }
        let Some((level, title)) = atx_heading(trimmed) else {
            continue;
        };
        let line_number = (index + 1) as u32;
        headings.push(HeadingRecord {
            level,
            anchor: String::new(),
            node: CodeNode {
                id: make_node_id(NodeKind::Heading, file_path, title, line_number),
                name: title.to_string(),
                qualified_name: None,
                kind: NodeKind::Heading,
                file_path: file_path.to_string(),
                start_line: line_number,
                end_line: line_number,
                start_column: 0,
                end_column: line.len() as u32,
                language: Language::Markdown,
                body: None,
                documentation: None,
                exported: None,
            },
        });
    }

    assign_section_ranges_and_bodies(&mut headings, &lines);
    let mut edges = assign_heading_hierarchy(&mut headings);
    assign_anchors(&mut headings);
    edges.extend(extract_internal_links(file_path, source, &headings));

    MarkdownExtraction {
        nodes: headings.into_iter().map(|heading| heading.node).collect(),
        edges,
    }
}

/// Compatibility wrapper for callers that need only headings.
pub fn extract_headings(file_path: &str, source: &str) -> Vec<CodeNode> {
    extract_markdown(file_path, source).nodes
}

fn assign_section_ranges_and_bodies(headings: &mut [HeadingRecord], lines: &[&str]) {
    for index in 0..headings.len() {
        let current_level = headings[index].level;
        let next_boundary = headings[index + 1..]
            .iter()
            .find(|next| next.level <= current_level)
            .map(|next| next.node.start_line.saturating_sub(1))
            .unwrap_or(lines.len() as u32);
        let end_line = next_boundary.max(headings[index].node.start_line);
        let body = bounded_section_body(lines, headings[index].node.start_line, end_line);
        headings[index].node.end_line = end_line;
        headings[index].node.body = body.clone();
        // `documentation` is the FTS-backed text column.  For a Markdown
        // heading it is the section's source text, not an inferred summary.
        headings[index].node.documentation = body;
    }
}

fn bounded_section_body(lines: &[&str], start_line: u32, end_line: u32) -> Option<String> {
    let start = start_line as usize;
    let end = end_line as usize;
    let text = lines
        .iter()
        .skip(start)
        .take(end.saturating_sub(start))
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.len() <= MAX_INDEXED_SECTION_BODY_LEN {
        return Some(text.to_string());
    }
    let end = text.floor_char_boundary(MAX_INDEXED_SECTION_BODY_LEN);
    Some(format!("{}...", &text[..end]))
}

fn assign_heading_hierarchy(headings: &mut [HeadingRecord]) -> Vec<CodeEdge> {
    let mut edges = Vec::new();
    let mut stack = Vec::<usize>::new();
    for index in 0..headings.len() {
        while stack
            .last()
            .is_some_and(|parent| headings[*parent].level >= headings[index].level)
        {
            stack.pop();
        }
        let parent = stack.last().copied();
        let parent_details = parent.map(|parent| {
            (
                headings[parent].node.id.clone(),
                headings[parent]
                    .node
                    .qualified_name
                    .clone()
                    .unwrap_or_else(|| headings[parent].node.name.clone()),
            )
        });
        if let Some((parent_id, parent_path)) = parent_details {
            let child = &mut headings[index].node;
            child.qualified_name = Some(format!("{parent_path} > {}", child.name));
            edges.push(CodeEdge {
                source: parent_id,
                target: child.id.clone(),
                kind: EdgeKind::Contains,
                file_path: child.file_path.clone(),
                line: child.start_line,
                target_name: Some(child.name.clone()),
                metadata: Some(HashMap::from([
                    (
                        "relation".to_string(),
                        "markdown_heading_hierarchy".to_string(),
                    ),
                    ("extractor".to_string(), "markdown".to_string()),
                    ("confidence".to_string(), "static".to_string()),
                ])),
            });
        } else {
            headings[index].node.qualified_name = Some(headings[index].node.name.clone());
        }
        stack.push(index);
    }
    edges
}

fn assign_anchors(headings: &mut [HeadingRecord]) {
    let mut seen = HashMap::<String, usize>::new();
    for heading in headings {
        let base = markdown_anchor(&heading.node.name);
        let count = seen.entry(base.clone()).or_default();
        heading.anchor = if *count == 0 {
            base
        } else {
            format!("{base}-{count}")
        };
        *count += 1;
    }
}

fn extract_internal_links(
    file_path: &str,
    source: &str,
    headings: &[HeadingRecord],
) -> Vec<CodeEdge> {
    let anchors = headings
        .iter()
        .map(|heading| (heading.anchor.as_str(), heading.node.id.as_str()))
        .collect::<HashMap<_, _>>();
    let mut edges = Vec::new();
    let mut in_fenced_code = false;
    let mut source_heading = None;

    for (index, line) in source.lines().enumerate() {
        let line_number = (index + 1) as u32;
        let trimmed = line.trim_start();
        if is_fence(trimmed) {
            in_fenced_code = !in_fenced_code;
            continue;
        }
        if in_fenced_code {
            continue;
        }
        if let Some((heading_index, _)) = headings
            .iter()
            .enumerate()
            .find(|(_, heading)| heading.node.start_line == line_number)
        {
            source_heading = Some(heading_index);
        }
        let Some(source_index) = source_heading else {
            continue;
        };
        for target in internal_anchor_destinations(line) {
            let target = markdown_anchor(&target);
            let Some(target_id) = anchors.get(target.as_str()) else {
                continue;
            };
            let source = &headings[source_index].node;
            edges.push(CodeEdge {
                source: source.id.clone(),
                target: (*target_id).to_string(),
                kind: EdgeKind::References,
                file_path: file_path.to_string(),
                line: line_number,
                target_name: Some(format!("#{target}")),
                metadata: Some(HashMap::from([
                    ("relation".to_string(), "markdown_internal_link".to_string()),
                    ("extractor".to_string(), "markdown".to_string()),
                    ("confidence".to_string(), "static".to_string()),
                ])),
            });
        }
    }
    edges
}

fn is_fence(trimmed: &str) -> bool {
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

fn atx_heading(trimmed: &str) -> Option<(usize, &str)> {
    let marker_count = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if marker_count == 0 || marker_count > 6 {
        return None;
    }
    let title = &trimmed[marker_count..];
    if !title.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    let title = title.trim().trim_end_matches('#').trim();
    (!title.is_empty()).then_some((marker_count, title))
}

fn internal_anchor_destinations(line: &str) -> Vec<String> {
    let mut destinations = Vec::new();
    let mut offset = 0;
    while let Some(relative_open) = line[offset..].find('[') {
        let open = offset + relative_open;
        offset = open + 1;
        if open > 0 && line.as_bytes()[open - 1] == b'!' {
            continue;
        }
        if is_inline_code(line, open) {
            continue;
        }
        let Some(close_label) = line[offset..].find("](") else {
            continue;
        };
        let destination_start = offset + close_label + 2;
        let Some(close_destination) = line[destination_start..].find(')') else {
            continue;
        };
        let destination_end = destination_start + close_destination;
        let destination = line[destination_start..destination_end]
            .trim()
            .trim_matches(['<', '>']);
        offset = destination_end + 1;
        if let Some(anchor) = destination.strip_prefix('#') {
            destinations.push(anchor.to_string());
        }
    }
    destinations
}

fn is_inline_code(line: &str, byte_offset: usize) -> bool {
    line[..byte_offset]
        .bytes()
        .filter(|byte| *byte == b'`')
        .count()
        % 2
        == 1
}

/// Deterministic GitHub-style anchor approximation for headings and `#...`
/// destinations.  It intentionally keeps this relation local to one document
/// instead of claiming that arbitrary cross-file URLs resolve in a repository.
fn markdown_anchor(input: &str) -> String {
    let mut anchor = String::new();
    let mut pending_dash = false;
    for character in input.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() || character == '_' {
            if pending_dash && !anchor.is_empty() {
                anchor.push('-');
            }
            anchor.push(character);
            pending_dash = false;
        } else if character == '-' {
            if !anchor.ends_with('-') && !anchor.is_empty() {
                anchor.push('-');
            }
            pending_dash = false;
        } else if character.is_whitespace() {
            pending_dash = true;
        }
    }
    if anchor.is_empty() {
        "section".to_string()
    } else {
        anchor.trim_end_matches('-').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_headings, extract_markdown};
    use crate::types::EdgeKind;

    #[test]
    fn extracts_atx_headings_without_fenced_or_empty_markers() {
        let headings = extract_headings(
            "README.md",
            "# Title\n```rust\n# not a heading\n```\n### Detail ###\n#\nplain text",
        );
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0].name, "Title");
        assert_eq!(headings[1].name, "Detail");
        assert_eq!(headings[1].start_line, 5);
    }

    #[test]
    fn extracts_heading_hierarchy_sections_and_internal_links() {
        let extraction = extract_markdown(
            "README.md",
            "# Overview\nIntro text.\n## Install\nInstall text. [Back](#overview)\n```md\n[Fake](#overview)\n```\n# Finish\nDone.",
        );
        assert_eq!(extraction.nodes.len(), 3);
        let overview = &extraction.nodes[0];
        let install = &extraction.nodes[1];
        assert_eq!(overview.end_line, 7);
        assert_eq!(overview.body.as_deref(), Some("Intro text.\n## Install\nInstall text. [Back](#overview)\n```md\n[Fake](#overview)\n```"));
        assert_eq!(
            install.qualified_name.as_deref(),
            Some("Overview > Install")
        );
        assert!(extraction.edges.iter().any(|edge| {
            edge.kind == EdgeKind::Contains
                && edge.source == overview.id
                && edge.target == install.id
        }));
        assert!(extraction.edges.iter().any(|edge| {
            edge.kind == EdgeKind::References
                && edge.source == install.id
                && edge.target == overview.id
                && edge.line == 4
        }));
    }
}
