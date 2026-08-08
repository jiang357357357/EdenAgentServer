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

from mon_agent_server.brokers import CameraCaptureBroker, PermissionBroker, QuestionBroker, ScreenCaptureBroker
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

from mon_agent_server.runtime.manager.shared import (
    NoCompactionNeeded,
    TurnAborted,
    _CORE_SYNC_RETRY_DELAYS,
    _MANUAL_COMPACTION_KEEP_RECENT_TOKENS,
    _action_image_url,
    _as_dict_list,
    _bounded_env_int,
    _default_character_action_state,
    _director_conversation_context,
    _subagent_budget_usage,
    _vision_inputs_from_parts,
    logger,
)
from mon_agent_server.runtime.coordination import RuntimeCoordinationMixin
from mon_agent_server.runtime.execution import (
    RuntimeCharacterMixin,
    RuntimeCompactionMixin,
    RuntimeLifecycleMixin,
    RuntimePromptMixin,
)
from mon_agent_server.runtime.persistence import RuntimePersistenceMixin
from mon_agent_server.runtime.resolution import RuntimeResolutionMixin


class MonAgentRuntime(
    RuntimeLifecycleMixin,
    RuntimeCoordinationMixin,
    RuntimeResolutionMixin,
    RuntimeCompactionMixin,
    RuntimeCharacterMixin,
    RuntimePromptMixin,
    RuntimePersistenceMixin,
    RuntimeEmitterMixin,
    RuntimePermissionMixin,
):
    def __init__(
        self,
        workspace_root: Path,
        store: SessionStore,
        events: EventBus,
        permissions: PermissionBroker,
        questions: QuestionBroker,
        core_client: CoreClient,
        screen_captures: ScreenCaptureBroker | None = None,
        environment: dict[str, Any] | None = None,
        camera_captures: CameraCaptureBroker | None = None,
        skill_installer: Any | None = None,
        connector_manager: Any | None = None,
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        self.store = store
        self.events = events
        self.permissions = permissions
        self.questions = questions
        self.core_client = core_client
        self.screen_captures = screen_captures
        self.camera_captures = camera_captures
        self.environment = environment
        self.skill_installer = skill_installer
        self.connector_manager = connector_manager
        self.subagent_catalog = load_subagent_catalog(self.workspace_root)
        self.subagent_repository = SubagentThreadRepository.for_workspace(self.workspace_root)
        self.subagent_max_threads = _bounded_env_int(
            "MON_AGENT_SUBAGENT_MAX_THREADS", 64, minimum=1, maximum=1_024
        )
        self.subagent_max_concurrent_per_session = _bounded_env_int(
            "MON_AGENT_SUBAGENT_MAX_CONCURRENT_PER_SESSION", 4, minimum=1, maximum=64
        )
        self.subagent_max_concurrent_global = _bounded_env_int(
            "MON_AGENT_SUBAGENT_MAX_CONCURRENT_GLOBAL", 8, minimum=1, maximum=256
        )
        self.subagent_max_depth = _bounded_env_int(
            "MON_AGENT_SUBAGENT_MAX_DEPTH", 2, minimum=1, maximum=8
        )
        self.subagent_max_tasks_per_batch = _bounded_env_int(
            "MON_AGENT_SUBAGENT_MAX_TASKS_PER_BATCH", 8, minimum=1, maximum=64
        )
        self.subagent_max_result_chars = _bounded_env_int(
            "MON_AGENT_SUBAGENT_MAX_RESULT_CHARS", 200_000, minimum=1_000, maximum=2_000_000
        )
        self.subagent_aggregation_max_retries = _bounded_env_int(
            "MON_AGENT_AGGREGATION_MAX_RETRIES", 2, minimum=0, maximum=10
        )
        self.subagent_aggregation_timeout_seconds = _bounded_env_int(
            "MON_AGENT_AGGREGATION_TIMEOUT_SECONDS", 180, minimum=10, maximum=1_800
        )
        self.pending_user_prompt_limit = _bounded_env_int(
            "MON_AGENT_PENDING_USER_PROMPT_LIMIT", 16, minimum=1, maximum=128
        )
        self.model_request_timeout_seconds = _bounded_env_int(
            "MON_AGENT_MODEL_TIMEOUT_SECONDS", 120, minimum=10, maximum=1_800
        )
        self.turn_timeout_seconds = _bounded_env_int(
            "MON_AGENT_TURN_TIMEOUT_SECONDS", 1_800, minimum=60, maximum=14_400
        )
        self._subagent_global_semaphore = asyncio.Semaphore(self.subagent_max_concurrent_global)
        self._host = RuntimeHost()
        self._running: dict[str, Future[Any]] = {}
        self._running_kinds: dict[str, str] = {}
        self._pending_user_prompts: dict[str, list[tuple[list[dict[str, Any]], str | None]]] = {}
        self._pending_proactive_prompts: dict[
            str, list[tuple[list[dict[str, Any]], str | None, int | str, str, int | str]]
        ] = {}
        self._agents: dict[str, Agent] = {}
        self._cancelled_sessions: set[str] = set()
        self._agent_controls: dict[str, AgentControl] = {}
        self._session_runtime_auth: dict[str, tuple[str | None, dict[str, Any] | None]] = {}
        self._open_coordination_batch_ids: dict[str, str] = {}
        self._reconciled_subagent_sessions: set[str] = set()
        self._restored_subagent_controls: set[str] = set()
        self._lock = threading.Lock()
