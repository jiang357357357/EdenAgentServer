"""Deterministic cap-pressure candidate selection."""

from __future__ import annotations

from collections import defaultdict

from .models import CandidateKind, FrameCandidate

_KIND_PRIORITY = {
    CandidateKind.TIMESTAMP: 6,
    CandidateKind.ENDPOINT: 5,
    CandidateKind.CHAPTER: 4,
    CandidateKind.SCENE: 3,
    CandidateKind.BASE: 1,
}


def candidate_value(candidate: FrameCandidate) -> float:
    chapter = 1.0 if candidate.kind is CandidateKind.CHAPTER else 0.0
    silent = 0.25 if candidate.silent_visual else 0.0
    return (
        _KIND_PRIORITY[candidate.kind]
        + 3.0 * candidate.scene_score
        + 2.0 * candidate.perceptual_difference
        + chapter
        + silent
        - candidate.static_score
    )


def _dedupe_exact(candidates: list[FrameCandidate]) -> list[FrameCandidate]:
    grouped: dict[int, list[FrameCandidate]] = defaultdict(list)
    for candidate in candidates:
        grouped[candidate.timestamp_ms].append(candidate)
    result: list[FrameCandidate] = []
    for timestamp in sorted(grouped):
        result.append(
            max(
                grouped[timestamp],
                key=lambda item: (
                    _KIND_PRIORITY[item.kind],
                    item.scene_score,
                    item.perceptual_difference,
                    -item.decoded_index,
                ),
            )
        )
    return result


def select_candidates(
    candidates: list[FrameCandidate],
    *,
    start_ms: int,
    end_ms: int,
    maximum: int,
    profile: str,
) -> list[FrameCandidate]:
    unique = _dedupe_exact(candidates)
    if len(unique) <= maximum:
        return unique
    coverage_ratio = dict(token_saver=0.75, balanced=0.70, content_first=0.67).get(profile, 0.70)
    endpoints = [item for item in unique if item.kind is CandidateKind.ENDPOINT]
    selected: dict[int, FrameCandidate] = {item.timestamp_ms: item for item in endpoints[:2]}
    coverage_slots = max(len(selected), int(maximum * coverage_ratio))
    span = max(1, end_ms - start_ms)
    bucket_width = span / max(1, coverage_slots)

    for bucket_index in range(coverage_slots):
        low = start_ms + bucket_index * bucket_width
        high = start_ms + (bucket_index + 1) * bucket_width
        members = [
            item
            for item in unique
            if low <= item.timestamp_ms <= high and item.timestamp_ms not in selected
        ]
        if not members:
            continue
        center = (low + high) / 2
        chosen = max(
            members,
            key=lambda item: (
                candidate_value(item),
                -abs(item.timestamp_ms - center),
                -item.timestamp_ms,
                -item.decoded_index,
            ),
        )
        selected[chosen.timestamp_ms] = chosen
        if len(selected) >= coverage_slots:
            break

    significant = sorted(
        (item for item in unique if item.timestamp_ms not in selected),
        key=lambda item: (
            candidate_value(item),
            _KIND_PRIORITY[item.kind],
            -item.timestamp_ms,
            -item.decoded_index,
        ),
        reverse=True,
    )
    for item in significant:
        if len(selected) >= maximum:
            break
        if item.kind is CandidateKind.BASE and candidate_value(item) <= 1.0:
            continue
        selected[item.timestamp_ms] = item

    # Only fill remaining gaps with candidates that improve chronological coverage.
    while len(selected) < maximum:
        remaining = [item for item in unique if item.timestamp_ms not in selected]
        if not remaining:
            break
        positions = sorted(selected) or [start_ms, end_ms]
        chosen = max(
            remaining,
            key=lambda item: (
                min(abs(item.timestamp_ms - position) for position in positions),
                candidate_value(item),
                -item.timestamp_ms,
            ),
        )
        if candidate_value(chosen) <= 1.0:
            break
        selected[chosen.timestamp_ms] = chosen
    return [selected[key] for key in sorted(selected)][:maximum]


def nearest_timestamp(target_ms: int, decoded_pts_ms: list[int]) -> tuple[int, int]:
    """Return nearest PTS and signed difference; exact ties choose the earlier frame."""
    if not decoded_pts_ms:
        raise ValueError("decoded_pts_ms must not be empty")
    actual = min(decoded_pts_ms, key=lambda value: (abs(value - target_ms), value))
    return actual, actual - target_ms
