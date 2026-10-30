"""Supervised wrapper around the fixed-policy yt-dlp worker."""

from __future__ import annotations

import asyncio
import json
import secrets
from pathlib import Path
from typing import Any, NoReturn

from ..config import Settings
from ..errors import ErrorCode, VideoMCPError
from ..logging import get_logger
from ..schemas import YoutubeTranscriptPolicy
from ..security.subprocesses import ProcessResult, minimal_environment, run_process
from ..security.urls import ValidatedYoutubeUrl

_SAFE_WORKER_CATEGORIES = {"MaxDownloadsReached"}


def _safe_stderr_summary(stderr: bytes) -> str | None:
    """Classify bounded worker stderr without retaining arbitrary external text."""
    if not stderr.strip():
        return None
    lowered = stderr[:4096].decode("utf-8", "replace").lower()
    if "no module named" in lowered or "finding module specification" in lowered:
        return "Python could not import the worker package."
    if "permission denied" in lowered:
        return "The worker executable or result path was not accessible."
    if "no such file or directory" in lowered or "not found" in lowered:
        return "A worker executable or dependency was not found."
    return "The worker emitted stderr; its content was redacted."


def _log_worker_failure(*, operation: str, result: ProcessResult, result_state: str) -> None:
    get_logger().error(
        "youtube_worker_failed",
        worker="yt-dlp",
        stage=operation,
        exit_code=result.returncode,
        signal=(-result.returncode if result.returncode < 0 else None),
        result_state=result_state,
        stderr_present=bool(result.stderr.strip()),
        stderr_summary=_safe_stderr_summary(result.stderr),
    )


def _safe_worker_diagnostic(payload: object) -> dict[str, bool | int | str] | None:
    if not isinstance(payload, dict) or payload.get("category") not in _SAFE_WORKER_CATEGORIES:
        return None
    finalized_exists = payload.get("finalized_file_existed")
    finalized_count = payload.get("finalized_file_count")
    incomplete_count = payload.get("incomplete_file_count")
    postconditions_passed = payload.get("postconditions_passed")
    if (
        not isinstance(finalized_exists, bool)
        or not isinstance(finalized_count, int)
        or isinstance(finalized_count, bool)
        or not 0 <= finalized_count <= 10_000
        or not isinstance(incomplete_count, int)
        or isinstance(incomplete_count, bool)
        or not 0 <= incomplete_count <= 10_000
        or not isinstance(postconditions_passed, bool)
        or finalized_exists != (finalized_count > 0)
    ):
        return None
    return {
        "category": str(payload["category"]),
        "finalized_file_existed": finalized_exists,
        "finalized_file_count": finalized_count,
        "incomplete_file_count": incomplete_count,
        "postconditions_passed": postconditions_passed,
    }


def _log_worker_diagnostic(
    *, operation: str, result: ProcessResult, diagnostic: dict[str, bool | int | str]
) -> None:
    values = {
        "worker": "yt-dlp",
        "stage": operation,
        "exit_code": result.returncode,
        **diagnostic,
    }
    logger = get_logger()
    if diagnostic["postconditions_passed"] is True and result.returncode == 0:
        logger.info("youtube_worker_recovery", **values)
    else:
        logger.error("youtube_worker_recovery_failed", **values)


def _raise_process_failure(*, operation: str, result: ProcessResult, result_state: str) -> NoReturn:
    _log_worker_failure(operation=operation, result=result, result_state=result_state)
    if result.returncode < 0:
        raise VideoMCPError(
            ErrorCode.DOWNLOAD_FAILED,
            "The yt-dlp worker was terminated unexpectedly. Check the server logs.",
            retryable=True,
        )
    if result_state == "structured_failure":
        raise VideoMCPError(
            ErrorCode.DOWNLOAD_FAILED, "The YouTube operation failed.", retryable=True
        )
    raise VideoMCPError(
        ErrorCode.DOWNLOAD_FAILED,
        "The yt-dlp worker failed to start correctly. Check the configured Python interpreter "
        "and server logs.",
    )


async def _run_worker(
    *,
    operation: str,
    validated: ValidatedYoutubeUrl,
    working_directory: Path,
    settings: Settings,
    caption_policy: YoutubeTranscriptPolicy = YoutubeTranscriptPolicy.CREATOR_CAPTIONS_THEN_WHISPER,
    language: str = "auto",
) -> dict[str, Any]:
    result_path = working_directory / f"yt-result-{secrets.token_hex(8)}.json"
    arguments = [
        str(settings.resolved_python_path),
        "-m",
        "video_understanding_mcp.workers.yt_dlp_worker",
        "--operation",
        operation,
        "--url",
        validated.canonical_url,
        "--video-id",
        validated.video_id,
        "--result",
        str(result_path),
        "--max-bytes",
        str(settings.max_source_bytes),
        "--max-duration",
        str(settings.max_duration_seconds),
        "--retries",
        str(settings.download_retries),
        "--socket-timeout",
        "30",
        "--language",
        language,
        "--caption-policy",
        caption_policy.value,
    ]
    if operation == "download":
        arguments.extend(["--output-dir", str(working_directory)])
    result = await run_process(
        arguments,
        timeout_seconds=(120 if operation == "preflight" else settings.max_job_wall_seconds),
        cwd=working_directory,
        env=minimal_environment(working_directory),
        cpu_time_limit_seconds=settings.max_subprocess_cpu_seconds,
        memory_limit_bytes=settings.max_subprocess_memory_bytes,
    )
    payload: Any = None
    result_state = "missing"
    try:
        try:
            serialized = result_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            pass
        except (OSError, UnicodeError):
            result_state = "unreadable"
        else:
            try:
                payload = json.loads(serialized)
            except json.JSONDecodeError:
                result_state = "malformed"
            else:
                result_state = "decoded"
    finally:
        result_path.unlink(missing_ok=True)

    if isinstance(payload, dict) and payload.get("ok") is False:
        result_state = "structured_failure"
    diagnostic = _safe_worker_diagnostic(
        payload.get("diagnostic") if isinstance(payload, dict) else None
    )
    if diagnostic is not None:
        _log_worker_diagnostic(operation=operation, result=result, diagnostic=diagnostic)
    if result.returncode != 0:
        _raise_process_failure(operation=operation, result=result, result_state=result_state)
    if result_state == "missing":
        _log_worker_failure(operation=operation, result=result, result_state=result_state)
        raise VideoMCPError(
            ErrorCode.DOWNLOAD_FAILED,
            "The yt-dlp worker exited without returning a result. Check the server logs.",
        )
    if result_state in {"unreadable", "malformed"} or not isinstance(payload, dict):
        _log_worker_failure(operation=operation, result=result, result_state=result_state)
        raise VideoMCPError(
            ErrorCode.DOWNLOAD_FAILED,
            "The yt-dlp worker returned malformed result data. Check the server logs.",
        )
    if payload.get("ok") is not True:
        _log_worker_failure(operation=operation, result=result, result_state=result_state)
        raise VideoMCPError(
            ErrorCode.DOWNLOAD_FAILED, "The YouTube operation failed.", retryable=True
        )
    data = payload.get("result")
    if not isinstance(data, dict):
        raise VideoMCPError(
            ErrorCode.DOWNLOAD_FAILED, "The YouTube operation returned invalid data."
        )
    return data


async def preflight_youtube(
    validated: ValidatedYoutubeUrl, *, working_directory: Path, settings: Settings
) -> dict[str, Any]:
    return await _run_worker(
        operation="preflight",
        validated=validated,
        working_directory=working_directory,
        settings=settings,
    )


async def download_youtube(
    validated: ValidatedYoutubeUrl,
    *,
    working_directory: Path,
    settings: Settings,
    caption_policy: YoutubeTranscriptPolicy,
    language: str,
) -> tuple[Path, dict[str, Any], list[Path]]:
    data = await _run_worker(
        operation="download",
        validated=validated,
        working_directory=working_directory,
        settings=settings,
        caption_policy=caption_policy,
        language=language,
    )
    filename = data.get("media_filename")
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise VideoMCPError(ErrorCode.DOWNLOAD_FAILED, "The downloaded media filename is invalid.")
    media = working_directory / filename
    if not await asyncio.to_thread(_safe_child_file, media, working_directory):
        raise VideoMCPError(ErrorCode.DOWNLOAD_FAILED, "The downloaded media is unavailable.")
    captions: list[Path] = []
    raw_captions = data.get("caption_filenames")
    if isinstance(raw_captions, list):
        for item in raw_captions:
            if isinstance(item, str) and Path(item).name == item:
                candidate = working_directory / item
                if await asyncio.to_thread(_safe_child_file, candidate, working_directory):
                    captions.append(candidate)
    return media, data, captions


def _safe_child_file(candidate: Path, root: Path) -> bool:
    return candidate.is_file() and candidate.resolve().is_relative_to(root.resolve())
