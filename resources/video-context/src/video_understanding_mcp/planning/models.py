"""Planner data structures."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class CandidateKind(StrEnum):
    BASE = "base"
    SCENE = "scene"
    CHAPTER = "chapter"
    ENDPOINT = "endpoint"
    TIMESTAMP = "timestamp"


@dataclass(frozen=True)
class FrameCandidate:
    timestamp_ms: int
    kind: CandidateKind
    scene_score: float = 0.0
    perceptual_difference: float = 0.0
    chapter_distance_ms: int | None = None
    silent_visual: bool = False
    static_score: float = 0.0
    decoded_index: int = 0


@dataclass(frozen=True)
class FramePlan:
    profile: str
    mode: str
    start_ms: int
    end_ms: int
    calculated_interval_seconds: float | None
    soft_base_target: int | None
    soft_final_target: int | None
    request_max_frames: int
    administrator_max_frames: int
    base_timestamps_ms: tuple[int, ...]
    scene_threshold: float
    near_duplicate_threshold: float
    scene_budget_ratio: float
    near_duplicate_enabled: bool = True
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @property
    def base_candidate_count(self) -> int:
        return len(self.base_timestamps_ms)


def evenly_distributed_timestamps(start_ms: int, end_ms: int, count: int) -> tuple[int, ...]:
    if count <= 0 or end_ms <= start_ms:
        return ()
    if count == 1:
        return (start_ms,)
    span = end_ms - start_ms
    return tuple(round(start_ms + (span * index / (count - 1))) for index in range(count))


def evenly_distributed_timestamps_exclusive(
    start_ms: int, end_ms: int, count: int
) -> tuple[int, ...]:
    """Distribute automatic candidates inside the half-open processing range."""
    if count <= 0 or end_ms <= start_ms:
        return ()
    span = end_ms - start_ms
    effective_count = min(count, span)
    return tuple(
        round(start_ms + (span * index / effective_count)) for index in range(effective_count)
    )
