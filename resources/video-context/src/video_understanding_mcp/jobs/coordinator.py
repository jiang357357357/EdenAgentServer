"""Bounded job queue and duplicate-work suppression."""

from __future__ import annotations

import asyncio
import importlib
import os
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

import psutil

from ..config import Settings
from ..errors import ErrorCode, VideoMCPError
from ..security.budgets import JobResourceBudget, reset_resource_budget, set_resource_budget

T = TypeVar("T")


def _reaped_children_cpu() -> float:
    """Return cumulative reaped-child CPU where POSIX accounting is available."""
    try:
        resource = importlib.import_module("resource")
    except ModuleNotFoundError:
        return 0.0
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return float(usage.ru_utime + usage.ru_stime)


class JobCoordinator:
    def __init__(self, settings: Settings) -> None:
        self._semaphore = asyncio.Semaphore(settings.max_concurrent_jobs)
        self._max_in_system = settings.max_concurrent_jobs + settings.max_queued_jobs
        self._max_wall_seconds = settings.max_job_wall_seconds
        self._max_cpu_seconds = settings.max_subprocess_cpu_seconds
        self._max_memory_bytes = settings.max_subprocess_memory_bytes
        self._queued = 0
        self._lock = asyncio.Lock()
        self._duplicates: dict[str, asyncio.Task[object]] = {}
        self._waiters: dict[str, int] = {}

    async def run(self, key: str, work: Callable[[], Awaitable[T]]) -> tuple[T, bool]:
        async with self._lock:
            existing = self._duplicates.get(key)
            if existing is not None:
                task = existing
                self._waiters[key] += 1
                coalesced = True
            else:
                if self._queued >= self._max_in_system:
                    raise VideoMCPError(
                        ErrorCode.QUEUE_FULL, "The bounded processing queue is full."
                    )
                self._queued += 1
                task = asyncio.create_task(self._guarded(work))
                self._duplicates[key] = task
                self._waiters[key] = 1
                coalesced = False
        try:
            result = await asyncio.shield(task)
        except asyncio.CancelledError:
            await self._release_waiter(key, task, cancel_if_last=True)
            raise
        except BaseException:
            await self._release_waiter(key, task, cancel_if_last=False)
            raise
        await self._release_waiter(key, task, cancel_if_last=False)
        return result, coalesced  # type: ignore[return-value]

    async def _release_waiter(
        self, key: str, task: asyncio.Task[object], *, cancel_if_last: bool
    ) -> None:
        should_cancel = False
        async with self._lock:
            remaining = self._waiters.get(key, 1) - 1
            if remaining <= 0:
                self._waiters.pop(key, None)
                should_cancel = cancel_if_last and not task.done()
            else:
                self._waiters[key] = remaining
            if task.done() or should_cancel:
                self._duplicates.pop(key, None)
        if should_cancel:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def shutdown(self) -> None:
        """Cancel every in-flight job and wait for its cleanup handlers."""
        async with self._lock:
            tasks = tuple(set(self._duplicates.values()))
            self._duplicates.clear()
            self._waiters.clear()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _guarded(self, work: Callable[[], Awaitable[T]]) -> T:
        try:
            async with self._semaphore:
                budget = JobResourceBudget(self._max_cpu_seconds, self._max_memory_bytes)
                token = set_resource_budget(budget)
                started_cpu = time.process_time()
                started_children_cpu = _reaped_children_cpu()
                work_task: asyncio.Future[T] | None = None
                monitor: asyncio.Task[str] | None = None
                try:
                    async with asyncio.timeout(self._max_wall_seconds):
                        work_task = asyncio.ensure_future(work())
                        monitor = asyncio.create_task(
                            self._monitor_resources(budget, started_cpu, started_children_cpu)
                        )
                        done, _ = await asyncio.wait(
                            (work_task, monitor), return_when=asyncio.FIRST_COMPLETED
                        )
                        if monitor in done:
                            reason = monitor.result()
                            raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, reason)
                        final_reason = self._resource_reason(
                            budget, started_cpu, started_children_cpu
                        )
                        if final_reason is not None:
                            raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, final_reason)
                        return await work_task
                except TimeoutError as exc:
                    raise VideoMCPError(
                        ErrorCode.TIMEOUT, "The video job exceeded its overall wall-time limit."
                    ) from exc
                finally:
                    pending = [
                        task
                        for task in (work_task, monitor)
                        if task is not None and not task.done()
                    ]
                    for task in pending:
                        task.cancel()
                    if pending:
                        await asyncio.gather(*pending, return_exceptions=True)
                    reset_resource_budget(token)
        finally:
            async with self._lock:
                self._queued -= 1

    async def _monitor_resources(
        self,
        budget: JobResourceBudget,
        started_cpu: float,
        started_children_cpu: float,
    ) -> str:
        while True:
            await asyncio.sleep(0.1)
            reason = self._resource_reason(budget, started_cpu, started_children_cpu)
            if reason is not None:
                return reason

    @staticmethod
    def _resource_reason(
        budget: JobResourceBudget,
        started_cpu: float,
        started_children_cpu: float,
    ) -> str | None:
        main_cpu = max(0.0, time.process_time() - started_cpu)
        reaped_child_cpu = max(0.0, _reaped_children_cpu() - started_children_cpu)
        child_cpu = max(budget.child_cpu_seconds, reaped_child_cpu)
        if main_cpu + child_cpu > budget.max_cpu_seconds:
            return "The operation exceeded its aggregate CPU-time limit."
        try:
            main_memory = int(psutil.Process(os.getpid()).memory_info().rss)
        except (psutil.Error, OSError):
            main_memory = 0
        if main_memory + budget.active_child_memory_bytes > budget.max_memory_bytes:
            return "The operation exceeded its aggregate memory limit."
        return None
