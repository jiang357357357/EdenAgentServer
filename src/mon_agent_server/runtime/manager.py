from __future__ import annotations

import asyncio
import base64
import threading
from pathlib import Path
from typing import Any

from mon_agent_core import Agent, AgentOptions
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
from ..prompts import attachment_context, build_agent_system_prompt, build_user_chat_task_prompt
from ..skills import create_skill_runtime
from ..store import SessionStore
from ..tools import MonToolContext
from .compaction import RuntimeCompactionModels, messages_to_compaction_entries, runtime_compaction_settings, timestamp_iso
from .config import RuntimeModelConfig, runtime_context_window
from .emitters import RuntimeEmitterMixin, runtime_error_summary
from .messages import content_text, images_from_parts, prompt_files
from .permissions import RuntimePermissionMixin
from .state import RunState

logger = get_logger("MonAgent", "Runtime")
_CORE_SYNC_RETRY_DELAYS = (0.15, 0.5, 1.5)
_MANUAL_COMPACTION_KEEP_RECENT_TOKENS = 8_000


def _as_dict_list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


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
        self._running: dict[str, threading.Thread] = {}
        self._lock = threading.Lock()

    def is_running(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._running

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
                raise RuntimeError("Session is already running")
            thread = threading.Thread(target=self._thread_main, args=(session_id, parts, auth_token), daemon=True)
            self._running[session_id] = thread
            thread.start()

    def compact_async(self, session_id: str, custom_instructions: str | None, auth_token: str | None) -> None:
        instructions = str(custom_instructions or "").strip()
        if len(instructions) > 2_000:
            raise RuntimeError("压缩要求不能超过 2000 个字符。")
        session = self.store.require_session(session_id)
        if not session.get("agentMessages"):
            raise RuntimeError("当前会话没有可压缩的上下文。")
        with self._lock:
            if session_id in self._running:
                raise RuntimeError("Session is already running")
            thread = threading.Thread(
                target=self._compact_thread_main,
                args=(session_id, instructions or None, auth_token),
                daemon=True,
            )
            self._running[session_id] = thread
            thread.start()

    def _thread_main(self, session_id: str, parts: list[dict[str, Any]], auth_token: str | None) -> None:
        try:
            asyncio.run(self._run_prompt(session_id, parts, auth_token))
        except Exception as error:
            self.emit_session_error(session_id, error)
        finally:
            with self._lock:
                self._running.pop(session_id, None)

    def _compact_thread_main(self, session_id: str, custom_instructions: str | None, auth_token: str | None) -> None:
        try:
            asyncio.run(self._run_manual_compaction(session_id, custom_instructions, auth_token))
        except Exception as error:
            self.emit_session_error(session_id, error)
        finally:
            with self._lock:
                self._running.pop(session_id, None)

    async def _resolve_runtime_config(self, auth_token: str | None) -> RuntimeModelConfig:
        if auth_token:
            core = await asyncio.to_thread(self.core_client.resolve_runtime_config, auth_token)
            if core:
                model, api_key, label, source = core_model(core)
                return RuntimeModelConfig(model, api_key, label, source, core)
        model, api_key, label, source = env_model()
        return RuntimeModelConfig(model, api_key, label, source, None)

    async def _run_manual_compaction(
        self,
        session_id: str,
        custom_instructions: str | None,
        auth_token: str | None,
    ) -> None:
        started = now_ms()
        run_state = RunState()
        self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "busy"}}})
        self.emit_runtime_thinking(session_id, run_state, "正在读取当前模型配置并准备主动压缩上下文。")
        try:
            runtime_config = await self._resolve_runtime_config(auth_token)
            await self.sync_core_session(session_id, auth_token, runtime_config.core)
            session = self.store.require_session(session_id)
            messages = list(session.get("agentMessages") or [])
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
        except Exception as error:
            logger.error(f"session {session_id} 主动压缩失败: {error}", exc_info=True)
            self.emit_runtime_thinking(session_id, run_state, runtime_error_summary(error), done=True)
            self.finish_runtime_message(session_id, run_state, error=error)
            self.emit_session_error(session_id, error)

    async def _resolve_environment(self, auth_token: str | None) -> dict[str, Any] | None:
        if not auth_token:
            return self.environment
        try:
            profile = await asyncio.to_thread(self.core_client.get_user_profile, auth_token)
            configured = profile.get("environment") if isinstance(profile.get("environment"), dict) else {}
            from ..config import merge_environment_context

            return merge_environment_context(self.environment or {}, configured)
        except Exception as error:
            logger.warning(f"读取 Core 用户偏好环境配置失败，使用本地默认值: {error}")
            return self.environment

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

    async def _run_prompt(self, session_id: str, parts: list[dict[str, Any]], auth_token: str | None) -> None:
        session = self.store.require_session(session_id)
        started = now_ms()
        run_state = RunState()
        self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "busy"}}})
        user_message = self.store.append_user_message(session_id, content_text(parts), prompt_files(parts))
        self.emit_message(session_id, user_message["info"])
        for part in user_message["parts"]:
            self.emit_part(session_id, part)
        self.emit_session(session_id)
        self.emit_runtime_thinking(session_id, run_state, "正在读取 Core 当前助手、角色与模型配置。")
        runtime_config: RuntimeModelConfig | None = None

        try:
            runtime_config = await self._resolve_runtime_config(auth_token)
            await self.sync_core_session(session_id, auth_token, runtime_config.core)
            await self.sync_core_message(session_id, user_message, auth_token, runtime_config.core)
            self.emit_runtime_thinking(
                session_id,
                run_state,
                f"已选择模型：{runtime_config.label}，配置来源：{'Core' if runtime_config.source == 'core' else '环境变量'}。",
            )
            files = prompt_files(parts)
            environment = await self._resolve_environment(auth_token)
            character = (runtime_config.core or {}).get("character") if runtime_config.core else None
            automatic_vision_context = await self._analyze_non_multimodal_images(
                session_id=session_id,
                message_id=user_message["info"]["id"],
                parts=parts,
                user_text=content_text(parts),
                auth_token=auth_token,
                runtime_config=runtime_config,
            )
            if automatic_vision_context:
                self.emit_runtime_thinking(
                    session_id,
                    run_state,
                    "当前对话模型不支持图片，已使用角色绑定的 Vision 配置完成自动分析。",
                )
            current_character_action = self.store.get_character_action(session_id)
            if (
                not current_character_action
                or (
                    isinstance(character, dict)
                    and character.get("id") is not None
                    and current_character_action.get("characterID") != character.get("id")
                )
            ):
                current_character_action = _default_character_action_state(session_id, character)
                if current_character_action:
                    self.store.set_character_action(session_id, current_character_action)
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
            )
            skill_runtime = create_skill_runtime(
                self.workspace_root,
                tool_context,
                profile="user_chat",
            )
            tools = skill_runtime.active_tools()
            self.emit_runtime_thinking(
                session_id,
                run_state,
                f"已加载按需技能目录，首轮暴露 {len(tools)} 个基础工具。",
            )
            attachment_details = attachment_context(files, runtime_config.supports_images)
            if automatic_vision_context:
                attachment_details = "\n\n".join(filter(None, [attachment_details, automatic_vision_context]))
            task_prompt = build_user_chat_task_prompt(content_text(parts), attachment_details)
            def system_prompt_for(active_skill_ids: tuple[str, ...]) -> str:
                return build_agent_system_prompt(
                    runtime_config.core,
                    current_character_action=self.store.get_character_action(session_id) or current_character_action,
                    supports_images=runtime_config.supports_images,
                    environment=environment,
                    active_skill_ids=active_skill_ids,
                )

            system_prompt = system_prompt_for(skill_runtime.active_skill_ids)
            agent_messages = await self.compact_agent_messages_if_needed(
                session_id,
                run_state,
                runtime_config,
                list(session.get("agentMessages") or []),
                user_message["info"]["time"]["created"],
                auth_token,
            )
            agent = Agent(
                AgentOptions(
                    session_id=session_id,
                    tool_execution="sequential",
                    convert_to_llm=convert_to_llm,
                    stream_fn=stream_openai_compatible,
                    initial_state={
                        "model": runtime_config.model,
                        "thinkingLevel": runtime_config.thinking_level,
                        "systemPrompt": system_prompt,
                        "tools": tools,
                        "messages": agent_messages,
                    },
                    get_api_key=lambda _provider: runtime_config.api_key,
                    before_tool_call=self._before_tool_call(session_id, run_state),
                    prepare_next_turn_with_context=lambda turn, _signal: skill_runtime.prepare_next_turn(
                        turn,
                        system_prompt_for,
                    ),
                )
            )
            agent.subscribe(lambda event, _signal: self.handle_agent_event(session_id, event, run_state))
            content: list[dict[str, Any]] = []
            if runtime_config.supports_images:
                content.extend(images_from_parts(parts))
            if task_prompt:
                content.append({"type": "text", "text": task_prompt})
            self.emit_runtime_thinking(session_id, run_state, "正在发送给 Python AgentCore，并等待模型回复。")
            await agent.prompt({"role": "user", "timestamp": user_message["info"]["time"]["created"], "content": content})
            self.store.set_agent_messages(session_id, list(agent.state.messages))
            if run_state.error_message:
                raise RuntimeError(run_state.error_message)
            self.emit_runtime_thinking(session_id, run_state, "回复生成完成。", done=True)
            if run_state.assistant_message_id:
                assistant_message = next(
                    (
                        item
                        for item in self.store.require_session(session_id)["messages"]
                        if item["info"]["id"] == run_state.assistant_message_id
                    ),
                    None,
                )
                if assistant_message:
                    try:
                        await self.sync_core_message(session_id, assistant_message, auth_token, runtime_config.core)
                    except Exception as error:
                        logger.error(
                            f"助手消息已生成但持久化到 Core 失败: session={session_id}, "
                            f"message={assistant_message['info']['id']}, error={error}",
                            exc_info=True,
                        )
                        self.emit_session_error(session_id, f"助手回复已生成，但保存历史记录失败：{error}")
            await self.sync_core_session(session_id, auth_token, runtime_config.core)
            self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "idle"}}})
            self.emit_session(session_id)
            duration = now_ms() - started
            logger.info(f"session {session_id} completed in {duration}ms")
        except Exception as error:
            logger.error(f"session {session_id} 运行失败: {error}", exc_info=True)
            self.emit_runtime_thinking(session_id, run_state, runtime_error_summary(error), done=True)
            self.finish_runtime_message(session_id, run_state, error=error)
            self.emit_session_error(session_id, error)
            if auth_token and runtime_config and run_state.assistant_message_id:
                assistant_message = next(
                    (
                        item
                        for item in self.store.require_session(session_id)["messages"]
                        if item["info"]["id"] == run_state.assistant_message_id
                    ),
                    None,
                )
                if assistant_message:
                    try:
                        await self.sync_core_message(session_id, assistant_message, auth_token, runtime_config.core)
                        await self.sync_core_session(session_id, auth_token, runtime_config.core)
                    except Exception as persist_error:
                        logger.error(
                            f"失败消息持久化到 Core 失败: session={session_id}, error={persist_error}",
                            exc_info=True,
                        )

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
                raise RuntimeError("当前会话刚完成压缩，没有新增内容可继续压缩。")
            return messages
        if force and not (
            preparation.value.get("messagesToSummarize")
            or preparation.value.get("turnPrefixMessages")
            or preparation.value.get("previousSummary")
        ):
            raise RuntimeError("当前上下文仍在保留范围内，没有可压缩的旧对话。")

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
        tokens_after = int(estimate_context_tokens(compacted_messages).get("tokens") or 0)
        self.store.set_agent_messages(session_id, compacted_messages)
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

    def _before_tool_call(self, session_id: str, run_state: RunState):
        async def before_tool_call(context: dict[str, Any], _signal: Any = None) -> dict[str, Any] | None:
            tool_call = context.get("toolCall") or {}
            tool_name = tool_call.get("name") or ""
            args = context.get("args") or {}
            pattern = self.permission_pattern(tool_name, args)
            if self.is_safe_tool(tool_name) or self.permissions.is_always_allowed(tool_name, pattern):
                return None
            reply = await asyncio.to_thread(
                self.permissions.ask,
                {
                    "sessionID": session_id,
                    "permission": tool_name,
                    "patterns": [pattern],
                    "always": self.permission_always_patterns(tool_name),
                    "metadata": {"args": args, "toolName": tool_name},
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
        for attempt in range(len(_CORE_SYNC_RETRY_DELAYS) + 1):
            try:
                await asyncio.to_thread(self.core_client.sync_agent_session, auth_token, session["info"], core)
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
        message_id = str(message.get("info", {}).get("id") or "unknown")
        for attempt in range(len(_CORE_SYNC_RETRY_DELAYS) + 1):
            try:
                result = await asyncio.to_thread(
                    self.core_client.sync_agent_message,
                    auth_token,
                    session["info"],
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
