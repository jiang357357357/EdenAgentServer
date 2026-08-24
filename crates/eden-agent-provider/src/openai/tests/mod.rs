use async_trait::async_trait;
use eden_agent_core::{
    AgentEvent, AssistantMessage, ContentBlock, EventEmitter, Message, ModelAdapter, ModelError,
    ModelOutput, ModelRequest, ModelSpec, ToolDefinition, UserContent, event_channel,
};
use serde_json::{Map, Map as JsonMap, Value, json};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::config::OpenAiCompatibleConfig;
use crate::core_client::{model_option, resolve_core_model};
use crate::dynamic::{DynamicModelProvider, ModelBinding};

use super::OpenAiCompatibleProvider;
use super::capabilities::ProviderCapabilities;
use super::messages::text_content;
use super::payload::{chat_payload, responses_payload};
use super::retry::validate_request_budget;
use super::speaker::LeadingSpeakerPrefixFilter;
use super::stream::{StreamAccumulator, parse_chat_response};
use super::usage::normalized_openai_usage;

#[async_trait]
trait TestDynamicCoreConfiguration {
    async fn configure_core_entity(&self, entity: &Value, label: &str)
    -> Result<Value, ModelError>;

    async fn configure_core_entity_for(
        &self,
        session_id: Option<&str>,
        entity: &Value,
        label: &str,
    ) -> Result<Value, ModelError>;

    async fn configure_core_entity_for_actor(
        &self,
        session_id: &str,
        assistant_id: &str,
        entity: &Value,
        label: &str,
    ) -> Result<Value, ModelError>;
}

#[async_trait]
impl TestDynamicCoreConfiguration for DynamicModelProvider {
    async fn configure_core_entity(
        &self,
        entity: &Value,
        label: &str,
    ) -> Result<Value, ModelError> {
        self.configure_resolved_for(None, resolve_core_model(entity, label)?)
            .await
    }

    async fn configure_core_entity_for(
        &self,
        session_id: Option<&str>,
        entity: &Value,
        label: &str,
    ) -> Result<Value, ModelError> {
        self.configure_resolved_for(session_id, resolve_core_model(entity, label)?)
            .await
    }

    async fn configure_core_entity_for_actor(
        &self,
        session_id: &str,
        assistant_id: &str,
        entity: &Value,
        label: &str,
    ) -> Result<Value, ModelError> {
        self.configure_resolved_for_actor(
            session_id,
            assistant_id,
            resolve_core_model(entity, label)?,
        )
        .await
    }
}

#[derive(Clone)]
struct FakeVisionProvider;

#[async_trait]
impl ModelAdapter for FakeVisionProvider {
    async fn generate(
        &self,
        _request: ModelRequest,
        _events: EventEmitter,
        _cancellation: CancellationToken,
    ) -> Result<ModelOutput, ModelError> {
        Ok(ModelOutput::complete(AssistantMessage::text(
            "画面中显示错误日志窗口。",
        )))
    }
}

fn request(messages: Vec<Message>) -> ModelRequest {
    ModelRequest {
        model: ModelSpec {
            id: "test-model".to_owned(),
            provider: "test".to_owned(),
            ..ModelSpec::default()
        },
        system_prompt: "Be concise".to_owned(),
        messages,
        tools: vec![ToolDefinition::direct("read", "Read a file")],
        session_id: None,
        metadata: json!({}),
    }
}

fn assistant_message_with_speaker(
    text: &str,
    assistant_id: &str,
    assistant_name: &str,
    character_name: &str,
) -> Message {
    let mut message = AssistantMessage::text(text);
    message.extra.insert(
        "speaker".to_owned(),
        json!({
            "assistantID":assistant_id,
            "assistantName":assistant_name,
            "characterName":character_name,
        }),
    );
    Message::Assistant(message)
}

async fn test_stream_provider(
    bodies: Vec<&'static str>,
    max_retries: u32,
) -> (OpenAiCompatibleProvider, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test server");
    let address = listener.local_addr().expect("test server address");
    let task = tokio::spawn(async move {
        for body in bodies {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let read = socket.read(&mut chunk).await.expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write response");
            socket.shutdown().await.expect("close response");
        }
    });
    let provider = OpenAiCompatibleProvider::new(OpenAiCompatibleConfig {
        model: request(Vec::new()).model,
        api_key: Arc::from("test-key"),
        base_url: format!("http://{address}/v1"),
        max_retries,
        request_timeout: Duration::from_secs(5),
    })
    .expect("provider");
    (provider, task)
}

mod config;
mod dynamic;
mod payload;
mod stream;
