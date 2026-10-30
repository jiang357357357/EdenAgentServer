"""Range and media limit enforcement."""

from __future__ import annotations

import math

from ..config import Settings
from ..errors import ErrorCode, VideoMCPError
from ..schemas import ProcessingRange, ResolvedRange


def resolve_processing_range(
    requested: ProcessingRange | None,
    *,
    media_duration_seconds: float,
    settings: Settings,
) -> ResolvedRange:
    if not math.isfinite(media_duration_seconds) or media_duration_seconds <= 0:
        raise VideoMCPError(
            ErrorCode.UNSUPPORTED_MEDIA, "The media duration is unavailable or invalid."
        )
    maximum_end = min(media_duration_seconds, settings.max_duration_seconds)
    requested = requested or ProcessingRange()
    start = requested.start_time_seconds if requested.start_time_seconds is not None else 0.0
    end = (
        requested.end_time_seconds
        if requested.end_time_seconds is not None
        else media_duration_seconds
    )
    if end > media_duration_seconds + 1e-6:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "The requested range exceeds media duration.")
    if end > settings.max_duration_seconds + 1e-6 or end - start > settings.max_duration_seconds:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "The requested range exceeds the administrator duration limit.",
        )
    if start < 0 or start >= end or end > maximum_end + 1e-6:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "The requested processing range is invalid.")
    start_ms = round(start * 1000)
    end_ms = round(end * 1000)
    return ResolvedRange(start_ms=start_ms, end_ms=end_ms, duration_ms=end_ms - start_ms)


def enforce_request_frame_limit(requested: int | None, settings: Settings, *, default: int) -> int:
    value = default if requested is None else requested
    if value > settings.max_output_frames:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "request_max_frames exceeds the administrator frame limit.",
            field="request_max_frames",
        )
    return value
