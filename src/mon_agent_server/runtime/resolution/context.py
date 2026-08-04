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
from mon_agent_server.config import merge_environment_context
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


class RuntimeResolutionMixin:
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

    async def _resolve_user_context(
        self, auth_token: str | None
    ) -> tuple[dict[str, Any] | None, str | None]:
        if not auth_token:
            return self.environment, None
        try:
            profile = await asyncio.to_thread(self.core_client.get_user_profile, auth_token)
            configured = profile.get("environment") if isinstance(profile.get("environment"), dict) else {}
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
            raise RuntimeError("当前对话模型不支持图片，且当前会话无法读取默认多模态 AI。")

        character = runtime_config.core.get("character")
        vision_entity = runtime_config.core.get("visionAIEntity")
        character_name = character.get("name") if isinstance(character, dict) else "当前角色"
        if not isinstance(vision_entity, dict) or not vision_entity.get("id"):
            raise RuntimeError(f"角色「{character_name or '当前角色'}」的对话模型不支持图片，且没有配置默认多模态 AI。")
        if vision_entity.get("status") == "unavailable":
            raise RuntimeError(
                f"无法读取角色「{character_name or '当前角色'}」选定的多模态 AI："
                f"{vision_entity.get('error') or 'Core 多模态 AI 不可用'}"
            )
        if vision_entity.get("status") not in (None, "", "active"):
            raise RuntimeError(
                f"角色「{character_name or '当前角色'}」选定的多模态 AI「{vision_entity.get('ai_name') or vision_entity.get('id')}」未启用。"
            )

        images = _vision_inputs_from_parts(parts)
        if len(images) != len(image_parts):
            raise RuntimeError("图片附件不是有效的 base64 data URL，无法交给多模态 AI 分析。")

        question = user_text.strip()
        prompt = (
            "请客观、完整地分析这些图片，提取画面内容、可见文字、界面状态、错误信息及其他重要细节。"
            "分析必须基于图片，不要猜测看不见的内容。"
        )
        if question:
            prompt += f"\n用户当前问题：{question[:2000]}"
        result = await asyncio.to_thread(
            self.core_client.analyze_image,
            auth_token,
            {
                "ai_entity_id": vision_entity["id"],
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
            raise RuntimeError(error or "多模态 AI 图片分析失败。")
        analysis = str(result.get("content") or result.get("summary") or "").strip()
        if not analysis:
            raise RuntimeError("多模态 AI 没有返回可用的图片分析结果。")

        references = "、".join(str(image.get("ref") or "图片") for image in images)
        return "\n".join(
            [
                "### 自动视觉分析结果",
                f"图片：{references}",
                f"视觉模型：{vision_entity.get('ai_name') or vision_entity.get('name') or vision_entity.get('id')}",
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
