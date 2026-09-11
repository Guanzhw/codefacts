# Source evidence pack: extraction-failure diagnosis

Prepared offline; no agent run or correctness improvement is claimed.
This is investigator-selected evidence, not a CodeFacts retrieval result.
Source snapshot: `76bae6820c3032e952dbfb5aeb8560b949af185c`.

## Questions for a future separately frozen diagnostic

Original question:

After editing a source file, parsing succeeds but relationship extraction fails. Which previous facts remain queryable, and how does an MCP caller learn that the index is incomplete? Explain the behavior and cite source and regression coverage.

Neutral question:

In this snapshot, a source file was changed. Parsing succeeds, but relationship extraction returns an error. What happens to the MCP request and to previously stored facts? Cite the implementation and accurately scoped regression coverage.

Keep model, evidence, output limit and grading fixed across question wordings.
Each run receives only its assigned question and the identical source blocks;
omit the alternative question and these experimental labels from its input.
This pair would test comprehension with provided evidence and sensitivity to
wording. It would not estimate a retrieval change's causal effect: that requires
a separate contemporaneous comparison with the same question and configuration.
No model run is part of this artifact preparation.

## src/indexer/pipeline.rs:220-275

```text
220:                 if incremental {
221:                     if let Some(stored) = stored_hashes.get(&rel_path) {
222:                         if stored == &content_hash {
223:                             skip_counts.unchanged.fetch_add(1, Ordering::Relaxed);
224:                             return None;
225:                         }
226:                     }
227:                 }
228: 
229:                 // Detect language
230:                 let language = CodeParser::detect_language(&rel_path)
231:                     .expect("collect_files returns supported source paths");
232: 
233:                 let (mut nodes, endpoints, markdown_edges, tree) = if language == Language::Markdown
234:                 {
235:                     let extraction = extract_markdown(&rel_path, &source_text);
236:                     (extraction.nodes, Vec::new(), extraction.edges, None)
237:                 } else {
238:                     // Parse with a thread-local Parser (Parser is NOT Send/Sync)
239:                     let parser = CodeParser::new();
240:                     let tree = match parser.parse(&source_text, language) {
241:                         Ok(t) => t,
242:                         Err(_) => {
243:                             skip_counts.parse_failed.fetch_add(1, Ordering::Relaxed);
244:                             return None;
245:                         }
246:                     };
247:                     let nodes =
248:                         match Extractor::extract_nodes(&tree, &rel_path, language, &source_text) {
249:                             Ok(n) => n,
250:                             Err(_) => {
251:                                 skip_counts.extract_failed.fetch_add(1, Ordering::Relaxed);
252:                                 return None;
253:                             }
254:                         };
255:                     (
256:                         nodes,
257:                         extract_endpoints(&rel_path, language, &source_text, &tree),
258:                         Vec::new(),
259:                         Some(tree),
260:                     )
261:                 };
262:                 nodes.extend(endpoints.iter().map(|binding| binding.endpoint.clone()));
263: 
264:                 Some(FileParseState {
265:                     relative_path: rel_path,
266:                     language,
267:                     content_hash,
268:                     source_text,
269:                     nodes,
270:                     endpoints,
271:                     markdown_edges,
272:                     tree,
273:                 })
274:             })
275:             .collect();
```

## src/indexer/pipeline.rs:326-379

```text
326:         // ---- Pass 2: extract edges & persist (parallel edge extraction) ----
327:         type FileData = (String, Language, String, Vec<CodeNode>, Vec<CodeEdge>);
328:         let edge_results: Vec<Result<FileData>> = parsed
329:             .par_iter()
330:             .map(|state| {
331:                 let mut edges = if state.language == Language::Markdown {
332:                     state.markdown_edges.clone()
333:                 } else {
334:                     // Pass 1 already parsed this exact source and loaded the
335:                     // same language query. Reuse that tree so Pass 2 cannot
336:                     // manufacture a second, divergent source-failure path.
337:                     let tree = state
338:                         .tree
339:                         .as_ref()
340:                         .expect("non-Markdown parse state retains its syntax tree");
341:                     Extractor::extract_edges(
342:                         tree,
343:                         &state.relative_path,
344:                         state.language,
345:                         &state.source_text,
346:                         &state.nodes,
347:                         &node_index,
348:                     )?
349:                 };
350:                 // On a full pass every source file is already present in the
351:                 // in-memory node index. Resolve receiver dispatch here rather
352:                 // than doing a second SQLite-wide relationship rewrite after
353:                 // persistence. This keeps cold indexing proportional to the
354:                 // source pass while still preserving polymorphic candidates.
355:                 edges = resolve_initial_call_candidates(edges, &node_index);
356:                 edges.extend(extract_endpoint_edges(&state.endpoints, &node_index));
357: 
358:                 Ok((
359:                     state.relative_path.clone(),
360:                     state.language,
361:                     state.content_hash.clone(),
362:                     state.nodes.clone(),
363:                     edges,
364:                 ))
365:             })
366:             .collect();
367: 
368:         // ---- Collect edge results ----
369:         let file_data: Vec<FileData> = edge_results.into_iter().collect::<Result<_>>()?;
370: 
371:         // ---- Persist to SQLite (sequential — single connection) ----
372:         // Every mutation, including cleanup and generation metadata, shares
373:         // one store-owned transaction. Failed parsing above never enters it.
374:         let full_pass_complete = !incremental
375:             && skip_counts.failures() == 0
376:             && skip_counts.too_large.load(Ordering::Relaxed) == 0;
377:         let (files_indexed, nodes_created, edges_created, relationships_rebound) =
378:             self.store.with_transaction(|store| {
379:                 for path in &removed_paths {
```

## src/service.rs:257-274

```text
257:     /// Refresh incrementally before every read workflow. That makes each MCP
258:     /// result explicitly fresh, rather than serving a silently stale snapshot.
259:     pub fn refresh(&self) -> Result<Freshness> {
260:         let pipeline = IndexingPipeline::new(&self.store);
261:         let result = pipeline.index_directory(&IndexOptions {
262:             root_dir: self.root.clone(),
263:             incremental: true,
264:         })?;
265:         Ok(freshness(
266:             result,
267:             repository_root_identity(&self.root),
268:             self.store.generation()?,
269:         ))
270:     }
271: 
272:     pub fn map(&self) -> Result<Value> {
273:         let freshness = self.refresh()?;
274:         let stats = self.store.get_stats()?;
```

## src/service.rs:1385-1403

```text
1385: fn freshness(result: IndexResult, repository_root: String, generation: i64) -> Freshness {
1386:     Freshness {
1387:         status: if result.files_failed == 0 && result.files_too_large == 0 {
1388:             "fresh"
1389:         } else {
1390:             "partial"
1391:         },
1392:         repository_root,
1393:         generation,
1394:         files_indexed: result.files_indexed,
1395:         files_skipped: result.files_skipped,
1396:         files_unchanged: result.files_unchanged,
1397:         files_too_large: result.files_too_large,
1398:         files_unreadable: result.files_unreadable,
1399:         files_parse_failed: result.files_parse_failed,
1400:         files_extract_failed: result.files_extract_failed,
1401:         files_failed: result.files_failed,
1402:         relationships_rebound: result.relationships_rebound,
1403:         duration_ms: result.duration_ms,
```

## src/indexer/pipeline.rs:1004-1082

```text
1004:     #[test]
1005:     fn refresh_transaction_rolls_back_replacement_deletion_hashes_and_generation() {
1006:         let source = tempfile::tempdir().unwrap();
1007:         fs::write(
1008:             source.path().join("keep.ts"),
1009:             "export function original(): string { return removed(); }\n",
1010:         )
1011:         .unwrap();
1012:         fs::write(
1013:             source.path().join("remove.ts"),
1014:             "export function removed(): string { return 'old'; }\n",
1015:         )
1016:         .unwrap();
1017: 
1018:         let database_dir = tempfile::tempdir().unwrap();
1019:         let database_path = database_dir.path().join("facts.sqlite");
1020:         let store = GraphStore::new(database_path.to_str().unwrap()).unwrap();
1021:         let pipeline = IndexingPipeline::new(&store);
1022:         pipeline
1023:             .index_directory(&IndexOptions {
1024:                 root_dir: source.path().to_path_buf(),
1025:                 incremental: true,
1026:             })
1027:             .unwrap();
1028: 
1029:         let generation = store.generation().unwrap();
1030:         let keep_hash = store.get_file_hash("keep.ts").unwrap();
1031:         let remove_hash = store.get_file_hash("remove.ts").unwrap();
1032:         let stats = store.get_stats().unwrap();
1033: 
1034:         fs::write(
1035:             source.path().join("keep.ts"),
1036:             "export function changed(): string { return 'new'; }\n",
1037:         )
1038:         .unwrap();
1039:         fs::remove_file(source.path().join("remove.ts")).unwrap();
1040: 
1041:         let trigger_connection = rusqlite::Connection::open(&database_path).unwrap();
1042:         trigger_connection
1043:             .execute_batch(
1044:                 "CREATE TRIGGER fail_generation_update
1045:                  BEFORE UPDATE OF value ON index_metadata
1046:                  WHEN OLD.key = 'generation'
1047:                  BEGIN
1048:                    SELECT RAISE(ABORT, 'injected generation failure');
1049:                  END;",
1050:             )
1051:             .unwrap();
1052:         drop(trigger_connection);
1053: 
1054:         let error = pipeline
1055:             .index_directory(&IndexOptions {
1056:                 root_dir: source.path().to_path_buf(),
1057:                 incremental: true,
1058:             })
1059:             .expect_err("generation failure must abort the refresh");
1060:         assert!(error.to_string().contains("injected generation failure"));
1061: 
1062:         assert_eq!(store.generation().unwrap(), generation);
1063:         assert_eq!(store.get_file_hash("keep.ts").unwrap(), keep_hash);
1064:         assert_eq!(store.get_file_hash("remove.ts").unwrap(), remove_hash);
1065:         assert_eq!(store.get_stats().unwrap().nodes, stats.nodes);
1066:         assert_eq!(store.get_stats().unwrap().edges, stats.edges);
1067:         assert!(store
1068:             .get_nodes_by_file("keep.ts")
1069:             .unwrap()
1070:             .iter()
1071:             .any(|node| node.name == "original"));
1072:         assert!(!store
1073:             .get_nodes_by_file("keep.ts")
1074:             .unwrap()
1075:             .iter()
1076:             .any(|node| node.name == "changed"));
1077:         assert!(store
1078:             .get_nodes_by_file("remove.ts")
1079:             .unwrap()
1080:             .iter()
1081:             .any(|node| node.name == "removed"));
1082:     }
```

## Source file SHA-256

```json
{
  "src/indexer/pipeline.rs": "7b996aeae587e291cc3d5e02805618996f6bd52ce0b39480f7ec91bee9db8633",
  "src/service.rs": "a32c72420e917a1be765d193574d014f94e98b4a6808c999876506f93ad06372"
}
```
