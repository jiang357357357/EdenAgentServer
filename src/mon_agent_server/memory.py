from __future__ import annotations

import json
import re
from typing import Any

from .core import CoreClient
from .logging import get_logger
from .model_stream import stream_openai_compatible


logger = get_logger("MonAgent", "Memory")
_SECRET_PATTERN = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|token|password|密码|密钥)\s*[:=：]\s*\S+)",
    re.IGNORECASE,
)


def _assistant_text(message: dict[str, Any]) -> str:
    return "".join(
        str(block.get("text") or "")
        for block in message.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()


def _parse_json(text: str) -> dict[str, Any]:
    value = text.strip()
    if value.startswith("```"):
        value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.IGNORECASE)
        value = re.sub(r"\s*```$", "", value)
    start, end = value.find("{"), value.rfind("}")
    if start < 0 or end < start:
        return {"memories": []}
    parsed = json.loads(value[start:end + 1])
    return parsed if isinstance(parsed, dict) else {"memories": []}


async def extract_turn_memories(
    *,
    core_client: CoreClient,
    core_token: str,
    runtime_config: Any,
    session_id: str,
    user_message_id: str,
    user_text: str,
    assistant_text: str,
    assistant_id: int | str | None,
    agent_character_id: int | str | None,
) -> list[dict[str, Any]]:
    if not runtime_config.api_key or not user_text.strip() or not assistant_text.strip():
        return []
    if not agent_character_id:
        return []
    system_prompt = """你是长期记忆提取器。只提取用户明确陈述或双方已经确认、未来跨会话仍有用的稳定信息。
允许类型：preference（用户偏好）、fact（稳定事实）、decision（已确认长期决策）、procedure（可复用流程）。
不要提取临时任务进度、问题本身、模型推测、工具原始输出、寒暄、密码、密钥、令牌或其他认证信息。
如果没有值得长期保存的信息，返回 {\"memories\":[]}。
只输出严格 JSON：{\"memories\":[{\"kind\":\"preference|fact|decision|procedure\",\"content\":\"独立、清楚、第三人称陈述\",\"confidence\":0.0}]}。
所有长期记忆都属于当前智能体角色，不存在跨角色共享的用户记忆。
仅输出置信度不低于 0.85 的候选；宁可遗漏，不要猜测。"""
    context = {
        "systemPrompt": system_prompt,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"用户消息：\n{user_text[:6000]}\n\n助手最终回复：\n{assistant_text[:6000]}",
                    }
                ],
            }
        ],
    }
    try:
        stream = await stream_openai_compatible(
            runtime_config.model,
            context,
            {"apiKey": runtime_config.api_key, "maxTokens": 1200, "temperature": 0},
        )
        message = await stream.result()
        parsed = _parse_json(_assistant_text(message))
    except Exception:
        logger.exception("长期记忆自动提取失败: session={}", session_id)
        return []

    saved: list[dict[str, Any]] = []
    for item in parsed.get("memories", []) if isinstance(parsed.get("memories"), list) else []:
        if not isinstance(item, dict):
            continue
        content = re.sub(r"\s+", " ", str(item.get("content") or "").strip())
        kind = str(item.get("kind") or "fact")
        try:
            confidence = float(item.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0
        if (
            not content
            or len(content) > 4000
            or confidence < 0.85
            or kind not in {"preference", "fact", "decision", "procedure"}
            or _SECRET_PATTERN.search(content)
        ):
            continue
        payload = {
            "assistant": None,
            "agent_character": agent_character_id,
            "scope_type": "agent_character",
            "scope_key": str(agent_character_id),
            "kind": kind,
            "content": content,
            "source_session_id": session_id,
            "source_message_ids": [user_message_id],
            "confidence": confidence,
            "metadata": {
                "source": "automatic_extraction",
                "source_assistant_id": assistant_id,
            },
        }
        try:
            saved.append(core_client.remember_memory(core_token, payload))
        except Exception:
            logger.exception("自动提取记忆写入 Core 失败: session={}", session_id)
    return saved
