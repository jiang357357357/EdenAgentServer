"""YouTube content-first automatic frame plan."""

from __future__ import annotations

import math

from ..errors import ErrorCode, VideoMCPError
from .models import FramePlan, evenly_distributed_timestamps_exclusive


def build_youtube_content_first_plan(
    *,
    start_ms: int,
    end_ms: int,
    administrator_max_frames: int = 3000,
    request_max_frames: int | None = None,
    soft_target_frames: int | None = None,
    scene_threshold: float | None = None,
    near_duplicate_threshold: float | None = None,
) -> FramePlan:
    if end_ms <= start_ms:
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT, "The selected range must have positive duration."
        )
    duration_seconds = (end_ms - start_ms) / 1000.0
    interval = max(2.0, min(duration_seconds / 120.0, 10.0))
    base_count = max(1, math.ceil(duration_seconds / interval))
    effective_max = administrator_max_frames if request_max_frames is None else request_max_frames
    if effective_max > administrator_max_frames:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "request_max_frames exceeds the administrator frame limit.",
        )
    if base_count > effective_max:
        base_count = effective_max
    derived_target = min(effective_max, math.ceil(base_count * 1.35))
    final_target = derived_target if soft_target_frames is None else soft_target_frames
    if final_target > effective_max:
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT,
            "soft_target_frames cannot exceed request_max_frames.",
        )
    return FramePlan(
        profile="content_first",
        mode="auto",
        start_ms=start_ms,
        end_ms=end_ms,
        calculated_interval_seconds=interval,
        soft_base_target=base_count,
        soft_final_target=final_target,
        request_max_frames=effective_max,
        administrator_max_frames=administrator_max_frames,
        base_timestamps_ms=evenly_distributed_timestamps_exclusive(start_ms, end_ms, base_count),
        scene_threshold=0.30 if scene_threshold is None else scene_threshold,
        near_duplicate_threshold=(
            0.98 if near_duplicate_threshold is None else near_duplicate_threshold
        ),
        scene_budget_ratio=0.35,
    )


def youtube_scene_budget(base_count: int, *, high_dynamic: bool, remaining_capacity: int) -> int:
    ratio = 0.50 if high_dynamic else 0.35
    return max(0, min(math.floor(base_count * ratio), remaining_capacity))
