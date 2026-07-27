from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import json
from typing import Any, Iterable

from mon_agent_core.harness.compaction import estimate_tokens

from ..ids import create_id, now_ms


@dataclass(frozen=True, slots=True)
class SessionEvent:
    id: str
    sequence: int
    type: str
    payload: dict[str, Any]
    turn_id: str | None = None
    created_at: int = 0

    def dump(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "sequence": self.sequence,
            "type": self.type,
            "turnID": self.turn_id,
            "payload": deepcopy(self.payload),
            "createdAt": self.created_at,
        }


class ContextManager:
    """Compile the canonical session event stream into model-visible messages."""

    MAX_TEXT_CHARS = 40_000
    MAX_TOOL_RESULT_CHARS = 12_000
    TOOL_RESULT_PROTECTED_USER_TURNS = 2
    TOOL_RESULT_PROTECTED_TOKENS = 4_000
    TOOL_RESULT_PRUNE_MINIMUM_TOKENS = 2_000
    PRUNED_TOOL_RESULT_TEXT = "[旧工具结果已清理；如仍需细节请重新调用工具]"

    @classmethod
    def event_for_message(
        cls,
        message: dict[str, Any],
        *,
        sequence: int,
        turn_id: str | None = None,
    ) -> SessionEvent:
        role = str(message.get("role") or "")
        event_type = {
            "user": "user_message",
            "assistant": "assistant_message",
            "toolResult": "tool_result",
            "compactionSummary": "compaction",
        }.get(role)
        if not event_type:
            raise ValueError(f"unsupported model message role: {role}")
        return SessionEvent(
            id=create_id("evt"),
            sequence=sequence,
            type=event_type,
            payload=deepcopy(message),
            turn_id=turn_id,
            created_at=int(message.get("timestamp") or now_ms()),
        )

    @classmethod
    def compile(cls, events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        ordered = sorted(events, key=lambda item: int(item.get("sequence") or 0))
        messages: list[dict[str, Any]] = []
        pending_calls: set[str] = set()
        for event in ordered:
            payload = deepcopy(event.get("payload") or {})
            event_type = event.get("type")
            if event_type == "compaction":
                messages = [cls._truncate_message(payload)]
                pending_calls.clear()
                continue
            if event_type not in {"user_message", "assistant_message", "tool_result"}:
                continue
            if event_type == "assistant_message":
                if cls._is_failed_assistant(payload):
                    continue
                for block in payload.get("content") or []:
                    if block.get("type") == "toolCall" and block.get("id"):
                        pending_calls.add(str(block["id"]))
            elif event_type == "tool_result":
                call_id = str(payload.get("toolCallId") or "")
                if not call_id or call_id not in pending_calls:
                    continue
                pending_calls.discard(call_id)
            messages.append(cls._truncate_message(payload))
        return cls._prune_old_tool_results(messages)

    @classmethod
    def _prune_old_tool_results(cls, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        user_positions = [index for index, message in enumerate(messages) if message.get("role") == "user"]
        if len(user_positions) < cls.TOOL_RESULT_PROTECTED_USER_TURNS:
            return messages
        protected_from = user_positions[-cls.TOOL_RESULT_PROTECTED_USER_TURNS]
        candidates: list[tuple[int, int]] = []
        protected_tokens = 0
        for index in range(protected_from - 1, -1, -1):
            message = messages[index]
            if message.get("role") != "toolResult":
                continue
            tokens = max(estimate_tokens(message), 1)
            if protected_tokens + tokens <= cls.TOOL_RESULT_PROTECTED_TOKENS:
                protected_tokens += tokens
                continue
            candidates.append((index, tokens))
        if sum(tokens for _index, tokens in candidates) < cls.TOOL_RESULT_PRUNE_MINIMUM_TOKENS:
            return messages
        for index, _tokens in candidates:
            messages[index]["content"] = [
                {"type": "text", "text": cls.PRUNED_TOOL_RESULT_TEXT}
            ]
        return messages

    @staticmethod
    def _is_failed_assistant(message: dict[str, Any]) -> bool:
        return bool(message.get("errorMessage")) or message.get("stopReason") in {"error", "aborted"}

    @classmethod
    def _truncate_message(cls, message: dict[str, Any]) -> dict[str, Any]:
        limit = cls.MAX_TOOL_RESULT_CHARS if message.get("role") == "toolResult" else cls.MAX_TEXT_CHARS
        content = message.get("content")
        if isinstance(content, str):
            message["content"] = cls._truncate_text(content, limit)
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                for key in ("text", "thinking"):
                    if isinstance(block.get(key), str):
                        block[key] = cls._truncate_text(block[key], limit)
                if block.get("type") == "toolCall" and "arguments" in block:
                    raw = json.dumps(block["arguments"], ensure_ascii=False)
                    if len(raw) > limit:
                        block["arguments"] = {"truncated": True, "preview": raw[:limit]}
        return message

    @staticmethod
    def _truncate_text(text: str, limit: int) -> str:
        if len(text) <= limit:
            return text
        return f"{text[:limit]}\n...[truncated {len(text) - limit} chars]"
