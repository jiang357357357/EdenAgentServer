from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
from typing import Any

from ..brokers import CameraCaptureBroker, PermissionBroker, QuestionBroker, ScreenCaptureBroker
from ..config import ServerConfig, environment_context, merge_environment_context
from ..core import CoreClient
from ..connectors import ExternalConnectionManager
from ..events import EventBus
from ..runtime import MonAgentRuntime
from ..store import SessionStore
from ..skills import SkillDirectoryWatcher, SkillInstallationService


@dataclass(slots=True)
class AppState:
    config: ServerConfig
    events: EventBus = field(default_factory=EventBus)
    store: SessionStore = field(default_factory=SessionStore)
    hydrated_session_ids: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.permissions = PermissionBroker(self.events)
        self.questions = QuestionBroker(self.events)
        self.screen_captures = ScreenCaptureBroker(self.events)
        self.camera_captures = CameraCaptureBroker(self.events)
        self.core_client = CoreClient(self.config.core_base_url)
        self.connector_manager = ExternalConnectionManager(self.core_client, self._handle_connector_event)
        self.skill_installer = SkillInstallationService(
            self.config.workspace_root,
            self.core_client,
        )
        self.skill_watcher = SkillDirectoryWatcher(self.config.workspace_root, self.events.emit)
        self.skill_watcher.start()
        self.runtime = MonAgentRuntime(
            self.config.workspace_root,
            self.store,
            self.events,
            self.permissions,
            self.questions,
            self.core_client,
            self.screen_captures,
            environment_context(self.config.environment),
            camera_captures=self.camera_captures,
            skill_installer=self.skill_installer,
            connector_manager=self.connector_manager,
        )
        try:
            self.connector_manager.reconcile_user(self.core_client.connector_runtime_service_identity())
        except Exception:
            # Core may still be starting. A later SSE connection or explicit
            # connector operation performs the same reconciliation.
            pass

    permissions: PermissionBroker = field(init=False)
    questions: QuestionBroker = field(init=False)
    screen_captures: ScreenCaptureBroker = field(init=False)
    camera_captures: CameraCaptureBroker = field(init=False)
    core_client: CoreClient = field(init=False)
    connector_manager: ExternalConnectionManager = field(init=False)
    skill_installer: SkillInstallationService = field(init=False)
    skill_watcher: SkillDirectoryWatcher = field(init=False)
    runtime: MonAgentRuntime = field(init=False)

    def _handle_connector_event(
        self,
        token: Any,
        connector: dict[str, Any],
        event: dict[str, Any],
        persisted: dict[str, Any],
    ) -> None:
        from ..proactive import start_connector_turn

        event_id = str(persisted.get("id") or event.get("external_event_id") or "").strip()
        if not event_id:
            return
        chat_session_id = None
        assistant_id = None
        try:
            latest_sessions = self.core_client.list_agent_sessions(token, limit=1)
            if latest_sessions:
                chat_session_id = latest_sessions[0].get("id")
                participant_ids = latest_sessions[0].get("participantAssistantIDs") or []
                assistant_id = participant_ids[0] if participant_ids else None
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            thread_key = str(payload.get("game_id") or event.get("external_event_id") or "").strip()
            if chat_session_id and thread_key:
                chat_session_id = self.core_client.bind_connector_thread_session(
                    token,
                    connector.get("id") or persisted.get("connector"),
                    thread_key,
                    str(chat_session_id),
                )
        except Exception:
            # Connector handling must not fail merely because the user has no
            # chat session yet or Core is temporarily unavailable.
            pass
        operation_id = f"connector-event-{event_id}"
        if not chat_session_id or assistant_id in (None, ""):
            return
        start_connector_turn(
            self,
            token,
            session_id=str(chat_session_id),
            assistant_id=assistant_id,
            operation_id=operation_id,
            connector_event_id=persisted.get("id"),
            event={
                "source": "connector",
                "type": "external_event",
                "connector_event_id": persisted.get("id"),
                "connector_id": connector.get("id"),
                "connector_key": connector.get("connector_key"),
                "external_event_id": event.get("external_event_id"),
                "event_type": event.get("event_type"),
                "payload": event.get("payload") or {},
            },
        )

    def environment_context_for_token(self, token: str | None) -> dict[str, Any]:
        base = environment_context(self.config.environment)
        if not token:
            return base
        profile = self.core_client.get_user_profile(token)
        environment = profile.get("environment") if isinstance(profile.get("environment"), dict) else {}
        return merge_environment_context(base, environment)

    @staticmethod
    def permission_scope(token: Any) -> str:
        if isinstance(token, str):
            material = token
        else:
            material = ":".join(
                str(getattr(token, field, "")) for field in ("service_id", "scope", "user_id")
            )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    def hydrate_permission_mode(self, token: str, session_id: str | None = None) -> dict[str, Any]:
        settings = self.core_client.get_agent_settings(token)
        mode = str(settings.get("permission_mode") or "restricted")
        return self.permissions.hydrate_mode(mode, self.permission_scope(token), session_id)

    def persist_permission_mode(self, token: str, mode: str) -> dict[str, Any]:
        normalized = mode if mode in {"restricted", "full_access", "takeover"} else "restricted"
        settings = self.core_client.update_agent_settings(token, {"permission_mode": normalized})
        persisted = str(settings.get("permission_mode") or "restricted")
        return self.permissions.set_mode(persisted, self.permission_scope(token))

    def hydrate(self, token: str, session_id: str) -> None:
        data = self.core_client.get_agent_session(token, session_id)
        self.store.upsert_session_info(data["info"])
        self.store.hydrate_messages(session_id, data["messages"], data.get("modelEvents"))
        self.runtime.load_persisted_subagents(session_id)
        self.connector_manager.reconcile_user(token)
        self.hydrated_session_ids.add(session_id)

    def ensure_hydrated(self, token: str, session_id: str) -> None:
        if session_id not in self.hydrated_session_ids:
            self.hydrate(token, session_id)
            return
        self.store.require_session(session_id)

    def mark_hydrated(self, session_id: str) -> None:
        self.hydrated_session_ids.add(session_id)

    def forget_hydrated(self, session_id: str) -> None:
        self.hydrated_session_ids.discard(session_id)

    def close(self) -> None:
        self.skill_watcher.close()
        self.connector_manager.close()
        self.runtime.close()


def is_agent_api_route(pathname: str) -> bool:
    return (
        pathname == "/events"
        or pathname == "/session"
        or pathname.startswith("/session/")
        or pathname == "/speech/synthesize"
        or pathname == "/speech/segments"
        or pathname == "/permission"
        or pathname.startswith("/permission/")
        or pathname == "/question"
        or pathname.startswith("/question/")
        or pathname == "/screen-capture"
        or pathname.startswith("/screen-capture/")
        or pathname == "/camera-capture"
        or pathname.startswith("/camera-capture/")
        or pathname == "/self-awake/runs"
        or pathname == "/memos"
        or pathname.startswith("/memos/")
        or pathname == "/model"
        or pathname == "/internal/self-awake/run"
        or pathname == "/tools/status"
        or pathname == "/skills"
        or pathname.startswith("/skills/")
    )
