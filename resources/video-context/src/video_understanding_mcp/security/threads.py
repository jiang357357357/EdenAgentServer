"""Cancellation-safe execution for bounded blocking work."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
T = TypeVar("T")


async def finish_thread_before_cancel(
    function: Callable[P, T], *args: P.args, **kwargs: P.kwargs
) -> T:
    """Do not release locks, staging, or queue capacity while a worker thread is still active."""
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.gather(task, return_exceptions=True)
        raise
