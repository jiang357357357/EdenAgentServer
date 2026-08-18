from __future__ import annotations

import asyncio
from typing import Any

from ..agent_api import AgentTool

from .context import MonToolContext
from .result import text_result


def create_interaction_tools(context: MonToolContext) -> list[AgentTool]:
    async def ask_user_execute(tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        if not context.questions or not context.session_id:
            raise RuntimeError("ask_user 需要在会话运行时中调用。")
        answers = await asyncio.to_thread(
            context.questions.ask,
            {
                "sessionID": context.session_id,
                "questions": [
                    {
                        "header": params.get("header") or "需要确认",
                        "question": params["question"],
                        "options": [
                            {"label": option.get("label"), "description": option.get("description") or ""}
                            for option in params.get("options", [])
                        ],
                        "multiple": bool(params.get("multiple")),
                        "custom": params.get("allow_custom", True),
                    }
                ],
                "tool": {"messageID": context.get_message_id(), "callID": tool_call_id}
                if context.get_message_id and context.get_message_id()
                else None,
            },
        )
        if answers is None:
            raise RuntimeError("用户暂不处理该问题。")
        flattened = [item for group in answers for item in group if item]
        return text_result("\n".join(flattened) or "用户未提供回答。", {"answers": answers})

    return [
        AgentTool(
            name="ask_user",
            label="询问用户",
            description="当缺少关键信息、需要用户选择方案或继续执行前需要确认边界时，向用户展示问题卡片并等待回答。",
            parameters={
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "要询问用户的问题。"},
                    "header": {"type": "string", "description": "问题分组标题，建议 12 个字以内。"},
                    "options": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"label": {"type": "string"}, "description": {"type": "string"}},
                            "required": ["label"],
                        },
                    },
                    "multiple": {"type": "boolean"},
                    "allow_custom": {"type": "boolean"},
                },
                "required": ["question"],
            },
            execute=ask_user_execute,
            execution_mode="sequential",
        )
    ]
