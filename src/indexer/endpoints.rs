//! Deterministic endpoint discovery for common static route declarations.
//!
//! Endpoint facts are deliberately conservative candidates: a route literal is
//! required, and handler candidates resolve only to indexed functions or
//! methods. The text-pattern extraction and every resulting edge are marked
//! heuristic; it is not a framework-aware routing analysis.

use std::collections::{HashMap, HashSet};

use tree_sitter::Tree;

use crate::types::{make_node_id, CodeEdge, CodeNode, EdgeKind, Language, NodeKind};

#[derive(Debug, Clone)]
pub struct EndpointBinding {
    pub endpoint: CodeNode,
    pub handler_names: Vec<String>,
}

pub fn extract_endpoints(
    file_path: &str,
    language: Language,
    source: &str,
    tree: &Tree,
) -> Vec<EndpointBinding> {
    if language == Language::Markdown {
        return Vec::new();
    }

    let mut endpoints = Vec::new();
    let mut seen = HashSet::new();
    let mut byte_offset = 0;
    for (index, source_line) in source.split_inclusive('\n').enumerate() {
        let line = source_line
            .strip_suffix('\n')
            .unwrap_or(source_line)
            .strip_suffix('\r')
            .unwrap_or(source_line);
        let line_number = (index + 1) as u32;
        for (method, verb) in route_methods(line, tree, byte_offset) {
            let key = format!("{line_number}:{verb}:{}", method.path);
            if !seen.insert(key) {
                continue;
            }
            let name = format!("{verb} {}", method.path);
            endpoints.push(EndpointBinding {
                endpoint: CodeNode {
                    id: make_node_id(NodeKind::Endpoint, file_path, &name, line_number),
                    name,
                    qualified_name: None,
                    kind: NodeKind::Endpoint,
                    file_path: file_path.to_string(),
                    start_line: line_number,
                    end_line: line_number,
                    start_column: 0,
                    end_column: line.len() as u32,
                    language,
                    body: None,
                    documentation: None,
                    exported: None,
                },
                handler_names: method.handler_names,
            });
        }
        byte_offset += source_line.len();
    }
    endpoints
}

pub fn extract_endpoint_edges(
    bindings: &[EndpointBinding],
    node_index: &HashMap<String, Vec<CodeNode>>,
) -> Vec<CodeEdge> {
    let mut edges = Vec::new();
    for binding in bindings {
        let mut emitted = HashSet::new();
        for handler_name in &binding.handler_names {
            let Some(candidates) = node_index.get(handler_name) else {
                continue;
            };
            let mut targets: Vec<&CodeNode> = candidates
                .iter()
                .filter(|node| matches!(node.kind, NodeKind::Function | NodeKind::Method))
                .collect();
            targets.sort_by(|left, right| {
                (&left.file_path, left.start_line, &left.id).cmp(&(
                    &right.file_path,
                    right.start_line,
                    &right.id,
                ))
            });
            for target in targets {
                if !emitted.insert(target.id.as_str()) {
                    continue;
                }
                edges.push(CodeEdge {
                    source: binding.endpoint.id.clone(),
                    target: target.id.clone(),
                    kind: EdgeKind::References,
                    file_path: binding.endpoint.file_path.clone(),
                    line: binding.endpoint.start_line,
                    target_name: Some(handler_name.clone()),
                    metadata: Some(HashMap::from([
                        (
                            "relation".to_string(),
                            "endpoint_handler_candidate".to_string(),
                        ),
                        ("extractor".to_string(), "endpoint-pattern".to_string()),
                        ("confidence".to_string(), "heuristic".to_string()),
                    ])),
                });
            }
        }
    }
    edges
}

struct RouteMethod {
    path: String,
    handler_names: Vec<String>,
}

fn route_methods(line: &str, tree: &Tree, line_offset: usize) -> Vec<(RouteMethod, &'static str)> {
    const METHODS: [(&str, &str); 6] = [
        ("get", "GET"),
        ("post", "POST"),
        ("put", "PUT"),
        ("patch", "PATCH"),
        ("delete", "DELETE"),
        ("head", "HEAD"),
    ];
    let mut found = Vec::new();
    for (method, verb) in METHODS {
        let call = format!(".{method}(");
        if let Some(index) = line.find(&call) {
            if is_code_position(tree, line_offset + index) {
                if let Some(route) = route_from_arguments(&line[index + call.len()..]) {
                    found.push((route, verb));
                }
            }
        }

        let annotation = format!("@{}Mapping(", capitalize(method));
        if let Some(index) = line.find(&annotation) {
            if is_code_position(tree, line_offset + index) {
                if let Some(route) = route_from_arguments(&line[index + annotation.len()..]) {
                    found.push((route, verb));
                }
            }
        }
    }
    found
}

/// Exclude text that appears only inside comments or string literals. The
/// endpoint parser is intentionally pattern-based, but its candidates must be
/// actual syntax rather than examples in prose or test fixtures.
fn is_code_position(tree: &Tree, byte_offset: usize) -> bool {
    let Some(mut node) = tree
        .root_node()
        .descendant_for_byte_range(byte_offset, byte_offset.saturating_add(1))
    else {
        return false;
    };

    loop {
        let kind = node.kind();
        if kind == "comment" || kind.contains("string") || kind.contains("template") {
            return false;
        }
        let Some(parent) = node.parent() else {
            return true;
        };
        node = parent;
    }
}

fn route_from_arguments(arguments: &str) -> Option<RouteMethod> {
    let (path, after_path) = quoted_argument(arguments)?;
    Some(RouteMethod {
        path: path.to_string(),
        handler_names: handler_candidates(after_path),
    })
}

/// Return direct, top-level identifiers after a route literal. Middleware and
/// a terminal handler are all candidates; nested callbacks and member access
/// are deliberately ignored rather than guessed at.
fn handler_candidates(after_path: &str) -> Vec<String> {
    let Some(arguments) = after_path.trim_start().strip_prefix(',') else {
        return Vec::new();
    };

    let mut candidates = Vec::new();
    let mut segment_start = 0;
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;

    for (index, character) in arguments.char_indices() {
        if let Some(active_quote) = quote {
            if character == active_quote && !escaped {
                quote = None;
            }
            escaped = character == '\\' && !escaped;
            if character != '\\' {
                escaped = false;
            }
            continue;
        }

        match character {
            '\'' | '"' => quote = Some(character),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' if depth == 0 => {
                push_handler_candidate(&arguments[segment_start..index], &mut candidates);
                break;
            }
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                push_handler_candidate(&arguments[segment_start..index], &mut candidates);
                segment_start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    candidates
}

fn push_handler_candidate(segment: &str, candidates: &mut Vec<String>) {
    let Some(name) = identifier(segment.trim_start()) else {
        return;
    };
    if !matches!(name, "function" | "class" | "new") {
        candidates.push(name.to_string());
    }
}

fn quoted_argument(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_start();
    let quote = input.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let mut escaped = false;
    for (index, character) in input.char_indices().skip(1) {
        if character == quote && !escaped {
            return Some((&input[1..index], &input[index + character.len_utf8()..]));
        }
        escaped = character == '\\' && !escaped;
        if character != '\\' {
            escaped = false;
        }
    }
    None
}

fn identifier(input: &str) -> Option<&str> {
    let input = input.strip_prefix("async ").unwrap_or(input);
    let end = input
        .char_indices()
        .take_while(|(_, character)| {
            character.is_alphanumeric() || *character == '_' || *character == '$'
        })
        .last()
        .map(|(index, character)| index + character.len_utf8())?;
    (end > 0).then_some(&input[..end])
}

fn capitalize(input: &str) -> String {
    let mut characters = input.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    first.to_uppercase().chain(characters).collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{extract_endpoint_edges, extract_endpoints};
    use crate::indexer::parser::CodeParser;
    use crate::types::{CodeNode, Language, NodeKind};

    fn handler() -> CodeNode {
        CodeNode {
            id: "function:routes.ts:getUser:1".into(),
            name: "getUser".into(),
            qualified_name: None,
            kind: NodeKind::Function,
            file_path: "routes.ts".into(),
            start_line: 1,
            end_line: 1,
            start_column: 0,
            end_column: 0,
            language: Language::TypeScript,
            body: None,
            documentation: None,
            exported: Some(true),
        }
    }

    fn bindings(file_path: &str, language: Language, source: &str) -> Vec<super::EndpointBinding> {
        let parser = CodeParser::new();
        let tree = parser.parse(source, language).expect("test parse tree");
        extract_endpoints(file_path, language, source, &tree)
    }

    #[test]
    fn extracts_express_route_and_resolves_a_unique_handler() {
        let bindings = bindings(
            "routes.ts",
            Language::TypeScript,
            "app.get('/users/:id', getUser);",
        );
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].endpoint.name, "GET /users/:id");

        let edges = extract_endpoint_edges(
            &bindings,
            &HashMap::from([("getUser".to_string(), vec![handler()])]),
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(
            edges[0].metadata.as_ref().unwrap()["confidence"],
            "heuristic"
        );
    }

    #[test]
    fn extracts_spring_mapping_without_claiming_a_handler() {
        let bindings = bindings(
            "UserController.java",
            Language::Java,
            "@GetMapping(\"/users/{id}\")\npublic User getUser() { return null; }",
        );

        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].endpoint.name, "GET /users/{id}");
        assert!(bindings[0].handler_names.is_empty());
    }

    #[test]
    fn skips_route_patterns_inside_comments_and_strings() {
        let bindings = bindings(
            "routes.ts",
            Language::TypeScript,
            "const example = \"app.get('/example', fake)\";\n// app.get('/comment', fake)\napp.get('/real', realHandler);",
        );

        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].endpoint.name, "GET /real");
    }
}
