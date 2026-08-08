from __future__ import annotations

import asyncio
import re
from typing import Any

from mon_agent_core import AgentTool

from .context import MonToolContext
from .core_access import core_call, require_core_access
from .datetime_utils import format_local_datetime
from .result import text_result, tool_failure


_SECRET_PATTERN = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|token|password|密码|密钥)\s*[:=：]\s*\S+)",
    re.IGNORECASE,
)


def _require_root_writer(context: MonToolContext) -> None:
    if context.agent_path != "/root":
        raise tool_failure("blocked", "子智能体只能检索长期记忆；写入、修改和遗忘必须由父智能体执行。")


def _safe_content(value: Any) -> str:
    content = re.sub(r"\s+", " ", str(value or "").strip())
    if not content:
        raise ValueError("记忆内容不能为空。")
    if _SECRET_PATTERN.search(content):
        raise ValueError("检测到可能的密钥、令牌或密码，拒绝写入长期记忆。")
    return content


def _memory_line(memory: dict[str, Any]) -> str:
    created_raw = memory.get("created_at")
    updated_raw = memory.get("updated_at")
    created_text = format_local_datetime(created_raw)
    updated_text = format_local_datetime(updated_raw)
    lines = [
        f"#{memory.get('id')} [{memory.get('kind') or 'fact'}]",
        f"   写入时间（本地）: {created_text}",
    ]
    if updated_raw and updated_text != created_text:
        lines.append(f"   更新时间（本地）: {updated_text}")
    lines.append(f"   内容: {memory.get('content') or ''}")
    return "\n".join(lines)


def _agent_character_id(context: MonToolContext, params: dict[str, Any]) -> int | str | None:
    explicit = params.get("agent_character_id")
    if explicit not in (None, ""):
        return explicit
    character = context.character if isinstance(context.character, dict) else {}
    return character.get("id")


def create_memory_tools(context: MonToolContext) -> list[AgentTool]:
    async def remember_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        _require_root_writer(context)
        core, token = require_core_access(context)
        scope_type = params.get("scope_type") or "agent_character"
        agent_character_id = _agent_character_id(context, params)
        if scope_type == "agent_character" and not agent_character_id:
            raise ValueError("智能体角色记忆必须提供 agent_character_id，或在当前会话绑定角色。")
        memory = await asyncio.to_thread(
            core_call,
            core.remember_memory,
            token,
            {
                "content": _safe_content(params["content"]),
                "kind": params.get("kind") or "fact",
                "scope_type": scope_type,
                "scope_key": str(agent_character_id or "") if scope_type == "agent_character" else params.get("scope_key") or "",
                "assistant": params.get("assistant_id"),
                "agent_character": agent_character_id if scope_type == "agent_character" else None,
                "source_session_id": context.session_id or "",
                "source_message_ids": [context.get_message_id()] if context.get_message_id and context.get_message_id() else [],
                "metadata": {"source": "explicit_tool", "agent_path": context.agent_path},
            },
        )
        return text_result(f"已写入长期记忆：\n\n{_memory_line(memory)}", {"memory": memory})

    async def search_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        core, token = require_core_access(context)
        memories = await asyncio.to_thread(
            core_call,
            core.list_memories,
            token,
            {
                "q": params.get("query"),
                "scope_type": params.get("scope_type"),
                "scope_key": params.get("scope_key"),
                "kind": params.get("kind"),
                "assistant": params.get("assistant_id"),
                "agent_character": _agent_character_id(context, params),
                "limit": params.get("limit") or 10,
            },
        )
        body = "没有找到相关长期记忆。" if not memories else "相关长期记忆：\n\n" + "\n".join(
            f"- {_memory_line(memory)}" for memory in memories
        )
        return text_result(body, {"memories": memories, "count": len(memories)})

    async def update_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        _require_root_writer(context)
        core, token = require_core_access(context)
        memory = await asyncio.to_thread(
            core_call,
            core.update_memory,
            token,
            int(params["id"]),
            {"content": _safe_content(params["content"]), **({"kind": params["kind"]} if params.get("kind") else {})},
        )
        return text_result(f"已更新长期记忆：\n\n{_memory_line(memory)}", {"memory": memory})

    async def forget_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        _require_root_writer(context)
        core, token = require_core_access(context)
        memory = await asyncio.to_thread(core_call, core.forget_memory, token, int(params["id"]))
        return text_result(f"已遗忘长期记忆 #{memory.get('id')}。", {"memory": memory})

    scope_properties = {
        "scope_type": {"type": "string", "enum": ["agent_character", "project", "workspace"]},
        "scope_key": {"type": "string"},
        "assistant_id": {"type": "number"},
        "agent_character_id": {"type": "number"},
    }
    return [
        AgentTool(
            "remember_memory", "记住长期信息",
            "当用户明确要求记住，或确认了未来会持续有用的稳定偏好、事实、决策或流程时写入当前智能体角色的长期记忆。角色之间不共享记忆。不要保存密码、密钥、临时进度或猜测。",
            {"type": "object", "properties": {"content": {"type": "string"}, "kind": {"type": "string", "enum": ["preference", "fact", "decision", "procedure"]}, **scope_properties}, "required": ["content"]},
            remember_execute, execution_mode="sequential",
        ),
        AgentTool(
            "search_memories", "搜索长期记忆",
            "按需搜索当前用户可见的历史偏好、事实、决策和流程；普通相关记忆会由运行时自动召回。",
            {"type": "object", "properties": {"query": {"type": "string"}, "kind": {"type": "string"}, "limit": {"type": "number"}, **scope_properties}},
            search_execute,
        ),
        AgentTool(
            "update_memory", "更新长期记忆",
            "修正一条已知 ID 的长期记忆。",
            {"type": "object", "properties": {"id": {"type": "number"}, "content": {"type": "string"}, "kind": {"type": "string"}}, "required": ["id", "content"]},
            update_execute, execution_mode="sequential",
        ),
        AgentTool(
            "forget_memory", "遗忘长期记忆",
            "在用户明确要求遗忘且目标记忆 ID 已确定时使用。目标不明确时先搜索或询问。",
            {"type": "object", "properties": {"id": {"type": "number"}}, "required": ["id"]},
            forget_execute, execution_mode="sequential",
        ),
    ]
