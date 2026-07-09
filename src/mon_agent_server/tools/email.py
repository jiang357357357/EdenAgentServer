from __future__ import annotations

import asyncio
from typing import Any

from mon_agent_core import AgentTool

from .context import MonToolContext
from .core_access import core_call, require_core_access
from .result import text_result


async def send_external_email(context: MonToolContext, params: dict[str, Any]) -> dict[str, Any]:
    core, token = require_core_access(context)
    subject = str(params.get("subject") or "").strip()
    content = str(params.get("content") or "").strip()
    if not subject or not content:
        raise RuntimeError("发送外部邮件需要 subject 和 content。")
    payload = {
        "subject": subject,
        "content": content,
        "html": str(params.get("html") or ""),
    }
    if params.get("to") not in (None, "", []):
        payload["to"] = params.get("to")
    result = await asyncio.to_thread(core_call, core.send_external_email, token, payload)
    recipients = result.get("to") or []
    recipient_text = ", ".join(str(item) for item in recipients) if isinstance(recipients, list) else str(recipients)
    rejected = result.get("rejected") or {}
    body = f"外部邮件已发送给 {recipient_text or '默认收件人'}。"
    if rejected:
        body += f"\n部分收件人被拒绝: {list(rejected.keys())}"
    return text_result(body, result)


def create_email_tools(context: MonToolContext) -> list[AgentTool]:
    async def external_email_status_execute(_tool_call_id: str, _params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        status = await asyncio.to_thread(core_call, core.external_email_status, token)
        ready = "可用" if status.get("ready") else "不可用"
        body = "\n".join(
            [
                f"外部邮箱状态: {ready}",
                f"启用: {'是' if status.get('enabled') else '否'}",
                f"SMTP: {status.get('smtp_host')}:{status.get('smtp_port')} ({status.get('smtp_security')})",
                f"账号: {status.get('username') or '-'}",
                f"默认收件人: {status.get('default_to') or '-'}",
                f"最近状态: {status.get('last_status') or '-'}",
                f"最近错误: {status.get('last_error') or '-'}",
            ]
        )
        return text_result(body, status)

    async def send_external_email_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        return await send_external_email(context, params)

    return [
        AgentTool(
            "external_email_status",
            "外部邮箱状态",
            "查看当前 Core 用户的外部邮箱配置是否可用于发信。实际邮件发送能力由 MonOs Email 模块提供。",
            {"type": "object", "properties": {}},
            external_email_status_execute,
        ),
        AgentTool(
            "send_external_email",
            "发送外部邮件",
            "通过 Core 用户配置调用 MonOs Email 能力发送外部邮件；to 为空时使用默认收件人。",
            {
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "description": "邮件主题。"},
                    "content": {"type": "string", "description": "纯文本正文。"},
                    "to": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "收件邮箱列表；为空时使用默认收件人。",
                    },
                    "html": {"type": "string", "description": "可选 HTML 正文。"},
                },
                "required": ["subject", "content"],
            },
            send_external_email_execute,
            execution_mode="sequential",
        ),
    ]
