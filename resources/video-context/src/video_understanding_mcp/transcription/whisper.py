"""Supervisor for local-only Whisper transcription."""

from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Any

from ..config import Settings
from ..errors import ErrorCode, VideoMCPError
from ..schemas import TranscriptSettings
from ..security.subprocesses import minimal_environment, run_process
from .models import TranscriptResult, TranscriptSegment, TranscriptSource


def installed_model_path(model: str, settings: Settings) -> Path | None:
    if model not in settings.approved_whisper_models:
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT, "The Whisper model is not administrator-approved."
        )
    candidate = settings.resolved_model_cache_dir / model
    required = (candidate / "config.json", candidate / "model.bin")
    return candidate if candidate.is_dir() and all(path.is_file() for path in required) else None


async def transcribe_local_audio(
    audio: Path,
    *,
    transcript: TranscriptSettings,
    working_directory: Path,
    settings: Settings,
) -> TranscriptResult:
    model_path = installed_model_path(transcript.model, settings)
    if model_path is None:
        raise VideoMCPError(
            ErrorCode.DEPENDENCY_MISSING,
            f"Whisper model {transcript.model!r} is not installed; run video-mcp install-model.",
        )
    result_path = working_directory / f"whisper-result-{secrets.token_hex(8)}.json"
    arguments = [
        str(settings.resolved_python_path),
        "-m",
        "video_understanding_mcp.workers.whisper_worker",
        "--audio",
        str(audio),
        "--model-path",
        str(model_path),
        "--result",
        str(result_path),
        "--language",
        transcript.language,
        "--task",
        transcript.task.value,
        "--word-timestamps",
        "true" if transcript.word_timestamps else "false",
        "--max-chars",
        str(settings.max_transcript_chars),
    ]
    result = await run_process(
        arguments,
        timeout_seconds=settings.max_job_wall_seconds,
        cwd=working_directory,
        env=minimal_environment(working_directory),
        cpu_time_limit_seconds=settings.max_subprocess_cpu_seconds,
        memory_limit_bytes=settings.max_subprocess_memory_bytes,
    )
    try:
        payload: Any = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VideoMCPError(ErrorCode.TRANSCRIPTION_FAILED, "Transcription worker failed.") from exc
    finally:
        result_path.unlink(missing_ok=True)
    if result.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True:
        raise VideoMCPError(ErrorCode.TRANSCRIPTION_FAILED, "Transcription worker failed.")
    data = payload.get("result")
    if not isinstance(data, dict):
        raise VideoMCPError(ErrorCode.TRANSCRIPTION_FAILED, "Transcription result is invalid.")
    raw_segments = data.get("segments")
    if not isinstance(raw_segments, list):
        raise VideoMCPError(ErrorCode.TRANSCRIPTION_FAILED, "Transcription result is invalid.")
    segments: list[TranscriptSegment] = []
    previous_start_ms = -1
    previous_end_ms = -1
    for item in raw_segments:
        if not isinstance(item, dict):
            raise VideoMCPError(ErrorCode.TRANSCRIPTION_FAILED, "Transcription result is invalid.")
        start_ms, end_ms, text = item.get("start_ms"), item.get("end_ms"), item.get("text")
        if (
            not isinstance(start_ms, int)
            or not isinstance(end_ms, int)
            or not isinstance(text, str)
        ):
            raise VideoMCPError(ErrorCode.TRANSCRIPTION_FAILED, "Transcription result is invalid.")
        if (
            start_ms < 0
            or end_ms <= start_ms
            or not text.strip()
            or start_ms < previous_start_ms
            or end_ms < previous_end_ms
        ):
            raise VideoMCPError(ErrorCode.TRANSCRIPTION_FAILED, "Transcription result is invalid.")
        segments.append(TranscriptSegment(start_ms, end_ms, text))
        previous_start_ms = start_ms
        previous_end_ms = end_ms
    language = data.get("language")
    status = data.get("status")
    if status not in {"complete", "no_speech"} or (status == "complete") != bool(segments):
        raise VideoMCPError(ErrorCode.TRANSCRIPTION_FAILED, "Transcription result is invalid.")
    return TranscriptResult(
        status=status,
        source=TranscriptSource.WHISPER,
        language=language if isinstance(language, str) else None,
        segments=tuple(segments),
        model=transcript.model,
    )
