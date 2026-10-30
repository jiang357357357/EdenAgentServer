"""Bounded subprocess execution with process-tree termination."""

from __future__ import annotations

import asyncio
import ctypes
import os
import signal

# Bandit B404 is acknowledged: this centralized wrapper uses exec only and never a shell.
import subprocess  # nosec B404
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, cast

import psutil

from ..constants import MAX_CAPTURED_PROCESS_BYTES
from ..errors import ErrorCode, VideoMCPError
from .budgets import current_resource_budget


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


class _BoundedBuffer:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.data = bytearray()
        self.truncated = False

    def append(self, chunk: bytes) -> None:
        remaining = self.limit - len(self.data)
        if remaining > 0:
            self.data.extend(chunk[:remaining])
        if len(chunk) > remaining:
            self.truncated = True


def minimal_environment(temp_dir: Path | None = None) -> dict[str, str]:
    env = {
        "PATH": os.defpath,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONNOUSERSITE": "1",
        "YTDLP_NO_PLUGINS": "1",
    }
    if os.name == "nt":
        for key in ("SystemRoot", "WINDIR"):
            if key in os.environ:
                env[key] = os.environ[key]
    if temp_dir is not None:
        env["TMPDIR"] = str(temp_dir)
        env["TEMP"] = str(temp_dir)
        env["TMP"] = str(temp_dir)
    return env


async def _drain(stream: asyncio.StreamReader | None, target: _BoundedBuffer) -> None:
    if stream is None:
        return
    while chunk := await stream.read(64 * 1024):
        target.append(chunk)


async def terminate_process_tree(pid: int) -> None:
    if os.name != "nt":
        kill_process_group = cast(Callable[[int, int], None], vars(os)["killpg"])
        sigkill = cast(int, vars(signal)["SIGKILL"])
        with suppress(ProcessLookupError, PermissionError):
            kill_process_group(pid, signal.SIGTERM)
        await asyncio.sleep(0.2)
        with suppress(ProcessLookupError, PermissionError):
            kill_process_group(pid, sigkill)
        return
    try:
        root = psutil.Process(pid)
        processes = root.children(recursive=True)
    except (psutil.Error, OSError):
        return
    processes.append(root)
    for process in reversed(processes):
        with suppress(psutil.Error):
            process.terminate()
    _, alive = await asyncio.to_thread(psutil.wait_procs, processes, timeout=2)
    for process in alive:
        with suppress(psutil.Error):
            process.kill()


async def _resource_limit_exceeded(
    pid: int,
    *,
    cpu_time_limit_seconds: float | None,
    memory_limit_bytes: int | None,
    budget_identifier: int,
) -> str | None:
    """Watch CPU/RSS for the process tree, tolerating inaccessible descendants."""
    while True:
        try:
            root = psutil.Process(pid)
            processes = [root, *root.children(recursive=True)]
        except psutil.NoSuchProcess:
            return None
        except (psutil.AccessDenied, OSError):
            processes = []
            with suppress(psutil.Error, OSError):
                processes.append(psutil.Process(pid))
        total_seconds = 0.0
        total_memory = 0
        for process in processes:
            with suppress(psutil.Error, OSError):
                times = process.cpu_times()
                total_seconds += float(times.user + times.system)
                total_memory += int(process.memory_info().rss)
        budget = current_resource_budget()
        if budget is not None:
            budget.update_child(
                budget_identifier,
                cpu_seconds=total_seconds,
                memory_bytes=total_memory,
            )
            if budget.child_cpu_seconds > budget.max_cpu_seconds:
                return "The operation exceeded its aggregate CPU-time limit."
            if budget.active_child_memory_bytes > budget.max_memory_bytes:
                return "The operation exceeded its aggregate child-memory limit."
        if cpu_time_limit_seconds is not None and total_seconds > cpu_time_limit_seconds:
            return "A media subprocess exceeded its CPU-time limit."
        if memory_limit_bytes is not None and total_memory > memory_limit_bytes:
            return "A media subprocess exceeded its memory limit."
        await asyncio.sleep(0.1)


async def run_process(
    arguments: list[str],
    *,
    timeout_seconds: float,
    cwd: Path,
    output_limit: int = MAX_CAPTURED_PROCESS_BYTES,
    env: dict[str, str] | None = None,
    cpu_time_limit_seconds: float | None = None,
    memory_limit_bytes: int | None = None,
) -> ProcessResult:
    if not arguments or not Path(arguments[0]).is_absolute():
        raise ValueError("subprocess executable must be an absolute path")
    if os.name == "nt":
        creationflags = int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)) | int(
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
        process = await asyncio.create_subprocess_exec(
            *arguments,
            cwd=cwd,
            env=env or minimal_environment(cwd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
        )
    else:
        process = await asyncio.create_subprocess_exec(
            *arguments,
            cwd=cwd,
            env=env or minimal_environment(cwd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    stdout_buffer = _BoundedBuffer(output_limit)
    stderr_buffer = _BoundedBuffer(output_limit)
    stdout_task = asyncio.create_task(_drain(process.stdout, stdout_buffer))
    stderr_task = asyncio.create_task(_drain(process.stderr, stderr_buffer))
    wait_task = asyncio.create_task(process.wait())
    resource_task = (
        asyncio.create_task(
            _resource_limit_exceeded(
                process.pid,
                cpu_time_limit_seconds=cpu_time_limit_seconds,
                memory_limit_bytes=memory_limit_bytes,
                budget_identifier=process.pid,
            )
        )
        if cpu_time_limit_seconds is not None or memory_limit_bytes is not None
        else None
    )
    try:
        async with asyncio.timeout(timeout_seconds):
            if resource_task is not None:
                done, _ = await asyncio.wait(
                    (wait_task, resource_task), return_when=asyncio.FIRST_COMPLETED
                )
                if resource_task in done and resource_task.result() is not None:
                    await terminate_process_tree(process.pid)
                    await wait_task
                    raise VideoMCPError(
                        ErrorCode.RESOURCE_LIMIT_EXCEEDED,
                        resource_task.result() or "A media subprocess exceeded a resource limit.",
                    )
            returncode = await wait_task
            await asyncio.gather(stdout_task, stderr_task)
    except TimeoutError as exc:
        await terminate_process_tree(process.pid)
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        raise VideoMCPError(
            ErrorCode.TIMEOUT, "A media subprocess exceeded its time limit."
        ) from exc
    except asyncio.CancelledError:
        await terminate_process_tree(process.pid)
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        raise
    finally:
        if resource_task is not None:
            resource_task.cancel()
            await asyncio.gather(resource_task, return_exceptions=True)
        budget = current_resource_budget()
        if budget is not None:
            budget.finish_child(process.pid)
    return ProcessResult(
        returncode=returncode,
        stdout=bytes(stdout_buffer.data),
        stderr=bytes(stderr_buffer.data),
        stdout_truncated=stdout_buffer.truncated,
        stderr_truncated=stderr_buffer.truncated,
    )


def _windows_elevation_state() -> bool | None:
    windll = getattr(ctypes, "windll", None)
    shell32 = getattr(windll, "shell32", None)
    checker = getattr(shell32, "IsUserAnAdmin", None)
    if not callable(checker):
        return None
    try:
        return bool(checker())
    except OSError:
        return None


def ensure_not_root() -> None:
    if os.name == "nt":
        if _windows_elevation_state() is not False:
            raise VideoMCPError(
                ErrorCode.INVALID_INPUT,
                "Refusing to run without verified non-Administrator privileges.",
            )
        return
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "Refusing to run the MCP server as root.")


def bounded_copy_stream(source: BinaryIO, destination: BinaryIO, maximum: int) -> int:
    total = 0
    while chunk := source.read(64 * 1024):
        total += len(chunk)
        if total > maximum:
            raise VideoMCPError(
                ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Stream exceeded its byte limit."
            )
        destination.write(chunk)
    return total
