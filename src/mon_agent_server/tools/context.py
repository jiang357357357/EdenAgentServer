from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ..brokers import CameraCaptureBroker, PermissionBroker, QuestionBroker, ScreenCaptureBroker
from ..core import CoreClient


@dataclass(slots=True)
class MonToolContext:
    session_id: str | None = None
    core_client: CoreClient | None = None
    core_token: str | None = None
    connector_manager: Any | None = None
    permissions: PermissionBroker | None = None
    questions: QuestionBroker | None = None
    screen_captures: ScreenCaptureBroker | None = None
    camera_captures: CameraCaptureBroker | None = None
    current_model_supports_images: bool = True
    vision_ai_entity: dict[str, Any] | None = None
    environment: dict[str, Any] | None = None
    character: dict[str, Any] | None = None
    assistant: dict[str, Any] | None = None
    current_character_action: dict[str, Any] | None = None
    emit_event: Callable[[dict[str, Any]], None] | None = None
    set_character_action: Callable[[dict[str, Any]], None] | None = None
    get_message_id: Callable[[], str | None] | None = None
    get_current_files: Callable[[], list[dict[str, Any]]] | None = None
    append_assistant_part: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    switch_session_assistant: Callable[[int | str], Awaitable[dict[str, Any]]] | None = None
    request_workspace_switch: Callable[[str], dict[str, Any]] | None = None
    list_skills: Callable[[dict[str, Any]], list[dict[str, Any]]] | None = None
    create_skill: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    update_skill: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    agent_path: str = "/root"
    operation_id: str | None = None
    permission_mode: str = "restricted"
    subagent_role_names: tuple[str, ...] = ()
    subagent_role_descriptions: dict[str, str] | None = None
    subagent_dispatch: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None
