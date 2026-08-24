use crate::{
    HostServices,
    support::{integer, limit, output, store_failure, string},
};
use async_trait::async_trait;
use eden_agent_core::{
    PermissionRequest, Tool, ToolCall, ToolCallContext, ToolDefinition, ToolFailure, ToolOutput,
};
use eden_agent_domain::SessionId;
use eden_agent_store::Store;
use regex::Regex;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Clone, Copy)]
enum MemoryAction {
    Remember,
    Search,
    Update,
    Forget,
}
impl MemoryAction {
    const ALL: [Self; 4] = [Self::Remember, Self::Search, Self::Update, Self::Forget];
}
struct MemoryTool {
    host: HostServices,
    action: MemoryAction,
}

#[async_trait]
impl Tool for MemoryTool {
    fn definition(&self) -> ToolDefinition {
        let (name, description, required) = match self.action {
            MemoryAction::Remember => (
                "remember_memory",
                "Store durable long-term memory",
                vec!["content"],
            ),
            MemoryAction::Search => ("search_memories", "Search long-term memory", vec![]),
            MemoryAction::Update => (
                "update_memory",
                "Correct long-term memory",
                vec!["id", "content"],
            ),
            MemoryAction::Forget => ("forget_memory", "Delete long-term memory", vec!["id"]),
        };
        let mut definition = ToolDefinition::direct(name, description);
        definition.parameters = json!({"type":"object","required":required,"properties":{"id":{"type":"integer"},"content":{"type":"string"},"query":{"type":"string"},"kind":{"type":"string","enum":["preference","fact","decision","procedure"]},"limit":{"type":"integer"}}});
        definition
    }
    fn permission_request(&self, arguments: &Value) -> Option<PermissionRequest> {
        if matches!(self.action, MemoryAction::Search) {
            None
        } else {
            Some(PermissionRequest {
                permission: "memory.write".to_owned(),
                patterns: vec![
                    arguments
                        .get("id")
                        .map_or_else(|| "new".to_owned(), Value::to_string),
                ],
                always: vec!["*".to_owned()],
            })
        }
    }
    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let args = &call.arguments;
        if !matches!(self.action, MemoryAction::Search) && is_subagent(&context) {
            return Err(ToolFailure::new(
                "blocked",
                "子智能体只能检索长期记忆；写入、修改和遗忘必须由主智能体执行",
            ));
        }
        let (scope_type, scope_key) = memory_scope(&self.host.store, &context).await?;
        let result = match self.action {
            MemoryAction::Remember => {
                let content = safe_memory(&string(args, "content")?)?;
                serde_json::to_value(
                    self.host
                        .store
                        .create_memory(
                            &content,
                            args.get("kind").and_then(Value::as_str).unwrap_or("fact"),
                            &scope_type,
                            &scope_key,
                            context.session_id.as_deref().unwrap_or(""),
                            json!({"source":"explicit_tool","agentCharacterId":scope_key}),
                        )
                        .await
                        .map_err(store_failure)?,
                )
                .unwrap_or_default()
            }
            MemoryAction::Search => serde_json::to_value(
                self.host
                    .store
                    .search_memories_in_scope(
                        &scope_type,
                        &scope_key,
                        args.get("query").and_then(Value::as_str),
                        limit(args),
                    )
                    .await
                    .map_err(store_failure)?,
            )
            .unwrap_or_default(),
            MemoryAction::Update => {
                let content = safe_memory(&string(args, "content")?)?;
                ensure_memory_scope(
                    &self.host.store,
                    integer(args, "id")?,
                    &scope_type,
                    &scope_key,
                )
                .await?;
                serde_json::to_value(
                    self.host
                        .store
                        .update_memory(
                            integer(args, "id")?,
                            &content,
                            args.get("kind").and_then(Value::as_str),
                        )
                        .await
                        .map_err(store_failure)?,
                )
                .unwrap_or_default()
            }
            MemoryAction::Forget => {
                ensure_memory_scope(
                    &self.host.store,
                    integer(args, "id")?,
                    &scope_type,
                    &scope_key,
                )
                .await?;
                self.host
                    .store
                    .delete_memory(integer(args, "id")?)
                    .await
                    .map_err(store_failure)?;
                json!({"deleted":true})
            }
        };
        Ok(output(result))
    }
}

fn is_subagent(context: &ToolCallContext) -> bool {
    context
        .metadata
        .get("agentPath")
        .and_then(Value::as_str)
        .is_some_and(|path| !path.trim().is_empty() && path != "/root")
}

async fn memory_scope(
    store: &Store,
    context: &ToolCallContext,
) -> Result<(String, String), ToolFailure> {
    let session_id = context
        .session_id
        .as_deref()
        .ok_or_else(|| ToolFailure::new("session_required", "长期记忆操作需要当前会话"))?
        .parse::<SessionId>()
        .map_err(|error| ToolFailure::new("invalid_session", error.to_string()))?;
    let session = store.get_session(session_id).await.map_err(store_failure)?;
    let character_id = session
        .participants
        .first()
        .and_then(|participant| scalar_id(participant.get("characterId")))
        .or_else(|| {
            session
                .participants
                .first()
                .and_then(|participant| participant.get("profile"))
                .and_then(|profile| profile.get("character"))
                .and_then(|character| scalar_id(character.get("id")))
        })
        .ok_or_else(|| {
            ToolFailure::new(
                "character_required",
                "当前会话没有绑定角色，不能访问角色长期记忆",
            )
        })?;
    Ok(("agent_character".to_owned(), character_id))
}

async fn ensure_memory_scope(
    store: &Store,
    id: i64,
    scope_type: &str,
    scope_key: &str,
) -> Result<(), ToolFailure> {
    let memory = store.get_memory(id).await.map_err(store_failure)?;
    if memory.scope_type != scope_type || memory.scope_key != scope_key {
        return Err(ToolFailure::new(
            "memory_scope_denied",
            "目标记忆不属于当前角色",
        ));
    }
    Ok(())
}

fn scalar_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn safe_memory(content: &str) -> Result<String, ToolFailure> {
    let content = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let secrets =
        Regex::new(r"(?i)(sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|token|password|密码|密钥|令牌)\s*[:=：]\s*\S+)")
            .expect("valid regex");
    if secrets.is_match(&content) {
        Err(ToolFailure::new(
            "secret_rejected",
            "credentials cannot be stored in long-term memory",
        ))
    } else {
        Ok(content)
    }
}

pub(super) fn tools(host: HostServices) -> Vec<Arc<dyn Tool>> {
    MemoryAction::ALL
        .iter()
        .copied()
        .map(|action| {
            Arc::new(MemoryTool {
                host: host.clone(),
                action,
            }) as Arc<dyn Tool>
        })
        .collect()
}
