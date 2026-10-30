"""FFprobe inspection with strict resource-limit enforcement."""

from __future__ import annotations

import asyncio
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import Settings
from ..constants import LOCAL_FORMAT_WHITELIST, LOCAL_PROTOCOL_WHITELIST, SAFE_INPUT_DEMUXERS
from ..errors import ErrorCode, VideoMCPError
from ..schemas import SafeSourceMetadata, SourceType
from ..security.subprocesses import run_process


@dataclass(frozen=True)
class Chapter:
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class ProbeResult:
    metadata: SafeSourceMetadata
    duration_seconds: float
    has_video: bool
    has_audio: bool
    chapters: tuple[Chapter, ...]


def resolve_executable(configured: Path | None, name: str) -> Path:
    if configured is not None:
        candidate = configured.expanduser().resolve(strict=True)
    else:
        located = shutil.which(name)
        if located is None:
            raise VideoMCPError(
                ErrorCode.DEPENDENCY_MISSING, f"Required executable {name} is missing."
            )
        candidate = Path(located).resolve()
    if not candidate.is_file():
        raise VideoMCPError(ErrorCode.DEPENDENCY_MISSING, f"Required executable {name} is invalid.")
    return candidate


def _fraction(value: str | None) -> float | None:
    if not value or value in {"0/0", "N/A"}:
        return None
    try:
        numerator, denominator = value.split("/", 1)
        result = float(numerator) / float(denominator)
    except (ValueError, ZeroDivisionError):
        return None
    return result if math.isfinite(result) and result >= 0 else None


def _safe_string(value: object, maximum: int = 80) -> str | None:
    if not isinstance(value, str):
        return None
    clean = " ".join(value.replace("\x00", " ").replace("\t", " ").splitlines())
    return " ".join(clean.split())[:maximum] or None


def parse_probe_json(
    payload: dict[str, Any],
    *,
    source_type: SourceType,
    display_name: str | None,
    source_size: int | None,
    settings: Settings,
) -> ProbeResult:
    streams = payload.get("streams")
    format_data = payload.get("format")
    if not isinstance(streams, list) or not isinstance(format_data, dict):
        raise VideoMCPError(
            ErrorCode.UNSUPPORTED_MEDIA, "FFprobe returned incomplete media metadata."
        )
    if len(streams) > settings.max_streams:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Media contains too many streams.")
    format_name = format_data.get("format_name")
    demuxers = set(format_name.split(",")) if isinstance(format_name, str) else set()
    if not demuxers or not demuxers.issubset(SAFE_INPUT_DEMUXERS):
        raise VideoMCPError(
            ErrorCode.UNSUPPORTED_MEDIA, "The media container/demuxer is not allowed."
        )

    videos = [
        item for item in streams if isinstance(item, dict) and item.get("codec_type") == "video"
    ]
    audios = [
        item for item in streams if isinstance(item, dict) and item.get("codec_type") == "audio"
    ]
    subtitles = [
        item for item in streams if isinstance(item, dict) and item.get("codec_type") == "subtitle"
    ]
    if not videos:
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "Media has no decodable video stream.")

    primary = videos[0]
    width = int(primary.get("width") or 0)
    height = int(primary.get("height") or 0)
    fps = _fraction(primary.get("avg_frame_rate") or primary.get("r_frame_rate"))
    duration_value = format_data.get("duration") or primary.get("duration")
    if not isinstance(duration_value, (str, int, float)):
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "Media duration is unavailable.")
    try:
        duration = float(duration_value)
    except (TypeError, ValueError) as exc:
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "Media duration is unavailable.") from exc

    if not math.isfinite(duration) or duration <= 0:
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "Media duration is invalid.")
    if duration > settings.max_duration_seconds:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Media exceeds the duration limit.")
    if width <= 0 or height <= 0:
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "Media dimensions are invalid.")
    if width > settings.max_source_width or height > settings.max_source_height:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Media dimensions exceed limits.")
    if width * height > settings.max_source_pixels:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Media pixel count exceeds limits.")
    if fps is not None and fps > settings.max_source_fps:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Media frame rate exceeds limits.")

    actual_size = source_size
    if actual_size is None:
        size_value = format_data.get("size")
        if isinstance(size_value, (str, int, float)):
            try:
                actual_size = int(size_value)
            except ValueError:
                actual_size = None
    if actual_size is not None and actual_size > settings.max_source_bytes:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Media exceeds the source byte limit."
        )

    raw_chapters = payload.get("chapters")
    chapters: list[Chapter] = []
    if isinstance(raw_chapters, list):
        for item in raw_chapters[: settings.max_streams * 100]:
            if not isinstance(item, dict):
                continue
            try:
                start_ms = round(float(item["start_time"]) * 1000)
                end_ms = round(float(item["end_time"]) * 1000)
            except (KeyError, TypeError, ValueError):
                continue
            if 0 <= start_ms < end_ms <= round(duration * 1000) + 1:
                chapters.append(Chapter(start_ms=start_ms, end_ms=end_ms))

    other_count = len(streams) - len(videos) - len(audios) - len(subtitles)
    metadata = SafeSourceMetadata(
        source_type=source_type,
        display_title_or_filename=display_name,
        duration_ms=round(duration * 1000),
        container=_safe_string(format_data.get("format_name")),
        width=width,
        height=height,
        display_aspect_ratio=_safe_string(primary.get("display_aspect_ratio")),
        source_fps=fps,
        video_codec=_safe_string(primary.get("codec_name")),
        audio_codec=_safe_string(audios[0].get("codec_name")) if audios else None,
        video_stream_count=len(videos),
        audio_stream_count=len(audios),
        subtitle_stream_count=len(subtitles),
        other_stream_count=max(0, other_count),
        source_size_bytes=actual_size,
        chapters_available=bool(chapters),
    )
    return ProbeResult(
        metadata=metadata,
        duration_seconds=duration,
        has_video=True,
        has_audio=bool(audios),
        chapters=tuple(chapters),
    )


async def probe_media(
    path: Path,
    *,
    source_type: SourceType,
    display_name: str | None,
    settings: Settings,
) -> ProbeResult:
    ffprobe = resolve_executable(settings.ffprobe_path, "ffprobe")
    result = await run_process(
        [
            str(ffprobe),
            "-v",
            "error",
            "-protocol_whitelist",
            LOCAL_PROTOCOL_WHITELIST,
            "-format_whitelist",
            LOCAL_FORMAT_WHITELIST,
            "-show_format",
            "-show_streams",
            "-show_chapters",
            "-of",
            "json",
            str(path),
        ],
        timeout_seconds=min(settings.subprocess_timeout_seconds, 120),
        cwd=path.parent,
        cpu_time_limit_seconds=settings.max_subprocess_cpu_seconds,
        memory_limit_bytes=settings.max_subprocess_memory_bytes,
    )
    if result.returncode != 0 or result.stdout_truncated:
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "FFprobe could not validate the media.")
    try:
        payload = json.loads(result.stdout)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise VideoMCPError(
            ErrorCode.UNSUPPORTED_MEDIA, "FFprobe returned invalid metadata."
        ) from exc
    if not isinstance(payload, dict):
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "FFprobe returned invalid metadata.")
    return parse_probe_json(
        payload,
        source_type=source_type,
        display_name=display_name,
        source_size=await asyncio.to_thread(lambda: path.stat().st_size),
        settings=settings,
    )
