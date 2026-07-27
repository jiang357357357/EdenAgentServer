from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
from typing import Any

from ..brokers import PermissionBroker, QuestionBroker, ScreenCaptureBroker
from ..config import ServerConfig, environment_context, merge_environment_context
from ..core import CoreClient
from ..events import EventBus
from ..runtime import MonAgentRuntime
from ..store import SessionStore
from ..speech import SpeechCache
from ..skills import SkillInstallationService


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
        self.core_client = CoreClient(self.config.core_base_url)
        self.speech_cache = SpeechCache(self.config.workspace_root / ".artifacts" / "speech-cache")
        self.skill_installer = SkillInstallationService(self.config.workspace_root, self.core_client)
        self.runtime = MonAgentRuntime(
            self.config.workspace_root,
            self.store,
            self.events,
            self.permissions,
            self.questions,
            self.core_client,
            self.screen_captures,
            environment_context(self.config.environment),
        )

    permissions: PermissionBroker = field(init=False)
    questions: QuestionBroker = field(init=False)
    screen_captures: ScreenCaptureBroker = field(init=False)
    core_client: CoreClient = field(init=False)
    speech_cache: SpeechCache = field(init=False)
    skill_installer: SkillInstallationService = field(init=False)
    runtime: MonAgentRuntime = field(init=False)

    def environment_context_for_token(self, token: str | None) -> dict[str, Any]:
        base = environment_context(self.config.environment)
        if not token:
            return base
        profile = self.core_client.get_user_profile(token)
        environment = profile.get("environment") if isinstance(profile.get("environment"), dict) else {}
        return merge_environment_context(base, environment)

    @staticmethod
    def permission_scope(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

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
        self.hydrated_session_ids.add(session_id)

    def ensure_hydrated(self, token: str, session_id: str) -> None:
        if session_id not in self.hydrated_session_ids:
            self.hydrate(token, session_id)
            return
        self.store.require_session(session_id)

    def mark_hydrated(self, session_id: str) -> None:
        self.hydrated_session_ids.add(session_id)

    def close(self) -> None:
        self.runtime.close()


def is_agent_api_route(pathname: str) -> bool:
    return (
        pathname == "/events"
        or pathname == "/session"
        or pathname.startswith("/session/")
        or pathname == "/speech/synthesize"
        or pathname == "/permission"
        or pathname.startswith("/permission/")
        or pathname == "/question"
        or pathname.startswith("/question/")
        or pathname == "/screen-capture"
        or pathname.startswith("/screen-capture/")
        or pathname == "/self-awake/runs"
        or pathname == "/memos"
        or pathname.startswith("/memos/")
        or pathname == "/model"
        or pathname == "/internal/self-awake/run"
        or pathname == "/tools/status"
        or pathname == "/skills"
        or pathname.startswith("/skills/")
    )
