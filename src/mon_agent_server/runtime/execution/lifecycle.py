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


class RuntimeLifecycleMixin:
    def is_running(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._running

    def forget_session(self, session_id: str) -> None:
        """清理已删除会话的全部内存态和子智能体持久态。"""
        if self.is_running(session_id):
            raise RuntimeError("智能体正在处理当前任务，不能删除会话。")
        with self._lock:
            self._pending_user_prompts.pop(session_id, None)
            self._agents.pop(session_id, None)
            self._cancelled_sessions.discard(session_id)
            self._agent_controls.pop(session_id, None)
            self._session_runtime_auth.pop(session_id, None)
            self._open_coordination_batch_ids.pop(session_id, None)
            self._reconciled_subagent_sessions.discard(session_id)
            self._restored_subagent_controls.discard(session_id)
        self.subagent_repository.delete_session(session_id)

    def abort(self, session_id: str) -> bool:
        with self._lock:
            running = session_id in self._running
            if running:
                self._cancelled_sessions.add(session_id)
            agent = self._agents.get(session_id)
            control = self._agent_controls.get(session_id)
        cancelled_at = now_ms()
        for batch in self.subagent_repository.list_coordination_batches(session_id):
            if str(batch.get("status") or "") in {"collecting", "ready", "aggregating"}:
                saved = self.subagent_repository.upsert_coordination_batch(
                    session_id,
                    {**batch, "status": "cancelled", "aggregationScheduled": False, "cancelledAt": cancelled_at},
                )
                self.events.emit(
                    {
                        "type": "subagent.batch.cancelled",
                        "properties": {
                            "sessionID": session_id,
                            "batchID": saved.get("batchID"),
                            "status": "cancelled",
                            "updatedAt": saved.get("updatedAt"),
                        },
                    }
                )
        if agent is not None:
            agent.abort()
        active_subagents = False
        if control is not None:
            active_subagents = any(
                snapshot.status not in TERMINAL_AGENT_STATUSES
                for snapshot in control.list_agents()
            )
            if active_subagents:
                future = self._host.submit(self._interrupt_all_subagents(control))
                future.add_done_callback(self._log_abort_cleanup_error)
        self.permissions.reject_all(session_id, reason="session_aborted")
        if self.screen_captures is not None:
            self.screen_captures.reject_all(session_id, reason="session_aborted")
        if self.camera_captures is not None:
            self.camera_captures.reject_all(session_id, reason="session_aborted")
        if running or active_subagents:
            self.events.emit(
                {"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "stopping"}}}
            )
        return running or active_subagents

    @staticmethod
    def _log_abort_cleanup_error(completed: Future[Any]) -> None:
        try:
            completed.result()
        except Exception as error:
            logger.error(f"后台中止子智能体失败: {error}", exc_info=True)

    @staticmethod
    async def _interrupt_all_subagents(control: AgentControl) -> bool:
        snapshots = control.list_agents()
        active = [
            snapshot
            for snapshot in snapshots
            if snapshot.status not in TERMINAL_AGENT_STATUSES
        ]
        for snapshot in active:
            await control.interrupt(snapshot.path)
        return bool(active)

    def _raise_if_cancelled(self, session_id: str) -> None:
        with self._lock:
            cancelled = session_id in self._cancelled_sessions
        if cancelled:
            raise TurnAborted("当前回合已由用户停止")

    def append_user_only(self, session_id: str, parts: list[dict[str, Any]]) -> dict[str, Any]:
        message = self.store.append_user_message(session_id, content_text(parts), prompt_files(parts))
        self.emit_message(session_id, message["info"])
        for part in message["parts"]:
            self.emit_part(session_id, part)
        self.emit_session(session_id)
        return message

    def prompt_async(self, session_id: str, parts: list[dict[str, Any]], auth_token: str | None) -> None:
        with self._lock:
            if session_id in self._running:
                if self._running_kinds.get(session_id) == "aggregation":
                    queue = self._pending_user_prompts.setdefault(session_id, [])
                    if len(queue) >= self.pending_user_prompt_limit:
                        raise RuntimeError(f"等待处理的用户消息已达到上限 {self.pending_user_prompt_limit}。")
                    queue.append((parts, auth_token))
                    return
                raise RuntimeError("Session is already running")
            future = self._host.submit(self._run_prompt(session_id, parts, auth_token))
            self._running[session_id] = future
            self._running_kinds[session_id] = "user"
            future.add_done_callback(lambda completed: self._finish_submission(session_id, completed))

    def compact_async(self, session_id: str, custom_instructions: str | None, auth_token: str | None) -> None:
        instructions = str(custom_instructions or "").strip()
        if len(instructions) > 2_000:
            raise RuntimeError("压缩要求不能超过 2000 个字符。")
        session = self.store.require_session(session_id)
        if not self.store.context_messages(session_id):
            raise RuntimeError("当前会话没有可压缩的上下文。")
        with self._lock:
            if session_id in self._running:
                raise RuntimeError("Session is already running")
            future = self._host.submit(self._run_manual_compaction(session_id, instructions or None, auth_token))
            self._running[session_id] = future
            self._running_kinds[session_id] = "compaction"
            future.add_done_callback(lambda completed: self._finish_submission(session_id, completed))

    def _finish_submission(self, session_id: str, completed: Future[Any]) -> None:
        try:
            completed.result()
        except Exception as error:
            self.emit_session_error(session_id, error)
        finally:
            should_schedule = False
            pending_user: tuple[list[dict[str, Any]], str | None] | None = None
            with self._lock:
                if self._running.get(session_id) is completed:
                    self._running.pop(session_id, None)
                    self._running_kinds.pop(session_id, None)
                    self._agents.pop(session_id, None)
                    self._cancelled_sessions.discard(session_id)
                    self._open_coordination_batch_ids.pop(session_id, None)
                    queued = self._pending_user_prompts.get(session_id) or []
                    if queued:
                        pending_user = queued.pop(0)
                        if not queued:
                            self._pending_user_prompts.pop(session_id, None)
                    else:
                        should_schedule = True
            if pending_user is not None:
                self.prompt_async(session_id, pending_user[0], pending_user[1])
            elif should_schedule:
                self._schedule_ready_aggregation(session_id)

    def close(self) -> None:
        self._host.close()
