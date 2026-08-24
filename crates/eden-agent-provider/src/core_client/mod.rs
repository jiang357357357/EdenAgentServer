use eden_agent_core::ModelError;
use reqwest::Client;
use std::time::Duration;

mod catalog;
mod configuration;
mod model;
mod transport;

#[cfg(test)]
pub(crate) use model::{model_option, resolve_core_model};

#[derive(Clone)]
pub struct CoreModelClient {
    client: Client,
}

impl CoreModelClient {
    pub fn new() -> Result<Self, ModelError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("Eden Agent/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| ModelError::new("core_client", error.to_string()))?;
        Ok(Self { client })
    }
}
