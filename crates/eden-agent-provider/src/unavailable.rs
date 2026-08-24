use async_trait::async_trait;
use eden_agent_core::{EventEmitter, ModelAdapter, ModelError, ModelOutput, ModelRequest};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub struct UnavailableProvider {
    reason: Arc<str>,
}

impl UnavailableProvider {
    #[must_use]
    pub fn new(reason: impl Into<Arc<str>>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

#[async_trait]
impl ModelAdapter for UnavailableProvider {
    async fn generate(
        &self,
        _request: ModelRequest,
        _events: EventEmitter,
        _cancellation: CancellationToken,
    ) -> Result<ModelOutput, ModelError> {
        Err(ModelError::new(
            "provider_unavailable",
            self.reason.as_ref(),
        ))
    }
}
