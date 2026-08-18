from __future__ import annotations

import asyncio
import base64
from collections.abc import Callable
from concurrent.futures import Future
import json
import os
import threading
import time
from types import SimpleNamespace
from pathlib import Path
from typing import Any

from mon_agent_server.brokers import PermissionBroker, QuestionBroker, ScreenCaptureBroker
from mon_agent_server.core import CoreAuthenticationExpiredError, CoreClient
from mon_agent_server.events import EventBus
from mon_agent_server.ids import create_id, now_ms
from mon_agent_server.logging import get_logger
from mon_agent_server.model_stream import core_model, env_model, stream_openai_compatible
from mon_agent_server.native_runtime import native_runtime_service
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


class RuntimeCompactionMixin:
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
            model_id = str(runtime_config.model.get("id") or "").strip() or None
            before_tokens = int((await _estimate_context_tokens(messages, model_id)).get("tokens") or 0)
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
            after_tokens = int(
                (await _estimate_context_tokens(compacted_messages, model_id)).get("tokens") or 0
            )
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
        cache_context: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        settings = runtime_compaction_settings()
        if not messages:
            if force:
                raise RuntimeError("当前会话没有可压缩的上下文。")
            return messages
        if force:
            settings = {
                **settings,
                "enabled": True,
            }
        if not force and not settings.get("enabled", True):
            return messages
        model_id = str(runtime_config.model.get("id") or "").strip() or None
        estimate = await _estimate_context_tokens(messages, model_id)
        context_tokens = int(estimate.get("tokens") or 0)
        context_window = runtime_context_window(runtime_config.model)
        if settings.get("keepRecentTokens") is None:
            usable_context = max(0, context_window - int(settings.get("reserveTokens") or 0))
            settings = {
                **settings,
                "keepRecentTokens": min(
                    _MANUAL_COMPACTION_KEEP_RECENT_TOKENS,
                    max(2_000, usable_context // 4),
                ),
            }
        if not force and not _should_compact(context_tokens, context_window, settings):
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
        try:
            preparation = await _prepare_compaction(entries, settings, model_id)
        except Exception as error:
            if force:
                raise RuntimeError(f"上下文压缩准备失败：{error}") from error
            logger.warning(f"上下文压缩准备失败: {error}")
            return messages
        if not preparation:
            if force:
                raise NoCompactionNeeded("当前会话刚完成压缩，没有新增内容可继续压缩。")
            return messages
        if force and not (
            preparation.get("messagesToSummarize")
            or preparation.get("turnPrefixMessages")
            or preparation.get("previousSummary")
        ):
            raise NoCompactionNeeded("当前上下文仍在保留范围内，无需压缩。")

        compact_arguments = (
            preparation,
            RuntimeCompactionModels(runtime_config.api_key),
            runtime_config.model,
            custom_instructions,
            None,
            runtime_config.thinking_level,
        )
        result = await (
            compact_context(*compact_arguments, cache_context=cache_context)
            if cache_context is not None
            else compact_context(*compact_arguments)
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
        compacted_messages = (await _build_session_context([*entries, compaction_entry]))["messages"]
        # Provider usage describes the request before compaction. Keeping it on
        # retained messages makes estimate_context_tokens report the stale,
        # pre-compaction size and can immediately trigger another compaction.
        for compacted_message in compacted_messages:
            compacted_message.pop("usage", None)
        tokens_after = int(
            (await _estimate_context_tokens(compacted_messages, model_id)).get("tokens") or 0
        )
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


async def _estimate_context_tokens(
    messages: list[dict[str, Any]],
    model_id: str | None,
) -> dict[str, Any]:
    service = native_runtime_service()
    await service.ensure_started()
    return await service.client.estimate_context_tokens(messages, model_id)


def _should_compact(context_tokens: int, context_window: int, settings: dict[str, Any]) -> bool:
    if not settings.get("enabled", True):
        return False
    return context_tokens > context_window - int(settings.get("reserveTokens") or 16_384)


async def _prepare_compaction(
    entries: list[dict[str, Any]],
    settings: dict[str, Any],
    model_id: str | None,
) -> dict[str, Any] | None:
    service = native_runtime_service()
    await service.ensure_started()
    return await service.client.prepare_compaction(entries, settings, model_id)


async def _build_session_context(entries: list[dict[str, Any]]) -> dict[str, Any]:
    service = native_runtime_service()
    await service.ensure_started()
    return await service.client.build_session_context(entries)


async def _compact_context_native_result(
    preparation: dict[str, Any],
    models: RuntimeCompactionModels,
    model: dict[str, Any],
    custom_instructions: str | None = None,
    _signal: Any | None = None,
    thinking_level: str | None = None,
    cache_context: dict[str, Any] | None = None,
) -> SimpleNamespace:
    try:
        service = native_runtime_service()
        await service.ensure_started()
        request = await service.client.build_compaction_summary_request(
            preparation,
            model,
            custom_instructions,
            thinking_level,
            cache_context=(
                {"systemPrompt": cache_context.get("systemPrompt")}
                if cache_context else None
            ),
        )
        request_context = dict(request.get("context") or {})
        if cache_context:
            request_context["tools"] = list(cache_context.get("tools") or [])
            if cache_context.get("promptCacheKey"):
                request_context["promptCacheKey"] = cache_context["promptCacheKey"]
        response = await models.complete_simple(
            model,
            request_context,
            dict(request.get("options") or {}),
        )
        compaction = await service.client.finalize_compaction(preparation, response)
        return SimpleNamespace(ok=True, value=compaction, error=None)
    except Exception as error:
        return SimpleNamespace(ok=False, value=None, error=error)


# Transitional name retained for callers/tests while implementation is native.
compact_context = _compact_context_native_result
