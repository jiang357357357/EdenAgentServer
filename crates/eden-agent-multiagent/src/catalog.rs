use eden_agent_core::ModelSpec;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

const STICKER_TOOLS: &[&str] = &[
    "list_character_stickers",
    "remember_character_sticker",
    "send_character_sticker",
    "delete_character_sticker",
];
const ROOT_ONLY_TOOLS: &[&str] = &[
    "remember_memory",
    "update_memory",
    "forget_memory",
    "switch_workspace",
    "switch_session_assistant",
    "switch_character_action",
];
const READ_ONLY_TOOLS: &[&str] = &[
    "load_skill",
    "list_skills",
    "read",
    "ls",
    "grep",
    "find",
    "get_diff",
    "web",
    "get_calendar_context",
    "get_weather",
    "analyze_image",
    "analyze_screen",
    "list_character_actions",
    "get_self_awake_state",
    "list_self_awake_diaries",
    "read_self_awake_diary",
    "external_ls",
    "external_read",
    "external_find",
    "external_grep",
    "list_memos",
    "list_due_memos",
    "get_next_memo_wake",
    "search_memories",
    "external_email_status",
    "qq_bot_list",
    "qq_bot_targets",
    "list_connectors",
    "describe_connector",
    "claim_connector_events",
    "query_openttd",
    "query_connector",
    "query_victoria3",
    "spawn_agent",
    "spawn_agents",
    "send_message",
    "followup_task",
    "list_agents",
    "interrupt_agent",
    "wait_agent",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct SubagentBudget {
    pub max_turns: u32,
    pub max_tool_calls: u32,
    pub timeout_seconds: u64,
    pub max_tokens: u64,
    pub max_cost_microusd: u64,
}

impl Default for SubagentBudget {
    fn default() -> Self {
        Self {
            max_turns: 64,
            max_tool_calls: 128,
            timeout_seconds: 1_800,
            max_tokens: 1_000_000,
            max_cost_microusd: 10_000_000,
        }
    }
}

impl SubagentBudget {
    pub fn validate(&self) -> Result<(), String> {
        if self.max_turns == 0 || self.max_turns > 1_024 {
            return Err("budget.max_turns must be between 1 and 1024".to_owned());
        }
        if self.max_tool_calls == 0 || self.max_tool_calls > 10_000 {
            return Err("budget.max_tool_calls must be between 1 and 10000".to_owned());
        }
        if self.timeout_seconds == 0 || self.timeout_seconds > 86_400 {
            return Err("budget.timeout_seconds must be between 1 and 86400".to_owned());
        }
        if self.max_tokens == 0 || self.max_tokens > 100_000_000 {
            return Err("budget.max_tokens is out of range".to_owned());
        }
        if self.max_cost_microusd == 0 || self.max_cost_microusd > 1_000_000_000 {
            return Err("budget.max_cost_microusd is out of range".to_owned());
        }
        Ok(())
    }

    pub fn restrict(&self, child: &Self) -> Self {
        Self {
            max_turns: self.max_turns.min(child.max_turns),
            max_tool_calls: self.max_tool_calls.min(child.max_tool_calls),
            timeout_seconds: self.timeout_seconds.min(child.timeout_seconds),
            max_tokens: self.max_tokens.min(child.max_tokens),
            max_cost_microusd: self.max_cost_microusd.min(child.max_cost_microusd),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct SubagentToolPolicy {
    pub sandbox_mode: String,
    pub allowed_tools: Option<BTreeSet<String>>,
    pub denied_tools: BTreeSet<String>,
}

impl Default for SubagentToolPolicy {
    fn default() -> Self {
        Self {
            sandbox_mode: "inherit".to_owned(),
            allowed_tools: None,
            denied_tools: BTreeSet::new(),
        }
    }
}

impl SubagentToolPolicy {
    pub fn normalized(mut self) -> Result<Self, String> {
        if !matches!(
            self.sandbox_mode.as_str(),
            "inherit" | "read-only" | "workspace-write"
        ) {
            return Err("sandbox_mode must be inherit, read-only, or workspace-write".to_owned());
        }
        self.denied_tools.extend(
            STICKER_TOOLS
                .iter()
                .chain(ROOT_ONLY_TOOLS)
                .map(|value| (*value).to_owned()),
        );
        if self.sandbox_mode == "read-only" {
            let read_only = READ_ONLY_TOOLS
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<BTreeSet<_>>();
            self.allowed_tools = Some(match self.allowed_tools {
                Some(configured) => configured.intersection(&read_only).cloned().collect(),
                None => read_only,
            });
        }
        Ok(self)
    }

    pub fn allows(&self, name: &str) -> bool {
        !self.denied_tools.contains(name)
            && self
                .allowed_tools
                .as_ref()
                .is_none_or(|allowed| allowed.contains(name))
    }

    pub fn restrict(&self, child: &Self) -> Result<Self, String> {
        let allowed_tools = match (&self.allowed_tools, &child.allowed_tools) {
            (Some(parent), Some(child)) => Some(parent.intersection(child).cloned().collect()),
            (Some(parent), None) => Some(parent.clone()),
            (None, Some(child)) => Some(child.clone()),
            (None, None) => None,
        };
        Self {
            sandbox_mode: restrict_sandbox_mode(&self.sandbox_mode, &child.sandbox_mode),
            allowed_tools,
            denied_tools: self
                .denied_tools
                .union(&child.denied_tools)
                .cloned()
                .collect(),
        }
        .normalized()
    }
}

fn restrict_sandbox_mode(parent: &str, child: &str) -> String {
    match (parent, child) {
        ("read-only", _) | (_, "read-only") => "read-only".to_owned(),
        ("workspace-write", _) | (_, "workspace-write") => "workspace-write".to_owned(),
        _ => "inherit".to_owned(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct SubagentDefinition {
    pub name: String,
    pub description: String,
    pub developer_instructions: String,
    pub skills: Vec<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    #[serde(flatten)]
    pub policy: SubagentToolPolicy,
    pub budget: SubagentBudget,
    pub source: String,
}

impl Default for SubagentDefinition {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            developer_instructions: String::new(),
            skills: Vec::new(),
            model: None,
            reasoning: None,
            policy: SubagentToolPolicy::default(),
            budget: SubagentBudget::default(),
            source: "project".to_owned(),
        }
    }
}

impl SubagentDefinition {
    fn validate(mut self) -> Result<Self, String> {
        if self.name.is_empty()
            || self.name.len() > 64
            || !self.name.chars().enumerate().all(|(index, value)| {
                if index == 0 {
                    value.is_ascii_lowercase()
                } else {
                    value.is_ascii_lowercase()
                        || value.is_ascii_digit()
                        || matches!(value, '_' | '-')
                }
            })
        {
            return Err("invalid sub-agent name".to_owned());
        }
        if self.description.trim().is_empty() || self.developer_instructions.trim().is_empty() {
            return Err("description and developer_instructions are required".to_owned());
        }
        if self.reasoning.as_deref().is_some_and(|value| {
            !matches!(
                value,
                "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
            )
        }) {
            return Err("invalid reasoning level".to_owned());
        }
        self.budget.validate()?;
        self.policy = self.policy.normalized()?;
        Ok(self)
    }

    pub fn model_spec(&self, parent: &ModelSpec) -> ModelSpec {
        let mut model = parent.clone();
        if let Some(configured) = self.model.as_deref() {
            if let Some((provider, id)) = configured.split_once('/') {
                model.provider = provider.to_owned();
                model.id = id.to_owned();
            } else {
                model.id = configured.to_owned();
            }
        }
        if let Some(reasoning) = &self.reasoning {
            model
                .extra
                .insert("reasoningEffort".to_owned(), reasoning.clone().into());
        }
        model
    }
}

#[derive(Clone)]
pub struct SubagentCatalog {
    definitions: BTreeMap<String, SubagentDefinition>,
}

impl SubagentCatalog {
    pub fn discover(workspace_root: &Path, user_root: Option<&Path>) -> Result<Self, String> {
        let mut definitions: BTreeMap<String, SubagentDefinition> = builtins()
            .into_iter()
            .map(|value| (value.name.clone(), value))
            .collect();
        let user = user_root
            .map(Path::to_owned)
            .unwrap_or_else(|| PathBuf::from("Data/agents"));
        for (scope, root) in [
            ("user", user),
            ("project", workspace_root.join(".edenagent/agents")),
        ] {
            if !root.is_dir() {
                continue;
            }
            let mut paths = fs::read_dir(&root)
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("toml"))
                .collect::<Vec<_>>();
            paths.sort();
            for path in paths {
                let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                let mut definition: SubagentDefinition = toml::from_str(&raw).map_err(|error| {
                    format!("invalid sub-agent definition {}: {error}", path.display())
                })?;
                definition.source = scope.to_owned();
                let definition = definition.validate().map_err(|error| {
                    format!("invalid sub-agent definition {}: {error}", path.display())
                })?;
                definitions.insert(definition.name.clone(), definition);
            }
        }
        Ok(Self { definitions })
    }

    pub fn resolve(&self, name: &str) -> Result<SubagentDefinition, String> {
        self.definitions
            .get(if name.trim().is_empty() {
                "general"
            } else {
                name
            })
            .cloned()
            .ok_or_else(|| format!("unknown sub-agent role: {name}"))
    }

    pub fn definitions(&self) -> Vec<SubagentDefinition> {
        self.definitions.values().cloned().collect()
    }
}

fn builtins() -> Vec<SubagentDefinition> {
    let definition =
        |name: &str, description: &str, instructions: &str, mode: &str, max_turns: u32| {
            SubagentDefinition {
                name: name.to_owned(),
                description: description.to_owned(),
                developer_instructions: instructions.to_owned(),
                policy: SubagentToolPolicy {
                    sandbox_mode: mode.to_owned(),
                    ..SubagentToolPolicy::default()
                }
                .normalized()
                .expect("builtin policy"),
                budget: SubagentBudget {
                    max_turns,
                    ..SubagentBudget::default()
                },
                source: "builtin".to_owned(),
                ..SubagentDefinition::default()
            }
        };
    vec![
        definition(
            "general",
            "通用后台任务执行者",
            "严格围绕委派任务工作，向父智能体提供证据和结论。",
            "inherit",
            64,
        ),
        definition(
            "researcher",
            "外部资料搜索与多来源核验",
            "先定位可信来源，明确区分事实、推断和未验证信息。",
            "read-only",
            24,
        ),
        definition(
            "explore",
            "只读探索代码位置和调用链",
            "缩小搜索范围后读取关键实现，不修改工作区。",
            "read-only",
            64,
        ),
        definition(
            "file_locator",
            "Read-only location of personal files, game saves, and application data within explicitly approved roots",
            "Only locate and verify evidence; never copy, modify, delete, or execute files. Outside the workspace, use external_ls, external_find, external_read, and external_grep. Keep each approved root narrow and return exact paths plus the evidence used to identify them.",
            "read-only",
            32,
        ),
        definition(
            "coder",
            "实现边界清晰的代码改动",
            "保留用户修改，完成后运行与风险相称的验证。",
            "workspace-write",
            64,
        ),
        definition(
            "reviewer",
            "只读审查实现与测试覆盖",
            "报告具体可验证的缺陷，不修改文件。",
            "read-only",
            32,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_definition_overrides_user_and_policy_only_narrows() {
        let root = tempfile::tempdir().expect("root");
        let user = root.path().join("user");
        let project = root.path().join(".edenagent/agents");
        fs::create_dir_all(&user).expect("user");
        fs::create_dir_all(&project).expect("project");
        fs::write(
            user.join("reviewer.toml"),
            "name='reviewer'\ndescription='user'\ndeveloper_instructions='user instructions'\n",
        )
        .expect("user config");
        fs::write(project.join("reviewer.toml"), "name='reviewer'\ndescription='project'\ndeveloper_instructions='project instructions'\nsandbox_mode='read-only'\nreasoning='high'\n[budget]\nmax_turns=12\nmax_tool_calls=20\ntimeout_seconds=300\nmax_tokens=50000\nmax_cost_microusd=100000\n").expect("project config");
        let catalog = SubagentCatalog::discover(root.path(), Some(&user)).expect("catalog");
        let reviewer = catalog.resolve("reviewer").expect("reviewer");
        assert_eq!(reviewer.description, "project");
        assert_eq!(reviewer.budget.max_turns, 12);
        assert!(!reviewer.policy.allows("write"));
        assert!(!reviewer.policy.allows("remember_memory"));
    }

    #[test]
    fn nested_policy_never_expands_parent_sandbox_or_root_only_tools() {
        let parent = SubagentToolPolicy {
            sandbox_mode: "workspace-write".to_owned(),
            allowed_tools: None,
            denied_tools: BTreeSet::new(),
        }
        .normalized()
        .expect("parent policy");
        let requested = SubagentToolPolicy::default()
            .normalized()
            .expect("child policy");
        let restricted = parent.restrict(&requested).expect("restricted policy");
        assert_eq!(restricted.sandbox_mode, "workspace-write");
        assert!(!restricted.allows("remember_memory"));

        let read_only = SubagentToolPolicy {
            sandbox_mode: "read-only".to_owned(),
            ..SubagentToolPolicy::default()
        }
        .normalized()
        .expect("read-only policy");
        let restricted = parent.restrict(&read_only).expect("read-only child");
        assert_eq!(restricted.sandbox_mode, "read-only");
        assert!(restricted.allows("spawn_agents"));
        assert!(!restricted.allows("write"));
    }
}
