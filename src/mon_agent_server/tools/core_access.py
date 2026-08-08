from __future__ import annotations

from typing import Any, Callable

from ..core import CoreClient
from .context import MonToolContext
from .result import tool_failure


def require_core_access(context: MonToolContext) -> tuple[CoreClient, str]:
    if not context.core_client or not context.core_token:
        raise tool_failure("authentication_required", "该工具需要 Core 登录态。请确认本轮请求携带 Core Token。")
    return context.core_client, context.core_token


def core_call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    return fn(*args, **kwargs)
