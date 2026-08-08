from __future__ import annotations

from dataclasses import replace
from typing import Any

from mon_agent_core import AgentTool


SAFE_TOOL_NAMES = frozenset({
    "load_skill", "list_skills", "read", "ls", "grep", "find",
    "external_ls", "external_read", "external_find", "external_grep",
    "search_memories", "web", "get_self_awake_state", "list_self_awake_diaries",
    "read_self_awake_diary", "external_email_status", "qq_bot_list", "qq_bot_targets",
    "read_qq_messages", "loaded_tools", "write_stdin", "list_assistants", "list_connectors",
    "query_openttd", "ask_user", "analyze_image", "analyze_screen",
    "get_calendar_context", "get_weather", "list_character_actions", "switch_character_action",
    "list_character_stickers", "send_character_sticker", "list_memos", "list_due_memos",
    "get_next_memo_wake", "spawn_agent", "send_message", "followup_task", "list_agents",
    "interrupt_agent",
})

VISUAL_TOOL_NAMES = frozenset({"analyze_screen", "capture_camera", "analyze_image"})
CONNECTOR_TOOL_NAMES = frozenset({
    "list_connectors", "register_connector", "set_connector_state", "claim_connector_events",
    "finish_connector_events", "query_openttd", "execute_connector_action",
})
CODING_TOOL_NAMES = frozenset({"read", "bash", "write_stdin", "edit", "write", "apply_patch", "grep", "find", "ls"})

# Match Codex's distinction between registration and model exposure. These are
# the small, general-purpose tools worth paying schema tokens for on every turn.
DIRECT_TOOL_NAMES = frozenset({
    "load_skill", "tool_search", "ask_user",
    "web",
    "read", "ls", "grep", "find", "write", "edit", "apply_patch", "bash", "write_stdin",
    "list_character_actions", "switch_character_action",
    "remember_memory", "search_memories", "update_memory", "forget_memory",
    "list_assistants", "switch_session_assistant",
    "spawn_agent", "send_message", "followup_task", "list_agents", "interrupt_agent",
})

# Runtime bookkeeping stays dispatchable but must never be suggested to the
# model. Add tools here only when another runtime component invokes them.
HIDDEN_TOOL_NAMES = frozenset()

TOOL_NAMESPACES = {
    "connector": CONNECTOR_TOOL_NAMES,
    "coding": CODING_TOOL_NAMES,
    "assistant": frozenset({"list_assistants", "switch_session_assistant"}),
    "character": frozenset({
        "list_character_actions", "switch_character_action",
        "list_character_stickers", "send_character_sticker",
    }),
    "memory": frozenset({"remember_memory", "search_memories", "update_memory", "forget_memory"}),
    "skill": frozenset({
        "load_skill", "tool_search", "list_skills", "create_skill", "update_skill",
        "install_skill", "uninstall_skill",
    }),
    "communication": frozenset({
        "external_email_status", "send_email", "qq_bot_list", "qq_bot_targets",
        "read_qq_messages", "send_qq_message", "notify_user",
    }),
    "self_awake": frozenset({
        "get_self_awake_state", "list_self_awake_diaries", "read_self_awake_diary",
    }),
}


def tool_namespace(name: str, source: str) -> str:
    for namespace, names in TOOL_NAMESPACES.items():
        if name in names:
            return namespace
    return "plugin" if source in {"skill", "extension"} else "general"


def _pattern(name: str, args: Any) -> str:
    if isinstance(args, dict):
        if name == "apply_patch" and isinstance(args.get("_paths"), list):
            return ", ".join(str(path) for path in args["_paths"])
        for key in ("path", "url", "query", "command"):
            if isinstance(args.get(key), str):
                return args[key]
    return name


def permission_resolver(name: str):
    if name in SAFE_TOOL_NAMES:
        return None

    def resolve(args: Any) -> dict[str, Any]:
        return {
            "permission": name,
            "patterns": [_pattern(name, args)],
            "always": ["*"] if name == "web" else [],
        }

    return resolve


def finalize_tool(tool: AgentTool, *, source: str) -> AgentTool:
    timeout = tool.timeout_seconds
    if timeout is None and tool.name != "ask_user":
        timeout = 300.0 if tool.name in VISUAL_TOOL_NAMES else 120.0
    capabilities = set(tool.capabilities)
    if tool.name in SAFE_TOOL_NAMES:
        capabilities.add("read")
    else:
        capabilities.add("mutate")
    if tool.name in CONNECTOR_TOOL_NAMES:
        capabilities.add("connector")
    if tool.name in CODING_TOOL_NAMES:
        capabilities.add("coding")
    exposure = (
        "hidden" if tool.name in HIDDEN_TOOL_NAMES
        else "direct" if tool.name in DIRECT_TOOL_NAMES
        else "deferred"
    )
    return replace(
        tool,
        timeout_seconds=timeout,
        source=source,
        capabilities=frozenset(capabilities),
        permission_resolver=permission_resolver(tool.name),
        exposure=exposure,
        namespace=tool_namespace(tool.name, source),
    )
