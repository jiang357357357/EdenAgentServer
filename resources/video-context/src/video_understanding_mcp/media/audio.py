"""Bounded audio extraction for offline transcription."""

from __future__ import annotations

import asyncio
from pathlib import Path

from ..config import Settings
from ..constants import LOCAL_FORMAT_WHITELIST, LOCAL_PROTOCOL_WHITELIST
from ..errors import ErrorCode, VideoMCPError
from ..schemas import ResolvedRange
from ..security.subprocesses import run_process
from .probe import resolve_executable


async def extract_transcription_audio(
    source: Path,
    destination: Path,
    *,
    selected_range: ResolvedRange,
    settings: Settings,
) -> Path:
    ffmpeg = resolve_executable(settings.ffmpeg_path, "ffmpeg")
    arguments = [
        str(ffmpeg),
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        LOCAL_PROTOCOL_WHITELIST,
        "-format_whitelist",
        LOCAL_FORMAT_WHITELIST,
        "-ss",
        f"{selected_range.start_ms / 1000:.3f}",
        "-i",
        str(source),
        "-t",
        f"{selected_range.duration_ms / 1000:.3f}",
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-y",
        str(destination),
    ]
    result = await run_process(
        arguments,
        timeout_seconds=settings.max_job_wall_seconds,
        cwd=destination.parent,
        cpu_time_limit_seconds=settings.max_subprocess_cpu_seconds,
        memory_limit_bytes=settings.max_subprocess_memory_bytes,
    )
    valid = await asyncio.to_thread(
        lambda: destination.is_file() and destination.stat().st_size > 0
    )
    if result.returncode != 0 or not valid:
        await asyncio.to_thread(destination.unlink, missing_ok=True)
        raise VideoMCPError(ErrorCode.TRANSCRIPTION_FAILED, "Audio extraction failed.")
    await asyncio.to_thread(destination.chmod, 0o600)
    return destination
