from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..logging import get_logger
from ..model_stream import core_model, env_model

if TYPE_CHECKING:
    from ..app import AppState

logger = get_logger("MonAgent", "SelfAwake")


@dataclass(slots=True)
class SelfAwakeRuntimeConfig:
    model: dict[str, Any]
    api_key: str | None
    label: str
    source: str
    core: dict[str, Any] | None
    supports_images: bool
    thinking_level: str


def runtime_config_from_model(
    model: dict[str, Any],
    api_key: str | None,
    label: str,
    source: str,
    core: dict[str, Any] | None = None,
) -> SelfAwakeRuntimeConfig:
    return SelfAwakeRuntimeConfig(
        model=model,
        api_key=api_key,
        label=label,
        source=source,
        core=core,
        supports_images="image" in (model.get("input") or []),
        thinking_level="medium" if model.get("reasoning") else "off",
    )


async def resolve_self_awake_runtime_config(app: AppState, token: str | None) -> SelfAwakeRuntimeConfig:
    if token:
        try:
            core = await asyncio.to_thread(app.core_client.resolve_runtime_config, token)
            if core:
                return runtime_config_from_model(*core_model(core), core)
        except Exception as error:
            logger.warning(f"解析 Core 默认助手配置失败，将使用环境模型: {error}")
    return runtime_config_from_model(*env_model(), None)
