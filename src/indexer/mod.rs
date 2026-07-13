//! Tree-sitter indexing pipeline: parse source files and build source facts.

pub mod extractor;
pub mod markdown;
pub mod parser;
pub mod pipeline;

pub use extractor::Extractor;
pub use parser::CodeParser;
pub use pipeline::{IndexOptions, IndexResult, IndexingPipeline};
