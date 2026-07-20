from __future__ import annotations

from html import escape
from typing import Any


def message_text(message: dict[str, Any]) -> str:
    return "\n".join(part.get("text", "") for part in message.get("parts", []) if part.get("type") == "text").strip()


def message_compaction(message: dict[str, Any]) -> dict[str, Any] | None:
    info = message.get("info", {})
    for part in message.get("parts", []):
        if part.get("type") != "compaction":
            continue
        summary = str(part.get("summary") or part.get("text") or "").strip()
        if not summary:
            return None
        return {
            "role": "compactionSummary",
            "summary": summary,
            "tokensBefore": int(part.get("tokensBefore") or part.get("tokens_before") or 0),
            "timestamp": info.get("time", {}).get("created"),
            "firstKeptEntryId": part.get("firstKeptEntryId") or part.get("tail_start_id"),
            "details": part.get("details"),
        }
    return None


def is_hidden_message(message: dict[str, Any]) -> bool:
    return bool(message.get("info", {}).get("hidden"))


def assistant_context_text(
    text: str,
    speaker_name: str | None,
    *,
    beat_index: int | None = None,
) -> str:
    """Keep speaker identity as metadata without creating a dialogue prefix to imitate."""
    if not speaker_name:
        return text
    attributes = [f'speaker="{escape(str(speaker_name), quote=True)}"']
    if beat_index is not None:
        attributes.append(f'beat="{beat_index}"')
    return f"<assistant-message {' '.join(attributes)}>\n{text}\n</assistant-message>"


def title_from_messages(messages: list[dict[str, Any]]) -> str | None:
    for message in messages:
        if is_hidden_message(message):
            continue
        if message.get("info", {}).get("role") != "user":
            continue
        text = message_text(message)
        if text:
            return f"{text[:24]}..." if len(text) > 24 else text
    return None


def to_agent_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for message in messages:
        compaction = message_compaction(message)
        if compaction:
            output = [compaction]
            continue
        text = message_text(message)
        if not text:
            continue
        info = message.get("info", {})
        role = info.get("role")
        if role == "user":
            output.append({"role": "user", "timestamp": info.get("time", {}).get("created"), "content": [{"type": "text", "text": text}]})
        elif role == "assistant":
            speaker = info.get("speaker") if isinstance(info.get("speaker"), dict) else {}
            speaker_name = speaker.get("assistantName") or speaker.get("characterName")
            assistant_text = assistant_context_text(text, speaker_name)
            output.append(
                {
                    "role": "assistant",
                    "timestamp": info.get("time", {}).get("created"),
                    "content": [{"type": "text", "text": assistant_text}],
                    "api": "openai-completions",
                    "provider": info.get("providerID") or "openai",
                    "model": info.get("modelID") or "unknown",
                    "usage": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 0,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
                    },
                    "stopReason": "error" if info.get("error") else "stop",
                    "errorMessage": (info.get("error") or {}).get("message"),
                }
            )
    return output
