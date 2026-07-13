//! Small deterministic Markdown heading extractor.
//!
//! Documentation headings are a first-class CodeFacts search and outline
//! target, but do not need a general-purpose Markdown parser for v1.

use crate::types::{make_node_id, CodeNode, Language, NodeKind};

pub fn extract_headings(file_path: &str, source: &str) -> Vec<CodeNode> {
    let mut headings = Vec::new();
    let mut in_fenced_code = false;
    for (index, line) in source.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fenced_code = !in_fenced_code;
            continue;
        }
        if in_fenced_code {
            continue;
        }
        let heading = (|| {
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
            if title.is_empty() {
                return None;
            }
            let line_number = (index + 1) as u32;
            Some(CodeNode {
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
            })
        })();
        if let Some(heading) = heading {
            headings.push(heading);
        }
    }
    headings
}

#[cfg(test)]
mod tests {
    use super::extract_headings;

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
}
