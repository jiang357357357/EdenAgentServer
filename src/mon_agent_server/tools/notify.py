from __future__ import annotations

from typing import Any

from mon_agent_core import AgentTool

from ..ids import now_ms
from .context import MonToolContext
from .email import send_external_email
from .qq import send_qq_message
from .result import text_result


def create_notify_tools(context: MonToolContext) -> list[AgentTool]:
    async def notify_user_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        title = str(params.get("title") or "").strip()
        message = str(params.get("message") or "").strip()
        if not message:
            raise RuntimeError("通知用户需要 message。")

        requested_channel = str(params.get("channel") or "auto").strip().lower()
        if requested_channel not in {"auto", "qq", "email", "both"}:
            raise RuntimeError("channel 必须是 auto、qq、email 或 both。")
        priority = str(params.get("priority") or "normal").strip().lower() or "normal"
        metadata = params.get("metadata") if isinstance(params.get("metadata"), dict) else {}
        source_type = str(params.get("source_type") or metadata.get("source_type") or "").strip()
        source_id = str(params.get("source_id") or metadata.get("source_id") or "").strip()

        text = f"{title}\n\n{message}" if title else message
        email_subject = title or "MonAgent 提醒"
        notify_metadata = {
            **metadata,
            "source": "notify_user",
            "source_type": source_type or metadata.get("source_type") or "agent",
            "source_id": source_id or metadata.get("source_id") or "",
            "priority": priority,
        }

        if requested_channel == "both":
            channels = ["qq", "email"]
            fallback = False
        elif requested_channel == "qq":
            channels = ["qq"]
            fallback = False
        elif requested_channel == "email":
            channels = ["email"]
            fallback = False
        else:
            channels = ["email", "qq"] if priority == "high" else ["qq", "email"]
            fallback = True

        attempts: list[dict[str, Any]] = []
        delivered_channels: list[str] = []

        async def try_channel(channel: str) -> None:
            try:
                if channel == "qq":
                    request_id_parts = ["notify", str(now_ms())]
                    if source_type:
                        request_id_parts.append(source_type)
                    if source_id:
                        request_id_parts.append(source_id)
                    result = await send_qq_message(
                        context,
                        {
                            "content": text,
                            "metadata": notify_metadata,
                            "request_id": "-".join(request_id_parts),
                        },
                    )
                else:
                    result = await send_external_email(
                        context,
                        {
                            "subject": email_subject,
                            "content": text,
                            "metadata": notify_metadata,
                        },
                    )
                attempts.append({"channel": channel, "success": True, "result": result.get("details") if isinstance(result, dict) else result})
                delivered_channels.append(channel)
            except Exception as error:
                attempts.append({"channel": channel, "success": False, "error": str(error)})

        if fallback:
            await try_channel(channels[0])
            if not delivered_channels:
                await try_channel(channels[1])
        else:
            for channel in channels:
                await try_channel(channel)

        if not delivered_channels:
            errors = "; ".join(f"{item['channel']}: {item.get('error')}" for item in attempts)
            raise RuntimeError(f"通知用户失败：{errors}")

        body = "\n".join(
            [
                "已通知用户。",
                f"请求通道: {requested_channel}",
                f"实际通道: {', '.join(delivered_channels)}",
                f"优先级: {priority}",
            ]
        )
        return text_result(
            body,
            {
                "success": True,
                "requested_channel": requested_channel,
                "delivered_channels": delivered_channels,
                "attempts": attempts,
                "priority": priority,
                "title": title,
                "message": message,
                "metadata": notify_metadata,
                "all_requested_channels_succeeded": requested_channel != "both" or set(delivered_channels) == {"qq", "email"},
            },
        )

    return [
        AgentTool(
            "notify_user",
            "通知用户",
            "向当前用户发送主动通知。channel=auto 时，priority=high 的重要事件优先发邮件并回退到 QQ，其他普通事件优先发 QQ 并回退到邮件；qq/email/both 可显式指定通道。到期提醒应先调用本工具通知成功，再标记提醒已触发。",
            {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "通知标题，可省略。"},
                    "message": {"type": "string", "description": "通知正文。"},
                    "channel": {"type": "string", "enum": ["auto", "qq", "email", "both"], "description": "通知通道，默认 auto。"},
                    "priority": {"type": "string", "enum": ["low", "normal", "high"], "description": "通知优先级，默认 normal。"},
                    "source_type": {"type": "string", "description": "可选来源类型，如 memo、reminder。"},
                    "source_id": {"type": "string", "description": "可选来源 ID。"},
                    "metadata": {"type": "object", "description": "可选业务元数据。"},
                },
                "required": ["message"],
            },
            notify_user_execute,
            execution_mode="sequential",
        )
    ]
