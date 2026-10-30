"""Explicit sampling plan construction."""

from __future__ import annotations

import math

from ..errors import ErrorCode, VideoMCPError
from ..schemas import (
    FpsSampling,
    HybridSampling,
    IntervalSampling,
    SceneSampling,
    TimestampSampling,
)
from .models import FramePlan, evenly_distributed_timestamps


def _limit(requested: int | None, administrator: int) -> int:
    value = administrator if requested is None else requested
    if value > administrator:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "request_max_frames exceeds the administrator frame limit.",
        )
    return value


def _bounded_count(derived: float, maximum: int, message: str) -> int:
    if not math.isfinite(derived) or derived > maximum:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, message)
    return max(1, math.ceil(derived))


def build_explicit_plan(
    sampling: IntervalSampling | FpsSampling | SceneSampling | HybridSampling | TimestampSampling,
    *,
    start_ms: int,
    end_ms: int,
    administrator_max_frames: int,
) -> FramePlan:
    duration_seconds = (end_ms - start_ms) / 1000.0
    maximum = _limit(sampling.request_max_frames, administrator_max_frames)
    interval: float | None = None
    timestamps: tuple[int, ...] = ()
    scene_threshold = 0.35
    scene_ratio = 0.0
    target = getattr(sampling, "soft_target_frames", None)

    if isinstance(sampling, IntervalSampling):
        interval = sampling.capture_interval_seconds
        count = _bounded_count(
            duration_seconds / interval,
            maximum,
            "The explicit interval schedule exceeds request_max_frames.",
        )
        timestamps = evenly_distributed_timestamps(start_ms, end_ms, count)
    elif isinstance(sampling, FpsSampling):
        count = _bounded_count(
            duration_seconds * sampling.capture_fps,
            maximum,
            "The explicit FPS schedule exceeds request_max_frames.",
        )
        interval = 1.0 / sampling.capture_fps
        timestamps = evenly_distributed_timestamps(start_ms, end_ms, count)
    elif isinstance(sampling, TimestampSampling):
        absolute = [round(value * 1000) for value in sampling.timestamps_seconds]
        if any(value < start_ms or value > end_ms for value in absolute):
            raise VideoMCPError(
                ErrorCode.INVALID_INPUT,
                "Explicit timestamps must be inside the selected processing range.",
            )
        if len(absolute) > maximum:
            raise VideoMCPError(
                ErrorCode.RESOURCE_LIMIT_EXCEEDED,
                "Explicit timestamp count exceeds request_max_frames.",
            )
        timestamps = tuple(sorted(absolute))
    elif isinstance(sampling, SceneSampling):
        scene_threshold = sampling.scene_threshold
        scene_ratio = 1.0
    elif isinstance(sampling, HybridSampling):
        scene_threshold = sampling.scene_threshold
        scene_ratio = 0.5
        if sampling.base.mode == "interval":
            interval = sampling.base.capture_interval_seconds
            derived_count = duration_seconds / interval
        else:
            derived_count = duration_seconds * sampling.base.capture_fps
            interval = None
        count = _bounded_count(
            derived_count,
            maximum,
            "The hybrid base schedule exceeds request_max_frames.",
        )
        if sampling.base.mode == "fps":
            interval = 1.0 / sampling.base.capture_fps
        timestamps = evenly_distributed_timestamps(start_ms, end_ms, count)

    dedup = sampling.near_duplicates
    return FramePlan(
        profile="custom",
        mode=sampling.mode,
        start_ms=start_ms,
        end_ms=end_ms,
        calculated_interval_seconds=interval,
        soft_base_target=len(timestamps) or None,
        soft_final_target=target,
        request_max_frames=maximum,
        administrator_max_frames=administrator_max_frames,
        base_timestamps_ms=timestamps,
        scene_threshold=scene_threshold,
        near_duplicate_threshold=(dedup.similarity_threshold if dedup else 0.96),
        scene_budget_ratio=scene_ratio,
        near_duplicate_enabled=dedup.enabled if dedup is not None else True,
    )
