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


class RuntimeCoordinationMixin:
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
                camera_captures=self.camera_captures,
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
                    environment=environment,
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
                    prepare_next_turn_with_context=lambda turn, _signal: {
                        **(skill_runtime.prepare_next_turn(turn, system_prompt_for) or {}),
                        "context": {
                            **turn["context"],
                            "systemPrompt": system_prompt_for(skill_runtime.active_skill_ids),
                            "tools": [
                                tool
                                for tool in skill_runtime.active_tools()
                                if tool.name not in blocked_tools
                            ],
                        },
                    },
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
