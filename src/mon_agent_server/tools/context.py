from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ..brokers import PermissionBroker, QuestionBroker, ScreenCaptureBroker
from ..core import CoreClient


@dataclass(slots=True)
class MonToolContext:
    session_id: str | None = None
    core_client: CoreClient | None = None
    core_token: str | None = None
    permissions: PermissionBroker | None = None
    questions: QuestionBroker | None = None
    screen_captures: ScreenCaptureBroker | None = None
    current_model_supports_images: bool = True
    vision_config: dict[str, Any] | None = None
    environment: dict[str, Any] | None = None
    character: dict[str, Any] | None = None
    current_character_action: dict[str, Any] | None = None
    emit_event: Callable[[dict[str, Any]], None] | None = None
    set_character_action: Callable[[dict[str, Any]], None] | None = None
    get_message_id: Callable[[], str | None] | None = None
    get_current_files: Callable[[], list[dict[str, Any]]] | None = None
    agent_path: str = "/root"
    subagent_role_names: tuple[str, ...] = ()
    subagent_role_descriptions: dict[str, str] | None = None
    subagent_dispatch: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None
