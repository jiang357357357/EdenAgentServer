from __future__ import annotations

from typing import Any


def recall_character_memories(
    core_client: Any,
    token: str,
    core: dict[str, Any] | None,
    query: str,
    *,
    limit: int = 5,
    max_chars: int = 4_000,
) -> list[dict[str, Any]]:
    """Recall bounded memories for exactly the current assistant and character."""
    core = core or {}
    assistant = core.get("assistant") if isinstance(core.get("assistant"), dict) else {}
    character = core.get("character") if isinstance(core.get("character"), dict) else {}
    memories = core_client.list_memories(
        token,
        {
            "q": str(query or "")[:1000],
            "assistant": assistant.get("id"),
            "agent_character": character.get("id"),
            "status": "active",
            "limit": limit,
        },
    )
    bounded: list[dict[str, Any]] = []
    total = 0
    for memory in memories:
        content = str(memory.get("content") or "") if isinstance(memory, dict) else ""
        if not content or total + len(content) > max_chars:
            continue
        bounded.append(memory)
        total += len(content)
    memory_ids = [
        int(item["id"])
        for item in bounded
        if isinstance(item, dict) and str(item.get("id") or "").isdigit()
    ]
    if memory_ids:
        core_client.mark_memories_used(token, memory_ids)
    return bounded
