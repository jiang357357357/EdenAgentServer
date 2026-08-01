from __future__ import annotations

from pathlib import Path
from typing import Any

from mon_agent_core.coding_agent.tools import create_all_tools

from .assistants import create_assistant_tools
from .character_actions import create_character_action_tools
from .context import MonToolContext
from .email import create_email_tools
from .environment import create_environment_tools
from .external_files import create_external_file_tools
from .interaction import create_interaction_tools
from .loaded import create_loaded_tools
from .memo import create_memo_tools
from .memory import create_memory_tools
from .notify import create_notify_tools
from .profiles import allowed_tool_names
from .qq import create_qq_tools
from .self_awake_tools import create_self_awake_tools
from .stickers import create_sticker_tools
from .subagents import create_subagent_tools
from .timer import create_timer_tools
from .vision import create_vision_tools
from .web import create_web_tools


def create_mon_agent_tools(
    workspace_root: str | Path,
    context: MonToolContext | None = None,
    profile: str = "user_chat",
) -> list[Any]:
    context = context or MonToolContext()
    root = Path(workspace_root).resolve()
    tools: list[Any] = []
    tools.extend(create_loaded_tools(tools))
    tools.extend(create_assistant_tools(context))
    tools.extend(create_web_tools())
    tools.extend(create_environment_tools(context))
    tools.extend(create_external_file_tools(root, context))
    tools.extend(create_interaction_tools(context))
    tools.extend(create_character_action_tools(context))
    tools.extend(create_self_awake_tools(root, context))
    tools.extend(create_memo_tools(root, context))
    tools.extend(create_memory_tools(context))
    tools.extend(create_sticker_tools(context))
    tools.extend(create_timer_tools(root))
    tools.extend(create_email_tools(context))
    tools.extend(create_qq_tools(context))
    tools.extend(create_notify_tools(context))
    tools.extend(create_vision_tools(root, context))
    tools.extend(create_subagent_tools(context))

    def outside_write_allowed() -> bool:
        if context.permissions is not None:
            return context.permissions.mode_for_session(context.session_id) == "takeover"
        return context.permission_mode == "takeover"
    coding_tools = create_all_tools(
        str(root),
        {
            "bash": {
                "owner_key": f"{context.session_id or 'unbound'}:{context.agent_path}",
            },
            "write": {"allow_outside_cwd": outside_write_allowed},
            "edit": {"allow_outside_cwd": outside_write_allowed},
            "apply_patch": {"allow_outside_cwd": outside_write_allowed},
        },
    )
    allowed = allowed_tool_names(profile, tools, coding_tools)
    for name, tool in coding_tools.items():
        if name in allowed:
            tools.append(tool)
    return [tool for tool in tools if tool.name in allowed]
