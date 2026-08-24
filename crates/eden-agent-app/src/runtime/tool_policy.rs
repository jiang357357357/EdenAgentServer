use crate::prompt;
use eden_agent_core::ToolRegistry;

const SELF_AWAKE_ALLOWED_TOOLS: &[&str] = &[
    "get_self_awake_state",
    "list_self_awake_diaries",
    "read_self_awake_diary",
    "web",
    "get_calendar_context",
    "get_weather",
    "analyze_image",
    "analyze_screen",
    "capture_camera",
    "create_memo",
    "create_reminder",
    "list_memos",
    "list_due_memos",
    "dispatch_due_memos",
    "get_next_memo_wake",
    "complete_memo",
    "archive_memo",
    "snooze_memo",
    "mark_memo_triggered",
    "external_email_status",
    "qq_bot_list",
    "qq_bot_targets",
    "read_qq_messages",
    "send_qq_message",
    "send_external_email",
    "contact_user",
    "list_connectors",
    "describe_connector",
    "register_connector",
    "set_connector_state",
    "claim_connector_events",
    "finish_connector_events",
    "execute_connector_action",
    "query_openttd",
    "query_connector",
    "query_victoria3",
    "openttd_newgrf",
    "read",
    "ls",
    "grep",
    "find",
    "create_skill",
    "update_skill",
    "list_skills",
];

pub(super) fn tools_for_profile(
    tools: &ToolRegistry,
    profile: prompt::PromptProfile,
) -> ToolRegistry {
    match profile {
        prompt::PromptProfile::UserChat => tools.only(
            tools
                .direct_definitions()
                .into_iter()
                .filter(|definition| {
                    definition.profiles.is_empty()
                        || definition.profiles.iter().any(|value| value == "user_chat")
                })
                .map(|definition| definition.name),
        ),
        prompt::PromptProfile::SelfAwake => tools.only(SELF_AWAKE_ALLOWED_TOOLS),
    }
}
