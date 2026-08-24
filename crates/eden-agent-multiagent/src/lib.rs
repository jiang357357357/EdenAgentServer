//! Durable, bounded sub-agent execution owned by the Rust host.

mod catalog;

pub use catalog::{SubagentBudget, SubagentCatalog, SubagentDefinition, SubagentToolPolicy};

use async_trait::async_trait;
use eden_agent_core::{
    AfterToolCall, AfterToolCallResult, AgentContext, AgentError, AgentLoop, AgentLoopConfig,
    AssistantMessage, BeforeToolCall, BeforeToolCallResult, ContentBlock, LoopControl, LoopHooks,
    LoopTurnContext, LoopTurnUpdate, Message, ModelAdapter, ModelSpec, Tool, ToolCall,
    ToolCallContext, ToolDefinition, ToolFailure, ToolHooks, ToolOutput, ToolRegistry,
    event_channel,
};
use eden_agent_domain::{AgentId, SessionId, TurnId};
use eden_agent_store::{AgentThreadRecord, Store, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, RwLock},
};
use thiserror::Error;
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;

pub type SkillPromptResolver =
    Arc<dyn Fn(&[String]) -> Result<String, String> + Send + Sync + 'static>;

#[derive(Debug, Error)]
pub enum MultiAgentError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("sub-agent task name is invalid")]
    InvalidTaskName,
    #[error("sub-agent execution limit is closed")]
    Closed,
    #[error("sub-agent loop failed: {0}")]
    Agent(String),
    #[error("sub-agent state encoding failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct MultiAgentService {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    model_spec: ModelSpec,
    model: Arc<dyn ModelAdapter>,
    tools: ToolRegistry,
    hooks: Arc<dyn ToolHooks>,
    system_prompt: Arc<RwLock<String>>,
    concurrency: Arc<Semaphore>,
    active: Mutex<HashMap<AgentId, ActiveAgent>>,
    catalog: Arc<RwLock<SubagentCatalog>>,
    workspace_root: Arc<RwLock<PathBuf>>,
    skill_prompt_resolver: SkillPromptResolver,
}

#[derive(Clone)]
struct ActiveAgent {
    cancellation: CancellationToken,
    control: LoopControl,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeConfig {
    definition: SubagentDefinition,
    budget: SubagentBudget,
    policy: SubagentToolPolicy,
    model: ModelSpec,
    depth: u32,
    parent_path: String,
    #[serde(default)]
    parent_history: Vec<Message>,
    #[serde(default)]
    skill_prompt: String,
    #[serde(default = "default_workspace_root")]
    workspace_root: PathBuf,
}

fn default_workspace_root() -> PathBuf {
    PathBuf::from(".")
}

impl MultiAgentService {
    #[must_use]
    pub fn new(
        store: Store,
        model_spec: ModelSpec,
        model: Arc<dyn ModelAdapter>,
        tools: ToolRegistry,
        hooks: Arc<dyn ToolHooks>,
        system_prompt: impl Into<String>,
        max_concurrency: usize,
    ) -> Self {
        let workspace_root = PathBuf::from(".");
        let catalog = SubagentCatalog::discover(&workspace_root, None)
            .expect("builtin sub-agent catalog must be valid");
        Self::new_with_catalog(
            store,
            model_spec,
            model,
            tools,
            hooks,
            system_prompt,
            max_concurrency,
            workspace_root,
            catalog,
        )
    }

    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub fn new_with_catalog(
        store: Store,
        model_spec: ModelSpec,
        model: Arc<dyn ModelAdapter>,
        tools: ToolRegistry,
        hooks: Arc<dyn ToolHooks>,
        system_prompt: impl Into<String>,
        max_concurrency: usize,
        workspace_root: PathBuf,
        catalog: SubagentCatalog,
    ) -> Self {
        Self::new_with_catalog_and_skills(
            store,
            model_spec,
            model,
            tools,
            hooks,
            system_prompt,
            max_concurrency,
            workspace_root,
            catalog,
            Arc::new(|names| {
                Ok(if names.is_empty() {
                    String::new()
                } else {
                    format!("Configured skills: {}", names.join(", "))
                })
            }),
        )
    }

    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub fn new_with_catalog_and_skills(
        store: Store,
        model_spec: ModelSpec,
        model: Arc<dyn ModelAdapter>,
        tools: ToolRegistry,
        hooks: Arc<dyn ToolHooks>,
        system_prompt: impl Into<String>,
        max_concurrency: usize,
        workspace_root: PathBuf,
        catalog: SubagentCatalog,
        skill_prompt_resolver: SkillPromptResolver,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                model_spec,
                model,
                tools,
                hooks,
                system_prompt: Arc::new(RwLock::new(system_prompt.into())),
                concurrency: Arc::new(Semaphore::new(max_concurrency.max(1))),
                active: Mutex::new(HashMap::new()),
                catalog: Arc::new(RwLock::new(catalog)),
                workspace_root: Arc::new(RwLock::new(workspace_root)),
                skill_prompt_resolver,
            }),
        }
    }

    pub fn set_system_prompt(&self, system_prompt: impl Into<String>) {
        *self
            .inner
            .system_prompt
            .write()
            .unwrap_or_else(|value| value.into_inner()) = system_prompt.into();
    }

    /// Reconfigure future sub-agent spawns after a workspace switch. Running
    /// and durable queued agents keep the workspace snapshot in their config.
    pub fn reconfigure_workspace(&self, workspace_root: PathBuf, catalog: SubagentCatalog) {
        *self
            .inner
            .catalog
            .write()
            .unwrap_or_else(|value| value.into_inner()) = catalog;
        *self
            .inner
            .workspace_root
            .write()
            .unwrap_or_else(|value| value.into_inner()) = workspace_root;
    }

    pub async fn spawn(
        &self,
        session_id: SessionId,
        task_name: &str,
        prompt: &str,
        role: &str,
    ) -> Result<AgentThreadRecord, MultiAgentError> {
        self.spawn_from(
            session_id, None, "/root", task_name, prompt, role, true, None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn spawn_from(
        &self,
        session_id: SessionId,
        parent_id: Option<AgentId>,
        parent_path: &str,
        task_name: &str,
        prompt: &str,
        role: &str,
        fork_history: bool,
        coordination_batch_id: Option<String>,
    ) -> Result<AgentThreadRecord, MultiAgentError> {
        let task_name = normalize_task_name(task_name)?;
        if prompt.trim().is_empty() {
            return Err(MultiAgentError::Agent(
                "sub-agent prompt is empty".to_owned(),
            ));
        }
        let definition = self
            .inner
            .catalog
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .resolve(if role.trim().is_empty() {
                "general"
            } else {
                role
            })
            .map_err(MultiAgentError::Agent)?;
        let (depth, budget, policy, parent_deadline, parent_path, workspace_root) =
            if let Some(parent_id) = parent_id {
                let parent = self.inner.store.get_agent_thread(parent_id).await?;
                if parent.session_id != session_id {
                    return Err(MultiAgentError::Agent(
                        "parent sub-agent belongs to another session".to_owned(),
                    ));
                }
                let config: AgentRuntimeConfig = serde_json::from_value(parent.config.clone())?;
                (
                    config.depth.saturating_add(1),
                    config.budget.restrict(&definition.budget),
                    config
                        .policy
                        .restrict(&definition.policy)
                        .map_err(MultiAgentError::Agent)?,
                    parent.deadline_at,
                    parent.agent_path,
                    config.workspace_root,
                )
            } else {
                (
                    1,
                    definition.budget.clone(),
                    definition.policy.clone(),
                    None,
                    parent_path.to_owned(),
                    self.inner
                        .workspace_root
                        .read()
                        .unwrap_or_else(|value| value.into_inner())
                        .clone(),
                )
            };
        if depth > 3 {
            return Err(MultiAgentError::Agent(
                "sub-agent nesting depth exceeds 3".to_owned(),
            ));
        }
        let existing = self.inner.store.list_agent_threads(session_id).await?;
        let parent_path = parent_path.trim_end_matches('/');
        let mut path = format!("{parent_path}/{task_name}");
        let mut suffix = 2;
        while existing.iter().any(|agent| agent.agent_path == path) {
            path = format!("{parent_path}/{task_name}_{suffix}");
            suffix += 1;
        }
        let deadline = now_ms().saturating_add(
            i64::try_from(budget.timeout_seconds.saturating_mul(1_000)).unwrap_or(i64::MAX),
        );
        let deadline = Some(parent_deadline.map_or(deadline, |parent| parent.min(deadline)));
        let parent_history = if fork_history {
            fork_parent_history(&self.inner.store, session_id).await?
        } else {
            Vec::new()
        };
        let mut skill_names = definition.skills.clone();
        if !skill_names.iter().any(|name| name == "multi-agent") {
            skill_names.push("multi-agent".to_owned());
        }
        let skill_prompt =
            (self.inner.skill_prompt_resolver)(&skill_names).map_err(MultiAgentError::Agent)?;
        let config = AgentRuntimeConfig {
            model: definition.model_spec(&self.inner.model_spec),
            definition: definition.clone(),
            budget,
            policy,
            depth,
            parent_path: parent_path.to_owned(),
            parent_history,
            skill_prompt,
            workspace_root,
        };
        let record = self
            .inner
            .store
            .create_agent_thread_configured(
                session_id,
                parent_id,
                path,
                task_name,
                definition.name,
                prompt,
                serde_json::to_value(config)?,
                deadline,
                coordination_batch_id,
            )
            .await?;
        self.launch(record.clone());
        Ok(record)
    }

    fn launch(&self, record: AgentThreadRecord) {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            if let Err(error) = run_agent(Arc::clone(&inner), record.clone()).await {
                let failed = inner
                    .store
                    .fail_agent_thread(record.id, error.to_string())
                    .await;
                if let Ok(failed) = failed {
                    let parent_path =
                        serde_json::from_value::<AgentRuntimeConfig>(failed.config.clone())
                            .map(|config| config.parent_path)
                            .unwrap_or_else(|_| "/root".to_owned());
                    let _ = inner
                        .store
                        .enqueue_agent_message(
                            failed.session_id,
                            &failed.agent_path,
                            parent_path,
                            format!(
                                "Sub-agent {} failed: {}",
                                failed.agent_path,
                                failed.error.as_deref().unwrap_or("unknown error")
                            ),
                            "completion",
                            false,
                            json!({"agentId":failed.id,"status":failed.status,"error":failed.error}),
                        )
                        .await;
                }
            }
            inner.active.lock().await.remove(&record.id);
        });
    }

    pub async fn list(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<AgentThreadRecord>, MultiAgentError> {
        Ok(self.inner.store.list_agent_threads(session_id).await?)
    }

    pub async fn resume(&self) -> Result<usize, MultiAgentError> {
        let records = self.inner.store.recover_agent_threads().await?;
        let count = records.len();
        for record in records {
            self.launch(record);
        }
        Ok(count)
    }

    pub async fn interrupt(&self, id: AgentId) -> Result<AgentThreadRecord, MultiAgentError> {
        if let Some(active) = self.inner.active.lock().await.get(&id) {
            active.cancellation.cancel();
        }
        let interrupted = self.inner.store.interrupt_agent_thread(id).await?;
        let parent_path = serde_json::from_value::<AgentRuntimeConfig>(interrupted.config.clone())
            .map(|config| config.parent_path)
            .unwrap_or_else(|_| "/root".to_owned());
        let _ = self
            .inner
            .store
            .enqueue_agent_message(
                interrupted.session_id,
                &interrupted.agent_path,
                parent_path,
                format!("Sub-agent {} was interrupted", interrupted.agent_path),
                "completion",
                false,
                json!({"agentId":interrupted.id,"status":interrupted.status}),
            )
            .await;
        Ok(interrupted)
    }

    pub async fn send_message(
        &self,
        id: AgentId,
        content: &str,
        trigger_turn: bool,
    ) -> Result<AgentThreadRecord, MultiAgentError> {
        let record = self.inner.store.get_agent_thread(id).await?;
        let message = self
            .inner
            .store
            .enqueue_agent_message(
                record.session_id,
                "/root",
                &record.agent_path,
                content,
                if trigger_turn { "followup" } else { "message" },
                trigger_turn,
                json!({}),
            )
            .await?;
        if let Some(active) = self.inner.active.lock().await.get(&id).cloned() {
            let prompt = Message::user(format!(
                "Message from {}:\n{}",
                message.sender_path, message.content
            ));
            if trigger_turn {
                active.control.follow_up.enqueue(prompt);
            } else {
                active.control.steering.enqueue(prompt);
            }
            self.inner
                .store
                .consume_agent_messages(&[message.id])
                .await?;
            return Ok(record);
        }
        if trigger_turn
            && matches!(
                record.status.as_str(),
                "completed" | "failed" | "interrupted"
            )
        {
            let queued = self.inner.store.requeue_agent_thread(id, content).await?;
            self.launch(queued.clone());
            return Ok(queued);
        }
        Ok(record)
    }

    #[must_use]
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        vec![
            Arc::new(SpawnAgentTool(self.clone())),
            Arc::new(SendMessageTool(self.clone())),
            Arc::new(FollowupAgentTool(self.clone())),
            Arc::new(ListAgentsTool(self.clone())),
            Arc::new(InterruptAgentTool(self.clone())),
            Arc::new(WaitAgentTool(self.clone())),
            Arc::new(SpawnAgentsTool(self.clone())),
        ]
    }
}

async fn run_agent(inner: Arc<Inner>, record: AgentThreadRecord) -> Result<(), MultiAgentError> {
    let _permit = Arc::clone(&inner.concurrency)
        .acquire_owned()
        .await
        .map_err(|_| MultiAgentError::Closed)?;
    let runtime_config = match serde_json::from_value::<AgentRuntimeConfig>(record.config.clone()) {
        Ok(config) => config,
        Err(_) => {
            let definition = inner
                .catalog
                .read()
                .unwrap_or_else(|value| value.into_inner())
                .resolve(&record.role)
                .map_err(MultiAgentError::Agent)?;
            AgentRuntimeConfig {
                model: definition.model_spec(&inner.model_spec),
                budget: definition.budget.clone(),
                policy: definition.policy.clone(),
                definition,
                depth: 1,
                parent_path: "/root".to_owned(),
                parent_history: Vec::new(),
                skill_prompt: String::new(),
                workspace_root: inner
                    .workspace_root
                    .read()
                    .unwrap_or_else(|value| value.into_inner())
                    .clone(),
            }
        }
    };
    let deadline = record.deadline_at.unwrap_or_else(|| {
        now_ms().saturating_add(
            i64::try_from(runtime_config.budget.timeout_seconds.saturating_mul(1_000))
                .unwrap_or(i64::MAX),
        )
    });
    inner.store.start_agent_thread(record.id).await?;
    let cancellation = CancellationToken::new();
    let control = LoopControl::default();
    inner.active.lock().await.insert(
        record.id,
        ActiveAgent {
            cancellation: cancellation.clone(),
            control: control.clone(),
        },
    );
    let turn_id = TurnId::new();
    let base_system_prompt = inner
        .system_prompt
        .read()
        .unwrap_or_else(|value| value.into_inner())
        .clone();
    let mut context = AgentContext {
        system_prompt: format!(
            "{}\n\n# Sub-agent identity\nPath: {}\nRole: {} — {}\n{}\nWorkspace: {}\nSkills requested by this role: {}\n\n# Preloaded skill snapshot\n{}\n\nSandbox policy: {}. Runtime budgets: {} turns, {} tool calls, {} tokens, {} seconds. Return a concise, verifiable result to the parent agent; never ask the user directly.",
            base_system_prompt,
            record.agent_path,
            runtime_config.definition.name,
            runtime_config.definition.description,
            runtime_config.definition.developer_instructions,
            runtime_config.workspace_root.display(),
            if runtime_config.definition.skills.is_empty() {
                "none".to_owned()
            } else {
                runtime_config.definition.skills.join(", ")
            },
            if runtime_config.skill_prompt.is_empty() {
                "No role-specific skill content.".to_owned()
            } else {
                runtime_config.skill_prompt.clone()
            },
            runtime_config.policy.sandbox_mode,
            runtime_config.budget.max_turns,
            runtime_config.budget.max_tool_calls,
            runtime_config.budget.max_tokens,
            runtime_config.budget.timeout_seconds,
        ),
        messages: runtime_config.parent_history.clone(),
        metadata: json!({
            "sessionId": record.session_id,
            "turnId": turn_id,
            "agentId": record.id,
            "agentPath": record.agent_path,
            "promptProfile": "subagent",
        }),
    };
    let resumed = if let Some(saved) = &record.context {
        if let Ok(saved) = serde_json::from_value::<AgentContext>(saved.clone()) {
            context.messages = saved.messages;
            true
        } else {
            false
        }
    } else {
        false
    };
    let terminal_checkpoint = resumed && context.messages.last().is_some_and(Message::is_assistant);
    if deadline <= now_ms() && !terminal_checkpoint {
        return Err(MultiAgentError::Agent(
            "sub-agent lifetime budget expired".to_owned(),
        ));
    }
    let mailbox = inner
        .store
        .pending_agent_messages(record.session_id, &record.agent_path)
        .await?;
    for message in &mailbox {
        let prompt = Message::user(format!(
            "Message from {}:\n{}",
            message.sender_path, message.content
        ));
        if message.trigger_turn {
            control.follow_up.enqueue(prompt);
        } else {
            control.steering.enqueue(prompt);
        }
    }
    inner
        .store
        .consume_agent_messages(&mailbox.iter().map(|message| message.id).collect::<Vec<_>>())
        .await?;
    let mut config = AgentLoopConfig::new(runtime_config.model.clone(), Arc::clone(&inner.model));
    let mut skill_names = runtime_config
        .definition
        .skills
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    skill_names.insert("multi-agent".to_owned());
    let allowed = inner
        .tools
        .direct_definitions()
        .into_iter()
        .filter(|definition| runtime_config.policy.allows(&definition.name))
        .filter(|definition| {
            if definition.source != "skill" {
                return definition.profiles.is_empty()
                    || definition.profiles.iter().any(|value| value == "subagent");
            }
            skill_names.contains(&definition.namespace)
                && definition.profiles.iter().any(|value| value == "subagent")
        })
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    config.tools = inner.tools.only(allowed);
    config.hooks = Arc::new(BudgetToolHooks {
        inner: Arc::clone(&inner.hooks),
        store: inner.store.clone(),
        agent_id: record.id,
        maximum: runtime_config.budget.max_tool_calls,
    });
    config.loop_hooks = Arc::new(BudgetLoopHooks {
        store: inner.store.clone(),
        agent_id: record.id,
        budget: runtime_config.budget.clone(),
    });
    let used_turns = record
        .usage
        .get("turns")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let remaining_turns = u64::from(runtime_config.budget.max_turns).saturating_sub(used_turns);
    if remaining_turns == 0 && !terminal_checkpoint {
        return Err(MultiAgentError::Agent(
            "sub-agent turn budget exhausted".to_owned(),
        ));
    }
    config.max_steps = u32::try_from(remaining_turns).unwrap_or(u32::MAX);
    config.session_id = Some(record.session_id.to_string());
    let driver = AgentLoop::new(config);
    let (emitter, mut events) = event_channel(256);
    let store = inner.store.clone();
    let event_record = record.clone();
    let persistence = async move {
        while let Some(event) = events.recv().await {
            let payload = serde_json::to_value(&event).unwrap_or_else(|_| json!({}));
            let kind = payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let _ = store
                .append_event(
                    event_record.session_id,
                    None,
                    format!("subagent.agent_{kind}"),
                    json!({"agentId":event_record.id,"agentPath":event_record.agent_path,"event":payload}),
                )
                .await;
        }
    };
    let execution = async {
        if terminal_checkpoint {
            return Ok(eden_agent_core::RunResult {
                new_messages: Vec::new(),
                context,
                turns: 0,
            });
        }
        let remaining = u64::try_from(deadline.saturating_sub(now_ms())).unwrap_or(0);
        tokio::time::timeout(std::time::Duration::from_millis(remaining), async move {
            if resumed && !context.messages.is_empty() {
                driver
                    .continue_from(context, control, cancellation, emitter)
                    .await
            } else {
                driver
                    .run(
                        vec![Message::user(&record.prompt)],
                        context,
                        control,
                        cancellation,
                        emitter,
                    )
                    .await
            }
        })
        .await
        .map_err(|_| AgentError::Hook("sub-agent lifetime budget expired".to_owned()))?
    };
    let (result, ()) = tokio::join!(execution, persistence);
    let result = result.map_err(|error| MultiAgentError::Agent(error.to_string()))?;
    if let Some(error) = result
        .context
        .messages
        .last()
        .and_then(|message| match message {
            Message::Assistant(message) => message.error_message.as_deref(),
            _ => None,
        })
        .map(str::to_owned)
    {
        return Err(MultiAgentError::Agent(error));
    }
    let content = result
        .new_messages
        .iter()
        .rev()
        .chain(result.context.messages.iter().rev())
        .find_map(|message| match message {
            Message::Assistant(message) => Some(
                message
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .unwrap_or_default();
    let completed = inner
        .store
        .complete_agent_thread(
            record.id,
            serde_json::to_value(result.context)?,
            json!({"content":content,"summary":content.chars().take(240).collect::<String>()}),
        )
        .await?;
    let _ = inner
        .store
        .enqueue_agent_message(
            record.session_id,
            &record.agent_path,
            &runtime_config.parent_path,
            format!("Sub-agent {} completed:\n{}", record.agent_path, content),
            "completion",
            false,
            json!({"agentId":record.id,"status":completed.status,"result":completed.result}),
        )
        .await;
    Ok(())
}

struct BudgetToolHooks {
    inner: Arc<dyn ToolHooks>,
    store: Store,
    agent_id: AgentId,
    maximum: u32,
}

#[async_trait]
impl ToolHooks for BudgetToolHooks {
    async fn before(
        &self,
        context: BeforeToolCall,
        cancellation: CancellationToken,
    ) -> Result<BeforeToolCallResult, ToolFailure> {
        self.store
            .reserve_agent_usage(self.agent_id, "toolCalls", 1, u64::from(self.maximum))
            .await
            .map_err(|error| ToolFailure::new("subagent_tool_budget", error.to_string()))?;
        self.inner.before(context, cancellation).await
    }

    async fn after(
        &self,
        context: AfterToolCall,
        cancellation: CancellationToken,
    ) -> Result<AfterToolCallResult, ToolFailure> {
        self.inner.after(context, cancellation).await
    }
}

struct BudgetLoopHooks {
    store: Store,
    agent_id: AgentId,
    budget: SubagentBudget,
}

#[async_trait]
impl LoopHooks for BudgetLoopHooks {
    async fn prepare_next_turn(
        &self,
        turn: LoopTurnContext,
        _cancellation: CancellationToken,
    ) -> Result<Option<LoopTurnUpdate>, AgentError> {
        self.store
            .reserve_agent_usage(self.agent_id, "turns", 1, u64::from(self.budget.max_turns))
            .await
            .map_err(|error| AgentError::Hook(error.to_string()))?;
        let tokens = turn
            .message
            .usage
            .as_ref()
            .and_then(|usage| usage.get("totalTokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if tokens > 0 {
            self.store
                .reserve_agent_usage(self.agent_id, "tokens", tokens, self.budget.max_tokens)
                .await
                .map_err(|error| AgentError::Hook(error.to_string()))?;
        }
        let cost_microusd = turn
            .message
            .usage
            .as_ref()
            .and_then(|usage| {
                usage
                    .get("costMicrousd")
                    .and_then(Value::as_u64)
                    .or_else(|| {
                        usage
                            .get("cost")
                            .and_then(Value::as_f64)
                            .map(|cost| (cost.max(0.0) * 1_000_000.0) as u64)
                    })
            })
            .unwrap_or(0);
        if cost_microusd > 0 {
            self.store
                .reserve_agent_usage(
                    self.agent_id,
                    "costMicrousd",
                    cost_microusd,
                    self.budget.max_cost_microusd,
                )
                .await
                .map_err(|error| AgentError::Hook(error.to_string()))?;
        }
        self.store
            .checkpoint_agent_thread(
                self.agent_id,
                serde_json::to_value(&turn.context)
                    .map_err(|error| AgentError::Hook(error.to_string()))?,
            )
            .await
            .map_err(|error| AgentError::Hook(error.to_string()))?;
        Ok(None)
    }
}

async fn fork_parent_history(
    store: &Store,
    session_id: SessionId,
) -> Result<Vec<Message>, MultiAgentError> {
    let events = store.list_events(session_id, 0).await?;
    let mut history = events
        .iter()
        .rev()
        .filter(|event| event.event_type == "agent.message_end")
        .filter_map(|event| event.payload.get("message"))
        .filter_map(|message| {
            let role = message.get("role").and_then(Value::as_str)?;
            let text = message_text(message);
            if text.trim().is_empty() {
                return None;
            }
            match role {
                "user" => Some(Message::user(text)),
                "assistant" => Some(Message::Assistant(AssistantMessage::text(text))),
                _ => None,
            }
        })
        .take(12)
        .collect::<Vec<_>>();
    history.reverse();
    Ok(history)
}

fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

struct SendMessageTool(MultiAgentService);

#[async_trait]
impl Tool for SendMessageTool {
    fn definition(&self) -> ToolDefinition {
        let mut value =
            ToolDefinition::direct("send_message", "Send a durable message to a sub-agent");
        value.parameters = json!({"type":"object","required":["id","message"],"properties":{"id":{"type":"string"},"message":{"type":"string"}}});
        value
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        message_tool_execute(&self.0, call, &context, false).await
    }
}

struct FollowupAgentTool(MultiAgentService);

#[async_trait]
impl Tool for FollowupAgentTool {
    fn definition(&self) -> ToolDefinition {
        let mut value = ToolDefinition::direct(
            "followup_task",
            "Send a durable follow-up and activate an idle sub-agent",
        );
        value.parameters = json!({"type":"object","required":["id","message"],"properties":{"id":{"type":"string"},"message":{"type":"string"}}});
        value
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        message_tool_execute(&self.0, call, &context, true).await
    }
}

async fn message_tool_execute(
    service: &MultiAgentService,
    call: &ToolCall,
    context: &ToolCallContext,
    trigger_turn: bool,
) -> Result<ToolOutput, ToolFailure> {
    let id = call
        .arguments
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .parse::<AgentId>()
        .map_err(|error| ToolFailure::new("invalid_agent_id", error.to_string()))?;
    let message = call
        .arguments
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if message.trim().is_empty() {
        return Err(ToolFailure::new(
            "invalid_message",
            "message cannot be empty",
        ));
    }
    let record = service
        .inner
        .store
        .get_agent_thread(id)
        .await
        .map_err(|error| ToolFailure::new("agent_not_found", error.to_string()))?;
    if record.session_id != session_id(context)? {
        return Err(ToolFailure::new(
            "agent_scope_violation",
            "sub-agent belongs to another session",
        ));
    }
    let record = service
        .send_message(id, message, trigger_turn)
        .await
        .map_err(|error| ToolFailure::new("message_failed", error.to_string()))?;
    Ok(ToolOutput::text(
        serde_json::to_string(&record).unwrap_or_default(),
    ))
}

fn normalize_task_name(value: &str) -> Result<String, MultiAgentError> {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_owned();
    if normalized.is_empty() || normalized.len() > 64 {
        Err(MultiAgentError::InvalidTaskName)
    } else {
        Ok(normalized)
    }
}

fn session_id(context: &ToolCallContext) -> Result<SessionId, ToolFailure> {
    context
        .session_id
        .as_deref()
        .ok_or_else(|| ToolFailure::new("missing_session", "tool requires a session"))?
        .parse::<SessionId>()
        .map_err(|error| ToolFailure::new("invalid_session", error.to_string()))
}

struct SpawnAgentTool(MultiAgentService);

struct SpawnAgentsTool(MultiAgentService);

#[async_trait]
impl Tool for SpawnAgentsTool {
    fn definition(&self) -> ToolDefinition {
        let mut value = ToolDefinition::direct(
            "spawn_agents",
            "Start a batch of up to eight bounded sub-agent tasks for later aggregation",
        );
        value.parameters = json!({"type":"object","required":["tasks"],"properties":{"tasks":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","required":["taskName","prompt"],"properties":{"taskName":{"type":"string"},"prompt":{"type":"string"},"role":{"type":"string"},"forkHistory":{"type":"boolean"}},"additionalProperties":false}}},"additionalProperties":false});
        value
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let tasks = call
            .arguments
            .get("tasks")
            .and_then(Value::as_array)
            .filter(|tasks| !tasks.is_empty() && tasks.len() <= 8)
            .ok_or_else(|| ToolFailure::new("invalid_tasks", "tasks must contain 1-8 items"))?;
        for task in tasks {
            normalize_task_name(
                task.get("taskName")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
            .map_err(|error| ToolFailure::new("invalid_task", error.to_string()))?;
            if task
                .get("prompt")
                .and_then(Value::as_str)
                .is_none_or(|prompt| prompt.trim().is_empty())
            {
                return Err(ToolFailure::new(
                    "invalid_task",
                    "every batch task requires a non-empty prompt",
                ));
            }
            self.0
                .inner
                .catalog
                .read()
                .unwrap_or_else(|value| value.into_inner())
                .resolve(
                    task.get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("general"),
                )
                .map_err(|error| ToolFailure::new("invalid_task", error))?;
        }
        let parent_id = context
            .metadata
            .get("agentId")
            .and_then(Value::as_str)
            .map(str::parse::<AgentId>)
            .transpose()
            .map_err(|error| ToolFailure::new("invalid_parent_agent", error.to_string()))?;
        let parent_path = context
            .metadata
            .get("agentPath")
            .and_then(Value::as_str)
            .unwrap_or("/root");
        let session_id = session_id(&context)?;
        let batch_id = uuid::Uuid::now_v7().to_string();
        let mut records = Vec::with_capacity(tasks.len());
        for task in tasks {
            let record = self
                .0
                .spawn_from(
                    session_id,
                    parent_id,
                    parent_path,
                    task.get("taskName").and_then(Value::as_str).unwrap_or(""),
                    task.get("prompt").and_then(Value::as_str).unwrap_or(""),
                    task.get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("general"),
                    task.get("forkHistory")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    Some(batch_id.clone()),
                )
                .await
                .map_err(|error| ToolFailure::new("spawn_batch_failed", error.to_string()))?;
            records.push(record);
        }
        let payload = json!({"batchId":batch_id,"agents":records});
        Ok(ToolOutput {
            content: vec![ContentBlock::Text {
                text: serde_json::to_string_pretty(&payload).unwrap_or_default(),
            }],
            structured_content: Some(payload.clone()),
            details: payload,
            ..ToolOutput::default()
        })
    }
}

#[async_trait]
impl Tool for SpawnAgentTool {
    fn definition(&self) -> ToolDefinition {
        let mut value = ToolDefinition::direct(
            "spawn_agent",
            "Start a bounded durable sub-agent task with an optional parent-history fork",
        );
        let roles = self
            .0
            .inner
            .catalog
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .definitions()
            .iter()
            .map(|definition| definition.name.clone())
            .collect::<Vec<_>>();
        value.parameters = json!({"type":"object","required":["taskName","prompt"],"properties":{"taskName":{"type":"string"},"prompt":{"type":"string"},"role":{"type":"string","enum":roles},"forkHistory":{"type":"boolean","default":true}}});
        value
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let task_name = call
            .arguments
            .get("taskName")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let prompt = call
            .arguments
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let role = call
            .arguments
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("general");
        let parent_id = context
            .metadata
            .get("agentId")
            .and_then(Value::as_str)
            .map(str::parse::<AgentId>)
            .transpose()
            .map_err(|error| ToolFailure::new("invalid_parent_agent", error.to_string()))?;
        let parent_path = context
            .metadata
            .get("agentPath")
            .and_then(Value::as_str)
            .unwrap_or("/root");
        let record = self
            .0
            .spawn_from(
                session_id(&context)?,
                parent_id,
                parent_path,
                task_name,
                prompt,
                role,
                call.arguments
                    .get("forkHistory")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                None,
            )
            .await
            .map_err(|error| ToolFailure::new("spawn_failed", error.to_string()))?;
        Ok(ToolOutput::text(
            serde_json::to_string(&record).unwrap_or_default(),
        ))
    }
}

struct ListAgentsTool(MultiAgentService);

#[async_trait]
impl Tool for ListAgentsTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::direct(
            "list_agents",
            "List durable sub-agent threads for this session",
        )
    }

    async fn execute(
        &self,
        _call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let records = self
            .0
            .list(session_id(&context)?)
            .await
            .map_err(|error| ToolFailure::new("list_agents_failed", error.to_string()))?;
        Ok(ToolOutput::text(
            serde_json::to_string_pretty(&records).unwrap_or_default(),
        ))
    }
}

struct InterruptAgentTool(MultiAgentService);

#[async_trait]
impl Tool for InterruptAgentTool {
    fn definition(&self) -> ToolDefinition {
        let mut value = ToolDefinition::direct("interrupt_agent", "Cancel a running sub-agent");
        value.parameters =
            json!({"type":"object","required":["id"],"properties":{"id":{"type":"string"}}});
        value
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let id = call
            .arguments
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .parse::<AgentId>()
            .map_err(|error| ToolFailure::new("invalid_agent_id", error.to_string()))?;
        let record = self
            .0
            .inner
            .store
            .get_agent_thread(id)
            .await
            .map_err(|error| ToolFailure::new("agent_not_found", error.to_string()))?;
        if record.session_id != session_id(&context)? {
            return Err(ToolFailure::new(
                "agent_scope_violation",
                "sub-agent belongs to another session",
            ));
        }
        let record = self
            .0
            .interrupt(id)
            .await
            .map_err(|error| ToolFailure::new("interrupt_failed", error.to_string()))?;
        Ok(ToolOutput::text(
            serde_json::to_string(&record).unwrap_or_default(),
        ))
    }
}

struct WaitAgentTool(MultiAgentService);

#[async_trait]
impl Tool for WaitAgentTool {
    fn definition(&self) -> ToolDefinition {
        let mut value = ToolDefinition::direct(
            "wait_agent",
            "Wait briefly for one or more sub-agents and aggregate their durable states",
        );
        value.parameters = json!({"type":"object","properties":{"id":{"type":"string"},"ids":{"type":"array","items":{"type":"string"},"maxItems":32},"batchId":{"type":"string"},"timeoutMs":{"type":"integer","minimum":0,"maximum":30000}},"additionalProperties":false});
        value
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let mut ids = call
            .arguments
            .get("ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::parse::<AgentId>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ToolFailure::new("invalid_agent_id", error.to_string()))?;
        if let Some(id) = call.arguments.get("id").and_then(Value::as_str) {
            ids.push(
                id.parse::<AgentId>()
                    .map_err(|error| ToolFailure::new("invalid_agent_id", error.to_string()))?,
            );
        }
        let session_id = session_id(&context)?;
        if let Some(batch_id) = call.arguments.get("batchId").and_then(Value::as_str) {
            if batch_id.trim().is_empty() {
                return Err(ToolFailure::new(
                    "invalid_batch_id",
                    "batchId cannot be empty",
                ));
            }
            ids.extend(
                self.0
                    .inner
                    .store
                    .list_agent_threads(session_id)
                    .await
                    .map_err(|error| ToolFailure::new("list_agents_failed", error.to_string()))?
                    .into_iter()
                    .filter(|record| record.coordination_batch_id.as_deref() == Some(batch_id))
                    .map(|record| record.id),
            );
        }
        ids.sort();
        ids.dedup();
        if ids.is_empty() || ids.len() > 32 {
            return Err(ToolFailure::new(
                "invalid_agent_ids",
                "id or 1-32 ids are required",
            ));
        }
        let timeout_ms = call
            .arguments
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(30_000)
            .min(30_000);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        let records = loop {
            let mut records = Vec::new();
            for id in &ids {
                let record = self
                    .0
                    .inner
                    .store
                    .get_agent_thread(*id)
                    .await
                    .map_err(|error| ToolFailure::new("agent_not_found", error.to_string()))?;
                if record.session_id != session_id {
                    return Err(ToolFailure::new(
                        "agent_scope_violation",
                        "sub-agent belongs to another session",
                    ));
                }
                records.push(record);
            }
            if records.iter().all(|record| {
                matches!(
                    record.status.as_str(),
                    "completed" | "failed" | "interrupted"
                )
            }) || tokio::time::Instant::now() >= deadline
            {
                break records;
            }
            tokio::select! {
                _ = context.cancellation.cancelled() => return Err(ToolFailure::new("cancelled", "wait_agent was cancelled")),
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
            }
        };
        let payload = json!({
            "agents":records,
            "complete":records.iter().all(|record| matches!(record.status.as_str(), "completed" | "failed" | "interrupted")),
        });
        Ok(ToolOutput {
            content: vec![ContentBlock::Text {
                text: serde_json::to_string_pretty(&payload).unwrap_or_default(),
            }],
            structured_content: Some(payload.clone()),
            details: payload,
            ..ToolOutput::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eden_agent_core::{
        EventEmitter, ModelError, ModelOutput, ModelRequest, NoopToolHooks, event_channel,
    };
    use std::{
        fs,
        sync::{
            Arc, Mutex as StdMutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use tempfile::TempDir;

    struct ReplyModel {
        text: String,
        usage: Value,
        requests: StdMutex<Vec<ModelRequest>>,
    }

    impl ReplyModel {
        fn new(text: &str, usage: Value) -> Self {
            Self {
                text: text.to_owned(),
                usage,
                requests: StdMutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<ModelRequest> {
            self.requests.lock().expect("requests lock").clone()
        }
    }

    #[async_trait]
    impl ModelAdapter for ReplyModel {
        async fn generate(
            &self,
            request: ModelRequest,
            _events: EventEmitter,
            _cancellation: CancellationToken,
        ) -> Result<ModelOutput, ModelError> {
            self.requests.lock().expect("requests lock").push(request);
            let mut message = AssistantMessage::text(&self.text);
            message.usage = Some(self.usage.clone());
            Ok(ModelOutput::complete(message))
        }
    }

    struct LoopingToolModel;

    #[async_trait]
    impl ModelAdapter for LoopingToolModel {
        async fn generate(
            &self,
            _request: ModelRequest,
            _events: EventEmitter,
            _cancellation: CancellationToken,
        ) -> Result<ModelOutput, ModelError> {
            let mut message = AssistantMessage::text("");
            message.stop_reason = "tool_calls".to_owned();
            message.content = vec![ContentBlock::ToolCall {
                id: uuid::Uuid::now_v7().to_string(),
                name: "counter".to_owned(),
                arguments: json!({}),
                provider_item_id: None,
            }];
            Ok(ModelOutput::complete(message))
        }
    }

    struct CountingTool(Arc<AtomicUsize>);

    #[async_trait]
    impl Tool for CountingTool {
        fn definition(&self) -> ToolDefinition {
            ToolDefinition::direct("counter", "Count executions")
        }

        async fn execute(
            &self,
            _call: &ToolCall,
            _context: ToolCallContext,
        ) -> Result<ToolOutput, ToolFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(ToolOutput::text("counted"))
        }
    }

    struct HangingModel;

    #[async_trait]
    impl ModelAdapter for HangingModel {
        async fn generate(
            &self,
            _request: ModelRequest,
            _events: EventEmitter,
            cancellation: CancellationToken,
        ) -> Result<ModelOutput, ModelError> {
            cancellation.cancelled().await;
            Err(ModelError::new("cancelled", "cancelled"))
        }
    }

    struct ConcurrencyModel {
        gate: Arc<Semaphore>,
        active: AtomicUsize,
        maximum: AtomicUsize,
    }

    #[async_trait]
    impl ModelAdapter for ConcurrencyModel {
        async fn generate(
            &self,
            _request: ModelRequest,
            _events: EventEmitter,
            _cancellation: CancellationToken,
        ) -> Result<ModelOutput, ModelError> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(active, Ordering::SeqCst);
            let permit = self.gate.acquire().await.expect("test gate");
            permit.forget();
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(ModelOutput::complete(AssistantMessage::text("done")))
        }
    }

    fn default_model_spec() -> ModelSpec {
        ModelSpec {
            id: "parent-model".to_owned(),
            provider: "test".to_owned(),
            ..ModelSpec::default()
        }
    }

    fn catalog(root: &TempDir) -> SubagentCatalog {
        SubagentCatalog::discover(root.path(), Some(&root.path().join("user-agents")))
            .expect("catalog")
    }

    fn service(store: Store, model: Arc<dyn ModelAdapter>, root: &TempDir) -> MultiAgentService {
        MultiAgentService::new_with_catalog(
            store,
            default_model_spec(),
            model,
            ToolRegistry::new(),
            Arc::new(NoopToolHooks),
            "root system prompt",
            2,
            root.path().to_owned(),
            catalog(root),
        )
    }

    fn install_bounded_role(root: &TempDir, max_tokens: u64) {
        let agents = root.path().join(".edenagent/agents");
        fs::create_dir_all(&agents).expect("agent directory");
        fs::write(
            agents.join("bounded.toml"),
            format!(
                "name='bounded'\ndescription='bounded test role'\ndeveloper_instructions='work within the test budget'\nmodel='test/child-model'\nreasoning='high'\nsandbox_mode='read-only'\n[budget]\nmax_turns=2\nmax_tool_calls=2\ntimeout_seconds=60\nmax_tokens={max_tokens}\nmax_cost_microusd=1000\n"
            ),
        )
        .expect("role definition");
    }

    fn install_limit_role(
        root: &TempDir,
        name: &str,
        max_turns: u32,
        max_tool_calls: u32,
        timeout_seconds: u64,
    ) {
        let agents = root.path().join(".edenagent/agents");
        fs::create_dir_all(&agents).expect("agent directory");
        fs::write(
            agents.join(format!("{name}.toml")),
            format!(
                "name='{name}'\ndescription='runtime limit test'\ndeveloper_instructions='obey runtime limits'\n[budget]\nmax_turns={max_turns}\nmax_tool_calls={max_tool_calls}\ntimeout_seconds={timeout_seconds}\nmax_tokens=10000\nmax_cost_microusd=10000\n"
            ),
        )
        .expect("role definition");
    }

    async fn wait_terminal(store: &Store, id: AgentId) -> AgentThreadRecord {
        for _ in 0..200 {
            let record = store.get_agent_thread(id).await.expect("agent thread");
            if matches!(
                record.status.as_str(),
                "completed" | "failed" | "interrupted"
            ) {
                return record;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("sub-agent did not reach a terminal state")
    }

    fn tool_context(session_id: SessionId) -> ToolCallContext {
        let (events, _receiver) = event_channel(16);
        ToolCallContext {
            cancellation: CancellationToken::new(),
            events,
            session_id: Some(session_id.to_string()),
            metadata: json!({}),
        }
    }

    #[tokio::test]
    async fn run_persists_role_history_usage_checkpoint_and_completion_notification() {
        let root = TempDir::new().expect("temp root");
        install_bounded_role(&root, 100);
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("multi-agent").await.expect("session");
        store
            .append_event(
                session.id,
                None,
                "agent.message_end",
                json!({"message":{"role":"user","content":[{"type":"text","text":"parent history fact"}]}}),
            )
            .await
            .expect("history event");
        let model = Arc::new(ReplyModel::new(
            "verified result",
            json!({"totalTokens":7,"costMicrousd":11}),
        ));
        let service = service(store.clone(), model.clone(), &root);

        let spawned = service
            .spawn(session.id, "research", "inspect the evidence", "bounded")
            .await
            .expect("spawn");
        let completed = wait_terminal(&store, spawned.id).await;

        assert_eq!(completed.status, "completed", "{:?}", completed.error);
        assert_eq!(completed.usage["turns"], 1);
        assert_eq!(completed.usage["tokens"], 7);
        assert_eq!(completed.usage["costMicrousd"], 11);
        assert_eq!(
            completed.result.as_ref().expect("result")["content"],
            "verified result"
        );
        assert!(completed.context.is_some());
        let runtime: AgentRuntimeConfig =
            serde_json::from_value(completed.config).expect("runtime config");
        assert_eq!(runtime.model.id, "child-model");
        assert_eq!(runtime.model.extra["reasoningEffort"], "high");
        assert!(runtime.policy.allows("spawn_agents"));
        assert!(!runtime.policy.allows("remember_memory"));

        let requests = model.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].model.id, "child-model");
        assert!(requests[0].system_prompt.contains("bounded test role"));
        assert!(requests[0].messages.iter().any(|message| {
            match message {
                Message::User { content, .. } => serde_json::to_string(content)
                    .expect("user message")
                    .contains("parent history fact"),
                _ => false,
            }
        }));
        let notifications = store
            .pending_agent_messages(session.id, "/root")
            .await
            .expect("notifications");
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].details["status"], "completed");
        assert!(notifications[0].content.contains("verified result"));
    }

    #[tokio::test]
    async fn token_budget_failure_is_durable_and_reports_the_actual_limit() {
        let root = TempDir::new().expect("temp root");
        install_bounded_role(&root, 5);
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("budget").await.expect("session");
        let model = Arc::new(ReplyModel::new(
            "too expensive",
            json!({"totalTokens":6,"costMicrousd":1}),
        ));
        let service = service(store.clone(), model, &root);

        let spawned = service
            .spawn(session.id, "budget", "stay bounded", "bounded")
            .await
            .expect("spawn");
        let failed = wait_terminal(&store, spawned.id).await;

        assert_eq!(failed.status, "failed");
        assert!(
            failed
                .error
                .as_deref()
                .is_some_and(|error| error.contains("tokens budget exceeded"))
        );
        assert_eq!(failed.usage["turns"], 1);
        assert_eq!(failed.usage["tokens"], 0);
        let notifications = store
            .pending_agent_messages(session.id, "/root")
            .await
            .expect("notifications");
        assert_eq!(notifications[0].details["status"], "failed");
    }

    #[tokio::test]
    async fn turn_and_tool_call_budgets_are_mechanically_enforced() {
        let root = TempDir::new().expect("temp root");
        install_limit_role(&root, "looper", 3, 1, 60);
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("tool budget").await.expect("session");
        let executions = Arc::new(AtomicUsize::new(0));
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(CountingTool(Arc::clone(&executions))));
        let service = MultiAgentService::new_with_catalog(
            store.clone(),
            default_model_spec(),
            Arc::new(LoopingToolModel),
            tools,
            Arc::new(NoopToolHooks),
            "root system prompt",
            1,
            root.path().to_owned(),
            catalog(&root),
        );

        let spawned = service
            .spawn(session.id, "loop", "keep calling", "looper")
            .await
            .expect("spawn");
        let failed = wait_terminal(&store, spawned.id).await;

        assert_eq!(failed.status, "failed");
        assert_eq!(failed.usage["turns"], 3);
        assert_eq!(failed.usage["toolCalls"], 1);
        assert_eq!(executions.load(Ordering::SeqCst), 1);
        assert!(
            failed
                .error
                .as_deref()
                .is_some_and(|error| error.contains("limit of 3 model steps")),
            "{:?}",
            failed.error
        );
    }

    #[tokio::test]
    async fn lifetime_budget_expires_a_hanging_model_call() {
        let root = TempDir::new().expect("temp root");
        install_limit_role(&root, "short", 2, 2, 1);
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("lifetime").await.expect("session");
        let service = service(store.clone(), Arc::new(HangingModel), &root);

        let spawned = service
            .spawn(session.id, "short", "wait forever", "short")
            .await
            .expect("spawn");
        let failed = wait_terminal(&store, spawned.id).await;

        assert_eq!(failed.status, "failed");
        assert!(
            failed
                .error
                .as_deref()
                .is_some_and(|error| error.contains("lifetime budget expired"))
        );
    }

    #[tokio::test]
    async fn nesting_depth_is_rejected_before_a_child_is_created() {
        let root = TempDir::new().expect("temp root");
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("depth").await.expect("session");
        let definition = catalog(&root).resolve("general").expect("definition");
        let runtime = AgentRuntimeConfig {
            model: definition.model_spec(&default_model_spec()),
            budget: definition.budget.clone(),
            policy: definition.policy.clone(),
            definition,
            depth: 3,
            parent_path: "/root".to_owned(),
            parent_history: Vec::new(),
            skill_prompt: String::new(),
            workspace_root: root.path().to_path_buf(),
        };
        let parent = store
            .create_agent_thread_configured(
                session.id,
                None,
                "/root/depth3",
                "depth3",
                "general",
                "parent",
                serde_json::to_value(runtime).expect("runtime"),
                Some(now_ms() + 60_000),
                None,
            )
            .await
            .expect("parent");
        let service = service(
            store.clone(),
            Arc::new(ReplyModel::new("unused", json!({}))),
            &root,
        );

        let error = service
            .spawn_from(
                session.id,
                Some(parent.id),
                &parent.agent_path,
                "too-deep",
                "child",
                "general",
                false,
                None,
            )
            .await
            .expect_err("depth four must be rejected");
        assert!(error.to_string().contains("nesting depth exceeds 3"));
        assert_eq!(
            store
                .list_agent_threads(session.id)
                .await
                .expect("list")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn global_concurrency_keeps_excess_agents_queued() {
        let root = TempDir::new().expect("temp root");
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("concurrency").await.expect("session");
        let gate = Arc::new(Semaphore::new(0));
        let model = Arc::new(ConcurrencyModel {
            gate: Arc::clone(&gate),
            active: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
        });
        let service = MultiAgentService::new_with_catalog(
            store.clone(),
            default_model_spec(),
            model.clone(),
            ToolRegistry::new(),
            Arc::new(NoopToolHooks),
            "root system prompt",
            1,
            root.path().to_owned(),
            catalog(&root),
        );
        let mut ids = Vec::new();
        for index in 0..3 {
            ids.push(
                service
                    .spawn(
                        session.id,
                        &format!("task-{index}"),
                        "bounded concurrency",
                        "general",
                    )
                    .await
                    .expect("spawn")
                    .id,
            );
        }
        for _ in 0..100 {
            if model.active.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let records = store.list_agent_threads(session.id).await.expect("list");
        assert_eq!(
            records
                .iter()
                .filter(|record| record.status == "running")
                .count(),
            1
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record.status == "queued")
                .count(),
            2
        );
        gate.add_permits(3);
        for id in ids {
            assert_eq!(wait_terminal(&store, id).await.status, "completed");
        }
        assert_eq!(model.maximum.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn restart_recovers_running_agent_from_checkpoint() {
        let root = TempDir::new().expect("temp root");
        let database = root.path().join("agent.db");
        let store = Store::open(&database).await.expect("store");
        let session = store.create_session("restart").await.expect("session");
        let definition = catalog(&root).resolve("general").expect("definition");
        let runtime = AgentRuntimeConfig {
            model: definition.model_spec(&default_model_spec()),
            budget: definition.budget.clone(),
            policy: definition.policy.clone(),
            definition,
            depth: 1,
            parent_path: "/root".to_owned(),
            parent_history: Vec::new(),
            skill_prompt: "restart skill snapshot".to_owned(),
            workspace_root: root.path().to_path_buf(),
        };
        let record = store
            .create_agent_thread_configured(
                session.id,
                None,
                "/root/restart",
                "restart",
                "general",
                "original prompt",
                serde_json::to_value(runtime).expect("runtime json"),
                Some(now_ms() + 60_000),
                None,
            )
            .await
            .expect("agent");
        store.start_agent_thread(record.id).await.expect("start");
        store
            .checkpoint_agent_thread(
                record.id,
                serde_json::to_value(AgentContext {
                    system_prompt: "old prompt".to_owned(),
                    messages: vec![Message::user("checkpointed work")],
                    metadata: json!({}),
                })
                .expect("context json"),
            )
            .await
            .expect("checkpoint");
        store.pool().close().await;
        drop(store);

        let reopened = Store::open(&database).await.expect("reopen store");
        let model = Arc::new(ReplyModel::new("resumed result", json!({"totalTokens":3})));
        let service = service(reopened.clone(), model.clone(), &root);
        assert_eq!(service.resume().await.expect("resume"), 1);
        let completed = wait_terminal(&reopened, record.id).await;

        assert_eq!(completed.status, "completed", "{:?}", completed.error);
        assert_eq!(
            completed.result.as_ref().expect("result")["content"],
            "resumed result"
        );
        assert!(model.requests()[0].messages.iter().any(|message| {
            serde_json::to_string(message)
                .expect("message json")
                .contains("checkpointed work")
        }));
    }

    #[tokio::test]
    async fn batch_spawn_can_be_aggregated_by_batch_id() {
        let root = TempDir::new().expect("temp root");
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("batch").await.expect("session");
        let service = service(
            store.clone(),
            Arc::new(ReplyModel::new("batch result", json!({"totalTokens":1}))),
            &root,
        );
        let spawned = SpawnAgentsTool(service.clone())
            .execute(
                &ToolCall {
                    id: "spawn-batch".to_owned(),
                    name: "spawn_agents".to_owned(),
                    arguments: json!({"tasks":[
                        {"taskName":"one","prompt":"first"},
                        {"taskName":"two","prompt":"second"}
                    ]}),
                },
                tool_context(session.id),
            )
            .await
            .expect("spawn batch");
        let batch_id = spawned
            .structured_content
            .as_ref()
            .and_then(|value| value.get("batchId"))
            .and_then(Value::as_str)
            .expect("batch id")
            .to_owned();

        let aggregated = WaitAgentTool(service)
            .execute(
                &ToolCall {
                    id: "wait-batch".to_owned(),
                    name: "wait_agent".to_owned(),
                    arguments: json!({"batchId":batch_id,"timeoutMs":3000}),
                },
                tool_context(session.id),
            )
            .await
            .expect("wait batch");
        let payload = aggregated.structured_content.expect("structured result");
        assert_eq!(payload["complete"], true);
        assert_eq!(payload["agents"].as_array().expect("agents").len(), 2);
        assert!(
            payload["agents"]
                .as_array()
                .expect("agents")
                .iter()
                .all(|record| record["coordinationBatchId"].as_str() == Some(batch_id.as_str()))
        );
    }
}
