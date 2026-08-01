from __future__ import annotations

import asyncio
import base64
from collections.abc import Callable
from concurrent.futures import Future
import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from mon_agent_core import (
    Agent,
    AgentControl,
    AgentOptions,
    AgentResult,
    AgentSnapshot,
    AgentThread,
    TERMINAL_AGENT_STATUSES,
    fork_messages,
)
from mon_agent_core.harness.compaction import (
    compact as compact_context,
    estimate_context_tokens,
    prepare_compaction,
    should_compact,
)
from mon_agent_core.harness.messages import convert_to_llm
from mon_agent_core.harness.session.session import build_session_context

from mon_agent_server.brokers import PermissionBroker, QuestionBroker, ScreenCaptureBroker
from mon_agent_server.core import CoreAuthenticationExpiredError, CoreClient
from mon_agent_server.events import EventBus
from mon_agent_server.ids import create_id, now_ms
from mon_agent_server.logging import get_logger
from mon_agent_server.model_stream import core_model, env_model, stream_openai_compatible
from mon_agent_server.prompts import attachment_context, build_agent_system_prompt
from mon_agent_server.skills import create_skill_runtime, owner_storage_key
from mon_agent_server.store import SessionStore, SubagentThreadRepository
from mon_agent_server.store.serializers import is_hidden_message, message_text
from mon_agent_server.tools import MonToolContext
from mon_agent_server.runtime.compaction import RuntimeCompactionModels, messages_to_compaction_entries, runtime_compaction_settings, timestamp_iso
from mon_agent_server.runtime.companion import DirectorBeat, DirectorExecution, DirectorScene, actor_task_prompt, create_director_plan
from mon_agent_server.runtime.config import RuntimeModelConfig, runtime_context_window
from mon_agent_server.runtime.emitters import RuntimeEmitterMixin, runtime_error_summary
from mon_agent_server.runtime.host import RuntimeHost
from mon_agent_server.runtime.messages import content_text, images_from_parts, prompt_files
from mon_agent_server.runtime.permissions import RuntimePermissionMixin
from mon_agent_server.runtime.state import RunState
from mon_agent_server.runtime.subagents import (
    SubagentBudget,
    SubagentDefinition,
    SubagentToolPolicy,
    build_subagent_system_prompt,
    load_subagent_catalog,
)

class NoCompactionNeeded(RuntimeError):
    """The manual compaction command is valid, but there is no old context to summarize."""


def _bounded_env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(max(value, minimum), maximum)


def _subagent_budget_usage(payload: Any = None) -> dict[str, Any]:
    value = payload if isinstance(payload, dict) else {}

    def nonnegative_int(key: str) -> int:
        try:
            return max(0, int(value.get(key) or 0))
        except (TypeError, ValueError):
            return 0

    return {
        "turnCount": nonnegative_int("turnCount"),
        "toolCallCount": nonnegative_int("toolCallCount"),
        "elapsedMs": nonnegative_int("elapsedMs"),
        "exceededReason": str(value.get("exceededReason") or "") or None,
    }


logger = get_logger("MonAgent", "Runtime")
_CORE_SYNC_RETRY_DELAYS = (0.15, 0.5, 1.5)
_MANUAL_COMPACTION_KEEP_RECENT_TOKENS = 8_000


class TurnAborted(RuntimeError):
    """Raised when the user explicitly stops the active turn."""


def _as_dict_list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _director_conversation_context(
    messages: list[dict[str, Any]],
    current_user_message_id: str,
    *,
    max_messages: int = 10,
    max_chars: int = 6_000,
) -> str:
    lines: list[str] = []
    for message in reversed(messages):
        info = message.get("info") if isinstance(message.get("info"), dict) else {}
        if info.get("id") == current_user_message_id or is_hidden_message(message):
            continue
        text = message_text(message)
        if not text:
            continue
        if info.get("role") == "assistant":
            speaker = info.get("speaker") if isinstance(info.get("speaker"), dict) else {}
            label = speaker.get("assistantName") or speaker.get("characterName") or "助手"
        else:
            label = "用户"
        lines.append(f"{label}：{text}")
        if len(lines) >= max_messages:
            break
    context = "\n".join(reversed(lines))
    return context[-max_chars:]


def _vision_inputs_from_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    for index, part in enumerate(parts, start=1):
        if part.get("type") != "file":
            continue
        mime_type = str(part.get("mime") or "application/octet-stream")
        if not mime_type.startswith("image/"):
            continue
        url = str(part.get("url") or "")
        if not url.startswith("data:") or "," not in url:
            continue
        header, payload = url.split(",", 1)
        if ";base64" not in header:
            continue
        try:
            base64.b64decode(payload, validate=True)
        except Exception:
            continue
        images.append(
            {
                "type": "base64",
                "source": payload,
                "media_type": mime_type,
                "ref": str(part.get("filename") or f"附件图片 {index}"),
            }
        )
    return images


def _action_image_url(action: dict[str, Any], visual_preference: str | None = None) -> str:
    static_url = str(action.get("static_image_url") or "").strip()
    dynamic_url = str(action.get("dynamic_preview_url") or "").strip()
    frames = _as_dict_list(action.get("dynamic_frames"))
    if not dynamic_url and frames:
        dynamic_url = str(frames[0].get("file_url") or "").strip()
    if visual_preference == "dynamic":
        return dynamic_url or static_url
    return static_url or dynamic_url


def _default_character_action_state(session_id: str, character: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(character, dict) or not character.get("id"):
        return None
    actions = _as_dict_list(character.get("visual_actions"))
    default_url = str(character.get("default_standing_image_url") or "").strip()
    visual_preference = str(character.get("visual_preference") or "static")
    action = None
    if default_url:
        action = next((item for item in actions if _action_image_url(item, visual_preference) == default_url), None)
    if not action and actions:
        action = next((item for item in actions if item.get("intent") == "idle"), None) or actions[0]
    image_url = _action_image_url(action, visual_preference) if action else default_url
    if not action and not image_url:
        return None
    return {
        "sessionID": session_id,
        "characterID": character.get("id"),
        "characterName": character.get("name") or "",
        "action": action or {},
        "group": None,
        "groupItem": None,
        "imageUrl": image_url,
        "reason": "默认立绘",
        "source": "default",
        "time": now_ms(),
    }
