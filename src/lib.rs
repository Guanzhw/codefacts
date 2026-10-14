//! CodeFacts — local, source-backed code facts for coding agents.
//!
//! The runtime exposes the indexing core and read-only exploration/fact
//! workflows. Upstream provenance is recorded in `UPSTREAM.md`.

pub mod cli;
pub mod db;
pub mod error;
pub mod graph;
pub mod indexer;
pub mod lsp;
pub mod mcp;
mod presentation;
pub mod resolution;
pub mod service;
pub mod types;

pub use service::{ExploreOptions, ExploreRead};
