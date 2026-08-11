from __future__ import annotations

import re
from typing import Any

from .logging import get_logger
from .model_stream import stream_openai_compatible


logger = get_logger("MonAgent", "SessionTitle")

_SYSTEM_PROMPT = """你是会话标题生成器。只输出一个便于用户日后查找本次会话的标题。
要求：
- 与用户消息使用相同语言；
- 单行，不超过 50 个字符；
- 聚焦用户真正要讨论或完成的主题；
- 不解释，不回答问题，不使用引号或 Markdown；
- 不写工具名，不写“生成标题”“总结会话”等过程描述。
即使输入很短，也必须输出一个自然、有意义的标题。"""


def fallback_session_title(user_text: str) -> str:
    normalized = re.sub(r"\s+", " ", user_text).strip()
    if not normalized:
        return "新会话"
    return f"{normalized[:47]}..." if len(normalized) > 50 else normalized


def normalize_generated_title(value: str) -> str:
    title = re.sub(r"\s+", " ", value).strip().strip("`#*_ ")
    if len(title) >= 2 and title[0] == title[-1] and title[0] in {'"', "'", "“", "”", "‘", "’"}:
        title = title[1:-1].strip()
    return title[:50].strip()


def _assistant_text(message: dict[str, Any]) -> str:
    return "".join(
        str(block.get("text") or "")
        for block in message.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()


async def generate_session_title(runtime_config: Any, user_text: str, assistant_text: str) -> str | None:
    if not runtime_config or not runtime_config.api_key or not user_text.strip():
        return None
    context = {
        "systemPrompt": _SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"用户首轮请求：\n{user_text[:4000]}\n\n助手首轮回复：\n{assistant_text[:4000]}",
                    }
                ],
            }
        ],
    }
    try:
        stream = await stream_openai_compatible(
            runtime_config.model,
            context,
            {"apiKey": runtime_config.api_key, "maxTokens": 100, "temperature": 0.2},
        )
        title = normalize_generated_title(_assistant_text(await stream.result()))
        return title or None
    except Exception:
        logger.exception("会话标题生成失败，保留待生成状态")
        return None
