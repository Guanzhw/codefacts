//! Deterministic Markdown projection for compact CodeFacts results.
//!
//! The renderer changes presentation only: every value remains present, arrays
//! retain their order, and repeated flat facts share one table header.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

pub(crate) fn render(value: &Value) -> String {
    let mut renderer = Renderer::default();
    renderer.value(value, 2);
    while renderer.output.ends_with('\n') {
        renderer.output.pop();
    }
    renderer.output.push('\n');
    renderer.output
}

#[derive(Default)]
struct Renderer {
    output: String,
}

impl Renderer {
    fn value(&mut self, value: &Value, heading_level: usize) {
        match value {
            Value::Object(fields) if fields.is_empty() => self.output.push_str("{}\n"),
            Value::Object(fields) => self.object(fields, heading_level),
            Value::Array(values) if values.is_empty() => self.output.push_str("[]\n"),
            Value::Array(values) => self.array(values, heading_level),
            _ => {
                self.output.push_str(&inline_value(value, false));
                self.output.push('\n');
            }
        }
    }

    fn object(&mut self, fields: &Map<String, Value>, heading_level: usize) {
        // Emit leaf metadata before child sections so a preceding Markdown
        // heading cannot accidentally make a later sibling look nested.
        for (name, value) in fields {
            if let Value::String(text) = value {
                if text.contains(['\n', '\r']) {
                    self.output.push_str("- ");
                    self.output.push_str(&escape_label(name));
                    self.output.push_str(":\n");
                    self.fenced(text);
                    continue;
                }
            }

            if is_inline(value) {
                self.output.push_str("- ");
                self.output.push_str(&escape_label(name));
                self.output.push_str(": ");
                self.output.push_str(&inline_value(value, false));
                self.output.push('\n');
            }
        }

        let mut children = fields
            .iter()
            .filter(|(_, value)| is_child(value))
            .collect::<Vec<_>>();
        children.sort_by(|(left, _), (right, _)| {
            child_priority(left)
                .cmp(&child_priority(right))
                .then_with(|| left.cmp(right))
        });
        for (name, value) in children {
            self.blank_line();
            self.heading(heading_level, name);
            self.value(value, heading_level + 1);
        }
    }

    fn array(&mut self, values: &[Value], heading_level: usize) {
        if let Some(table) = FlatTable::from_values(values) {
            self.table(&table);
            return;
        }

        if values.iter().all(is_scalar) {
            self.output
                .push_str(&inline_value(&Value::Array(values.to_vec()), false));
            self.output.push('\n');
            return;
        }

        for (index, value) in values.iter().enumerate() {
            if is_inline(value) {
                self.output.push_str(&(index + 1).to_string());
                self.output.push_str(". ");
                self.output.push_str(&inline_value(value, false));
                self.output.push('\n');
            } else {
                self.blank_line();
                self.heading(heading_level, &(index + 1).to_string());
                self.value(value, heading_level + 1);
            }
        }
    }

    fn table(&mut self, table: &FlatTable) {
        self.output.push('|');
        for column in &table.columns {
            self.output.push_str(&escape_table_text(column));
            self.output.push('|');
        }
        self.output.push('\n');
        self.output.push('|');
        for _ in &table.columns {
            self.output.push_str("---|");
        }
        self.output.push('\n');
        for row in &table.rows {
            self.output.push('|');
            for column in &table.columns {
                if let Some(value) = row.get(column) {
                    self.output.push_str(&inline_value(value, true));
                }
                self.output.push('|');
            }
            self.output.push('\n');
        }
    }

    fn fenced(&mut self, text: &str) {
        let fence = "`".repeat(longest_backtick_run(text).saturating_add(1).max(3));
        self.output.push_str(&fence);
        self.output.push('\n');
        self.output.push_str(text);
        if !text.ends_with('\n') && !text.ends_with('\r') {
            self.output.push('\n');
        }
        self.output.push_str(&fence);
        self.output.push('\n');
    }

    fn heading(&mut self, level: usize, name: &str) {
        self.output.push_str(&"#".repeat(level.clamp(1, 6)));
        self.output.push(' ');
        self.output.push_str(&escape_label(name));
        self.output.push('\n');
    }

    fn blank_line(&mut self) {
        if !self.output.is_empty() && !self.output.ends_with("\n\n") {
            self.output.push('\n');
        }
    }
}

struct FlatTable {
    columns: Vec<String>,
    rows: Vec<BTreeMap<String, Value>>,
}

impl FlatTable {
    fn from_values(values: &[Value]) -> Option<Self> {
        if values.is_empty() {
            return None;
        }

        let mut columns = Vec::new();
        let mut rows = Vec::with_capacity(values.len());
        let mut common_columns: Option<Vec<String>> = None;
        for value in values {
            let fields = value.as_object()?;
            let mut row = BTreeMap::new();
            flatten(fields, "", &mut row)?;
            if row.is_empty() {
                return None;
            }
            let row_columns = row.keys().cloned().collect::<Vec<_>>();
            common_columns = Some(match common_columns {
                None => row_columns.clone(),
                Some(common) => common
                    .into_iter()
                    .filter(|column| row.contains_key(column))
                    .collect(),
            });
            for column in row_columns {
                if !columns.contains(&column) {
                    columns.push(column);
                }
            }
            rows.push(row);
        }

        if common_columns.is_some_and(|columns| columns.is_empty()) {
            return None;
        }
        Some(Self { columns, rows })
    }
}

fn flatten(
    fields: &Map<String, Value>,
    prefix: &str,
    output: &mut BTreeMap<String, Value>,
) -> Option<()> {
    for (name, value) in fields {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        match value {
            Value::Object(nested) if nested.is_empty() => {
                output.insert(path, Value::Object(Map::new()));
            }
            Value::Object(nested) => flatten(nested, &path, output)?,
            Value::Array(values) if values.is_empty() => {
                output.insert(path, Value::Array(Vec::new()));
            }
            Value::Array(_) => return None,
            Value::String(text) if text.contains(['\n', '\r']) => return None,
            _ => {
                output.insert(path, value.clone());
            }
        }
    }
    Some(())
}

fn is_scalar(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

fn is_inline(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(text) => !text.contains(['\n', '\r']),
        Value::Array(values) => values.is_empty() || values.iter().all(is_scalar),
        Value::Object(fields) => fields.is_empty(),
    }
}

fn is_child(value: &Value) -> bool {
    !is_inline(value) && !matches!(value, Value::String(text) if text.contains(['\n', '\r']))
}

fn child_priority(name: &str) -> u8 {
    match name {
        "definition" | "symbol" => 0,
        "source" => 1,
        _ => 2,
    }
}

fn inline_value(value: &Value, table_cell: bool) -> String {
    match value {
        Value::String(text) if plain_string(text) => text.to_owned(),
        Value::String(text) if !text.is_empty() && !text.chars().any(char::is_whitespace) => {
            inline_code(text, table_cell)
        }
        Value::String(text) => inline_code(
            &serde_json::to_string(text).expect("string JSON"),
            table_cell,
        ),
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) if values.is_empty() => "[]".into(),
        Value::Array(_) => inline_code(
            &serde_json::to_string(value).expect("array JSON"),
            table_cell,
        ),
        Value::Object(fields) if fields.is_empty() => "{}".into(),
        Value::Object(_) => unreachable!("nested objects are rendered structurally"),
    }
}

fn plain_string(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "true" | "false" | "null")
        && value.parse::<f64>().is_err()
        && markdown_sensitive_underscores_are_absent(value)
        && !value.contains("~~")
        && !value
            .as_bytes()
            .windows(2)
            .any(|pair| pair[0] == b'\\' && pair[1].is_ascii_punctuation())
        && value.chars().all(|character| {
            character.is_alphanumeric()
                || matches!(
                    character,
                    '_' | '-' | '.' | '/' | '\\' | ':' | '@' | '+' | '=' | '~' | '#'
                )
        })
}

fn markdown_sensitive_underscores_are_absent(value: &str) -> bool {
    let characters = value.chars().collect::<Vec<_>>();
    characters.iter().enumerate().all(|(index, character)| {
        *character != '_'
            || (index > 0
                && index + 1 < characters.len()
                && characters[index - 1].is_alphanumeric()
                && characters[index + 1].is_alphanumeric())
    })
}

fn inline_code(value: &str, table_cell: bool) -> String {
    let fence = "`".repeat(longest_backtick_run(value).saturating_add(1).max(1));
    let escaped = if table_cell {
        value.replace('|', "\\|")
    } else {
        value.to_owned()
    };
    let padding = if value.starts_with('`') || value.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{fence}{padding}{escaped}{padding}{fence}")
}

fn longest_backtick_run(value: &str) -> usize {
    value
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0)
}

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace('*', "\\*")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('<', "\\<")
        .replace('>', "\\>")
        .replace('#', "\\#")
        .replace('|', "\\|")
}

fn escape_table_text(value: &str) -> String {
    value.replace('\\', "\\\\").replace('|', "\\|")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn repeated_facts_share_flattened_columns_and_keep_row_order() {
        let value = json!({
            "format": "markdown",
            "results": [
                {
                    "id": "src/a.rs::function:first:1",
                    "name": "first",
                    "kind": "function",
                    "evidence": {
                        "file_path": "src/a.rs",
                        "start_line": 1,
                        "end_line": 3,
                        "extractor": "tree-sitter",
                        "confidence": "confirmed"
                    }
                },
                {
                    "id": "src/b.rs::function:second:8",
                    "name": "second",
                    "kind": "function",
                    "evidence": {
                        "file_path": "src/b.rs",
                        "start_line": 8,
                        "end_line": 12,
                        "extractor": "tree-sitter",
                        "confidence": "heuristic"
                    },
                    "resolution": "call_candidates"
                }
            ],
            "source_hashes": {
                "src/a.rs": "aaa111",
                "src/b.rs": "bbb222"
            }
        });

        let markdown = render(&value);

        assert!(markdown.contains("evidence.file_path"));
        assert_eq!(markdown.matches("evidence.file_path").count(), 1);
        assert!(markdown.contains("resolution"));
        assert!(markdown.contains("confirmed"));
        assert!(markdown.contains("heuristic"));
        assert!(markdown.contains("call_candidates"));
        assert!(markdown.contains("aaa111"));
        assert!(markdown.contains("bbb222"));
        assert!(
            markdown.find("first:1").expect("first row")
                < markdown.find("second:8").expect("second row")
        );
        assert!(markdown.len() < serde_json::to_string_pretty(&value).unwrap().len());
    }

    #[test]
    fn preserves_status_cursors_truncation_and_empty_containers() {
        let value = json!({
            "status": "stale_cursor",
            "next": {},
            "next_cursor": "0a0b0c",
            "truncated": true,
            "results": [],
            "details": {
                "empty_object": {},
                "empty_array": [],
                "null_value": null
            }
        });

        let markdown = render(&value);

        for expected in [
            "status: stale_cursor",
            "next: {}",
            "next_cursor: 0a0b0c",
            "truncated: true",
            "results: []",
            "empty_object: {}",
            "empty_array: []",
            "null_value: null",
        ] {
            assert!(
                markdown.contains(expected),
                "missing {expected}:\n{markdown}"
            );
        }
        assert!(
            markdown.find("- status:").unwrap() < markdown.find("## details").unwrap(),
            "root metadata must not appear under a child heading:\n{markdown}"
        );
    }

    #[test]
    fn special_strings_and_source_fences_are_unambiguous() {
        let value = json!({
            "message": "管道 | and `tick`",
            "source": {
                "status": "ok",
                "text": "fn main() {\n    println!(\"``` | 中文\");\n}",
                "truncated": false
            }
        });

        let markdown = render(&value);

        assert!(markdown.contains("`tick`"));
        assert!(markdown.contains("管道 | and"));
        assert!(!markdown.contains("管道 \\| and"));
        assert!(markdown.contains("````\nfn main()"));
        assert!(markdown.contains("println!(\"``` | 中文\");"));
        assert!(markdown.contains("}\n````"));
    }

    #[test]
    fn nested_arrays_keep_item_order_without_forcing_a_table() {
        let value = json!({
            "context_entries": [
                {"symbol": {"name": "alpha"}, "callers": ["zeta", "eta"]},
                {"symbol": {"name": "beta"}, "callers": []}
            ]
        });

        let markdown = render(&value);

        assert!(!markdown.contains("symbol.name | callers"));
        assert!(
            markdown.find("alpha").expect("first item")
                < markdown.find("beta").expect("second item")
        );
        assert!(markdown.contains("[\"zeta\",\"eta\"]"));
        assert!(markdown.contains("callers: []"));
    }

    #[test]
    fn disjoint_object_shapes_use_sections_instead_of_a_sparse_table() {
        let value = json!({"items": [{"left": "one"}, {"right": "two"}]});

        let markdown = render(&value);

        assert!(!markdown.contains("| left | right |"));
        assert!(markdown.contains("### 1"));
        assert!(markdown.contains("### 2"));
        assert!(markdown.contains("left: one"));
        assert!(markdown.contains("right: two"));
    }

    #[test]
    fn context_relationship_headings_retain_their_parent_depth() {
        let value = json!({
            "context_entries": [{
                "symbol": {"id": "anchor"},
                "references": {
                    "inbound": [
                        {"kind": "references", "from": {"id": "first"}},
                        {"kind": "references", "from": {"id": "second"}}
                    ],
                    "outbound": []
                }
            }]
        });

        let markdown = render(&value);

        for heading in [
            "## context_entries",
            "### 1",
            "#### references",
            "##### inbound",
            "#### symbol",
        ] {
            assert!(markdown.contains(heading), "missing {heading}:\n{markdown}");
        }
        assert_eq!(markdown.matches("from.id").count(), 1);
        assert!(markdown.find("first").unwrap() < markdown.find("second").unwrap());
    }

    #[test]
    fn anchors_and_source_precede_relationship_sections() {
        let value = json!({
            "status": "ok",
            "callers": [{"kind": "calls"}, {"kind": "calls"}],
            "source": {"status": "ok", "text": "body"},
            "definition": {"id": "anchor"},
            "context_entries": [{
                "callers": [{"kind": "calls"}, {"kind": "calls"}],
                "source": {"status": "ok", "text": "context body"},
                "symbol": {"id": "context-anchor"}
            }]
        });

        let markdown = render(&value);

        let definition = markdown.find("## definition").unwrap();
        let source = markdown.find("## source").unwrap();
        let callers = markdown.find("## callers").unwrap();
        assert!(definition < source && source < callers, "{markdown}");

        let context = markdown.find("## context_entries").unwrap();
        let symbol = markdown[context..].find("#### symbol").unwrap();
        let context_source = markdown[context..].find("#### source").unwrap();
        let context_callers = markdown[context..].find("#### callers").unwrap();
        assert!(
            symbol < context_source && context_source < context_callers,
            "{markdown}"
        );
    }

    #[test]
    fn markdown_sensitive_identifiers_and_windows_paths_render_literally() {
        let value = json!({
            "identifier": "__init__",
            "repository_root": "C:\\_repo",
            "ordinary_identifier": "source_hashes"
        });

        let markdown = render(&value);

        assert!(markdown.contains("identifier: `__init__`"), "{markdown}");
        assert!(
            markdown.contains("repository_root: `C:\\_repo`"),
            "{markdown}"
        );
        assert!(markdown.contains("ordinary_identifier: source_hashes"));
    }

    #[test]
    fn boundary_backticks_and_pipes_survive_bullets_and_table_cells() {
        let value = json!({
            "name": "`api`",
            "qualified_name": "a|b",
            "headings": [
                {"kind": "heading", "name": "`api`"},
                {"kind": "heading", "name": "a|b"}
            ]
        });

        let markdown = render(&value);

        assert!(markdown.contains("- name: `` `api` ``"), "{markdown}");
        assert!(markdown.contains("- qualified_name: `a|b`"), "{markdown}");
        assert!(markdown.contains("|heading|`` `api` ``|"), "{markdown}");
        assert!(markdown.contains("|heading|`a\\|b`|"), "{markdown}");
    }

    #[test]
    fn singleton_context_relationship_is_a_flat_owned_row() {
        let value = json!({
            "context_entries": [{
                "symbol": {"id": "anchor"},
                "callers": [{
                    "kind": "calls",
                    "evidence": {
                        "file_path": "src/callsite.rs",
                        "confidence": "heuristic"
                    },
                    "from": {
                        "id": "caller",
                        "evidence": {
                            "file_path": "src/caller.rs",
                            "confidence": "confirmed"
                        }
                    }
                }]
            }]
        });

        let markdown = render(&value);

        assert!(markdown.contains("#### callers\n|"), "{markdown}");
        assert_eq!(markdown.matches("evidence.file_path").count(), 2);
        assert!(markdown.contains("from.evidence.file_path"));
        assert!(markdown.contains("src/callsite.rs"));
        assert!(markdown.contains("src/caller.rs"));
        assert!(!markdown.contains("##### 1"), "{markdown}");
        assert!(!markdown.contains("###### evidence"), "{markdown}");
    }
}
