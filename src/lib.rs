//! CodeFacts — local, source-backed code facts for coding agents.
//!
//! The runtime deliberately exposes only the indexing core and the five
//! read-only MCP workflows. Upstream provenance is recorded in `UPSTREAM.md`.

pub mod db;
pub mod error;
pub mod graph;
pub mod indexer;
pub mod lsp;
pub mod mcp;
pub mod resolution;
pub mod service;
pub mod types;
