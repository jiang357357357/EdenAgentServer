use super::*;

#[test]
fn single_participant_assistant_events_keep_speaker_voice_metadata() {
    let event = AgentEvent::MessageEnd {
        message: Message::Assistant(AssistantMessage::text("hello")),
    };
    let annotated = annotate_agent_event(
        event,
        &json!({
            "assistantID": "assistant-1",
            "characterID": "character-1",
            "ttsConfigID": 2,
        }),
        &json!({}),
    );
    let AgentEvent::MessageEnd {
        message: Message::Assistant(message),
    } = annotated
    else {
        panic!("expected assistant message end");
    };
    assert_eq!(message.extra["speaker"]["assistantID"], "assistant-1");
    assert_eq!(message.extra["speaker"]["ttsConfigID"], 2);
}

#[test]
fn self_awake_profile_rejects_interactive_and_dynamic_process_tools() {
    let mut tools = ToolRegistry::new();
    for name in ["read", "powershell", "bash", "write_stdin", "get_self_awake_context", "search_memories", "show_desktop_reminder", "get_desktop_reminder", "contact_user", "send_qq_message", "send_external_email", "switch_session_assistant"] {
        tools.register(Arc::new(NamedTool(name)));
    }
    tools.register_dynamic_source(Arc::new(ReloadableUnsafeTool));

    let filtered = tools_for_profile(&tools, prompt::PromptProfile::SelfAwake);
    assert!(filtered.get("read").is_some());
    for name in ["powershell", "bash", "write_stdin", "get_self_awake_context", "search_memories", "show_desktop_reminder", "get_desktop_reminder"] { assert!(filtered.get(name).is_some()); }
    assert!(filtered.get("switch_session_assistant").is_none());
    for name in ["contact_user", "send_qq_message", "send_external_email"] { assert!(filtered.get(name).is_none()); }
    assert!(filtered.get("skill_process_tool").is_none());
    assert!(filtered.get("subagent_only_tool").is_none());
    assert_eq!(filtered.direct_definitions().len(), 8);

    let user_tools = tools_for_profile(&tools, prompt::PromptProfile::UserChat);
    assert!(user_tools.get("skill_process_tool").is_some());
    assert!(user_tools.get("subagent_only_tool").is_none());
}
