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
from mon_agent_server.memory import extract_turn_memories
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


class RuntimePromptMixin:
    async def _run_prompt(
        self,
        session_id: str,
        parts: list[dict[str, Any]],
        auth_token: str | None,
        *,
        internal_batch_id: str | None = None,
        continuation_run_id: str | None = None,
        active_assistant_id: int | str | None = None,
        runtime_profile: str = "user_chat",
        active_skill_ids: tuple[str, ...] = (),
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
            user_message = self.store.append_internal_user_message(
                session_id,
                content_text(parts),
                persist_context=runtime_profile != "self_awake",
            )
        else:
            user_message = self.store.append_user_message(session_id, content_text(parts), prompt_files(parts))
            self.emit_message(session_id, user_message["info"])
            for part in user_message["parts"]:
                self.emit_part(session_id, part)
            self.emit_session(session_id)
        try:
            self._raise_if_cancelled(session_id)
            participants = [item for item in session["info"].get("participants", []) if item.get("assistantID") is not None]
            if active_assistant_id not in (None, ""):
                participants = [
                    item for item in participants
                    if str(item.get("assistantID")) == str(active_assistant_id)
                ]
            primary_id = participants[0].get("assistantID") if participants else None
            director_config = await self._resolve_runtime_config(auth_token, primary_id)
            self._session_runtime_auth[session_id] = (auth_token, director_config.core)
            if not participants and director_config.core:
                participants = [self._participant_from_core(director_config.core)]
                self.store.update_participants(session_id, participants)
            if not participants:
                raise RuntimeError("当前会话没有可用的参与助手。")
            await self.sync_core_session(session_id, auth_token, director_config.core)
            if runtime_profile != "self_awake":
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
                current_beat = beat
                handoff_from: dict[str, Any] | None = None
                first_run = True
                while True:
                    active_run_state = RunState(
                        speaker=speaker,
                        orchestration=orchestration,
                        run_id=continuation_run_id if first_run else None,
                    )
                    first_run = False
                    message, reply, handoff = await self._run_character_main_agent(
                        session_id=session_id,
                        parts=parts,
                        user_message=user_message,
                        auth_token=auth_token,
                        runtime_config=active_config,
                        run_state=active_run_state,
                        beat=current_beat,
                        scene=plan.scene if director_enabled else None,
                        execution=plan.execution if director_enabled else None,
                        previous_replies=previous_replies,
                        environment=environment,
                        skill_owner_key=skill_owner_key,
                        handoff_from=handoff_from,
                        runtime_profile=runtime_profile,
                        active_skill_ids=active_skill_ids,
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
                    if not handoff:
                        break
                    handoff_from = handoff["from"]
                    participant = handoff["participant"]
                    active_config = handoff["config"]
                    speaker = {
                        **participant,
                        "turnIndex": beat_index,
                        "beatIndex": beat_index,
                    }
                    current_beat = DirectorBeat(
                        participant["assistantID"],
                        beat.intent,
                        beat.speech_act,
                        beat.address_to,
                        beat.reply_to_beat,
                    )
                previous_replies.append(
                    {
                        "beatIndex": beat_index,
                        "assistantID": participant.get("assistantID"),
                        "assistantName": str(participant.get("assistantName") or "助手"),
                        "reply": reply,
                        "speechAct": current_beat.speech_act,
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
            if auth_token and active_config and previous_replies:
                extraction_reply = "\n\n".join(
                    str(item.get("reply") or "") for item in previous_replies if str(item.get("reply") or "").strip()
                )
                if extraction_reply:
                    asyncio.create_task(
                        extract_turn_memories(
                            core_client=self.core_client,
                            core_token=auth_token,
                            runtime_config=active_config,
                            session_id=session_id,
                            user_message_id=user_message["info"]["id"],
                            user_text=content_text(parts),
                            assistant_text=extraction_reply,
                            assistant_id=(active_config.core or {}).get("assistant", {}).get("id") if active_config.core else None,
                            agent_character_id=(active_config.core or {}).get("character", {}).get("id") if active_config.core else None,
                        ),
                        name=f"memory-extract:{session_id}:{user_message['info']['id']}",
                    )
            self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "idle"}}})
            self.emit_session(session_id)
            logger.info(f"session {session_id} companion turn completed in {now_ms() - started}ms")
        except TurnAborted:
            if active_run_state is not None:
                self.fail_unfinished_tool_calls(
                    session_id, active_run_state, "当前回合已由用户停止。", aborted=True
                )
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
                self.fail_unfinished_tool_calls(session_id, active_run_state, error)
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
            permission_request = context.get("permissionRequest")
            if not isinstance(permission_request, dict):
                return None
            permission_name = str(permission_request.get("permission") or tool_name)
            patterns = [str(item) for item in permission_request.get("patterns") or [tool_name]]
            pattern = patterns[0]
            if self.permissions is None:
                return {
                    "block": True,
                    "reason": "当前运行时没有可用的权限代理，已阻止需要授权的工具。",
                }
            permission_mode = self.permissions.mode_for_session(session_id)
            if (
                self.permissions.is_always_allowed(permission_name, pattern, session_id)
                or (permission_mode == "full_access" and tool_name != "bash")
            ):
                return None
            reply = await asyncio.to_thread(
                self.permissions.ask,
                {
                    "sessionID": session_id,
                    "permission": permission_name,
                    "patterns": patterns,
                    "always": [str(item) for item in permission_request.get("always") or []],
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
