from __future__ import annotations

import math
import random
import string
from datetime import datetime
from typing import Any

from ..ids import now_ms


def to_storage_iso(value: int | float | None = None) -> str:
    millis = now_ms() if value is None else value
    return datetime.fromtimestamp(millis / 1000).astimezone().isoformat()


def unwrap_results(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("results"), list):
        return value["results"]
    return []


def to_millis(value: Any, fallback: int | None = None) -> int:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            normalized = value.replace("Z", "+00:00")
            return int(datetime.fromisoformat(normalized).timestamp() * 1000)
        except ValueError:
            return fallback if fallback is not None else now_ms()
    return fallback if fallback is not None else now_ms()


def is_api_session_payload(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("id"), str)
        and isinstance(value.get("title"), str)
        and isinstance(value.get("time"), dict)
        and isinstance(value["time"].get("created"), (int, float))
        and isinstance(value["time"].get("updated"), (int, float))
    )


def is_api_message_payload(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("info"), dict)
        and isinstance(value.get("parts"), list)
        and isinstance(value["info"].get("id"), str)
        and value["info"].get("role") in {"user", "assistant"}
    )


def session_from_map(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("session_payload") if is_api_session_payload(item.get("session_payload")) else None
    created = payload["time"]["created"] if payload else to_millis(item.get("created_at"))
    updated = max(
        payload["time"]["updated"] if payload else 0,
        to_millis(item.get("last_message_at"), 0),
        to_millis(item.get("updated_at"), created),
        created,
    )
    raw_participants = item.get("participants") if isinstance(item.get("participants"), list) else []
    participants = [
        {
            "assistantID": participant.get("assistant"),
            "assistantName": participant.get("assistant_name") or "",
            "characterID": participant.get("character"),
            "characterName": participant.get("character_name") or "",
            "signature": participant.get("character_signature") or "",
            "avatarUrl": participant.get("character_avatar_url") or "",
            "standingImageUrl": participant.get("standing_image_url") or "",
            "ttsConfigID": participant.get("tts_config_id"),
            "position": participant.get("position", index),
        }
        for index, participant in enumerate(raw_participants)
        if participant.get("assistant") is not None and participant.get("enabled", True)
    ]
    raw_director_runs = item.get("director_runs") if isinstance(item.get("director_runs"), list) else []
    director_runs = [
        {
            "planID": run.get("external_plan_id"),
            "userMessageID": run.get("external_user_message_id"),
            "source": run.get("source") or "",
            "diagnostic": run.get("diagnostic") or None,
            "scene": run.get("scene_payload") or None,
            "execution": run.get("execution_payload") or None,
            "beats": run.get("beats_payload") or [],
            "status": run.get("status") or "planned",
            "activeBeatIndex": run.get("active_beat_index"),
            "completedBeatIndexes": run.get("completed_beat_indexes") or [],
            "participantCount": run.get("participant_count") or 0,
            "error": run.get("error") or None,
            "createdAt": to_millis(run.get("created_at")),
            "updatedAt": to_millis(run.get("updated_at")),
        }
        for run in raw_director_runs
        if run.get("external_plan_id")
    ]
    return {
        "id": item.get("external_session_id"),
        "title": item.get("title") or (payload or {}).get("title") or "新会话",
        "mode": item.get("mode") or (payload or {}).get("mode") or "companion",
        "directorPolicy": item.get("director_policy") or (payload or {}).get("directorPolicy") or {},
        "participants": participants or (payload or {}).get("participants") or [],
        "participantAssistantIDs": [participant["assistantID"] for participant in participants]
        or (payload or {}).get("participantAssistantIDs")
        or ([item.get("assistant")] if item.get("assistant") else []),
        "directorRuns": director_runs or (payload or {}).get("directorRuns") or [],
        "characterRuntime": (payload or {}).get("characterRuntime") if isinstance((payload or {}).get("characterRuntime"), dict) else None,
        "time": {"created": created, "updated": updated},
    }


def message_from_map(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("message_payload")
    if is_api_message_payload(payload):
        if payload.get("info", {}).get("role") == "assistant" and not payload["info"].get("speaker"):
            payload["info"]["speaker"] = {
                "assistantID": item.get("speaker_assistant"),
                "characterID": item.get("speaker_character"),
                "turnIndex": item.get("turn_index"),
            }
        return payload
    created = to_millis(item.get("created_at"))
    return {
        "info": {
            "id": item.get("external_message_id") or f"core_msg_{item.get('id')}",
            "role": "user" if item.get("kind") == "user" else "assistant",
            "time": {"created": created, "completed": to_millis(item.get("updated_at"), created)},
        },
        "parts": [],
    }


def random_suffix(length: int = 6) -> str:
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(length))


def run_id_from_millis(prefix: str, millis: int) -> str:
    stamp = "".join(char for char in to_storage_iso(millis) if char.isdigit())
    return f"{prefix}-{stamp}-{random_suffix()}"
