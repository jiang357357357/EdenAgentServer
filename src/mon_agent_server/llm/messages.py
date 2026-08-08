from __future__ import annotations

import json
from typing import Any


def _model_tool_output(text: str, structured: Any) -> str:
    if structured is None:
        return text
    encoded = json.dumps(structured, ensure_ascii=False, separators=(",", ":"), default=str)
    return f"{text}\n\n<structured_output>{encoded}</structured_output>" if text else encoded


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
    active_speaker = context.get("activeSpeaker") if isinstance(context.get("activeSpeaker"), dict) else {}
    active_assistant_id = active_speaker.get("assistantID")
    handoff_from = context.get("handoffFrom") if isinstance(context.get("handoffFrom"), dict) else {}
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
            if message.get("errorMessage") or message.get("stopReason") in {"error", "aborted"}:
                continue
            content_blocks = [block for block in message.get("content", []) if isinstance(block, dict)]
            text = "".join(
                str(block.get("text") or "")
                for block in content_blocks
                if block.get("type") == "text" and str(block.get("text") or "").strip()
            )
            context_speaker = (
                message.get("contextSpeaker")
                if isinstance(message.get("contextSpeaker"), dict)
                else {}
            )
            if not context_speaker and any(
                block.get("type") == "toolCall"
                and block.get("name") == "switch_session_assistant"
                for block in content_blocks
            ):
                context_speaker = handoff_from
            speaker_id = context_speaker.get("assistantID")
            speaker_name = str(
                context_speaker.get("assistantName")
                or context_speaker.get("characterName")
                or ""
            ).strip()
            is_other_assistant = (
                speaker_id is not None
                and active_assistant_id is not None
                and str(speaker_id) != str(active_assistant_id)
            )
            speaker_label = f"[{speaker_name or f'助手#{speaker_id}'}]"
            if is_other_assistant:
                text = f"{speaker_label} {text}".strip()
            tool_calls = []
            for block in content_blocks:
                if block.get("type") == "toolCall":
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
            item: dict[str, Any] = {
                "role": "assistant",
                "content": text or (speaker_label if is_other_assistant else None),
            }
            thinking_blocks = [
                block
                for block in content_blocks
                if block.get("type") == "thinking" and str(block.get("thinking") or "").strip()
            ]
            if thinking_blocks:
                signature = thinking_blocks[0].get("thinkingSignature")
                if message.get("provider") == "opencode-go" and signature == "reasoning":
                    signature = "reasoning_content"
                if isinstance(signature, str) and signature:
                    item[signature] = "\n".join(str(block.get("thinking") or "") for block in thinking_blocks)
            if tool_calls:
                item["tool_calls"] = tool_calls
            if not text and not tool_calls:
                continue
            messages.append(item)
        elif role == "toolResult":
            blocks = [block for block in message.get("content", []) if isinstance(block, dict)]
            text = "\n".join(block.get("text", "") for block in blocks if block.get("type") == "text")
            images = [block for block in blocks if block.get("type") == "image" and block.get("data")]
            structured = message.get("structuredContent")
            model_output = _model_tool_output(text, structured)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": message.get("toolCallId"),
                    "content": model_output or ("图片已由工具获取。" if images else ""),
                }
            )
            if images:
                image_content = message_content(images)
                content = [
                    {
                        "type": "text",
                        "text": (
                            f"以下图片由工具 {message.get('toolName') or 'image tool'} 刚刚返回。"
                            "请直接根据图片完成分析，不要因为本轮没有上传附件而再次调用 analyze_image。"
                        ),
                    }
                ]
                if isinstance(image_content, list):
                    content.extend(image_content)
                messages.append({"role": "user", "content": content})
    return messages


def _responses_user_content(blocks: Any) -> str | list[dict[str, Any]]:
    if isinstance(blocks, str):
        return blocks
    content: list[dict[str, Any]] = []
    for block in blocks if isinstance(blocks, list) else []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            content.append({"type": "input_text", "text": str(block.get("text") or "")})
        elif block.get("type") == "image" and block.get("data"):
            mime = block.get("mimeType") or "image/png"
            content.append({"type": "input_image", "image_url": f"data:{mime};base64,{block.get('data')}"})
    if not content:
        return ""
    if len(content) == 1 and content[0]["type"] == "input_text":
        return content[0]["text"]
    return content


def to_responses_input(context: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert durable AgentCore context to stateless Responses API input items."""
    items: list[dict[str, Any]] = []
    for message in context.get("messages", []):
        role = message.get("role")
        if role == "user":
            items.append({"role": "user", "content": _responses_user_content(message.get("content"))})
        elif role == "compactionSummary":
            summary = str(message.get("summary") or "")
            items.append(
                {
                    "role": "user",
                    "content": "The conversation history before this point was compacted into the following summary:\n\n"
                    f"<summary>\n{summary}\n</summary>",
                }
            )
        elif role == "assistant":
            if message.get("errorMessage") or message.get("stopReason") in {"error", "aborted"}:
                continue
            blocks = [block for block in message.get("content", []) if isinstance(block, dict)]
            text = "".join(
                str(block.get("text") or "")
                for block in blocks
                if block.get("type") == "text" and str(block.get("text") or "").strip()
            )
            if text:
                items.append({"role": "assistant", "content": text})
            for block in blocks:
                if block.get("type") != "toolCall":
                    continue
                call_id = str(block.get("id") or "")
                item: dict[str, Any] = {
                    "type": "function_call",
                    "call_id": call_id,
                    "name": block.get("name") or "unknown_tool",
                    "arguments": json.dumps(block.get("arguments") or {}, ensure_ascii=False),
                }
                provider_item_id = block.get("providerItemId")
                if provider_item_id:
                    item["id"] = provider_item_id
                items.append(item)
        elif role == "toolResult":
            blocks = [block for block in message.get("content", []) if isinstance(block, dict)]
            text = "\n".join(str(block.get("text") or "") for block in blocks if block.get("type") == "text")
            images = [block for block in blocks if block.get("type") == "image" and block.get("data")]
            structured = message.get("structuredContent")
            model_output = _model_tool_output(text, structured)
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": message.get("toolCallId"),
                    "output": model_output or ("The tool returned an image." if images else ""),
                }
            )
            if images:
                image_content = _responses_user_content(images)
                content: list[dict[str, Any]] = [
                    {
                        "type": "input_text",
                        "text": f"The following image was returned by {message.get('toolName') or 'an image tool'}. Analyze it directly.",
                    }
                ]
                if isinstance(image_content, list):
                    content.extend(image_content)
                items.append({"role": "user", "content": content})
    return items
