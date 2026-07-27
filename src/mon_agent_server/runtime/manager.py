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

from ..brokers import PermissionBroker, QuestionBroker, ScreenCaptureBroker
from ..core import CoreAuthenticationExpiredError, CoreClient
from ..events import EventBus
from ..ids import create_id, now_ms
from ..logging import get_logger
from ..model_stream import core_model, env_model, stream_openai_compatible
from ..prompts import attachment_context, build_agent_system_prompt
from ..skills import create_skill_runtime, owner_storage_key
from ..store import SessionStore, SubagentThreadRepository
from ..store.serializers import is_hidden_message, message_text
from ..tools import MonToolContext
from .compaction import RuntimeCompactionModels, messages_to_compaction_entries, runtime_compaction_settings, timestamp_iso
from .companion import DirectorBeat, DirectorExecution, DirectorScene, actor_task_prompt, create_director_plan
from .config import RuntimeModelConfig, runtime_context_window
from .emitters import RuntimeEmitterMixin, runtime_error_summary
from .host import RuntimeHost
from .messages import content_text, images_from_parts, prompt_files
from .permissions import RuntimePermissionMixin
from .state import RunState
from .subagents import (
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


class MonAgentRuntime(RuntimeEmitterMixin, RuntimePermissionMixin):
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
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        self.store = store
        self.events = events
        self.permissions = permissions
        self.questions = questions
        self.core_client = core_client
        self.screen_captures = screen_captures
        self.environment = environment
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
        self._subagent_global_semaphore = asyncio.Semaphore(self.subagent_max_concurrent_global)
        self._host = RuntimeHost()
        self._running: dict[str, Future[Any]] = {}
        self._running_kinds: dict[str, str] = {}
        self._pending_user_prompts: dict[str, list[tuple[list[dict[str, Any]], str | None]]] = {}
        self._agents: dict[str, Agent] = {}
        self._cancelled_sessions: set[str] = set()
        self._agent_controls: dict[str, AgentControl] = {}
        self._session_runtime_auth: dict[str, tuple[str | None, dict[str, Any] | None]] = {}
        self._open_coordination_batch_ids: dict[str, str] = {}
        self._reconciled_subagent_sessions: set[str] = set()
        self._restored_subagent_controls: set[str] = set()
        self._lock = threading.Lock()

    def is_running(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._running

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

    def _schedule_ready_aggregation(self, session_id: str) -> bool:
        ready = next(
            (
                batch
                for batch in self.subagent_repository.list_coordination_batches(session_id)
                if batch.get("status") == "ready" and not batch.get("aggregationScheduled")
            ),
            None,
        )
        if ready is None:
            return False
        with self._lock:
            if session_id in self._running:
                return False
            batch_id = str(ready.get("batchID") or "")
            if not batch_id:
                return False
            saved = self.subagent_repository.upsert_coordination_batch(
                session_id,
                {
                    **ready,
                    "aggregationScheduled": True,
                    "status": "aggregating",
                    "aggregationStartedAt": ready.get("aggregationStartedAt") or now_ms(),
                },
            )
            future = self._host.submit(self._run_aggregation(session_id, batch_id))
            self._running[session_id] = future
            self._running_kinds[session_id] = "aggregation"
            future.add_done_callback(lambda completed: self._finish_submission(session_id, completed))
        self.events.emit(
            {
                "type": "subagent.batch.aggregating",
                "properties": {
                    "sessionID": session_id,
                    "batchID": batch_id,
                    "status": saved.get("status"),
                    "updatedAt": saved.get("updatedAt"),
                },
            }
        )
        return True

    async def _run_aggregation(self, session_id: str, batch_id: str) -> None:
        batch = await asyncio.to_thread(
            self.subagent_repository.get_coordination_batch,
            session_id,
            batch_id,
        )
        if not batch or batch.get("status") != "aggregating":
            return
        results = batch.get("pendingResults") if isinstance(batch.get("pendingResults"), dict) else {}
        serialized_results = json.dumps(results, ensure_ascii=False, separators=(",", ":"))
        if len(serialized_results) > self.subagent_max_result_chars:
            serialized_results = serialized_results[: self.subagent_max_result_chars] + "…[结果已按运行时上限截断]"
        prompt = "\n".join(
            [
                f'<subagent_batch_result batch_id="{batch_id}" objective_epoch="{int(batch.get("objectiveEpoch") or 0)}">',
                serialized_results,
                "</subagent_batch_result>",
                "请验证并整合以上子智能体结果，不要逐字复制。说明失败任务对结论的影响。",
                "这是内部最终整合阶段；不要再创建子智能体。",
            ]
        )
        auth_token, _core = self._session_runtime_auth.get(session_id, (None, None))
        try:
            async with asyncio.timeout(self.subagent_aggregation_timeout_seconds):
                await self._run_prompt(
                    session_id,
                    [{"type": "text", "text": prompt}],
                    auth_token,
                    internal_batch_id=batch_id,
                    continuation_run_id=str(batch.get("sourceTurnID") or "") or None,
                )
        except Exception:
            retry_count = int(batch.get("aggregationRetryCount") or 0) + 1
            can_retry = retry_count <= self.subagent_aggregation_max_retries
            failed = await asyncio.to_thread(
                self.subagent_repository.upsert_coordination_batch,
                session_id,
                {
                    **batch,
                    "status": "ready" if can_retry else "aggregation_failed",
                    "aggregationScheduled": False,
                    "aggregationRetryCount": retry_count,
                    "failedAt": now_ms(),
                },
            )
            self.events.emit(
                {
                    "type": "subagent.batch.failed",
                    "properties": {
                        "sessionID": session_id,
                        "batchID": batch_id,
                        "status": failed.get("status"),
                        "retryCount": retry_count,
                        "updatedAt": failed.get("updatedAt"),
                    },
                }
            )
            raise
        completed = await asyncio.to_thread(
            self.subagent_repository.upsert_coordination_batch,
            session_id,
            {**batch, "status": "completed", "aggregationScheduled": True, "completedAt": now_ms()},
        )
        self.events.emit(
            {
                "type": "subagent.batch.completed",
                "properties": {
                    "sessionID": session_id,
                    "batchID": batch_id,
                    "status": completed.get("status"),
                    "updatedAt": completed.get("updatedAt"),
                },
            }
        )

    def close(self) -> None:
        self._host.close()

    def interrupt_subagent(self, session_id: str, target: str) -> dict[str, Any]:
        async def interrupt() -> dict[str, Any]:
            control = self._agent_controls.get(session_id)
            if control is None:
                raise KeyError(f"当前会话没有运行中的子智能体控制器：{session_id}")
            return (await control.interrupt(target)).to_payload()

        return self._host.submit(interrupt()).result(timeout=5)

    def followup_subagent(
        self,
        session_id: str,
        target: str,
        message: str,
        auth_token: str | None,
    ) -> dict[str, Any]:
        task = str(message or "").strip()
        if not task:
            raise ValueError("追加任务不能为空。")

        async def followup() -> dict[str, Any]:
            session = self.store.require_session(session_id)
            participants = session.get("info", {}).get("participants") or []
            assistant_id = participants[0].get("assistantID") if participants else None
            parent_config = await self._resolve_runtime_config(auth_token, assistant_id)
            environment, owner_key = await self._resolve_user_context(auth_token)
            control = await self._ensure_subagent_control_restored(
                session_id=session_id,
                parent_runtime_config=parent_config,
                auth_token=auth_token,
                environment=environment,
                skill_owner_key=owner_key,
            )
            communication = await control.followup_task(target, task, sender="/root")
            return communication.to_payload()

        return self._host.submit(followup()).result(timeout=10)

    def load_persisted_subagents(self, session_id: str) -> list[dict[str, Any]]:
        first_restore = session_id not in self._reconciled_subagent_sessions
        if first_restore:
            self.subagent_repository.reconcile_inflight(session_id)
            self.subagent_repository.reconcile_coordination_batches(
                session_id,
                aggregation_max_retries=self.subagent_aggregation_max_retries,
            )
            self._reconciled_subagent_sessions.add(session_id)
        threads = self.subagent_repository.list_threads(session_id)
        for thread in threads:
            self.store.upsert_agent_thread(session_id, thread, touch=False)
            if first_restore:
                self.events.emit(
                    {
                        "type": "subagent.restored",
                        "properties": {"sessionID": session_id, "agent": thread},
                    }
                )
            self._schedule_ready_aggregation(session_id)
        return threads

    def get_subagent_thread_details(
        self,
        session_id: str,
        target: str,
        *,
        event_limit: int = 500,
        include_messages: bool = False,
    ) -> dict[str, Any]:
        return self.subagent_repository.thread_details(
            session_id,
            target,
            event_limit=event_limit,
            include_messages=include_messages,
        )

    def _agent_control_for(self, session_id: str) -> AgentControl:
        control = self._agent_controls.get(session_id)
        if control is None:
            control = AgentControl(
                session_id,
                max_threads=self.subagent_max_threads,
                max_concurrent=self.subagent_max_concurrent_per_session,
                max_depth=self.subagent_max_depth,
                on_event=self._on_subagent_event,
            )
            self._agent_controls[session_id] = control
        return control

    async def _ensure_subagent_control_restored(
        self,
        *,
        session_id: str,
        parent_runtime_config: RuntimeModelConfig,
        auth_token: str | None,
        environment: dict[str, Any] | None,
        skill_owner_key: str | None,
    ) -> AgentControl:
        control = self._agent_control_for(session_id)
        if session_id in self._restored_subagent_controls:
            return control
        await asyncio.to_thread(self.load_persisted_subagents, session_id)
        persisted = await asyncio.to_thread(self.subagent_repository.list_threads, session_id)
        policies_by_id: dict[str, SubagentToolPolicy] = {}
        budgets_by_id: dict[str, SubagentBudget] = {}
        for payload in sorted(persisted, key=lambda item: (int(item.get("depth") or 1), int(item.get("createdAt") or 0))):
            snapshot = AgentSnapshot.from_payload(payload)
            try:
                definition = self.subagent_catalog.resolve(snapshot.role)
            except ValueError:
                definition = self.subagent_catalog.resolve("general")
            checkpoint = await asyncio.to_thread(
                self.subagent_repository.load_checkpoint,
                session_id,
                snapshot.id,
            ) or {}
            saved_policy_payload = checkpoint.get("toolPolicy")
            saved_policy = (
                SubagentToolPolicy.from_payload(saved_policy_payload)
                if isinstance(saved_policy_payload, dict)
                else definition.tool_policy
            )
            effective_policy = saved_policy.restrict(definition.tool_policy)
            if snapshot.parent_id and snapshot.parent_id in policies_by_id:
                effective_policy = policies_by_id[snapshot.parent_id].restrict(effective_policy)
            policies_by_id[snapshot.id] = effective_policy
            saved_budget_payload = checkpoint.get("budget")
            try:
                saved_budget = (
                    SubagentBudget.from_payload(saved_budget_payload)
                    if isinstance(saved_budget_payload, dict)
                    else definition.budget
                )
            except ValueError:
                logger.warning(f"恢复子智能体预算失败，使用当前角色预算: agent={snapshot.path}")
                saved_budget = definition.budget
            effective_budget = saved_budget.restrict(definition.budget)
            if snapshot.parent_id and snapshot.parent_id in budgets_by_id:
                effective_budget = budgets_by_id[snapshot.parent_id].restrict(effective_budget)
            budgets_by_id[snapshot.id] = effective_budget
            try:
                runtime_config = await self._resolve_subagent_runtime_config(
                    definition,
                    parent_runtime_config,
                    auth_token,
                )
            except Exception as error:
                logger.warning(
                    f"恢复子智能体模型配置失败，回退父会话模型: agent={snapshot.path}, error={error}"
                )
                runtime_config = RuntimeModelConfig(
                    dict(parent_runtime_config.model),
                    parent_runtime_config.api_key,
                    parent_runtime_config.label,
                    parent_runtime_config.source,
                    parent_runtime_config.core,
                )
            inherited_messages = [
                item for item in (checkpoint.get("messages") or []) if isinstance(item, dict)
            ]
            restored_skills = tuple(
                str(item) for item in (checkpoint.get("activeSkillIDs") or []) if str(item).strip()
            ) or None
            child_state: dict[str, Any] = {
                "budgetUsage": _subagent_budget_usage(checkpoint.get("budgetUsage")),
            }

            async def restored_runner(
                thread: AgentThread,
                message: str,
                *,
                _definition: SubagentDefinition = definition,
                _runtime_config: RuntimeModelConfig = runtime_config,
                _inherited_messages: list[dict[str, Any]] = inherited_messages,
                _child_state: dict[str, Any] = child_state,
                _tool_policy: SubagentToolPolicy = effective_policy,
                _budget: SubagentBudget = effective_budget,
                _restored_skills: tuple[str, ...] | None = restored_skills,
            ) -> AgentResult:
                return await self._run_subagent_thread(
                    thread=thread,
                    message=message,
                    role=_definition,
                    runtime_config=_runtime_config,
                    auth_token=auth_token,
                    environment=environment,
                    skill_owner_key=skill_owner_key,
                    inherited_messages=_inherited_messages,
                    child_state=_child_state,
                    tool_policy=_tool_policy,
                    budget=_budget,
                    restored_skill_ids=_restored_skills,
                )

            control.restore(snapshot, restored_runner)
        persisted_mailbox = await asyncio.to_thread(self.subagent_repository.list_mailbox, session_id)
        control.restore_mailbox(persisted_mailbox)
        self._restored_subagent_controls.add(session_id)
        return control

    async def _on_subagent_event(self, event: dict[str, Any]) -> None:
        properties = event.get("properties") if isinstance(event.get("properties"), dict) else {}
        session_id = str(properties.get("rootSessionID") or "")
        event_type = str(event.get("type") or "agent.updated")
        if event_type == "agent.messages_consumed" and session_id:
            receiver = str(properties.get("receiver") or "/root")
            message_ids = [str(item) for item in (properties.get("messageIDs") or []) if str(item)]
            await asyncio.to_thread(
                self.subagent_repository.consume_messages,
                session_id,
                receiver,
                message_ids,
            )
            self.events.emit(
                {
                    "type": "subagent.messages_consumed",
                    "properties": {
                        "sessionID": session_id,
                        "receiver": receiver,
                        "messageIDs": message_ids,
                    },
                }
            )
            return
        agent = properties.get("agent") if isinstance(properties.get("agent"), dict) else None
        if not session_id or agent is None:
            return
        await asyncio.to_thread(self.subagent_repository.upsert_thread, session_id, agent)
        self.store.upsert_agent_thread(session_id, agent)
        message = properties.get("message") if isinstance(properties.get("message"), dict) else None
        if message:
            await asyncio.to_thread(
                self.subagent_repository.enqueue_message,
                session_id,
                message,
            )
            await asyncio.to_thread(
                self.subagent_repository.append_event,
                session_id,
                str(agent.get("id") or "unknown"),
                {"type": "agent.communication", "message": message},
            )
            self.store.append_agent_message(session_id, message)
        self.events.emit(
            {
                "type": event_type.replace("agent.", "subagent.", 1),
                "properties": {"sessionID": session_id, **properties},
            }
        )
        if agent.get("status") in {"completed", "failed", "interrupted", "cancelled"}:
            await self._record_coordination_terminal_result(session_id, agent)
            auth_token, core = self._session_runtime_auth.get(session_id, (None, None))
            if auth_token:
                try:
                    await self.sync_core_session(session_id, auth_token, core)
                except Exception as error:
                    logger.error(
                        f"子智能体终态同步到 Core 失败: session={session_id} agent={agent.get('id')}: {error}",
                        exc_info=True,
                    )

    async def _record_coordination_terminal_result(
        self,
        session_id: str,
        agent: dict[str, Any],
    ) -> None:
        metadata = agent.get("metadata") if isinstance(agent.get("metadata"), dict) else {}
        batch_id = str(metadata.get("coordinationBatchID") or "").strip()
        task_id = str(agent.get("id") or "").strip()
        if not batch_id or not task_id:
            return
        attempt_id = str(metadata.get("attemptID") or "initial")
        result_payload = agent.get("result") if isinstance(agent.get("result"), dict) else None
        normalized_result = {
            "taskID": task_id,
            "attemptID": attempt_id,
            "taskName": str(agent.get("taskName") or ""),
            "agentPath": str(agent.get("agentPath") or ""),
            "role": str(agent.get("role") or "general"),
            "status": str(agent.get("status") or "failed"),
            "result": result_payload,
            "error": str(agent.get("error") or "") or None,
            "completedAt": agent.get("completedAt") or now_ms(),
        }
        try:
            batch, inserted = await asyncio.to_thread(
                self.subagent_repository.record_coordination_result,
                session_id,
                batch_id,
                task_id=task_id,
                attempt_id=attempt_id,
                result=normalized_result,
            )
        except KeyError:
            logger.warning(
                "子智能体终态缺少协调批次: session={} batch={} agent={}",
                session_id,
                batch_id,
                task_id,
            )
            return
        if not inserted:
            return
        event_type = "subagent.batch.ready" if batch.get("status") == "ready" else "subagent.batch.updated"
        self.events.emit(
            {
                "type": event_type,
                "properties": {
                    "sessionID": session_id,
                    "batchID": batch_id,
                    "status": batch.get("status"),
                    "requiredTotal": len(batch.get("requiredTaskIDs") or []),
                    "requiredTerminal": len(
                        set(batch.get("requiredTaskIDs") or [])
                        & set(batch.get("terminalTaskIDs") or [])
                    ),
                    "optionalTotal": len(batch.get("optionalTaskIDs") or []),
                    "objectiveEpoch": int(batch.get("objectiveEpoch") or 0),
                    "updatedAt": batch.get("updatedAt"),
                },
            }
        )
        if batch.get("status") == "ready":
            self._schedule_ready_aggregation(session_id)

    async def _resolve_runtime_config(
        self,
        auth_token: str | None,
        assistant_id: int | str | None = None,
    ) -> RuntimeModelConfig:
        if auth_token:
            if assistant_id is not None:
                core = await asyncio.to_thread(
                    self.core_client.resolve_runtime_config_for_assistant,
                    auth_token,
                    assistant_id,
                )
            else:
                core = await asyncio.to_thread(self.core_client.resolve_runtime_config, auth_token)
            if core:
                model, api_key, label, source = core_model(core)
                return RuntimeModelConfig(model, api_key, label, source, core)
        model, api_key, label, source = env_model()
        return RuntimeModelConfig(model, api_key, label, source, None)

    async def _resolve_subagent_runtime_config(
        self,
        definition: SubagentDefinition,
        parent: RuntimeModelConfig,
        auth_token: str | None,
    ) -> RuntimeModelConfig:
        if definition.ai_entity_id is None:
            resolved = RuntimeModelConfig(
                dict(parent.model),
                parent.api_key,
                parent.label,
                parent.source,
                parent.core,
            )
        else:
            if not auth_token:
                raise RuntimeError(
                    f"子智能体 {definition.name} 配置了 ai_entity_id，但当前会话没有 Core 身份凭据。"
                )
            entity = await asyncio.to_thread(
                self.core_client.get_ai_entity,
                auth_token,
                definition.ai_entity_id,
            )
            if not entity.get("api_key"):
                raise RuntimeError(f"子智能体 {definition.name} 使用的 AI 实体没有配置 API Key。")
            core = {**(parent.core or {}), "aiEntity": entity}
            model, api_key, label, source = core_model(core)
            resolved = RuntimeModelConfig(model, api_key, label, source, core)
        if definition.thinking_level is not None:
            resolved.thinking_level = definition.thinking_level
        return resolved

    async def _run_manual_compaction(
        self,
        session_id: str,
        custom_instructions: str | None,
        auth_token: str | None,
    ) -> None:
        started = now_ms()
        session = self.store.require_session(session_id)
        participants = session.get("info", {}).get("participants") or []
        primary_participant = participants[0] if participants else {}
        run_state = RunState(speaker=primary_participant)
        self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "busy"}}})
        self.emit_runtime_thinking(session_id, run_state, "正在读取当前模型配置并准备主动压缩上下文。")
        try:
            runtime_config = await self._resolve_runtime_config(auth_token, primary_participant.get("assistantID"))
            await self.sync_core_session(session_id, auth_token, runtime_config.core)
            messages = self.store.context_messages(session_id)
            before_tokens = int(estimate_context_tokens(messages).get("tokens") or 0)
            compacted_messages = await self.compact_agent_messages_if_needed(
                session_id,
                run_state,
                runtime_config,
                messages,
                now_ms(),
                auth_token,
                force=True,
                custom_instructions=custom_instructions,
            )
            after_tokens = int(estimate_context_tokens(compacted_messages).get("tokens") or 0)
            self.emit_runtime_thinking(
                session_id,
                run_state,
                f"主动压缩完成：上下文约从 {before_tokens} 降至 {after_tokens} tokens。",
                done=True,
            )
            self.finish_runtime_message(session_id, run_state)
            await self.sync_core_session(session_id, auth_token, runtime_config.core)
            self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "idle"}}})
            self.emit_session(session_id)
            logger.info(
                "session {} manual compaction completed: before={} after={} duration={}ms",
                session_id,
                before_tokens,
                after_tokens,
                now_ms() - started,
            )
        except NoCompactionNeeded as notice:
            logger.info("session {} manual compaction skipped: {}", session_id, notice)
            self.emit_runtime_thinking(session_id, run_state, str(notice), done=True)
            self.finish_runtime_message(session_id, run_state)
            self.events.emit(
                {"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "idle"}}}
            )
            self.emit_session(session_id)
        except Exception as error:
            logger.error(f"session {session_id} 主动压缩失败: {error}", exc_info=True)
            self.emit_runtime_thinking(session_id, run_state, runtime_error_summary(error), done=True)
            self.finish_runtime_message(session_id, run_state, error=error)
            self.emit_session_error(session_id, error)

    async def _resolve_user_context(
        self, auth_token: str | None
    ) -> tuple[dict[str, Any] | None, str | None]:
        if not auth_token:
            return self.environment, None
        try:
            profile = await asyncio.to_thread(self.core_client.get_user_profile, auth_token)
            configured = profile.get("environment") if isinstance(profile.get("environment"), dict) else {}
            from ..config import merge_environment_context

            return merge_environment_context(self.environment or {}, configured), owner_storage_key(profile.get("id"))
        except Exception as error:
            logger.warning(f"读取 Core 用户偏好环境配置失败，使用本地默认值: {error}")
            return self.environment, None

    async def _analyze_non_multimodal_images(
        self,
        *,
        session_id: str,
        message_id: str,
        parts: list[dict[str, Any]],
        user_text: str,
        auth_token: str | None,
        runtime_config: RuntimeModelConfig,
    ) -> str:
        image_parts = [
            part
            for part in parts
            if part.get("type") == "file" and str(part.get("mime") or "").startswith("image/")
        ]
        if runtime_config.supports_images or not image_parts:
            return ""
        if not auth_token or not runtime_config.core:
            raise RuntimeError("当前对话模型不支持图片，且当前会话无法读取角色绑定的 Vision 配置。")

        character = runtime_config.core.get("character")
        vision_config = runtime_config.core.get("visionConfig")
        character_name = character.get("name") if isinstance(character, dict) else "当前角色"
        if not isinstance(vision_config, dict) or not vision_config.get("id"):
            raise RuntimeError(f"角色「{character_name or '当前角色'}」的对话模型不支持图片，且角色未绑定 Vision 配置。")
        if vision_config.get("status") == "unavailable":
            raise RuntimeError(
                f"无法读取角色「{character_name or '当前角色'}」绑定的 Vision 配置："
                f"{vision_config.get('error') or 'Core Vision 配置不可用'}"
            )
        if vision_config.get("status") not in (None, "", "active"):
            raise RuntimeError(
                f"角色「{character_name or '当前角色'}」绑定的 Vision 配置「{vision_config.get('vision_name') or vision_config.get('id')}」未启用。"
            )

        images = _vision_inputs_from_parts(parts)
        if len(images) != len(image_parts):
            raise RuntimeError("图片附件不是有效的 base64 data URL，无法交给角色绑定的 Vision 服务分析。")

        question = user_text.strip()
        prompt = (
            "请客观、完整地分析这些图片，提取画面内容、可见文字、界面状态、错误信息及其他重要细节。"
            "分析必须基于图片，不要猜测看不见的内容。"
        )
        if question:
            prompt += f"\n用户当前问题：{question[:2000]}"
        result = await asyncio.to_thread(
            self.core_client.analyze_vision,
            auth_token,
            {
                "config_id": vision_config["id"],
                "images": images,
                "prompt": prompt,
                "source": "monagent",
                "related_session_id": session_id,
                "related_message_id": message_id,
                "metadata": {
                    "automatic": True,
                    "fallback_reason": "current_model_does_not_support_images",
                    "character_id": character.get("id") if isinstance(character, dict) else None,
                },
                "temperature": 0.2,
                "max_tokens": 1600,
            },
        )
        if not isinstance(result, dict) or not result.get("success"):
            error = (result.get("error") or result.get("error_message")) if isinstance(result, dict) else None
            raise RuntimeError(error or "角色绑定的 Vision 服务分析失败。")
        analysis = str(result.get("content") or result.get("summary") or "").strip()
        if not analysis:
            raise RuntimeError("角色绑定的 Vision 服务没有返回可用的图片分析结果。")

        references = "、".join(str(image.get("ref") or "图片") for image in images)
        return "\n".join(
            [
                "### 自动视觉分析结果",
                f"图片：{references}",
                f"视觉配置：{vision_config.get('vision_name') or vision_config.get('name') or vision_config.get('id')}",
                analysis,
            ]
        )

    @staticmethod
    def _participant_from_core(core: dict[str, Any], position: int = 0) -> dict[str, Any]:
        assistant = core.get("assistant") if isinstance(core.get("assistant"), dict) else {}
        character = core.get("character") if isinstance(core.get("character"), dict) else {}
        return {
            "assistantID": assistant.get("id"),
            "assistantName": assistant.get("name") or character.get("name") or "助手",
            "characterID": character.get("id"),
            "characterName": character.get("name") or assistant.get("name") or "助手",
            "signature": character.get("signature") or "",
            "avatarUrl": character.get("avatar_url") or "",
            "standingImageUrl": character.get("default_standing_image_url") or "",
            "ttsConfigID": character.get("tts_config_id"),
            "position": position,
        }

    def _make_subagent_dispatcher(
        self,
        *,
        session_id: str,
        parent_path: str,
        runtime_config: RuntimeModelConfig,
        auth_token: str | None,
        environment: dict[str, Any] | None,
        skill_owner_key: str | None,
        messages_provider: Callable[[], list[dict[str, Any]]],
        parent_policy: SubagentToolPolicy | None = None,
        parent_budget: SubagentBudget | None = None,
        parent_run_id: str | None = None,
    ):
        async def dispatch(action: str, params: dict[str, Any]) -> dict[str, Any]:
            control = self._agent_control_for(session_id)
            if action == "spawn":
                if parent_path != AgentControl.ROOT_PATH:
                    raise RuntimeError("当前子智能体角色不允许递归创建下级智能体。")
                role = self.subagent_catalog.resolve(params.get("role"))
                role_policy = role.tool_policy
                effective_policy = parent_policy.restrict(role_policy) if parent_policy else role_policy
                effective_budget = parent_budget.restrict(role.budget) if parent_budget else role.budget
                child_runtime_config = await self._resolve_subagent_runtime_config(
                    role,
                    runtime_config,
                    auth_token,
                )
                task = str(params.get("message") or "").strip()
                task_name = str(params.get("task_name") or "").strip()
                if not task:
                    raise ValueError("子智能体任务说明不能为空。")
                fork_turns = params.get("fork_turns", "none")
                background = bool(params.get("background", True))
                required_for_final = bool(params.get("required_for_final", True))
                category_by_role = {
                    "researcher": "external_research",
                    "explore": "code_exploration",
                    "file_locator": "user_file_location",
                    "coder": "implementation",
                    "reviewer": "review",
                }
                task_category = str(params.get("task_category") or category_by_role.get(role.name, "other"))
                valid_categories = {"external_research", "code_exploration", "user_file_location", "diagnosis", "implementation", "review", "other"}
                if task_category not in valid_categories:
                    raise ValueError(f"不支持的子任务类别：{task_category}")
                role_reason = str(params.get("role_reason") or "").strip()[:500] or None
                required_reason = str(params.get("required_reason") or "").strip()[:500] or None
                raw_scope = params.get("target_scope")
                target_scope = None
                if raw_scope is not None:
                    if not isinstance(raw_scope, dict):
                        raise ValueError("target_scope 必须是对象。")
                    scope_kind = str(raw_scope.get("kind") or "")
                    if scope_kind not in {"web", "workspace", "user_files", "logs", "mixed", "other"}:
                        raise ValueError("target_scope.kind 无效。")
                    raw_targets = raw_scope.get("targets")
                    if not isinstance(raw_targets, list) or len(raw_targets) > 20:
                        raise ValueError("target_scope.targets 必须是最多 20 项的数组。")
                    target_scope = {"kind": scope_kind, "targets": [str(item)[:1000] for item in raw_targets]}
                batch_id = self._open_coordination_batch_ids.get(session_id)
                batch = (
                    self.subagent_repository.get_coordination_batch(session_id, batch_id)
                    if batch_id
                    else None
                )
                if not batch or batch.get("status") != "collecting":
                    batch_id = create_id("batch")
                    batch = self.subagent_repository.upsert_coordination_batch(
                        session_id,
                        {
                            "batchID": batch_id,
                            "sourceTurnID": parent_run_id,
                            "objectiveEpoch": 0,
                            "status": "collecting",
                            "requiredTaskIDs": [],
                            "optionalTaskIDs": [],
                            "terminalTaskIDs": [],
                            "pendingResults": {},
                            "deliveredResultKeys": [],
                            "aggregationScheduled": False,
                            "createdAt": now_ms(),
                        },
                    )
                    self._open_coordination_batch_ids[session_id] = batch_id
                    self.events.emit(
                        {
                            "type": "subagent.batch.created",
                            "properties": {
                                "sessionID": session_id,
                                "batchID": batch_id,
                                "status": "collecting",
                                "requiredTotal": 0,
                                "requiredTerminal": 0,
                                "optionalTotal": 0,
                                "objectiveEpoch": 0,
                                "updatedAt": batch.get("updatedAt"),
                            },
                        }
                    )
                current_task_count = len(batch.get("requiredTaskIDs") or []) + len(batch.get("optionalTaskIDs") or [])
                if current_task_count >= self.subagent_max_tasks_per_batch:
                    raise RuntimeError(f"单个协调批次最多允许 {self.subagent_max_tasks_per_batch} 个子任务。")
                attempt_id = create_id("attempt")
                inherited_messages = fork_messages(messages_provider(), fork_turns)
                child_state: dict[str, Any] = {"budgetUsage": _subagent_budget_usage()}

                async def runner(thread: AgentThread, message: str) -> AgentResult:
                    return await self._run_subagent_thread(
                        thread=thread,
                        message=message,
                        role=role,
                        runtime_config=child_runtime_config,
                        auth_token=auth_token,
                        environment=environment,
                        skill_owner_key=skill_owner_key,
                        inherited_messages=inherited_messages,
                        child_state=child_state,
                        tool_policy=effective_policy,
                        budget=effective_budget,
                    )

                snapshot = await control.spawn(
                    message=task,
                    task_name=task_name,
                    parent=parent_path,
                    role=role.name,
                    runner=runner,
                    metadata={
                        "forkTurns": fork_turns,
                        "roleDescription": role.description,
                        "configSource": role.source,
                        "configPath": role.file_path,
                        "sandboxMode": effective_policy.sandbox_mode,
                        "model": child_runtime_config.label,
                        "thinkingLevel": child_runtime_config.thinking_level,
                        "budget": effective_budget.to_payload(),
                        "coordinationBatchID": batch_id,
                        "requiredForFinal": required_for_final,
                        "background": background,
                        "objectiveEpoch": int(batch.get("objectiveEpoch") or 0),
                        "attemptID": attempt_id,
                        "taskCategory": task_category,
                        "roleReason": role_reason,
                        "requiredReason": required_reason,
                        "targetScope": target_scope,
                        "delegationMode": runtime_config.delegation_policy.mode,
                    },
                    start=False,
                )
                task_key = "requiredTaskIDs" if required_for_final else "optionalTaskIDs"
                task_ids = [str(item) for item in batch.get(task_key) or []]
                if snapshot.id not in task_ids:
                    task_ids.append(snapshot.id)
                batch = self.subagent_repository.upsert_coordination_batch(
                    session_id,
                    {**batch, task_key: task_ids},
                )
                self.events.emit(
                    {
                        "type": "subagent.batch.updated",
                        "properties": {
                            "sessionID": session_id,
                            "batchID": batch_id,
                            "status": batch.get("status"),
                            "requiredTotal": len(batch.get("requiredTaskIDs") or []),
                            "requiredTerminal": len(
                                set(batch.get("requiredTaskIDs") or [])
                                & set(batch.get("terminalTaskIDs") or [])
                            ),
                            "optionalTotal": len(batch.get("optionalTaskIDs") or []),
                            "objectiveEpoch": int(batch.get("objectiveEpoch") or 0),
                            "updatedAt": batch.get("updatedAt"),
                        },
                    }
                )
                await control.start(snapshot.id, task)
                payload = snapshot.to_payload()
                payload["coordinationBatchID"] = batch_id
                payload["requiredForFinal"] = required_for_final
                if not background:
                    timeout_ms = min(60_000, max(0, int(params.get("timeout_ms") or 60_000)))
                    payload["wait"] = await control.wait(
                        [snapshot.id],
                        timeout=timeout_ms / 1000,
                        receiver=parent_path,
                    )
                return payload
            if action == "send_message":
                message = await control.send_message(
                    str(params.get("target") or ""),
                    str(params.get("message") or ""),
                    sender=parent_path,
                )
                return message.to_payload()
            if action == "followup_task":
                message = await control.followup_task(
                    str(params.get("target") or ""),
                    str(params.get("message") or ""),
                    sender=parent_path,
                )
                return message.to_payload()
            if action == "list_agents":
                prefix = str(params.get("path_prefix") or "").strip() or None
                return {"agents": [item.to_payload() for item in control.list_agents(prefix)]}
            if action == "wait_agent":
                raw_targets = params.get("targets")
                targets = [str(item) for item in raw_targets] if isinstance(raw_targets, list) else None
                timeout_ms = min(60_000, max(0, int(params.get("timeout_ms") or 30_000)))
                return await control.wait(targets, timeout=timeout_ms / 1000, receiver=parent_path)
            if action == "interrupt_agent":
                snapshot = await control.interrupt(str(params.get("target") or ""))
                return snapshot.to_payload()
            raise ValueError(f"未知子智能体操作：{action}")

        return dispatch

    async def _run_subagent_thread(
        self,
        *,
        thread: AgentThread,
        message: str,
        role: SubagentDefinition,
        runtime_config: RuntimeModelConfig,
        auth_token: str | None,
        environment: dict[str, Any] | None,
        skill_owner_key: str | None,
        inherited_messages: list[dict[str, Any]],
        child_state: dict[str, Any],
        tool_policy: SubagentToolPolicy,
        budget: SubagentBudget,
        restored_skill_ids: tuple[str, ...] | None = None,
    ) -> AgentResult:
        agent = child_state.get("agent")
        skill_runtime = child_state.get("skillRuntime")
        budget_usage = child_state.setdefault("budgetUsage", _subagent_budget_usage())
        if not isinstance(agent, Agent):
            holder: dict[str, Agent] = {}
            tool_context = MonToolContext(
                session_id=thread.snapshot.root_session_id,
                core_client=self.core_client,
                core_token=auth_token,
                permissions=self.permissions,
                questions=self.questions,
                screen_captures=self.screen_captures,
                current_model_supports_images=runtime_config.supports_images,
                vision_config=(runtime_config.core or {}).get("visionConfig") if runtime_config.core else None,
                environment=environment,
                emit_event=self.events.emit,
                agent_path=thread.snapshot.path,
                permission_mode=(
                    self.permissions.mode_for_session(thread.snapshot.root_session_id)
                    if self.permissions is not None
                    else "restricted"
                ),
                subagent_role_names=self.subagent_catalog.names,
            )
            tool_context.subagent_dispatch = self._make_subagent_dispatcher(
                session_id=thread.snapshot.root_session_id,
                parent_path=thread.snapshot.path,
                runtime_config=runtime_config,
                auth_token=auth_token,
                environment=environment,
                skill_owner_key=skill_owner_key,
                messages_provider=lambda: holder.get("agent").state.messages if holder.get("agent") else inherited_messages,
                parent_policy=tool_policy,
                parent_budget=budget,
            )
            skill_runtime = create_skill_runtime(
                self.workspace_root,
                tool_context,
                profile="user_chat",
                active_skill_ids=restored_skill_ids or tuple([*role.initial_skills, "multi-agent"]),
                owner_key=skill_owner_key,
                tool_filter=tool_policy.filter(),
            )
            blocked_tools = {"ask_user", "list_character_actions", "switch_character_action"}
            tools = [tool for tool in skill_runtime.active_tools() if tool.name not in blocked_tools]

            def system_prompt_for(active_skill_ids: tuple[str, ...]) -> str:
                return build_subagent_system_prompt(
                    role,
                    agent_path=thread.snapshot.path,
                    workspace_root=str(self.workspace_root),
                    skill_prompt=skill_runtime.prompt_section(),
                    tool_policy=tool_policy,
                    budget=budget,
                )

            permission_hook = self._before_tool_call(
                thread.snapshot.root_session_id,
                RunState(),
                agent_path=thread.snapshot.path,
                tool_policy=tool_policy,
            )

            async def budgeted_before_tool_call(
                context: dict[str, Any],
                signal: Any = None,
            ) -> dict[str, Any] | None:
                permission_result = await permission_hook(context, signal)
                if permission_result and permission_result.get("block"):
                    return permission_result
                if int(budget_usage["toolCallCount"]) >= budget.max_tool_calls:
                    budget_usage["exceededReason"] = (
                        f"子智能体工具调用预算已耗尽：最多 {budget.max_tool_calls} 次。"
                    )
                    return {"block": True, "reason": budget_usage["exceededReason"]}
                budget_usage["toolCallCount"] = int(budget_usage["toolCallCount"]) + 1
                return None

            async def should_stop_after_turn(context: dict[str, Any]) -> bool:
                budget_usage["turnCount"] = int(budget_usage["turnCount"]) + 1
                if int(budget_usage["turnCount"]) >= budget.max_turns and context.get("toolResults"):
                    budget_usage["exceededReason"] = (
                        f"子智能体模型轮次预算已耗尽：最多 {budget.max_turns} 轮。"
                    )
                    return True
                return bool(budget_usage.get("exceededReason"))

            agent = Agent(
                AgentOptions(
                    session_id=f"{thread.snapshot.root_session_id}:{thread.snapshot.id}",
                    tool_execution="sequential",
                    convert_to_llm=convert_to_llm,
                    stream_fn=stream_openai_compatible,
                    initial_state={
                        "model": runtime_config.model,
                        "thinkingLevel": runtime_config.thinking_level,
                        "systemPrompt": system_prompt_for(skill_runtime.active_skill_ids),
                        "tools": tools,
                        "messages": inherited_messages,
                    },
                    get_api_key=lambda _provider: runtime_config.api_key,
                    before_tool_call=budgeted_before_tool_call,
                    should_stop_after_turn=should_stop_after_turn,
                    prepare_next_turn_with_context=lambda turn, _signal: skill_runtime.prepare_next_turn(
                        turn, system_prompt_for
                    ),
                )
            )
            holder["agent"] = agent
            child_state["agent"] = agent
            child_state["skillRuntime"] = skill_runtime
            agent.subscribe(
                lambda event, _signal: self._record_subagent_agent_event(
                    thread,
                    event,
                    agent,
                    skill_runtime,
                    role,
                    tool_policy,
                    budget,
                    budget_usage,
                    runtime_config,
                )
            )
        if int(budget_usage["turnCount"]) >= budget.max_turns:
            raise RuntimeError(f"子智能体模型轮次预算已耗尽：最多 {budget.max_turns} 轮。")
        remaining_seconds = budget.timeout_seconds - (int(budget_usage["elapsedMs"]) / 1_000)
        if remaining_seconds <= 0:
            raise RuntimeError(f"子智能体运行时间预算已耗尽：最多 {budget.timeout_seconds} 秒。")
        started_at = time.monotonic()
        try:
            async with asyncio.timeout(remaining_seconds):
                async with self._subagent_global_semaphore:
                    await agent.prompt(message)
        except TimeoutError as error:
            budget_usage["exceededReason"] = (
                f"子智能体运行时间预算已耗尽：最多 {budget.timeout_seconds} 秒。"
            )
            raise RuntimeError(budget_usage["exceededReason"]) from error
        finally:
            budget_usage["elapsedMs"] = int(budget_usage["elapsedMs"]) + int(
                (time.monotonic() - started_at) * 1_000
            )
            await asyncio.to_thread(
                self.subagent_repository.save_checkpoint,
                thread.snapshot.root_session_id,
                thread.snapshot.id,
                self._subagent_checkpoint_payload(
                    thread,
                    agent,
                    skill_runtime,
                    role,
                    tool_policy,
                    budget,
                    budget_usage,
                    runtime_config,
                ),
            )
        if budget_usage.get("exceededReason"):
            raise RuntimeError(str(budget_usage["exceededReason"]))
        if agent.state.error_message:
            raise RuntimeError(agent.state.error_message)
        final_message = next(
            (
                item
                for item in reversed(agent.state.messages)
                if item.get("role") == "assistant"
                and not any(block.get("type") == "toolCall" for block in (item.get("content") or []))
            ),
            None,
        )
        content = "\n".join(
            str(block.get("text") or "")
            for block in (final_message or {}).get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        ).strip()
        if not content:
            raise RuntimeError("子智能体没有返回可用结果。")
        return AgentResult(
            content=content,
            summary=content[:240],
            details={
                "model": runtime_config.label,
                "messageCount": len(agent.state.messages),
                "loadedSkills": list(skill_runtime.active_skill_ids) if skill_runtime else [],
            },
        )

    async def _record_subagent_agent_event(
        self,
        thread: AgentThread,
        event: dict[str, Any],
        agent: Agent,
        skill_runtime: Any,
        role: SubagentDefinition,
        tool_policy: SubagentToolPolicy,
        budget: SubagentBudget,
        budget_usage: dict[str, Any],
        runtime_config: RuntimeModelConfig,
    ) -> None:
        event_type = str(event.get("type") or "")
        if event_type == "message_update":
            self._emit_subagent_activity(thread.snapshot.root_session_id, thread.snapshot.path, event)
            return
        durable_event = dict(event)
        if event_type == "agent_end":
            durable_event = {
                "type": "agent_end",
                "messageCount": len(agent.state.messages),
                "error": agent.state.error_message,
            }
        await asyncio.to_thread(
            self.subagent_repository.append_event,
            thread.snapshot.root_session_id,
            thread.snapshot.id,
            durable_event,
        )
        if event_type in {"message_end", "tool_execution_end", "agent_end"}:
            await asyncio.to_thread(
                self.subagent_repository.save_checkpoint,
                thread.snapshot.root_session_id,
                thread.snapshot.id,
                self._subagent_checkpoint_payload(
                    thread,
                    agent,
                    skill_runtime,
                    role,
                    tool_policy,
                    budget,
                    budget_usage,
                    runtime_config,
                ),
            )
        self._emit_subagent_activity(thread.snapshot.root_session_id, thread.snapshot.path, event)

    @staticmethod
    def _subagent_checkpoint_payload(
        thread: AgentThread,
        agent: Agent,
        skill_runtime: Any,
        role: SubagentDefinition,
        tool_policy: SubagentToolPolicy,
        budget: SubagentBudget,
        budget_usage: dict[str, Any],
        runtime_config: RuntimeModelConfig,
    ) -> dict[str, Any]:
        return {
            "agentPath": thread.snapshot.path,
            "role": role.name,
            "roleSource": role.source,
            "messages": list(agent.state.messages),
            "activeSkillIDs": list(skill_runtime.active_skill_ids),
            "model": {
                "label": runtime_config.label,
                "source": runtime_config.source,
                "id": runtime_config.model.get("id"),
                "provider": runtime_config.model.get("provider"),
            },
            "thinkingLevel": runtime_config.thinking_level,
            "toolPolicy": tool_policy.to_payload(),
            "budget": budget.to_payload(),
            "budgetUsage": dict(budget_usage),
        }

    def _emit_subagent_activity(self, session_id: str, agent_path: str, event: dict[str, Any]) -> None:
        event_type = str(event.get("type") or "")
        if event_type not in {"model_retry", "tool_execution_start", "tool_execution_end"}:
            return
        properties = {
            key: value
            for key, value in event.items()
            if key in {"toolCallId", "toolName", "args", "isError", "attempt", "maxAttempts", "delayMs", "reason"}
        }
        self.events.emit(
            {
                "type": "subagent.activity",
                "properties": {"sessionID": session_id, "agentPath": agent_path, "activityType": event_type, **properties},
            }
        )

    async def _run_character_main_agent(
        self,
        *,
        session_id: str,
        parts: list[dict[str, Any]],
        user_message: dict[str, Any],
        auth_token: str | None,
        runtime_config: RuntimeModelConfig,
        run_state: RunState,
        beat: DirectorBeat,
        scene: DirectorScene | None,
        execution: DirectorExecution | None,
        previous_replies: list[dict[str, Any]],
        environment: dict[str, Any] | None,
        skill_owner_key: str | None,
    ) -> tuple[dict[str, Any] | None, str]:
        files = prompt_files(parts)
        character = (runtime_config.core or {}).get("character") if runtime_config.core else None
        self.emit_runtime_thinking(
            session_id,
            run_state,
            f"{run_state.speaker.get('assistantName') or '当前角色'}正在理解请求并处理本轮任务。",
        )
        character_id = character.get("id") if isinstance(character, dict) else None
        current_character_action = self.store.get_character_action(session_id, character_id)
        if not current_character_action:
            current_character_action = _default_character_action_state(session_id, character)
            if current_character_action:
                self.store.set_character_action(session_id, current_character_action, record_history=False)
        recent_character_actions = (
            self.store.get_character_action_history(session_id, character_id)
            if character_id is not None
            else []
        )
        tool_context = MonToolContext(
            session_id=session_id,
            core_client=self.core_client,
            core_token=auth_token,
            permissions=self.permissions,
            questions=self.questions,
            screen_captures=self.screen_captures,
            current_model_supports_images=runtime_config.supports_images,
            vision_config=(runtime_config.core or {}).get("visionConfig") if runtime_config.core else None,
            environment=environment,
            character=character,
            current_character_action=current_character_action,
            emit_event=self.events.emit,
            set_character_action=lambda state: self.store.set_character_action(session_id, state),
            get_message_id=lambda: run_state.assistant_message_id,
            get_current_files=lambda: files,
            agent_path="/root",
            permission_mode=(
                self.permissions.mode_for_session(session_id)
                if self.permissions is not None
                else "restricted"
            ),
            subagent_role_names=self.subagent_catalog.names,
            subagent_role_descriptions=self.subagent_catalog.descriptions,
        )
        is_tool_owner = (
            execution is None
            or execution.tool_owner_assistant_id is None
            or str(beat.assistant_id) == str(execution.tool_owner_assistant_id)
        )
        collaboration_policy = None if is_tool_owner else SubagentToolPolicy.create("read-only")
        await self._ensure_subagent_control_restored(
            session_id=session_id,
            parent_runtime_config=runtime_config,
            auth_token=auth_token,
            environment=environment,
            skill_owner_key=skill_owner_key,
        )
        tool_context.subagent_dispatch = self._make_subagent_dispatcher(
            session_id=session_id,
            parent_path="/root",
            runtime_config=runtime_config,
            auth_token=auth_token,
            environment=environment,
            skill_owner_key=skill_owner_key,
            messages_provider=lambda: self.store.context_messages(session_id),
            parent_policy=collaboration_policy,
            parent_run_id=run_state.run_id,
        )
        skill_runtime = create_skill_runtime(
            self.workspace_root,
            tool_context,
            profile="user_chat",
            active_skill_ids=(),
            owner_key=skill_owner_key,
            tool_filter=(
                None
                if is_tool_owner
                else lambda tool: (
                    collaboration_policy is not None
                    and collaboration_policy.allows(tool.name)
                )
                or tool.name == "switch_character_action"
            ),
        )
        actor_user_text = content_text(parts)
        explicit_skill = skill_runtime.load_command(actor_user_text)
        if explicit_skill is not None:
            if explicit_skill["success"]:
                actor_user_text = explicit_skill["userMessage"] or actor_user_text
            else:
                actor_user_text = (
                    f"用户请求了未知技能：{', '.join(explicit_skill['unknown'])}。"
                    f"当前可用技能：{', '.join(explicit_skill['available'])}。"
                )
        tools = skill_runtime.active_tools()
        attachment_details = attachment_context(files, runtime_config.supports_images)
        if not runtime_config.supports_images:
            automatic_vision_context = await self._analyze_non_multimodal_images(
                session_id=session_id,
                message_id=user_message["info"]["id"],
                parts=parts,
                user_text=actor_user_text,
                auth_token=auth_token,
                runtime_config=runtime_config,
            )
            if automatic_vision_context:
                attachment_details = "\n\n".join(
                    filter(None, [attachment_details, automatic_vision_context])
                )
        task_prompt = actor_task_prompt(
            actor_user_text,
            beat,
            previous_replies,
            attachment_details,
            scene=scene,
            execution=execution,
        )

        def system_prompt_for(active_skill_ids: tuple[str, ...]) -> str:
            return build_agent_system_prompt(
                runtime_config.core,
                source="user_chat",
                current_character_action=(
                    self.store.get_character_action(session_id, character_id) or current_character_action
                ),
                recent_character_actions=(
                    self.store.get_character_action_history(session_id, character_id)
                    if character_id is not None
                    else recent_character_actions
                ),
                supports_images=runtime_config.supports_images,
                environment=environment,
                active_skill_ids=active_skill_ids,
                skill_resource_prompt=skill_runtime.prompt_section(),
                delegation_mode=runtime_config.delegation_policy.mode,
            )

        agent_messages = await self.compact_agent_messages_if_needed(
            session_id,
            run_state,
            runtime_config,
            self.store.context_messages(session_id),
            user_message["info"]["time"]["created"],
            auth_token,
        )

        async def prepare_root_next_turn(turn: dict[str, Any], _signal: Any) -> dict[str, Any] | None:
            skill_update = skill_runtime.prepare_next_turn(turn, system_prompt_for)
            current_context = (
                skill_update.get("context")
                if isinstance(skill_update, dict) and isinstance(skill_update.get("context"), dict)
                else turn.get("context")
            )
            if not isinstance(current_context, dict):
                return skill_update
            tool_results = turn.get("toolResults")
            if not isinstance(tool_results, list) or not tool_results:
                return skill_update
            current_messages = current_context.get("messages")
            if not isinstance(current_messages, list):
                return skill_update
            compacted_messages = await self.compact_agent_messages_if_needed(
                session_id,
                run_state,
                runtime_config,
                current_messages,
                user_message["info"]["time"]["created"],
                auth_token,
            )
            if compacted_messages is current_messages:
                return skill_update
            return {
                **(skill_update or {}),
                "context": {**current_context, "messages": compacted_messages},
            }

        agent = Agent(
            AgentOptions(
                session_id=session_id,
                tool_execution="sequential",
                convert_to_llm=convert_to_llm,
                stream_fn=stream_openai_compatible,
                initial_state={
                    "model": runtime_config.model,
                    "thinkingLevel": runtime_config.thinking_level,
                    "systemPrompt": system_prompt_for(skill_runtime.active_skill_ids),
                    "tools": tools,
                    "messages": agent_messages,
                },
                get_api_key=lambda _provider: runtime_config.api_key,
                before_tool_call=self._before_tool_call(
                    session_id,
                    run_state,
                    agent_path="/root",
                    delegation_mode=runtime_config.delegation_policy.mode,
                ),
                prepare_next_turn_with_context=prepare_root_next_turn,
            )
        )
        with self._lock:
            self._agents[session_id] = agent
            cancelled = session_id in self._cancelled_sessions
        if cancelled:
            agent.abort()
        agent.subscribe(lambda event, _signal: self.handle_agent_event(session_id, event, run_state))
        content: list[dict[str, Any]] = []
        if runtime_config.supports_images:
            content.extend(images_from_parts(parts))
        content.append({"type": "text", "text": task_prompt})
        self.store.append_session_event(
            session_id,
            "turn_started",
            {"speaker": run_state.speaker, "orchestration": run_state.orchestration},
            turn_id=run_state.run_id,
        )
        self.emit_runtime_thinking(session_id, run_state, "正在发送给 Python AgentCore，并等待模型回复。")
        try:
            async with asyncio.timeout(self.model_request_timeout_seconds):
                await agent.prompt({"role": "user", "timestamp": now_ms(), "content": content})
        except TimeoutError as error:
            model_label = runtime_config.label or str(runtime_config.model.get("id") or "unknown")
            logger.error(
                "主智能体模型请求超时: session={} model={} timeout={}s",
                session_id,
                model_label,
                self.model_request_timeout_seconds,
            )
            raise RuntimeError(
                f"模型请求超时：{model_label} 在 {self.model_request_timeout_seconds} 秒内没有完成响应。"
            ) from error
        self._raise_if_cancelled(session_id)
        if run_state.error_message:
            raise RuntimeError(run_state.error_message)
        self.emit_runtime_thinking(session_id, run_state, "回复生成完成。", done=True)
        self.store.append_session_event(
            session_id,
            "turn_completed",
            {"finalMessageID": run_state.final_assistant_message_id},
            turn_id=run_state.run_id,
        )
        message = next(
            (
                item for item in self.store.list_messages(session_id, limit=10_000, include_compactions=True)
                if item["info"]["id"] == run_state.final_assistant_message_id
            ),
            None,
        )
        if auth_token:
            visible_messages = self.store.list_messages(session_id, limit=10_000, include_compactions=True)
            for assistant_message_id in run_state.assistant_message_ids:
                persisted = next(
                    (item for item in visible_messages if item["info"]["id"] == assistant_message_id),
                    None,
                )
                if persisted:
                    await self.sync_core_message(session_id, persisted, auth_token, runtime_config.core)
        text = "\n".join(
            str(part.get("text") or "") for part in (message or {}).get("parts", []) if part.get("type") == "text"
        ).strip()
        return message, text

    def _start_character_main_run(
        self,
        session_id: str,
        user_message_id: str,
        assistant_name: str,
    ) -> str:
        orchestration_id = create_id("orc")
        created_at = now_ms()
        self.store.upsert_orchestrator_run(
            session_id,
            {
                "orchestrationID": orchestration_id,
                "userMessageID": user_message_id,
                "status": "running",
                "phase": f"{assistant_name}正在理解并处理请求",
                "summary": "",
                "source": "character_main",
                "createdAt": created_at,
                "updatedAt": created_at,
            },
        )
        self.store.append_session_event(
            session_id,
            "orchestrator_started",
            {"orchestrationID": orchestration_id, "userMessageID": user_message_id, "source": "character_main"},
            turn_id=orchestration_id,
        )
        self.events.emit(
            {
                "type": "orchestrator.started",
                "properties": {
                    "sessionID": session_id,
                    "orchestrationID": orchestration_id,
                    "userMessageID": user_message_id,
                    "phase": f"{assistant_name}正在理解并处理请求",
                    "source": "character_main",
                },
            }
        )
        return orchestration_id

    def _finish_character_main_run(
        self,
        session_id: str,
        orchestration_id: str,
        user_message_id: str,
        *,
        error: Exception | None = None,
    ) -> None:
        failed = error is not None
        summary = runtime_error_summary(error) if failed else "当前角色已完成本轮处理"
        status = "failed" if failed else "completed"
        phase = "处理失败" if failed else "已完成"
        self.store.upsert_orchestrator_run(
            session_id,
            {
                "orchestrationID": orchestration_id,
                "userMessageID": user_message_id,
                "status": status,
                "phase": phase,
                "summary": summary,
                "source": "character_main",
                "error": summary if failed else None,
                "updatedAt": now_ms(),
            },
        )
        event_suffix = "failed" if failed else "completed"
        payload = {
            "sessionID": session_id,
            "orchestrationID": orchestration_id,
            "userMessageID": user_message_id,
            "source": "character_main",
        }
        if failed:
            payload["error"] = summary
            event_payload: dict[str, Any] = {"error": summary}
        else:
            brief = {"summary": summary, "source": "character_main"}
            payload["brief"] = brief
            event_payload = brief
        self.store.append_session_event(
            session_id,
            f"orchestrator_{event_suffix}",
            event_payload,
            turn_id=orchestration_id,
        )
        self.events.emit({"type": f"orchestrator.{event_suffix}", "properties": payload})

    async def _run_prompt(
        self,
        session_id: str,
        parts: list[dict[str, Any]],
        auth_token: str | None,
        *,
        internal_batch_id: str | None = None,
        continuation_run_id: str | None = None,
    ) -> None:
        session = self.store.require_session(session_id)
        started = now_ms()
        active_run_state: RunState | None = None
        active_config: RuntimeModelConfig | None = None
        director_config: RuntimeModelConfig | None = None
        active_director_run: dict[str, Any] | None = None
        active_main_run_id: str | None = None
        participants: list[dict[str, Any]] = []
        self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "busy"}}})
        if internal_batch_id:
            user_message = self.store.append_internal_user_message(session_id, content_text(parts))
        else:
            user_message = self.store.append_user_message(session_id, content_text(parts), prompt_files(parts))
            self.emit_message(session_id, user_message["info"])
            for part in user_message["parts"]:
                self.emit_part(session_id, part)
            self.emit_session(session_id)
        try:
            self._raise_if_cancelled(session_id)
            participants = [item for item in session["info"].get("participants", []) if item.get("assistantID") is not None]
            primary_id = participants[0].get("assistantID") if participants else None
            director_config = await self._resolve_runtime_config(auth_token, primary_id)
            self._session_runtime_auth[session_id] = (auth_token, director_config.core)
            if not participants and director_config.core:
                participants = [self._participant_from_core(director_config.core)]
                self.store.update_participants(session_id, participants)
            if not participants:
                raise RuntimeError("当前会话没有可用的参与助手。")
            await self.sync_core_session(session_id, auth_token, director_config.core)
            await self.sync_core_message(session_id, user_message, auth_token, director_config.core)
            environment, skill_owner_key = await self._resolve_user_context(auth_token)
            active_main_run_id = self._start_character_main_run(
                session_id,
                user_message["info"]["id"],
                str(participants[0].get("assistantName") or "当前角色"),
            )
            director_enabled = len(participants) > 1
            if director_enabled:
                self.events.emit(
                    {
                        "type": "companion.director.started",
                        "properties": {
                            "sessionID": session_id,
                            "participantCount": len(participants),
                            "userMessageID": user_message["info"]["id"],
                        },
                    }
                )
            plan = await create_director_plan(
                user_text=content_text(parts),
                participants=participants,
                director_config=director_config,
                policy=session["info"].get("directorPolicy") or {},
                conversation_context=_director_conversation_context(
                    self.store.list_messages(session_id, limit=10_000),
                    user_message["info"]["id"],
                ),
                attachment_context=attachment_context(prompt_files(parts), director_config.supports_images),
            )
            if director_enabled:
                active_director_run = self.store.upsert_director_run(
                    session_id,
                    {
                        "planID": plan.plan_id,
                        "userMessageID": user_message["info"]["id"],
                        "source": plan.source,
                        "diagnostic": plan.diagnostic,
                        "scene": plan.scene.to_payload(),
                        "execution": plan.execution.to_payload(),
                        "beats": [beat.to_payload() for beat in plan.beats],
                        "status": "planned",
                        "activeBeatIndex": None,
                        "completedBeatIndexes": [],
                        "participantCount": len(participants),
                        "error": None,
                    },
                )
                await self.sync_core_director_run(
                    session_id,
                    active_director_run,
                    auth_token,
                    director_config.core,
                )
                self.events.emit(
                    {
                        "type": "companion.plan",
                        "properties": {
                            "sessionID": session_id,
                            "planID": plan.plan_id,
                            "userMessageID": user_message["info"]["id"],
                            "source": plan.source,
                            "diagnostic": plan.diagnostic,
                            "scene": plan.scene.to_payload(),
                            "execution": plan.execution.to_payload(),
                            "beats": [beat.to_payload() for beat in plan.beats],
                        },
                    }
                )
            previous_replies: list[dict[str, Any]] = []
            for beat_index, beat in enumerate(plan.beats):
                self._raise_if_cancelled(session_id)
                participant = next(
                    item for item in participants if str(item.get("assistantID")) == str(beat.assistant_id)
                )
                active_config = await self._resolve_runtime_config(auth_token, beat.assistant_id)
                speaker = {
                    **participant,
                    "turnIndex": beat_index,
                    "beatIndex": beat_index,
                }
                orchestration = (
                    {
                        "planID": plan.plan_id,
                        "directorSource": plan.source,
                        "directorDiagnostic": plan.diagnostic,
                        "scene": plan.scene.to_payload(),
                        "execution": plan.execution.to_payload(),
                        "beatIndex": beat_index,
                        "speechAct": beat.speech_act,
                        "addressTo": beat.address_to,
                        "replyToBeat": beat.reply_to_beat,
                        "intent": beat.intent,
                    }
                    if director_enabled
                    else {}
                )
                active_run_state = RunState(
                    speaker=speaker,
                    orchestration=orchestration,
                    run_id=continuation_run_id,
                )
                if director_enabled:
                    active_director_run = self.store.upsert_director_run(
                        session_id,
                        {
                            **(active_director_run or {}),
                            "planID": plan.plan_id,
                            "status": "running",
                            "activeBeatIndex": beat_index,
                        },
                    )
                    await self.sync_core_director_run(
                        session_id,
                        active_director_run,
                        auth_token,
                        director_config.core,
                    )
                    self.events.emit(
                        {
                            "type": "companion.speaker.started",
                            "properties": {
                                "sessionID": session_id,
                                "planID": plan.plan_id,
                                "beatIndex": beat_index,
                                "speaker": speaker,
                                "beat": beat.to_payload(),
                            },
                        }
                    )
                message, reply = await self._run_character_main_agent(
                    session_id=session_id,
                    parts=parts,
                    user_message=user_message,
                    auth_token=auth_token,
                    runtime_config=active_config,
                    run_state=active_run_state,
                    beat=beat,
                    scene=plan.scene if director_enabled else None,
                    execution=plan.execution if director_enabled else None,
                    previous_replies=previous_replies,
                    environment=environment,
                    skill_owner_key=skill_owner_key,
                )
                if message:
                    batch_id = internal_batch_id or self._open_coordination_batch_ids.get(session_id)
                    batch = (
                        self.subagent_repository.get_coordination_batch(session_id, batch_id)
                        if batch_id
                        else None
                    )
                    required_pending = bool(
                        batch
                        and batch.get("requiredTaskIDs")
                        and not set(batch.get("requiredTaskIDs") or [])
                        <= set(batch.get("terminalTaskIDs") or [])
                    )
                    completion_state = "provisional" if required_pending and not internal_batch_id else "final"
                    updated_message = self.store.upsert_message(
                        session_id,
                        {
                            **message["info"],
                            "completionState": completion_state,
                            "coordinationBatchID": batch_id,
                        },
                    )
                    self.emit_message(session_id, updated_message["info"])
                previous_replies.append(
                    {
                        "beatIndex": beat_index,
                        "assistantID": participant.get("assistantID"),
                        "assistantName": str(participant.get("assistantName") or "助手"),
                        "reply": reply,
                        "speechAct": beat.speech_act,
                    }
                )
                if director_enabled:
                    completed_beat_indexes = sorted(
                        set([*(active_director_run or {}).get("completedBeatIndexes", []), beat_index])
                    )
                    active_director_run = self.store.upsert_director_run(
                        session_id,
                        {
                            **(active_director_run or {}),
                            "planID": plan.plan_id,
                            "status": "completed" if len(completed_beat_indexes) >= len(plan.beats) else "running",
                            "activeBeatIndex": None,
                            "completedBeatIndexes": completed_beat_indexes,
                        },
                    )
                    await self.sync_core_director_run(
                        session_id,
                        active_director_run,
                        auth_token,
                        director_config.core,
                    )
                    self.events.emit(
                        {
                            "type": "companion.speaker.finished",
                            "properties": {
                                "sessionID": session_id,
                                "planID": plan.plan_id,
                                "beatIndex": beat_index,
                                "speaker": speaker,
                            },
                        }
                    )
            if active_main_run_id:
                completed_main_run_id = active_main_run_id
                active_main_run_id = None
                self._finish_character_main_run(
                    session_id,
                    completed_main_run_id,
                    user_message["info"]["id"],
                )
            await self.sync_core_session(session_id, auth_token, director_config.core)
            self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "idle"}}})
            self.emit_session(session_id)
            logger.info(f"session {session_id} companion turn completed in {now_ms() - started}ms")
        except TurnAborted:
            if active_run_state is not None:
                self.emit_runtime_thinking(session_id, active_run_state, "当前回合已停止。", done=True)
                self.store.append_session_event(
                    session_id,
                    "turn_aborted",
                    {"reason": "user_requested"},
                    turn_id=active_run_state.run_id,
                )
            if active_director_run:
                self.store.upsert_director_run(
                    session_id,
                    {**active_director_run, "status": "aborted", "activeBeatIndex": None, "error": None},
                )
            self.events.emit(
                {"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "idle"}}}
            )
            self.emit_session(session_id)
            logger.info(f"session {session_id} turn aborted by user")
        except Exception as error:
            logger.error(f"session {session_id} 运行失败: {error}", exc_info=True)
            if active_main_run_id:
                failed_main_run_id = active_main_run_id
                active_main_run_id = None
                self._finish_character_main_run(
                    session_id,
                    failed_main_run_id,
                    user_message["info"]["id"],
                    error=error,
                )
            if active_director_run:
                active_director_run = self.store.upsert_director_run(
                    session_id,
                    {
                        **active_director_run,
                        "status": "failed",
                        "activeBeatIndex": None,
                        "error": runtime_error_summary(error),
                    },
                )
                if auth_token and director_config:
                    try:
                        await self.sync_core_director_run(
                            session_id,
                            active_director_run,
                            auth_token,
                            director_config.core,
                        )
                    except Exception:
                        logger.exception("导演运行失败状态持久化到 Core 失败")
                self.emit_session(session_id)
            if active_run_state is None:
                active_run_state = RunState(speaker=participants[0] if participants else {})
            if active_run_state:
                self.store.append_session_event(
                    session_id,
                    "turn_failed",
                    {"error": runtime_error_summary(error)},
                    turn_id=active_run_state.run_id,
                )
                self.emit_runtime_thinking(session_id, active_run_state, runtime_error_summary(error), done=True)
                self.finish_runtime_message(session_id, active_run_state, error=error)
                if auth_token and active_config and active_run_state.final_assistant_message_id:
                    message = next(
                        (
                            item for item in self.store.list_messages(session_id, limit=10_000, include_compactions=True)
                            if item["info"]["id"] == active_run_state.final_assistant_message_id
                        ),
                        None,
                    )
                    if message:
                        try:
                            await self.sync_core_message(session_id, message, auth_token, active_config.core)
                        except Exception:
                            logger.exception("多人会话失败消息持久化到 Core 失败")
            self.emit_session_error(session_id, error)
            if internal_batch_id:
                raise

    async def compact_agent_messages_if_needed(
        self,
        session_id: str,
        run_state: RunState,
        runtime_config: RuntimeModelConfig,
        messages: list[dict[str, Any]],
        current_user_created_at: int,
        auth_token: str | None,
        *,
        force: bool = False,
        custom_instructions: str | None = None,
    ) -> list[dict[str, Any]]:
        settings = runtime_compaction_settings()
        if not messages:
            if force:
                raise RuntimeError("当前会话没有可压缩的上下文。")
            return messages
        if force:
            last_user_index = next(
                (index for index in range(len(messages) - 1, -1, -1) if messages[index].get("role") == "user"),
                len(messages) - 1,
            )
            recent_turn_tokens = int(estimate_context_tokens(messages[last_user_index:]).get("tokens") or 1)
            configured_keep_recent = int(
                settings.get("keepRecentTokens") or _MANUAL_COMPACTION_KEEP_RECENT_TOKENS
            )
            settings = {
                **settings,
                "enabled": True,
                "keepRecentTokens": min(
                    configured_keep_recent,
                    _MANUAL_COMPACTION_KEEP_RECENT_TOKENS,
                    max(1, recent_turn_tokens),
                ),
            }
        if not force and not settings.get("enabled", True):
            return messages
        estimate = estimate_context_tokens(messages)
        context_tokens = int(estimate.get("tokens") or 0)
        context_window = runtime_context_window(runtime_config.model)
        if not force and not should_compact(context_tokens, context_window, settings):
            return messages
        if not runtime_config.api_key:
            if force:
                raise RuntimeError("当前模型缺少 API Key，无法生成压缩摘要。")
            logger.warning("上下文达到压缩阈值，但当前模型缺少 API Key，跳过压缩。")
            return messages

        self.emit_runtime_thinking(
            session_id,
            run_state,
            (
                f"正在按用户要求压缩上下文；当前约 {context_tokens} tokens。"
                if force
                else f"上下文约 {context_tokens} tokens，超过压缩阈值，正在压缩旧对话。"
            ),
        )
        entries = messages_to_compaction_entries(messages)
        preparation = prepare_compaction(entries, settings)
        if not preparation.ok:
            if force:
                raise RuntimeError(f"上下文压缩准备失败：{preparation.error}")
            logger.warning(f"上下文压缩准备失败: {preparation.error}")
            return messages
        if not preparation.value:
            if force:
                raise NoCompactionNeeded("当前会话刚完成压缩，没有新增内容可继续压缩。")
            return messages
        if force and not (
            preparation.value.get("messagesToSummarize")
            or preparation.value.get("turnPrefixMessages")
            or preparation.value.get("previousSummary")
        ):
            raise NoCompactionNeeded("当前上下文仍在保留范围内，无需压缩。")

        result = await compact_context(
            preparation.value,
            RuntimeCompactionModels(runtime_config.api_key),
            runtime_config.model,
            custom_instructions,
            None,
            runtime_config.thinking_level,
        )
        if not result.ok or not result.value:
            if force:
                raise RuntimeError(f"上下文压缩失败：{result.error}")
            logger.warning(f"上下文压缩失败: {result.error}")
            return messages

        compaction = result.value
        compaction_entry = {
            "type": "compaction",
            "id": f"runtime_{len(entries):06d}_compaction",
            "parentId": entries[-1]["id"] if entries else None,
            "timestamp": timestamp_iso(current_user_created_at - 1),
            "summary": compaction.get("summary") or "",
            "tokensBefore": int(compaction.get("tokensBefore") or context_tokens),
            "firstKeptEntryId": compaction.get("firstKeptEntryId"),
            "details": compaction.get("details"),
        }
        compacted_messages = build_session_context([*entries, compaction_entry])["messages"]
        # Provider usage describes the request before compaction. Keeping it on
        # retained messages makes estimate_context_tokens report the stale,
        # pre-compaction size and can immediately trigger another compaction.
        for compacted_message in compacted_messages:
            compacted_message.pop("usage", None)
        tokens_after = int(estimate_context_tokens(compacted_messages).get("tokens") or 0)
        self.store.replace_context_messages(session_id, compacted_messages)
        hidden_message = self.store.append_compaction_message(
            session_id,
            summary=compaction_entry["summary"],
            tokens_before=compaction_entry["tokensBefore"],
            tokens_after=tokens_after,
            first_kept_entry_id=compaction_entry.get("firstKeptEntryId"),
            details=compaction_entry.get("details"),
            created_at=max(0, current_user_created_at - 1),
            automatic=not force,
            overflow=not force,
        )
        self.emit_message(session_id, hidden_message["info"])
        for part in hidden_message["parts"]:
            self.emit_part(session_id, part)
        await self.sync_core_message(session_id, hidden_message, auth_token, runtime_config.core)
        self.emit_runtime_thinking(
            session_id,
            run_state,
            (
                f"主动压缩摘要已写入：保留最近约 {settings.get('keepRecentTokens')} tokens。"
                if force
                else f"上下文压缩完成：保留最近约 {settings.get('keepRecentTokens')} tokens，并写入压缩摘要。"
            ),
        )
        logger.info(
            "session {} compacted context: before={} after={} kept={}",
            session_id,
            context_tokens,
            tokens_after,
            compaction_entry.get("firstKeptEntryId"),
        )
        return compacted_messages

    def _before_tool_call(
        self,
        session_id: str,
        run_state: RunState,
        *,
        agent_path: str = "/root",
        tool_policy: SubagentToolPolicy | None = None,
        delegation_mode: str = "disabled",
    ):
        async def before_tool_call(context: dict[str, Any], _signal: Any = None) -> dict[str, Any] | None:
            if getattr(_signal, "aborted", False):
                return {"block": True, "reason": "会话已取消。"}
            tool_call = context.get("toolCall") or {}
            tool_name = tool_call.get("name") or ""
            args = context.get("args") or {}
            if tool_policy is not None and not tool_policy.allows(tool_name):
                return {
                    "block": True,
                    "reason": (
                        f"工具 {tool_name} 被子智能体 {agent_path} 的 "
                        f"{tool_policy.sandbox_mode} 策略禁止。"
                    ),
                }
            pattern = self.permission_pattern(tool_name, args)
            permission_mode = self.permissions.mode_for_session(session_id)
            if (
                self.is_safe_tool(tool_name)
                or self.permissions.is_always_allowed(tool_name, pattern, session_id)
                or (permission_mode == "full_access" and tool_name != "bash")
            ):
                return None
            reply = await asyncio.to_thread(
                self.permissions.ask,
                {
                    "sessionID": session_id,
                    "permission": tool_name,
                    "patterns": [pattern],
                    "always": self.permission_always_patterns(tool_name),
                    "metadata": {"args": args, "toolName": tool_name, "agentPath": agent_path},
                    "tool": {
                        "messageID": run_state.assistant_message_id,
                        "callID": tool_call.get("id"),
                    }
                    if run_state.assistant_message_id
                    else None,
                },
            )
            if reply == "reject":
                return {"block": True, "reason": "用户拒绝执行工具。"}
            return None

        return before_tool_call

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
