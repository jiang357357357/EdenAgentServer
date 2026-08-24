use eden_agent_core::ModelSpec;
use serde_json::Value;
use std::sync::Arc;

/// Fully resolved provider configuration produced by an external configuration
/// adapter. Secrets stay in this process-local value and are never serialized.
pub(crate) struct ResolvedModelBinding {
    pub(crate) spec: ModelSpec,
    pub(crate) api_key: Arc<str>,
    pub(crate) base_url: String,
    pub(crate) source: &'static str,
    pub(crate) entity_id: Option<Value>,
    pub(crate) label: String,
}
