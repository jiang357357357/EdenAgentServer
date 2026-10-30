"""Runtime dependency and administrator-limit diagnostics."""

from __future__ import annotations

import asyncio
import importlib.util
import re
import secrets
import shutil
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from .config import Settings
from .constants import MINIMUM_FFMPEG_MAJOR
from .errors import VideoMCPError
from .media.probe import resolve_executable
from .schemas import DependencyStatus, DoctorResult, WarningMessage
from .security.subprocesses import run_process
from .transcription.whisper import installed_model_path


def _package_status(distribution: str, module: str) -> DependencyStatus:
    available = importlib.util.find_spec(module) is not None
    package_version: str | None = None
    detail: str | None = None
    if available:
        try:
            package_version = version(distribution)
        except PackageNotFoundError:
            detail = "Importable, but distribution metadata is unavailable."
    return DependencyStatus(available=available, version=package_version, detail=detail)


def parse_ffmpeg_major(version_line: str) -> int | None:
    match = re.search(r"\bff(?:mpeg|probe) version (\d+)(?:\.|\b)", version_line)
    return int(match.group(1)) if match is not None else None


async def _binary_status(configured: Path | None, name: str) -> DependencyStatus:
    try:
        executable = resolve_executable(configured, name)
        result = await run_process(
            [str(executable), "-version"],
            timeout_seconds=10,
            cwd=executable.parent,
            cpu_time_limit_seconds=10,
        )
        first_line = result.stdout.decode("utf-8", "replace").splitlines()[0][:240]
        major = parse_ffmpeg_major(first_line)
        supported = major is not None and major >= MINIMUM_FFMPEG_MAJOR
        return DependencyStatus(
            available=result.returncode == 0 and supported,
            version=first_line or None,
            detail=(
                None
                if result.returncode == 0 and supported
                else f"Version {MINIMUM_FFMPEG_MAJOR} or newer is required."
            ),
        )
    except (VideoMCPError, OSError, ValueError, IndexError):
        return DependencyStatus(available=False, detail=f"{name} is unavailable.")


def _cache_writable(settings: Settings) -> bool:
    settings.prepare_private_directories()
    probe = settings.cache_dir / f".doctor-{secrets.token_hex(8)}"
    try:
        with probe.open("x", encoding="utf-8") as handle:
            handle.write("ok")
        return True
    except OSError:
        return False
    finally:
        probe.unlink(missing_ok=True)


async def run_doctor(settings: Settings) -> DoctorResult:
    ffmpeg, ffprobe = await asyncio.gather(
        _binary_status(settings.ffmpeg_path, "ffmpeg"),
        _binary_status(settings.ffprobe_path, "ffprobe"),
    )
    cache_writable = await asyncio.to_thread(_cache_writable, settings)
    try:
        free = await asyncio.to_thread(lambda: shutil.disk_usage(settings.cache_dir).free)
    except OSError:
        free = 0
    installed = [
        model
        for model in settings.approved_whisper_models
        if installed_model_path(model, settings) is not None
    ]
    unavailable = [model for model in settings.approved_whisper_models if model not in installed]
    python_status = DependencyStatus(
        available=sys.version_info >= (3, 11),
        version=sys.version.split()[0],
        detail=f"executable={settings.resolved_python_path}",
    )
    mcp_sdk = _package_status("mcp", "mcp")
    yt_dlp = _package_status("yt-dlp", "yt_dlp")
    whisper = _package_status("faster-whisper", "faster_whisper")
    healthy = (
        all(
            status.available
            for status in (python_status, mcp_sdk, ffmpeg, ffprobe, yt_dlp, whisper)
        )
        and cache_writable
    )
    return DoctorResult(
        healthy=healthy,
        python=python_status,
        mcp_sdk=mcp_sdk,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        yt_dlp=yt_dlp,
        whisper_backend=whisper,
        cache_directory=str(settings.cache_dir),
        cache_writable=cache_writable,
        allowed_directories=[str(path) for path in settings.allowed_directories],
        installed_approved_models=installed,
        unavailable_approved_models=unavailable,
        default_model=settings.default_whisper_model,
        model_cache=str(settings.resolved_model_cache_dir),
        free_bytes=free,
        webp_enabled=settings.enable_webp,
        configured_limits={
            "max_source_bytes": settings.max_source_bytes,
            "max_duration_seconds": settings.max_duration_seconds,
            "max_source_width": settings.max_source_width,
            "max_source_height": settings.max_source_height,
            "max_source_pixels": settings.max_source_pixels,
            "max_source_fps": settings.max_source_fps,
            "max_streams": settings.max_streams,
            "max_output_frames": settings.max_output_frames,
            "max_output_image_pixels": settings.max_output_image_pixels,
            "max_completed_output_bytes": settings.max_completed_output_bytes,
            "max_transcript_chars": settings.max_transcript_chars,
            "max_job_wall_seconds": settings.max_job_wall_seconds,
            "max_subprocess_cpu_seconds": settings.max_subprocess_cpu_seconds,
            "max_subprocess_memory_bytes": settings.max_subprocess_memory_bytes,
            "max_frame_retrieval": settings.max_frame_retrieval,
            "max_frame_retrieval_bytes": settings.max_frame_retrieval_bytes,
            "max_frame_retrieval_pixels": settings.max_frame_retrieval_pixels,
            "max_preview_retrieval": settings.max_preview_retrieval,
            "max_preview_retrieval_bytes": settings.max_preview_retrieval_bytes,
            "max_preview_retrieval_pixels": settings.max_preview_retrieval_pixels,
            "max_concurrent_retrievals": settings.max_concurrent_retrievals,
            "max_pending_retrievals": settings.max_pending_retrievals,
            "max_preview_width": settings.max_preview_width,
            "timeline_max_chars": settings.timeline_max_chars,
            "max_concurrent_jobs": settings.max_concurrent_jobs,
            "max_queued_jobs": settings.max_queued_jobs,
            "normal_ttl_seconds": settings.normal_ttl_seconds,
            "ephemeral_ttl_seconds": settings.ephemeral_ttl_seconds,
            "max_cache_bytes": settings.max_cache_bytes,
            "min_free_bytes": settings.min_free_bytes,
            "download_retries": settings.download_retries,
        },
        warnings=(
            []
            if installed
            else [
                WarningMessage(
                    code="MODEL_NOT_INSTALLED",
                    message=(
                        "No approved Whisper model is installed; transcription will be partial."
                    ),
                )
            ]
        ),
    )
