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


class RuntimePersistenceMixin:
    async def sync_core_session(self, session_id: str, auth_token: str | None, core: dict[str, Any] | None) -> None:
        if not auth_token:
            return
        session = self.store.require_session(session_id)
        persisted_session = {
            **session["info"],
            "modelEvents": self.store.model_events(session_id),
            "characterRuntime": self.store.get_character_action(session_id),
        }
        for attempt in range(len(_CORE_SYNC_RETRY_DELAYS) + 1):
            try:
                await asyncio.to_thread(self.core_client.sync_agent_session, auth_token, persisted_session, core)
                return
            except CoreAuthenticationExpiredError:
                raise
            except Exception as error:
                if attempt >= len(_CORE_SYNC_RETRY_DELAYS):
                    raise
                delay = _CORE_SYNC_RETRY_DELAYS[attempt]
                logger.warning(
                    f"Core 会话同步失败，准备重试: session={session_id}, "
                    f"attempt={attempt + 1}, delay={delay}s, error={error}"
                )
                await asyncio.sleep(delay)

    async def sync_core_message(
        self,
        session_id: str,
        message: dict[str, Any],
        auth_token: str | None,
        core: dict[str, Any] | None,
    ) -> None:
        if not auth_token:
            return
        session = self.store.require_session(session_id)
        persisted_session = {
            **session["info"],
            "modelEvents": self.store.model_events(session_id),
            "characterRuntime": self.store.get_character_action(session_id),
        }
        message_id = str(message.get("info", {}).get("id") or "unknown")
        for attempt in range(len(_CORE_SYNC_RETRY_DELAYS) + 1):
            try:
                result = await asyncio.to_thread(
                    self.core_client.sync_agent_message,
                    auth_token,
                    persisted_session,
                    message,
                    core,
                )
            except CoreAuthenticationExpiredError:
                raise
            except Exception as error:
                if attempt >= len(_CORE_SYNC_RETRY_DELAYS):
                    raise
                delay = _CORE_SYNC_RETRY_DELAYS[attempt]
                logger.warning(
                    f"Core 消息同步失败，准备重试: session={session_id}, message={message_id}, "
                    f"attempt={attempt + 1}, delay={delay}s, error={error}"
                )
                await asyncio.sleep(delay)
                continue

            projection_failed = isinstance(result, dict) and result.get("sync_status") == "failed"
            if not projection_failed:
                return
            if attempt >= len(_CORE_SYNC_RETRY_DELAYS):
                logger.error(
                    f"Core 已保存原始消息，但业务消息投影持续失败: session={session_id}, message={message_id}"
                )
                return
            delay = _CORE_SYNC_RETRY_DELAYS[attempt]
            logger.warning(
                f"Core 消息投影失败，准备重试: session={session_id}, message={message_id}, "
                f"attempt={attempt + 1}, delay={delay}s"
            )
            await asyncio.sleep(delay)

    async def sync_core_director_run(
        self,
        session_id: str,
        director_run: dict[str, Any],
        auth_token: str | None,
        core: dict[str, Any] | None,
    ) -> None:
        if not auth_token:
            return
        session = self.store.require_session(session_id)
        plan_id = str(director_run.get("planID") or "unknown")
        for attempt in range(len(_CORE_SYNC_RETRY_DELAYS) + 1):
            try:
                await asyncio.to_thread(
                    self.core_client.sync_agent_director_run,
                    auth_token,
                    session["info"],
                    director_run,
                    core,
                )
                return
            except CoreAuthenticationExpiredError:
                raise
            except Exception as error:
                if attempt >= len(_CORE_SYNC_RETRY_DELAYS):
                    raise
                delay = _CORE_SYNC_RETRY_DELAYS[attempt]
                logger.warning(
                    f"Core 导演运行同步失败，准备重试: session={session_id}, plan={plan_id}, "
                    f"attempt={attempt + 1}, delay={delay}s, error={error}"
                )
                await asyncio.sleep(delay)
