"""Balanced automatic planning preset."""

from __future__ import annotations

import math

from ..errors import ErrorCode, VideoMCPError
from .models import FramePlan, evenly_distributed_timestamps_exclusive


def build_balanced_plan(
    *,
    start_ms: int,
    end_ms: int,
    administrator_max_frames: int,
    request_max_frames: int | None,
    soft_target_frames: int | None,
    scene_threshold: float | None,
    near_duplicate_threshold: float | None,
) -> FramePlan:
    duration_seconds = (end_ms - start_ms) / 1000.0
    if duration_seconds <= 0:
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT, "The selected range must have positive duration."
        )
    interval = max(2.0, min(duration_seconds / 120.0, 10.0))
    maximum = administrator_max_frames if request_max_frames is None else request_max_frames
    if maximum > administrator_max_frames:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "request_max_frames exceeds the administrator frame limit.",
        )
    base_count = min(max(1, math.ceil(duration_seconds / interval)), maximum)
    target = min(maximum, math.ceil(base_count * 1.25))
    if soft_target_frames is not None:
        target = soft_target_frames
    if target > maximum:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "soft target exceeds request maximum.")
    return FramePlan(
        profile="balanced",
        mode="auto",
        start_ms=start_ms,
        end_ms=end_ms,
        calculated_interval_seconds=interval,
        soft_base_target=base_count,
        soft_final_target=target,
        request_max_frames=maximum,
        administrator_max_frames=administrator_max_frames,
        base_timestamps_ms=evenly_distributed_timestamps_exclusive(start_ms, end_ms, base_count),
        scene_threshold=0.35 if scene_threshold is None else scene_threshold,
        near_duplicate_threshold=(
            0.96 if near_duplicate_threshold is None else near_duplicate_threshold
        ),
        scene_budget_ratio=0.35,
    )
