"""Corrected local token-saver planner with no maximum interval clamp."""

from __future__ import annotations

import math

from ..errors import ErrorCode, VideoMCPError
from .models import FramePlan, evenly_distributed_timestamps_exclusive


def build_local_token_saver_plan(
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
    # Required correction: no maximum interval. Long videos directly produce about 90 bases.
    local_interval = max(duration_seconds / 90.0, 3.0)
    base_count = max(1, math.ceil(duration_seconds / local_interval))

    effective_max = 180 if request_max_frames is None else request_max_frames
    if effective_max > administrator_max_frames:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "request_max_frames exceeds the administrator frame limit.",
        )
    final_target = min(120, effective_max) if soft_target_frames is None else soft_target_frames
    if final_target > effective_max:
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT,
            "soft_target_frames cannot exceed request_max_frames.",
        )
    timestamps = evenly_distributed_timestamps_exclusive(
        start_ms, end_ms, min(base_count, effective_max)
    )
    return FramePlan(
        profile="token_saver",
        mode="auto",
        start_ms=start_ms,
        end_ms=end_ms,
        calculated_interval_seconds=local_interval,
        soft_base_target=90,
        soft_final_target=final_target,
        request_max_frames=effective_max,
        administrator_max_frames=administrator_max_frames,
        base_timestamps_ms=timestamps,
        scene_threshold=0.45 if scene_threshold is None else scene_threshold,
        near_duplicate_threshold=(
            0.94 if near_duplicate_threshold is None else near_duplicate_threshold
        ),
        scene_budget_ratio=1 / 3,
    )
