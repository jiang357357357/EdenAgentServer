from __future__ import annotations

import asyncio
from typing import Any

from mon_agent_core import AgentTool

from ..core import CoreClient
from .context import MonToolContext
from .core_access import core_call, require_core_access
from .datetime_utils import format_local_datetime
from .result import text_result


def qq_bot_line(bot: dict[str, Any]) -> str:
    contacts = bot.get("qq_contacts") if isinstance(bot.get("qq_contacts"), list) else []
    groups = bot.get("qq_groups") if isinstance(bot.get("qq_groups"), list) else []
    default = " [默认]" if bot.get("is_default") else ""
    return "\n".join(
        [
            f"#{bot.get('id')} {bot.get('bot_name') or bot.get('bot_id')}{default}",
            f"   QQ: {bot.get('bot_id')}",
            f"   状态: {bot.get('status_display') or bot.get('status')}",
            f"   好友/群聊: {len(contacts)} / {len(groups)}",
            f"   最后在线: {format_local_datetime(bot.get('last_seen'))}",
        ]
    )


def qq_target_line(item: dict[str, Any], target_type: str) -> str:
    qq_number = str(item.get("qq_number") or item.get("id") or item.get("target_qq_number") or "")
    name = str(item.get("name") or qq_number or "未知对象")
    label = str(item.get("permission_label") or item.get("access_reason") or "")
    approved = "已批准" if item.get("approved") else "未批准"
    return f"[{target_type}] {name} ({qq_number}) - {approved}{' / ' + label if label else ''}"


def qq_management_data(raw: Any) -> dict[str, Any]:
    data = raw.get("data") if isinstance(raw, dict) else raw
    return data if isinstance(data, dict) else {}


def qq_management_bot_id(data: dict[str, Any]) -> Any:
    return data.get("bot_id") or data.get("default_bot_id")


def qq_default_send_target(data: dict[str, Any]) -> dict[str, Any] | None:
    target = data.get("default_send_target")
    if isinstance(target, dict) and target.get("target_qq_number"):
        return target
    permissions = data.get("permissions") if isinstance(data.get("permissions"), dict) else {}
    contacts = permissions.get("allowed_contacts") if isinstance(permissions, dict) else []
    if not isinstance(contacts, list):
        return None
    for item in contacts:
        if not isinstance(item, dict):
            continue
        if item.get("approved") and item.get("permission_level") == "super_admin":
            return {
                "target_type": "user",
                "target_qq_number": item.get("target_qq_number") or item.get("qq_number") or item.get("id"),
                "name": item.get("name"),
                "permission_level": item.get("permission_level"),
                "permission_label": item.get("permission_label"),
            }
    return None


async def qq_get_management(core: CoreClient, token: str, bot_id: Any | None = None) -> tuple[dict[str, Any], Any]:
    raw = await asyncio.to_thread(core_call, core.get_qq_bot_management, token, bot_id)
    return qq_management_data(raw), raw


async def qq_resolve_send_target(core: CoreClient, token: str, params: dict[str, Any]) -> tuple[int, str, str, dict[str, Any] | None, Any]:
    bot_id = params.get("bot_id")
    management, raw_management = await qq_get_management(core, token, bot_id if bot_id not in (None, "") else None)
    resolved_bot_id = bot_id or qq_management_bot_id(management)
    if resolved_bot_id in (None, ""):
        raise RuntimeError("未设置默认 QQBot，请先在 QQBot 管理页设置默认机器人，或显式提供 bot_id。")

    explicit_target_type = str(params.get("target_type") or "").strip()
    explicit_target_number = str(params.get("target_qq_number") or "").strip()
    if explicit_target_number:
        return int(resolved_bot_id), explicit_target_type or "user", explicit_target_number, None, raw_management
    if explicit_target_type and explicit_target_type != "user":
        raise RuntimeError(f"发送到 {explicit_target_type} 时必须显式提供 target_qq_number。")

    default_target = qq_default_send_target(management)
    if not default_target:
        raise RuntimeError("未指定 QQ 发送目标，也未设置默认 QQBot 超级管理员。请在 QQBot 权限里把一个好友设为超级管理员，或显式提供 target_qq_number。")
    target_number = str(default_target.get("target_qq_number") or "").strip()
    if not target_number:
        raise RuntimeError("默认 QQBot 超级管理员缺少 QQ 号，无法发送。")
    return int(resolved_bot_id), str(default_target.get("target_type") or "user"), target_number, default_target, raw_management


async def send_qq_message(context: MonToolContext, params: dict[str, Any]) -> dict[str, Any]:
    core, token = require_core_access(context)
    content = str(params.get("content") or "").strip()
    if not content:
        raise RuntimeError("发送 QQ 消息需要 content。")
    bot_id, target_type, target_qq_number, default_target, raw_management = await qq_resolve_send_target(core, token, params)
    payload = {
        "target_type": target_type,
        "target_qq_number": target_qq_number,
        "content": content,
        "metadata": params.get("metadata") or {},
    }
    request_id = params.get("request_id") or (f"{context.operation_id}-qq" if context.operation_id else None)
    if request_id:
        payload["request_id"] = str(request_id)
    raw = await asyncio.to_thread(core_call, core.send_qq_message, token, bot_id, payload)
    data = raw.get("data") if isinstance(raw, dict) else raw
    request_id = data.get("request_id") if isinstance(data, dict) else ""
    delivery = data.get("delivery") if isinstance(data, dict) else {}
    delivery = delivery if isinstance(delivery, dict) else {}
    confirmed = bool(delivery.get("confirmed"))
    delivery_status = str(delivery.get("status") or ("sent" if confirmed else "unknown"))
    message_id = str(delivery.get("message_id") or "")
    api_name = str(delivery.get("api") or "")
    default_note = "默认目标: 是" if default_target else "默认目标: 否"
    status_line = "QQ 消息已由 BotCore/NapCat 确认发送。" if confirmed else f"QQ 消息已下发，但投递回执未确认: {delivery_status}"
    body = "\n".join(
        [
            status_line,
            f"Bot: #{bot_id}",
            f"目标: {target_type}:{target_qq_number}",
            default_note,
            f"request_id: {request_id or '-'}",
            f"message_id: {message_id or '-'}",
            f"api: {api_name or '-'}",
        ]
    )
    details = raw if isinstance(raw, dict) else {"data": raw}
    if isinstance(details, dict):
        details["resolved"] = {
            "bot_id": bot_id,
            "target_type": target_type,
            "target_qq_number": target_qq_number,
            "used_default_target": bool(default_target),
            "management": raw_management,
        }
    return text_result(body, details)


def create_qq_tools(context: MonToolContext) -> list[AgentTool]:
    async def qq_bot_list_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        bots = await asyncio.to_thread(
            core_call,
            core.list_qq_bots,
            token,
            params.get("owner_only", True) is not False,
            str(params.get("status") or "").strip() or None,
        )
        body = "QQBot 列表：\n\n" + ("\n\n".join(qq_bot_line(bot) for bot in bots) if bots else "暂无可用 QQBot。")
        return text_result(body, {"bots": bots, "count": len(bots)})

    async def qq_bot_targets_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        data, raw = await qq_get_management(core, token, params.get("bot_id"))
        bot_id = qq_management_bot_id(data)
        if bot_id in (None, ""):
            raise RuntimeError("未设置默认 QQBot，请先在 QQBot 管理页设置默认机器人，或显式提供 bot_id。")
        permissions = data.get("permissions") if isinstance(data, dict) else {}
        include_unapproved = bool(params.get("include_unapproved"))
        contacts = permissions.get("allowed_contacts") if isinstance(permissions, dict) else []
        groups = permissions.get("allowed_groups") if isinstance(permissions, dict) else []
        contacts = contacts if isinstance(contacts, list) else []
        groups = groups if isinstance(groups, list) else []
        contacts = [item for item in contacts or [] if include_unapproved or item.get("approved")]
        groups = [item for item in groups or [] if include_unapproved or item.get("approved")]
        contact_text = "\n".join(qq_target_line(item, "user") for item in contacts) or "暂无已批准好友。"
        group_text = "\n".join(qq_target_line(item, "group") for item in groups) or "暂无已批准群聊。"
        default_target = qq_default_send_target(data)
        default_text = (
            f"\n\n默认发送目标：{default_target.get('target_type', 'user')}:{default_target.get('target_qq_number')}"
            if default_target
            else "\n\n默认发送目标：未设置超级管理员。"
        )
        return text_result(
            f"QQBot #{bot_id} 可发送目标：\n\n好友：\n{contact_text}\n\n群聊：\n{group_text}{default_text}",
            {"contacts": contacts, "groups": groups, "raw": raw},
        )

    async def send_qq_message_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        return await send_qq_message(context, params)

    return [
        AgentTool(
            "qq_bot_list",
            "QQBot 列表",
            "查看当前 Core 用户可管理的 QQBot、在线状态以及同步到的好友/群聊数量。",
            {
                "type": "object",
                "properties": {
                    "owner_only": {"type": "boolean", "description": "是否只看当前用户拥有的 QQBot，默认 true。"},
                    "status": {"type": "string", "description": "可选状态过滤：online、offline、error。"},
                },
            },
            qq_bot_list_execute,
        ),
        AgentTool(
            "qq_bot_targets",
            "QQBot 目标",
            "查看某个 QQBot 已批准可发送消息的好友和群聊。bot_id 不填时使用当前用户默认 QQBot。未批准目标不能通过发送工具发消息。",
            {
                "type": "object",
                "properties": {
                    "bot_id": {"type": "number", "description": "Core 中的 QQBot 数据库 ID；不填时使用当前用户默认 QQBot。"},
                    "include_unapproved": {"type": "boolean", "description": "是否同时列出未批准目标，默认 false。"},
                },
            },
            qq_bot_targets_execute,
        ),
        AgentTool(
            "send_qq_message",
            "发送 QQ 消息",
            "通过在线 BotCore/NapCat 向已批准的 QQ 好友或群聊发送一条文本消息。用户未指定 bot 或目标时不要询问，省略对应参数，工具会使用默认 QQBot 和超级管理员；content 是必填文本内容。用户没有给出具体正文但意图明确时，由智能体根据当前任务自己生成合适正文，不使用固定默认消息。",
            {
                "type": "object",
                "properties": {
                    "bot_id": {"type": "number", "description": "Core 中的 QQBot 数据库 ID；不填时使用当前用户默认 QQBot。"},
                    "target_type": {"type": "string", "enum": ["user", "group"], "description": "发送目标类型；不填且 target_qq_number 不填时使用默认 QQBot 的超级管理员。"},
                    "target_qq_number": {"type": "string", "description": "好友 QQ 号或群号；不填时使用默认 QQBot 的超级管理员 QQ 号。"},
                    "content": {"type": "string", "description": "要发送的文本内容，必填；没有用户指定正文时，根据当前任务生成合适正文。"},
                    "metadata": {"type": "object", "description": "可选来源/业务元数据。"},
                    "request_id": {"type": "string", "description": "可选请求 ID，不传则由 Core 生成。"},
                },
                "required": ["content"],
            },
            send_qq_message_execute,
            execution_mode="sequential",
        ),
    ]
