from __future__ import annotations

import json
from typing import Any


def message_content(blocks: Any) -> Any:
    if isinstance(blocks, str):
        return blocks
    if not isinstance(blocks, list):
        return ""
    output: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            output.append({"type": "text", "text": block.get("text") or ""})
        elif block.get("type") == "image" and block.get("data"):
            mime = block.get("mimeType") or "image/png"
            output.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{block.get('data')}"}})
    if not output:
        return ""
    if len(output) == 1 and output[0]["type"] == "text":
        return output[0]["text"]
    return output


def to_openai_messages(context: dict[str, Any]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    system_prompt = context.get("systemPrompt") or context.get("system_prompt")
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    for message in context.get("messages", []):
        role = message.get("role")
        if role == "user":
            messages.append({"role": "user", "content": message_content(message.get("content"))})
        elif role == "compactionSummary":
            summary = str(message.get("summary") or "")
            messages.append(
                {
                    "role": "user",
                    "content": "The conversation history before this point was compacted into the following summary:\n\n"
                    f"<summary>\n{summary}\n</summary>",
                }
            )
        elif role == "assistant":
            text = "\n".join(block.get("text", "") for block in message.get("content", []) if isinstance(block, dict) and block.get("type") == "text")
            tool_calls = []
            for block in message.get("content", []):
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    tool_calls.append(
                        {
                            "id": block.get("id"),
                            "type": "function",
                            "function": {
                                "name": block.get("name"),
                                "arguments": json.dumps(block.get("arguments") or {}, ensure_ascii=False),
                            },
                        }
                    )
            item: dict[str, Any] = {"role": "assistant", "content": text or None}
            if tool_calls:
                item["tool_calls"] = tool_calls
            messages.append(item)
        elif role == "toolResult":
            text = "\n".join(block.get("text", "") for block in message.get("content", []) if isinstance(block, dict) and block.get("type") == "text")
            messages.append({"role": "tool", "tool_call_id": message.get("toolCallId"), "content": text})
    return messages
