//! Deterministic endpoint discovery for common static route declarations.
//!
//! Endpoint facts are deliberately conservative candidates: a route literal is
//! required, the call must have a known routing receiver, and handler
//! candidates resolve only to indexed functions or methods. Extraction is
//! anchored to Tree-sitter call/annotation nodes so query-parameter access such
//! as `searchParams.get(...)` is never mistaken for an HTTP route.

use std::collections::{HashMap, HashSet};

use tree_sitter::{Node, Tree};

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

    let mut routes = Vec::new();
    match language {
        Language::TypeScript | Language::Tsx | Language::JavaScript | Language::Jsx => {
            collect_javascript_routes(tree.root_node(), source.as_bytes(), &mut routes);
        }
        // Spring mappings are annotation syntax rather than calls, but are
        // still extracted from an AST annotation node instead of a raw line.
        Language::Java => collect_java_routes(tree.root_node(), source.as_bytes(), &mut routes),
        _ => {}
    }

    routes.sort_by(|left, right| {
        (left.start_line, &left.verb, &left.path).cmp(&(right.start_line, &right.verb, &right.path))
    });

    let mut endpoints = Vec::new();
    let mut seen = HashSet::new();
    for route in routes {
        let key = format!("{}:{}:{}", route.start_line, route.verb, route.path);
        if !seen.insert(key) {
            continue;
        }
        let name = format!("{} {}", route.verb, route.path);
        endpoints.push(EndpointBinding {
            endpoint: CodeNode {
                id: make_node_id(NodeKind::Endpoint, file_path, &name, route.start_line),
                name,
                qualified_name: None,
                kind: NodeKind::Endpoint,
                file_path: file_path.to_string(),
                start_line: route.start_line,
                end_line: route.end_line,
                start_column: route.start_column,
                end_column: route.end_column,
                language,
                body: None,
                documentation: None,
                exported: None,
            },
            handler_names: route.handler_names,
        });
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
                        ("extractor".to_string(), "endpoint-ast".to_string()),
                        ("confidence".to_string(), "heuristic".to_string()),
                    ])),
                });
            }
        }
    }
    edges
}

struct RouteCandidate {
    verb: &'static str,
    path: String,
    handler_names: Vec<String>,
    start_line: u32,
    end_line: u32,
    start_column: u32,
    end_column: u32,
}

fn collect_javascript_routes(node: Node<'_>, source: &[u8], routes: &mut Vec<RouteCandidate>) {
    if node.kind() == "call_expression" {
        if let Some(route) = route_from_javascript_call(node, source) {
            routes.push(route);
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_javascript_routes(child, source, routes);
    }
}

fn route_from_javascript_call(call: Node<'_>, source: &[u8]) -> Option<RouteCandidate> {
    const METHODS: [(&str, &str); 6] = [
        ("get", "GET"),
        ("post", "POST"),
        ("put", "PUT"),
        ("patch", "PATCH"),
        ("delete", "DELETE"),
        ("head", "HEAD"),
    ];
    let function = call.child_by_field_name("function")?;
    if function.kind() != "member_expression" {
        return None;
    }
    let receiver = function.child_by_field_name("object")?;
    let method = function.child_by_field_name("property")?;
    if !is_known_route_receiver(node_text(receiver, source)) {
        return None;
    }
    let method = node_text(method, source).to_ascii_lowercase();
    let verb = METHODS
        .iter()
        .find_map(|(name, verb)| (*name == method).then_some(*verb))?;

    let arguments = call.child_by_field_name("arguments")?;
    let mut cursor = arguments.walk();
    let arguments = arguments.named_children(&mut cursor).collect::<Vec<_>>();
    let path = route_path(arguments.first().copied()?, source)?;
    let handler_names = arguments
        .iter()
        .skip(1)
        .filter_map(|argument| direct_handler_name(*argument, source))
        .collect();

    Some(RouteCandidate {
        verb,
        path,
        handler_names,
        start_line: call.start_position().row as u32 + 1,
        end_line: call.end_position().row as u32 + 1,
        start_column: call.start_position().column as u32,
        end_column: call.end_position().column as u32,
    })
}

fn collect_java_routes(node: Node<'_>, source: &[u8], routes: &mut Vec<RouteCandidate>) {
    if node.kind().contains("annotation") {
        if let Some(route) = route_from_java_annotation(node, source) {
            routes.push(route);
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_java_routes(child, source, routes);
    }
}

fn route_from_java_annotation(annotation: Node<'_>, source: &[u8]) -> Option<RouteCandidate> {
    let text = node_text(annotation, source).trim();
    let (mapping, verb) = [
        ("@GetMapping", "GET"),
        ("@PostMapping", "POST"),
        ("@PutMapping", "PUT"),
        ("@PatchMapping", "PATCH"),
        ("@DeleteMapping", "DELETE"),
    ]
    .into_iter()
    .find(|(mapping, _)| text.starts_with(mapping))?;
    let arguments = text.strip_prefix(mapping)?.trim_start();
    let path = first_quoted_route(arguments)?;
    Some(RouteCandidate {
        verb,
        path,
        handler_names: Vec::new(),
        start_line: annotation.start_position().row as u32 + 1,
        end_line: annotation.end_position().row as u32 + 1,
        start_column: annotation.start_position().column as u32,
        end_column: annotation.end_position().column as u32,
    })
}

fn is_known_route_receiver(receiver: &str) -> bool {
    let receiver = receiver.trim();
    let terminal = receiver
        .rsplit('.')
        .next()
        .unwrap_or(receiver)
        .to_ascii_lowercase();
    matches!(
        terminal.as_str(),
        "app" | "api" | "router" | "route" | "routes" | "server" | "fastify" | "hono"
    ) || terminal.ends_with("router")
        || terminal.ends_with("routes")
}

fn route_path(node: Node<'_>, source: &[u8]) -> Option<String> {
    let text = node_text(node, source).trim();
    match node.kind() {
        "string" | "template_string" => unquote_route(text),
        kind if kind.contains("regex") => Some(text.to_string()),
        _ if text.starts_with('/') && text[1..].contains('/') => Some(text.to_string()),
        _ => None,
    }
}

fn unquote_route(text: &str) -> Option<String> {
    let quote = text.chars().next()?;
    if !matches!(quote, '\'' | '"' | '`') || !text.ends_with(quote) || text.len() < 2 {
        return None;
    }
    Some(text[quote.len_utf8()..text.len() - quote.len_utf8()].to_string())
}

fn first_quoted_route(text: &str) -> Option<String> {
    let start = text.find(&['\'', '"'][..])?;
    let remainder = &text[start..];
    let quote = remainder.chars().next()?;
    let mut escaped = false;
    for (index, character) in remainder.char_indices().skip(1) {
        if character == quote && !escaped {
            return Some(remainder[quote.len_utf8()..index].to_string());
        }
        escaped = character == '\\' && !escaped;
        if character != '\\' {
            escaped = false;
        }
    }
    None
}

fn direct_handler_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    (node.kind() == "identifier").then(|| node_text(node, source).to_string())
}

fn node_text<'a>(node: Node<'_>, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.start_byte()..node.end_byte()]).unwrap_or_default()
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

    #[test]
    fn recognizes_route_templates_and_regexes_but_not_query_parameters() {
        let bindings = bindings(
            "routes.ts",
            Language::TypeScript,
            r#"
const range = searchParams.get("range");
app.get(`/api/${version}/users`, getUsers);
router.get(/^\/api\/v\d+\/items$/, getItems);
"#,
        );

        let names = bindings
            .iter()
            .map(|binding| binding.endpoint.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "GET /api/${version}/users",
                "GET /^\\/api\\/v\\d+\\/items$/"
            ]
        );
        assert!(!names.iter().any(|name| name.contains("range")));
    }
}
