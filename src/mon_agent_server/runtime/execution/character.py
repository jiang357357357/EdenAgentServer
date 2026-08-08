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
    AssistantMessageEventStream,
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
from mon_agent_server.core.serializers import session_from_map
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
from mon_agent_server.runtime.character_memory import recall_character_memories
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


class RuntimeCharacterMixin:
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
        handoff_from: dict[str, Any] | None = None,
        runtime_profile: str = "user_chat",
        active_skill_ids: tuple[str, ...] = (),
    ) -> tuple[dict[str, Any] | None, str, dict[str, Any] | None]:
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
        continuation = {
            "config": runtime_config,
            "relevantMemories": [],
            "handoffFrom": dict(handoff_from) if handoff_from else None,
            "handoff": None,
        }
        def append_assistant_part(payload: dict[str, Any]) -> dict[str, Any]:
            message_id = run_state.assistant_message_id
            if not message_id:
                raise RuntimeError("当前助手消息尚未建立，无法追加消息内容。")
            part = {
                "id": create_id(str(payload.get("type") or "part")),
                "messageID": message_id,
                "sessionID": session_id,
                **payload,
            }
            self.emit_part(session_id, part)
            return part

        async def switch_session_assistant(assistant_id: int | str) -> dict[str, Any]:
            if not auth_token:
                raise RuntimeError("切换会话助手需要有效的 Core 登录态。")
            next_config = await self._resolve_runtime_config(auth_token, assistant_id)
            assistant = (next_config.core or {}).get("assistant") if next_config.core else {}
            if assistant.get("id") is None:
                raise ValueError(f"助手 {assistant_id} 不存在或当前用户无权访问。")
            participant = self._participant_from_core(
                {
                    "assistant": assistant,
                    "character": assistant.get("character") if isinstance(assistant.get("character"), dict) else {},
                }
            )
            continuation["handoff"] = {
                "config": next_config,
                "participant": participant,
                "from": dict(run_state.speaker),
                "assistant": assistant,
            }
            return {
                "assistant": assistant,
                "historyPreserved": True,
                "effectiveFrom": "next_root_run",
            }

        def create_skill(payload: dict[str, Any]) -> dict[str, Any]:
            if not auth_token or self.skill_installer is None:
                raise RuntimeError("创建技能需要有效登录态和技能安装服务。")
            profile = self.core_client.get_user_profile(auth_token)
            owner_id = profile.get("id")
            if owner_id in (None, ""):
                raise RuntimeError("Core 用户资料缺少 id。")
            return self.skill_installer.create_generated(owner_id, auth_token, "local", payload)

        def list_skills(payload: dict[str, Any]) -> list[dict[str, Any]]:
            if not auth_token or self.skill_installer is None:
                raise RuntimeError("查看技能需要有效登录态和技能安装服务。")
            profile = self.core_client.get_user_profile(auth_token)
            owner_id = profile.get("id")
            if owner_id in (None, ""):
                raise RuntimeError("Core 用户资料缺少 id。")
            return self.skill_installer.list_for_model(owner_id, auth_token, "local", payload)

        tool_context = MonToolContext(
            session_id=session_id,
            core_client=self.core_client,
            core_token=auth_token,
            connector_manager=self.connector_manager,
            permissions=self.permissions,
            questions=self.questions,
            screen_captures=self.screen_captures,
            camera_captures=self.camera_captures,
            current_model_supports_images=runtime_config.supports_images,
            vision_ai_entity=(runtime_config.core or {}).get("visionAIEntity") if runtime_config.core else None,
            environment=environment,
            character=character,
            assistant=(runtime_config.core or {}).get("assistant") if runtime_config.core else None,
            current_character_action=current_character_action,
            emit_event=self.events.emit,
            set_character_action=lambda state: self.store.set_character_action(session_id, state),
            get_message_id=lambda: run_state.assistant_message_id,
            get_current_files=lambda: files,
            append_assistant_part=append_assistant_part,
            switch_session_assistant=switch_session_assistant,
            list_skills=list_skills,
            create_skill=create_skill,
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
            profile=runtime_profile,
            active_skill_ids=active_skill_ids,
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
        relevant_memories: list[dict[str, Any]] = []
        if auth_token and actor_user_text.strip():
            try:
                relevant_memories = await asyncio.to_thread(
                    recall_character_memories,
                    self.core_client,
                    auth_token,
                    runtime_config.core,
                    actor_user_text,
                )
                continuation["relevantMemories"] = relevant_memories
            except Exception:
                logger.exception("长期记忆召回失败，当前回合将不注入记忆: session={}", session_id)
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
        if handoff_from:
            task_prompt = (
                "<assistant_handoff>\n"
                "这是系统内部交接指令，不是用户的新消息。你已接管当前会话；"
                "请基于历史中最近一条用户消息直接回应，不要声称用户重复了请求。\n"
                "</assistant_handoff>"
            )

        def system_prompt_for(active_skill_ids: tuple[str, ...]) -> str:
            active_config = continuation["config"]
            active_core = active_config.core
            active_character = (active_core or {}).get("character") if active_core else None
            active_character_id = active_character.get("id") if isinstance(active_character, dict) else None
            prompt = build_agent_system_prompt(
                active_core,
                source="self_awake" if runtime_profile == "self_awake" else "user_chat",
                current_character_action=self.store.get_character_action(session_id, active_character_id),
                recent_character_actions=(
                    self.store.get_character_action_history(session_id, active_character_id)
                    if active_character_id is not None
                    else []
                ),
                supports_images=active_config.supports_images,
                environment=environment,
                active_skill_ids=active_skill_ids,
                skill_resource_prompt=skill_runtime.prompt_section(),
                delegation_mode=active_config.delegation_policy.mode,
                relevant_memories=continuation["relevantMemories"],
            )
            previous_speaker = continuation.get("handoffFrom")
            if isinstance(previous_speaker, dict):
                prompt += (
                    "\n\n## 会话接管\n\n"
                    "会话已切换给你。请以自己的身份直接完成用户当前请求，"
                    "不要替原助手告别或转交。"
                )
            return prompt

        existing_context_messages = self.store.context_messages(session_id)
        user_created_at = user_message["info"]["time"]["created"]
        user_already_persisted = any(
            message.get("role") == "user" and message.get("timestamp") == user_created_at
            for message in existing_context_messages
        )
        if not user_already_persisted:
            canonical_user_content: list[dict[str, Any]] = []
            if runtime_config.supports_images:
                canonical_user_content.extend(images_from_parts(parts))
            canonical_user_content.append({"type": "text", "text": content_text(parts)})
            run_state.context_user_message = {
                "role": "user",
                "timestamp": user_created_at,
                "content": canonical_user_content,
            }

        agent_messages = await self.compact_agent_messages_if_needed(
            session_id,
            run_state,
            runtime_config,
            existing_context_messages,
            user_created_at,
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
            # 时间是易变的运行时事实。每次工具循环继续请求模型前都重建提示词，
            # 同时覆盖技能加载或上下文压缩后携带的旧时间。
            current_context = {
                **current_context,
                "systemPrompt": system_prompt_for(skill_runtime.active_skill_ids),
                "tools": skill_runtime.active_tools(),
                "activeSpeaker": run_state.speaker,
            }
            active_config = continuation["config"]
            skill_update = {
                **(skill_update or {}),
                "context": current_context,
                "model": active_config.model,
                "thinkingLevel": active_config.thinking_level,
            }
            tool_results = turn.get("toolResults")
            if not isinstance(tool_results, list) or not tool_results:
                return skill_update
            if any(
                isinstance(result, dict) and result.get("toolName") == "load_skill"
                for result in tool_results
            ):
                # Rebuild from the authoritative skill runtime even when a host
                # wrapper consumed the revision marker before this callback.
                # This guarantees newly loaded capabilities are available to
                # the very next model request in the same agent run.
                current_context = {
                    **current_context,
                    "systemPrompt": system_prompt_for(skill_runtime.active_skill_ids),
                    "tools": skill_runtime.active_tools(),
                }
                skill_update = {
                    **(skill_update or {}),
                    "context": current_context,
                }
            current_messages = current_context.get("messages")
            if not isinstance(current_messages, list):
                return skill_update
            compacted_messages = await self.compact_agent_messages_if_needed(
                session_id,
                run_state,
                continuation["config"],
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
                    "activeSpeaker": run_state.speaker,
                },
                get_api_key=lambda _provider: continuation["config"].api_key,
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

        model_label = runtime_config.label or str(runtime_config.model.get("id") or "unknown")

        async def stream_with_request_timeout(
            model: dict[str, Any], context: dict[str, Any], options: dict[str, Any]
        ) -> AssistantMessageEventStream:
            target = AssistantMessageEventStream()

            async def relay() -> None:
                try:
                    async with asyncio.timeout(self.model_request_timeout_seconds):
                        source = await stream_openai_compatible(model, context, options)
                        async for event in source:
                            target.push(event)
                except TimeoutError:
                    logger.error(
                        "主智能体单次模型请求超时: session={} model={} timeout={}s",
                        session_id,
                        model_label,
                        self.model_request_timeout_seconds,
                    )
                    target.push(
                        {
                            "type": "error",
                            "error": {
                                "role": "assistant",
                                "content": [{"type": "text", "text": ""}],
                                "api": model.get("api", "openai-completions"),
                                "provider": model.get("provider", "unknown"),
                                "model": model.get("id", "unknown"),
                                "stopReason": "error",
                                "errorMessage": (
                                    f"模型请求超时：{model_label} 的单次请求在 "
                                    f"{self.model_request_timeout_seconds} 秒内没有完成响应。"
                                ),
                                "timestamp": now_ms(),
                            },
                        }
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    target.push(
                        {
                            "type": "error",
                            "error": {
                                "role": "assistant",
                                "content": [{"type": "text", "text": ""}],
                                "api": model.get("api", "openai-completions"),
                                "provider": model.get("provider", "unknown"),
                                "model": model.get("id", "unknown"),
                                "stopReason": "error",
                                "errorMessage": str(error),
                                "timestamp": now_ms(),
                            },
                        }
                    )

            target.attach_producer(asyncio.create_task(relay()))
            return target

        agent.stream_fn = stream_with_request_timeout
        try:
            async with asyncio.timeout(self.turn_timeout_seconds):
                await agent.prompt({"role": "user", "timestamp": now_ms(), "content": content})
        except TimeoutError as error:
            agent.abort()
            logger.error(
                "主智能体整轮任务超时: session={} model={} timeout={}s",
                session_id,
                model_label,
                self.turn_timeout_seconds,
            )
            raise RuntimeError(
                f"整轮任务超时：{model_label} 在 {self.turn_timeout_seconds} 秒内没有完成任务。"
            ) from error
        except BaseException:
            agent.abort()
            raise
        self._raise_if_cancelled(session_id)
        if run_state.error_message:
            raise RuntimeError(run_state.error_message)
        handoff = continuation.get("handoff")
        self.emit_runtime_thinking(
            session_id,
            run_state,
            "助手交接完成。" if handoff else "回复生成完成。",
            done=True,
        )
        self.store.append_session_event(
            session_id,
            "turn_completed",
            {
                "finalMessageID": run_state.final_assistant_message_id,
                "handoffAssistantID": (
                    handoff["participant"].get("assistantID")
                    if isinstance(handoff, dict) and isinstance(handoff.get("participant"), dict)
                    else None
                ),
            },
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
                    await self.sync_core_message(
                        session_id,
                        persisted,
                        auth_token,
                        runtime_config.core,
                    )
            if isinstance(handoff, dict):
                participant = handoff["participant"]
                assistant = handoff["assistant"]
                session_info = self.store.update_participants(session_id, [participant])
                mapped = await asyncio.to_thread(
                    self.core_client.update_agent_session_participants,
                    auth_token,
                    session_info,
                    [assistant["id"]],
                )
                info = self.store.upsert_session_info(session_from_map(mapped))
                handoff["session"] = info
                self.events.emit(
                    {
                        "type": "session.updated",
                        "properties": {"sessionID": session_id, "info": info},
                    }
                )
        text = "\n".join(
            str(part.get("text") or "") for part in (message or {}).get("parts", []) if part.get("type") == "text"
        ).strip()
        return message, text, handoff if isinstance(handoff, dict) else None

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
