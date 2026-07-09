from __future__ import annotations

import asyncio
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

from ..brokers import PermissionBroker, QuestionBroker
from ..core import CoreAuthenticationExpiredError, CoreClient
from ..events import EventBus
from ..ids import create_id, now_ms
from ..logging import get_logger
from ..model_stream import core_model, env_model, stream_openai_compatible
from ..prompts import attachment_context, build_agent_system_prompt, build_user_chat_task_prompt
from ..store import SessionStore
from ..tools import MonToolContext, create_mon_agent_tools
from .compaction import RuntimeCompactionModels, messages_to_compaction_entries, runtime_compaction_settings, timestamp_iso
from .config import RuntimeModelConfig, runtime_context_window
from .emitters import RuntimeEmitterMixin
from .messages import content_text, images_from_parts, prompt_files
from .permissions import RuntimePermissionMixin
from .state import RunState

logger = get_logger("MonAgent", "Runtime")


def _as_dict_list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


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
        environment: dict[str, Any] | None = None,
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        self.store = store
        self.events = events
        self.permissions = permissions
        self.questions = questions
        self.core_client = core_client
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

    def _thread_main(self, session_id: str, parts: list[dict[str, Any]], auth_token: str | None) -> None:
        try:
            asyncio.run(self._run_prompt(session_id, parts, auth_token))
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
        self.emit_runtime_thinking(session_id, run_state, "正在读取 Core 默认助手、角色与模型配置。")

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
            tools = create_mon_agent_tools(
                self.workspace_root,
                MonToolContext(
                    session_id=session_id,
                    core_client=self.core_client,
                    core_token=auth_token,
                    permissions=self.permissions,
                    questions=self.questions,
                    current_model_supports_images=runtime_config.supports_images,
                    vision_config=(runtime_config.core or {}).get("visionConfig") if runtime_config.core else None,
                    environment=environment,
                    character=character,
                    current_character_action=current_character_action,
                    emit_event=self.events.emit,
                    set_character_action=lambda state: self.store.set_character_action(session_id, state),
                    get_message_id=lambda: run_state.assistant_message_id,
                    get_current_files=lambda: files,
                ),
                "user_chat",
            )
            self.emit_runtime_thinking(session_id, run_state, f"已注册 Python Mon 工具：{len(tools)} 个。")
            task_prompt = build_user_chat_task_prompt(
                content_text(parts),
                attachment_context(files, runtime_config.supports_images),
            )
            system_prompt = build_agent_system_prompt(runtime_config.core, current_character_action=current_character_action)
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
                    await self.sync_core_message(session_id, assistant_message, auth_token, runtime_config.core)
            await self.sync_core_session(session_id, auth_token, runtime_config.core)
            self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "idle"}}})
            self.emit_session(session_id)
            duration = now_ms() - started
            logger.info(f"session {session_id} completed in {duration}ms")
        except Exception as error:
            self.emit_runtime_thinking(session_id, run_state, f"运行失败：{error}", done=True)
            self.emit_session_error(session_id, error)

    async def compact_agent_messages_if_needed(
        self,
        session_id: str,
        run_state: RunState,
        runtime_config: RuntimeModelConfig,
        messages: list[dict[str, Any]],
        current_user_created_at: int,
        auth_token: str | None,
    ) -> list[dict[str, Any]]:
        settings = runtime_compaction_settings()
        if not messages or not settings.get("enabled", True):
            return messages
        estimate = estimate_context_tokens(messages)
        context_tokens = int(estimate.get("tokens") or 0)
        context_window = runtime_context_window(runtime_config.model)
        if not should_compact(context_tokens, context_window, settings):
            return messages
        if not runtime_config.api_key:
            logger.warning("上下文达到压缩阈值，但当前模型缺少 API Key，跳过压缩。")
            return messages

        self.emit_runtime_thinking(
            session_id,
            run_state,
            f"上下文约 {context_tokens} tokens，超过压缩阈值，正在压缩旧对话。",
        )
        entries = messages_to_compaction_entries(messages)
        preparation = prepare_compaction(entries, settings)
        if not preparation.ok:
            logger.warning(f"上下文压缩准备失败: {preparation.error}")
            return messages
        if not preparation.value:
            return messages

        result = await compact_context(
            preparation.value,
            RuntimeCompactionModels(runtime_config.api_key),
            runtime_config.model,
            None,
            None,
            runtime_config.thinking_level,
        )
        if not result.ok or not result.value:
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
        self.store.set_agent_messages(session_id, compacted_messages)
        hidden_message = self.store.append_compaction_message(
            session_id,
            summary=compaction_entry["summary"],
            tokens_before=compaction_entry["tokensBefore"],
            first_kept_entry_id=compaction_entry.get("firstKeptEntryId"),
            details=compaction_entry.get("details"),
            created_at=max(0, current_user_created_at - 1),
        )
        await self.sync_core_message(session_id, hidden_message, auth_token, runtime_config.core)
        self.emit_runtime_thinking(
            session_id,
            run_state,
            f"上下文压缩完成：保留最近约 {settings.get('keepRecentTokens')} tokens，并写入压缩摘要。",
        )
        logger.info(
            "session {} compacted context: before={} after={} kept={}",
            session_id,
            context_tokens,
            estimate_context_tokens(compacted_messages).get("tokens"),
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
        await asyncio.to_thread(self.core_client.sync_agent_session, auth_token, session["info"], core)

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
        await asyncio.to_thread(self.core_client.sync_agent_message, auth_token, session["info"], message, core)
