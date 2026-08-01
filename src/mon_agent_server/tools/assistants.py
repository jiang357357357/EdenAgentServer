from __future__ import annotations

import asyncio
from typing import Any

from mon_agent_core import AgentTool

from .context import MonToolContext
from .core_access import core_call, require_core_access
from .result import text_result


def _assistant_line(assistant: dict[str, Any]) -> str:
    character = assistant.get("character") if isinstance(assistant.get("character"), dict) else {}
    name = assistant.get("name") or character.get("name") or "未命名助手"
    flags = []
    if assistant.get("is_current"):
        flags.append("全局当前")
    if assistant.get("is_default"):
        flags.append("默认")
    suffix = f"（{'、'.join(flags)}）" if flags else ""
    return f"#{assistant.get('id')} {name} / 角色：{character.get('name') or '未绑定角色'}{suffix}"


def create_assistant_tools(context: MonToolContext) -> list[AgentTool]:
    async def list_execute(
        _call_id: str,
        _params: dict[str, Any],
        _signal: Any = None,
        _update: Any = None,
    ) -> dict[str, Any]:
        core, token = require_core_access(context)
        assistants = await asyncio.to_thread(core_call, core.list_assistants, token)
        body = (
            "当前用户没有可用助手。"
            if not assistants
            else "可用助手：\n\n" + "\n".join(f"- {_assistant_line(assistant)}" for assistant in assistants)
        )
        return text_result(body, {"assistants": assistants, "count": len(assistants)})

    async def switch_execute(
        _call_id: str,
        params: dict[str, Any],
        _signal: Any = None,
        _update: Any = None,
    ) -> dict[str, Any]:
        if context.agent_path != "/root":
            raise RuntimeError("只有当前会话的父智能体可以切换会话助手。")
        if not context.switch_session_assistant:
            raise RuntimeError("当前运行环境不支持切换会话助手。")
        assistant_id = params.get("assistant_id")
        if assistant_id in (None, ""):
            raise ValueError("assistant_id 不能为空；请先查看助手列表并使用明确的助手 ID。")
        result = await context.switch_session_assistant(assistant_id)
        assistant = result.get("assistant") if isinstance(result.get("assistant"), dict) else {}
        character = assistant.get("character") if isinstance(assistant.get("character"), dict) else {}
        name = assistant.get("name") or character.get("name") or assistant_id
        return text_result(
            f"切换完成。你现在是助手「{name}」，请直接以新身份完成用户当前请求。"
            "会话历史已保留，不要替原助手告别或转交。",
            result,
        )

    return [
        AgentTool(
            "list_assistants",
            "查看助手列表",
            "列出当前用户可用的助手、绑定角色以及默认/当前状态。切换前目标不明确时先调用。",
            {"type": "object", "properties": {}},
            list_execute,
        ),
        AgentTool(
            "switch_session_assistant",
            "切换会话助手",
            "将当前会话切换给指定助手。新助手立即接手并保留会话历史；不修改用户的全局默认助手。",
            {
                "type": "object",
                "properties": {
                    "assistant_id": {
                        "type": "number",
                        "description": "通过 list_assistants 获得的助手 ID。",
                    }
                },
                "required": ["assistant_id"],
            },
            switch_execute,
            execution_mode="sequential",
        ),
    ]
