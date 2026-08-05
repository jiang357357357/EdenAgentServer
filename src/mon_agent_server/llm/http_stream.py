from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import os
from typing import Any, AsyncIterator

import httpx


RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


def _timeout_from_env(name: str, default: int, *, minimum: int = 1, maximum: int = 300) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def stream_timeouts() -> tuple[int, int, int]:
    return (
        _timeout_from_env("MON_AGENT_MODEL_CONNECT_TIMEOUT_SECONDS", 15),
        _timeout_from_env("MON_AGENT_MODEL_FIRST_EVENT_TIMEOUT_SECONDS", 45),
        _timeout_from_env("MON_AGENT_MODEL_IDLE_TIMEOUT_SECONDS", 60, minimum=10),
    )


@asynccontextmanager
async def open_sse(
    url: str,
    *,
    payload: dict[str, Any],
    headers: dict[str, str],
    connect_timeout_seconds: int,
) -> AsyncIterator[httpx.Response]:
    timeout = httpx.Timeout(connect=connect_timeout_seconds, read=None, write=connect_timeout_seconds, pool=connect_timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as response:
            yield response


async def iter_sse_data(
    response: httpx.Response,
    *,
    first_event_timeout_seconds: int,
    idle_timeout_seconds: int,
) -> AsyncIterator[str]:
    lines = response.aiter_lines().__aiter__()
    timeout_seconds = first_event_timeout_seconds
    while True:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                phase = "首个有效事件" if timeout_seconds == first_event_timeout_seconds else "有效事件空闲"
                raise TimeoutError(f"模型流{phase}超时（{timeout_seconds} 秒）")
            try:
                line = await asyncio.wait_for(lines.__anext__(), timeout=remaining)
            except StopAsyncIteration:
                return
            line = line.strip()
            if not line or line.startswith(":") or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data:
                break
        yield data
        timeout_seconds = idle_timeout_seconds
