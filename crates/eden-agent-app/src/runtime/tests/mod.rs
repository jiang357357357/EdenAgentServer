mod compaction;
mod directed;
mod event_policy;
mod turns;

use super::context::{RuntimeLoopHooks, conversation_entries};
use super::event::annotate_agent_event;
use super::message::build_user_message;
use super::tool_policy::tools_for_profile;
use super::{RuntimeInner, SessionRuntime};
use crate::prompt;
use async_trait::async_trait;
use eden_agent_core::{
    AgentContext, AgentEvent, AssistantMessage, EventEmitter, LoopHooks, Message, ModelAdapter,
    ModelError, ModelOutput, ModelRequest, ModelSpec, NoopToolHooks, ToolDefinition, ToolRegistry,
};
use eden_agent_domain::{SessionId, TurnId};
use eden_agent_store::{EventRecord, Store};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, RwLock},
    time::Duration,
};
use tokio::sync::{Mutex, broadcast};
use tokio_util::sync::CancellationToken;

const TEST_EVENT_TIMEOUT: Duration = Duration::from_secs(10);

struct RecordingModel {
    requests: StdMutex<Vec<ModelRequest>>,
}

struct DirectorModel {
    requests: StdMutex<Vec<ModelRequest>>,
}

struct LoopCompactionModel {
    requests: StdMutex<Vec<ModelRequest>>,
}

struct CompactionFailureModel;

struct NamedTool(&'static str);

#[async_trait]
impl eden_agent_core::Tool for NamedTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::direct(self.0, self.0)
    }

    async fn execute(
        &self,
        _call: &eden_agent_core::ToolCall,
        _context: eden_agent_core::ToolCallContext,
    ) -> Result<eden_agent_core::ToolOutput, eden_agent_core::ToolFailure> {
        Ok(eden_agent_core::ToolOutput::text("ok"))
    }
}

struct ReloadableUnsafeTool;

impl eden_agent_core::DynamicToolSource for ReloadableUnsafeTool {
    fn get(&self, name: &str) -> Option<Arc<dyn eden_agent_core::Tool>> {
        match name {
            "skill_process_tool" => Some(Arc::new(NamedTool("skill_process_tool"))),
            "subagent_only_tool" => Some(Arc::new(NamedTool("subagent_only_tool"))),
            _ => None,
        }
    }

    fn direct_definitions(&self) -> Vec<ToolDefinition> {
        let user_tool = ToolDefinition::direct("skill_process_tool", "dynamic process tool");
        let mut subagent_tool =
            ToolDefinition::direct("subagent_only_tool", "subagent-only process tool");
        subagent_tool.source = "skill".to_owned();
        subagent_tool.namespace = "research".to_owned();
        subagent_tool.profiles = vec!["subagent".to_owned()];
        vec![user_tool, subagent_tool]
    }
}

#[async_trait]
impl ModelAdapter for DirectorModel {
    async fn generate(
        &self,
        request: ModelRequest,
        _events: EventEmitter,
        _cancellation: CancellationToken,
    ) -> Result<ModelOutput, ModelError> {
        let purpose = request
            .metadata
            .get("purpose")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let assistant_id = request
            .metadata
            .get("primaryAssistantId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        self.requests.lock().expect("requests").push(request);
        let text = match purpose.as_str() {
                "companion_director" => r#"{"scene":{"domain":"social","interactionType":"conversation","confidence":0.9,"summary":"共同回应"},"execution":{"mode":"ensemble","leadAssistantID":1,"toolOwnerAssistantID":null,"observationStrategy":"on_demand"},"beats":[{"assistantID":1,"intent":"先回应","speechAct":"respond","addressTo":"user"},{"assistantID":2,"intent":"承接补充","speechAct":"react","addressTo":"assistant:1","replyToBeat":0}]}"#.to_owned(),
                "automatic_memory_extraction" => r#"{"memories":[]}"#.to_owned(),
                _ => format!("reply-from-{assistant_id}"),
            };
        Ok(ModelOutput::complete(AssistantMessage::text(text)))
    }
}

#[async_trait]
impl ModelAdapter for RecordingModel {
    async fn generate(
        &self,
        request: ModelRequest,
        _events: EventEmitter,
        _cancellation: CancellationToken,
    ) -> Result<ModelOutput, ModelError> {
        self.requests.lock().expect("requests").push(request);
        let mut message = AssistantMessage::text("done");
        message.usage = Some(json!({
            "input": 19_000,
            "output": 100,
            "totalTokens": 19_100,
            "cacheRead": 16_384,
            "cacheMiss": 2_616,
        }));
        Ok(ModelOutput::complete(message))
    }
}

#[async_trait]
impl ModelAdapter for LoopCompactionModel {
    async fn generate(
        &self,
        request: ModelRequest,
        _events: EventEmitter,
        _cancellation: CancellationToken,
    ) -> Result<ModelOutput, ModelError> {
        self.requests.lock().expect("requests").push(request);
        Ok(ModelOutput::complete(AssistantMessage::text(
            "checkpoint: preserve completed tool work and continue the active task",
        )))
    }
}

#[async_trait]
impl ModelAdapter for CompactionFailureModel {
    async fn generate(
        &self,
        request: ModelRequest,
        _events: EventEmitter,
        _cancellation: CancellationToken,
    ) -> Result<ModelOutput, ModelError> {
        assert_eq!(request.metadata["purpose"], "context_compaction");
        Err(ModelError::new(
            "compaction_failed",
            "summary provider failed",
        ))
    }
}

async fn wait_for_completion(events: &mut broadcast::Receiver<EventRecord>) {
    tokio::time::timeout(TEST_EVENT_TIMEOUT, async {
        loop {
            let event = events.recv().await.expect("runtime event");
            if event.event_type == "turn.completed" {
                break;
            }
        }
    })
    .await
    .expect("turn completion timeout");
}
