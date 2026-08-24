//! Model-provider implementations hosted by the Rust server.

mod binding;
mod config;
mod core_client;
mod dynamic;
mod openai;
mod support;
mod unavailable;

pub use config::{OpenAiCompatibleConfig, model_spec_from_env};
pub use core_client::CoreModelClient;
pub use dynamic::{DynamicModelProvider, ModelAvailability, SessionModelSnapshot};
pub use openai::OpenAiCompatibleProvider;
pub use unavailable::UnavailableProvider;
