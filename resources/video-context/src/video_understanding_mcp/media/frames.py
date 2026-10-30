"""Deterministic, bounded frame extraction and perceptual candidate reduction."""

from __future__ import annotations

import asyncio
import importlib
import json
import math
import re
import shutil
from bisect import bisect_left
from collections import defaultdict, deque
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Any, Literal

from ..config import Settings
from ..constants import LOCAL_FORMAT_WHITELIST, LOCAL_PROTOCOL_WHITELIST
from ..errors import ErrorCode, VideoMCPError
from ..logging import get_logger
from ..planning.models import CandidateKind, FrameCandidate, FramePlan
from ..planning.prioritization import nearest_timestamp, select_candidates
from ..planning.youtube_content_first import youtube_scene_budget
from ..schemas import (
    ExactSizing,
    FitSizing,
    ImageSettings,
    JpegEncoding,
    OriginalSizing,
    PngEncoding,
    WebpEncoding,
)
from ..security.subprocesses import run_process
from ..security.threads import finish_thread_before_cancel
from .probe import Chapter, resolve_executable

_SHOWINFO_PTS_ENTRY = re.compile(rb"\bpts_time:([^\s]+)")
_CANDIDATE_FILENAME = re.compile(r"(?:base|scene|endpoint|chapter|timestamp)-[0-9]{6}\.jpg\Z")
_INCOMPLETE_MARKERS = (".part", ".tmp", ".temp", ".ytdl")
_MAX_DIAGNOSTIC_INTEGER = 2**63 - 1
_IMAGE: Any = importlib.import_module("PIL.Image")
_IMAGE_DRAW: Any = importlib.import_module("PIL.ImageDraw")
_IMAGE_OPS: Any = importlib.import_module("PIL.ImageOps")


@dataclass(frozen=True)
class FrameRecord:
    frame_id: str
    filename: str
    timestamp_ms: int
    requested_timestamps_ms: tuple[int, ...]
    signed_differences_ms: tuple[int, ...]
    kind: CandidateKind
    width: int
    height: int
    mime_type: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class FrameExtractionResult:
    records: tuple[FrameRecord, ...]
    base_candidates: int
    scene_candidates: int
    retained_scene_candidates: int
    chapter_candidates: int
    duplicate_frames_removed: int
    scene_budget: int


@dataclass
class _ExtractedCandidate:
    timestamp_ms: int
    requested_timestamps_ms: list[int]
    kind: CandidateKind
    source_path: Path
    scene_score: float = 0.0


@dataclass(frozen=True)
class _ShowinfoParseResult:
    timestamps_ms: tuple[int, ...]
    nonnumeric_entry_count: int
    duplicate_timestamp_count: int
    timestamps_monotonic: bool


def _output_identity(images: ImageSettings, settings: Settings) -> tuple[str, str]:
    encoding = images.encoding
    if isinstance(encoding, JpegEncoding):
        return ".jpg", "image/jpeg"
    if isinstance(encoding, PngEncoding):
        return ".png", "image/png"
    if isinstance(encoding, WebpEncoding):
        if not settings.enable_webp:
            raise VideoMCPError(
                ErrorCode.WEBP_DISABLED, "WebP output is disabled by administrator."
            )
        return ".webp", "image/webp"
    raise VideoMCPError(ErrorCode.INVALID_INPUT, "Image encoding was not resolved.")


def _bounded_dimensions(
    source_width: int,
    source_height: int,
    images: ImageSettings,
    settings: Settings,
) -> tuple[int, int]:
    sizing = images.sizing
    if isinstance(sizing, OriginalSizing):
        width, height = source_width, source_height
    elif isinstance(sizing, FitSizing):
        width_limit = sizing.max_width or source_width
        height_limit = sizing.max_height or source_height
        scale = min(width_limit / source_width, height_limit / source_height)
        if not sizing.allow_upscale:
            scale = min(1.0, scale)
        width, height = max(1, round(source_width * scale)), max(1, round(source_height * scale))
    elif isinstance(sizing, ExactSizing):
        width, height = sizing.width, sizing.height
    else:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "Image sizing was not resolved.")
    if width * height > settings.max_output_image_pixels:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Requested output image pixels exceed limits."
        )
    if width > settings.max_source_width or height > settings.max_source_height:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Requested output dimensions exceed limits."
        )
    return width, height


def _ffmpeg_scale_filter(width: int, height: int) -> str:
    return f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2"


def _filtered_frame_filter_chain(
    *,
    duration_ms: int,
    select_filter: str,
    bound_width: int,
    bound_height: int,
) -> str:
    """Keep range eligibility ahead of selection and timestamp accounting.

    Input seeking rebases decoded timestamps to the selected range, while the
    parser restores source-absolute milliseconds by adding ``start_ms``.  The
    trim therefore intentionally preserves timestamps instead of resetting
    them with ``setpts``.
    """
    range_filter = f"trim=start=0:end={duration_ms / 1000:.3f}"
    return (
        f"{range_filter},select={select_filter},"
        f"{_ffmpeg_scale_filter(bound_width, bound_height)},showinfo"
    )


def _parse_showinfo_timestamps(stderr: bytes, start_ms: int) -> _ShowinfoParseResult:
    timestamps: list[int] = []
    nonnumeric = 0
    for match in _SHOWINFO_PTS_ENTRY.finditer(stderr):
        try:
            seconds = float(match.group(1))
        except ValueError:
            nonnumeric += 1
            continue
        if not math.isfinite(seconds):
            nonnumeric += 1
            continue
        timestamps.append(start_ms + round(seconds * 1000))
    return _ShowinfoParseResult(
        timestamps_ms=tuple(timestamps),
        nonnumeric_entry_count=nonnumeric,
        duplicate_timestamp_count=len(timestamps) - len(set(timestamps)),
        timestamps_monotonic=all(earlier <= later for earlier, later in pairwise(timestamps)),
    )


def _bounded_diagnostic_integer(value: int) -> int:
    return max(-_MAX_DIAGNOSTIC_INTEGER, min(value, _MAX_DIAGNOSTIC_INTEGER))


def _sequence_numbers(paths: list[Path], output_pattern: Path) -> list[int]:
    prefix, suffix = output_pattern.name.split("%06d", 1)
    pattern = re.compile(rf"{re.escape(prefix)}([0-9]{{6}}){re.escape(suffix)}\Z")
    sequences: list[int] = []
    for path in paths:
        match = pattern.fullmatch(path.name)
        if match is not None:
            sequences.append(int(match.group(1)))
    return sequences


def _candidate_directory_state(directory: Path) -> tuple[bool, bool]:
    unexpected = False
    incomplete = False
    for path in directory.iterdir():
        name = path.name
        lowered = name.lower()
        is_incomplete = name.startswith(".") or any(
            marker in lowered for marker in _INCOMPLETE_MARKERS
        )
        incomplete = incomplete or is_incomplete
        if not is_incomplete and _CANDIDATE_FILENAME.fullmatch(name) is None:
            unexpected = True
    return unexpected, incomplete


def _frame_accounting_diagnostic(
    *,
    stage: Literal["base", "scene"],
    start_ms: int,
    duration_ms: int,
    interval_seconds: float | None,
    scene_threshold: float | None,
    maximum: int,
    returncode: int,
    files: list[Path],
    parsed: _ShowinfoParseResult,
    output_pattern: Path,
    stderr_truncated: bool,
    failure_reason: str,
) -> dict[str, int | float | bool | str | None]:
    sequences = _sequence_numbers(files, output_pattern)
    unexpected, incomplete = _candidate_directory_state(output_pattern.parent)
    timestamps = parsed.timestamps_ms
    return {
        "category": f"{stage}_frame_accounting_mismatch",
        "stage": stage,
        "range_start_ms": _bounded_diagnostic_integer(start_ms),
        "range_end_ms": _bounded_diagnostic_integer(start_ms + duration_ms),
        "configured_interval_seconds": (
            round(interval_seconds, 6) if interval_seconds is not None else None
        ),
        "configured_scene_threshold": (
            round(scene_threshold, 6) if scene_threshold is not None else None
        ),
        "frame_cap": _bounded_diagnostic_integer(maximum),
        "ffmpeg_return_code": _bounded_diagnostic_integer(returncode),
        "finalized_file_count": _bounded_diagnostic_integer(len(sequences)),
        "numeric_pts_count": _bounded_diagnostic_integer(len(timestamps)),
        "nonnumeric_pts_entry_count": _bounded_diagnostic_integer(parsed.nonnumeric_entry_count),
        "duplicate_timestamp_count": _bounded_diagnostic_integer(parsed.duplicate_timestamp_count),
        "timestamps_monotonic": parsed.timestamps_monotonic,
        "first_timestamp_ms": (_bounded_diagnostic_integer(timestamps[0]) if timestamps else None),
        "last_timestamp_ms": (_bounded_diagnostic_integer(timestamps[-1]) if timestamps else None),
        "first_finalized_sequence": min(sequences) if sequences else None,
        "last_finalized_sequence": max(sequences) if sequences else None,
        "unexpected_files_present": unexpected,
        "incomplete_files_present": incomplete,
        "stderr_truncated": stderr_truncated,
        "failure_reason": failure_reason,
    }


async def _extract_filtered(
    source: Path,
    output_pattern: Path,
    *,
    start_ms: int,
    duration_ms: int,
    select_filter: str,
    maximum: int,
    bound_width: int,
    bound_height: int,
    settings: Settings,
    stage: Literal["base", "scene"],
    interval_seconds: float | None = None,
    scene_threshold: float | None = None,
    allow_empty: bool = False,
) -> list[tuple[Path, int]]:
    if maximum <= 0:
        return []
    ffmpeg = resolve_executable(settings.ffmpeg_path, "ffmpeg")
    filter_chain = _filtered_frame_filter_chain(
        duration_ms=duration_ms,
        select_filter=select_filter,
        bound_width=bound_width,
        bound_height=bound_height,
    )
    arguments = [
        str(ffmpeg),
        "-nostdin",
        "-v",
        "info",
        "-protocol_whitelist",
        LOCAL_PROTOCOL_WHITELIST,
        "-format_whitelist",
        LOCAL_FORMAT_WHITELIST,
        "-ss",
        f"{start_ms / 1000:.3f}",
        "-i",
        str(source),
        "-t",
        f"{duration_ms / 1000:.3f}",
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        filter_chain,
        "-fps_mode",
        "vfr",
        "-frames:v",
        str(maximum),
        "-q:v",
        "2",
        "-y",
        str(output_pattern),
    ]
    result = await run_process(
        arguments,
        timeout_seconds=settings.max_job_wall_seconds,
        cwd=output_pattern.parent,
        cpu_time_limit_seconds=settings.max_subprocess_cpu_seconds,
        memory_limit_bytes=settings.max_subprocess_memory_bytes,
    )
    files = sorted(output_pattern.parent.glob(output_pattern.name.replace("%06d", "*")))
    parsed = _parse_showinfo_timestamps(result.stderr, start_ms)
    if (
        allow_empty
        and result.returncode != 0
        and not files
        and b"No filtered frames" in result.stderr
    ):
        return []
    if result.returncode != 0 or result.stderr_truncated:
        reason = "ffmpeg_nonzero_exit" if result.returncode != 0 else "ffmpeg_stderr_truncated"
        get_logger().error(
            "frame_accounting_failure",
            **_frame_accounting_diagnostic(
                stage=stage,
                start_ms=start_ms,
                duration_ms=duration_ms,
                interval_seconds=interval_seconds,
                scene_threshold=scene_threshold,
                maximum=maximum,
                returncode=result.returncode,
                files=files,
                parsed=parsed,
                output_pattern=output_pattern,
                stderr_truncated=result.stderr_truncated,
                failure_reason=reason,
            ),
        )
        raise VideoMCPError(ErrorCode.FRAME_EXTRACTION_FAILED, "Frame extraction failed.")
    timestamps = parsed.timestamps_ms
    if len(files) != len(timestamps) or parsed.nonnumeric_entry_count:
        if len(files) > len(timestamps):
            reason = "more_finalized_files_than_numeric_pts"
        elif len(timestamps) > len(files):
            reason = "more_numeric_pts_than_finalized_files"
        else:
            reason = "nonnumeric_pts_entries"
        get_logger().error(
            "frame_accounting_failure",
            **_frame_accounting_diagnostic(
                stage=stage,
                start_ms=start_ms,
                duration_ms=duration_ms,
                interval_seconds=interval_seconds,
                scene_threshold=scene_threshold,
                maximum=maximum,
                returncode=result.returncode,
                files=files,
                parsed=parsed,
                output_pattern=output_pattern,
                stderr_truncated=result.stderr_truncated,
                failure_reason=reason,
            ),
        )
        raise VideoMCPError(
            ErrorCode.FRAME_EXTRACTION_FAILED, "Frame timestamp accounting was incomplete."
        )
    return list(zip(files, timestamps, strict=True))


async def _nearby_pts(source: Path, target_ms: int, settings: Settings) -> list[int]:
    ffprobe = resolve_executable(settings.ffprobe_path, "ffprobe")
    radius_ms = 36_000
    maximum_radius_ms = round(settings.max_duration_seconds * 1000)
    while True:
        window_start = max(0, target_ms - radius_ms)
        window_end = min(maximum_radius_ms, target_ms + radius_ms)
        arguments = [
            str(ffprobe),
            "-v",
            "error",
            "-protocol_whitelist",
            LOCAL_PROTOCOL_WHITELIST,
            "-format_whitelist",
            LOCAL_FORMAT_WHITELIST,
            "-select_streams",
            "v:0",
            "-read_intervals",
            f"{window_start / 1000:.3f}%+{(window_end - window_start) / 1000:.3f}",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            str(source),
        ]
        result = await run_process(
            arguments,
            timeout_seconds=min(settings.subprocess_timeout_seconds, 120),
            cwd=source.parent,
            cpu_time_limit_seconds=settings.max_subprocess_cpu_seconds,
            memory_limit_bytes=settings.max_subprocess_memory_bytes,
        )
        if result.returncode != 0 or result.stdout_truncated:
            raise VideoMCPError(ErrorCode.FRAME_EXTRACTION_FAILED, "Frame timestamp probe failed.")
        try:
            payload: Any = json.loads(result.stdout)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise VideoMCPError(
                ErrorCode.FRAME_EXTRACTION_FAILED, "Frame timestamp probe failed."
            ) from exc
        frames = payload.get("frames") if isinstance(payload, dict) else None
        timestamps: list[int] = []
        if isinstance(frames, list):
            for item in frames:
                value = item.get("best_effort_timestamp_time") if isinstance(item, dict) else None
                if isinstance(value, str):
                    try:
                        timestamp = round(float(value) * 1000)
                    except ValueError:
                        continue
                    if window_start <= timestamp <= window_end:
                        timestamps.append(timestamp)
        if timestamps or (window_start == 0 and window_end == maximum_radius_ms):
            return timestamps
        radius_ms = min(maximum_radius_ms, radius_ms * 2)


async def _extract_exact(
    source: Path,
    destination: Path,
    *,
    requested_ms: int,
    upper_bound_exclusive_ms: int | None = None,
    bound_width: int,
    bound_height: int,
    settings: Settings,
) -> int:
    points = await _nearby_pts(source, requested_ms, settings)
    if upper_bound_exclusive_ms is not None:
        points = [point for point in points if point < upper_bound_exclusive_ms]
    if not points:
        raise VideoMCPError(
            ErrorCode.FRAME_EXTRACTION_FAILED, "No decoded frame is near timestamp."
        )
    selected_ms, _ = nearest_timestamp(requested_ms, points)
    seek_ms = max(0, selected_ms - 1500)
    offset_ms = selected_ms - seek_ms
    ffmpeg = resolve_executable(settings.ffmpeg_path, "ffmpeg")
    filter_chain = f"{_ffmpeg_scale_filter(bound_width, bound_height)},showinfo"
    arguments = [
        str(ffmpeg),
        "-nostdin",
        "-v",
        "info",
        "-protocol_whitelist",
        LOCAL_PROTOCOL_WHITELIST,
        "-format_whitelist",
        LOCAL_FORMAT_WHITELIST,
        "-ss",
        f"{seek_ms / 1000:.3f}",
        "-i",
        str(source),
        "-ss",
        f"{offset_ms / 1000:.3f}",
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        filter_chain,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-y",
        str(destination),
    ]
    result = await run_process(
        arguments,
        timeout_seconds=settings.subprocess_timeout_seconds,
        cwd=destination.parent,
        cpu_time_limit_seconds=settings.max_subprocess_cpu_seconds,
        memory_limit_bytes=settings.max_subprocess_memory_bytes,
    )
    if result.returncode != 0 or not await asyncio.to_thread(destination.is_file):
        raise VideoMCPError(ErrorCode.FRAME_EXTRACTION_FAILED, "Exact frame extraction failed.")
    # ffprobe selected the actual source PTS. FFmpeg's post-seek showinfo clock can be rebased.
    return selected_ms


def _resize_and_save(
    source: Path,
    destination: Path,
    *,
    images: ImageSettings,
    timestamp_ms: int,
) -> tuple[int, int, str]:
    with _IMAGE.open(source) as opened:
        image = _IMAGE_OPS.exif_transpose(opened).convert("RGB")
        sizing = images.sizing
        if isinstance(sizing, FitSizing):
            target = (sizing.max_width or image.width, sizing.max_height or image.height)
            if sizing.allow_upscale:
                scale = min(target[0] / image.width, target[1] / image.height)
                image = image.resize(
                    (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                    _IMAGE.Resampling.LANCZOS,
                )
            else:
                image.thumbnail(target, _IMAGE.Resampling.LANCZOS)
        elif isinstance(sizing, ExactSizing):
            target = (sizing.width, sizing.height)
            may_stretch = sizing.allow_upscale or (
                target[0] <= image.width and target[1] <= image.height
            )
            if sizing.stretch and may_stretch:
                image = image.resize(target, _IMAGE.Resampling.LANCZOS)
            else:
                contained = image.copy()
                if sizing.allow_upscale:
                    scale = min(target[0] / image.width, target[1] / image.height)
                    contained = image.resize(
                        (
                            max(1, round(image.width * scale)),
                            max(1, round(image.height * scale)),
                        ),
                        _IMAGE.Resampling.LANCZOS,
                    )
                else:
                    contained.thumbnail(target, _IMAGE.Resampling.LANCZOS)
                image = _IMAGE.new("RGB", target, "black")
                image.paste(
                    contained,
                    ((target[0] - contained.width) // 2, (target[1] - contained.height) // 2),
                )
        if images.timestamp_overlay:
            _IMAGE_DRAW.Draw(image).text((8, 8), f"{timestamp_ms / 1000:.3f}s", fill="white")
        encoding = images.encoding
        if isinstance(encoding, JpegEncoding):
            image.save(destination, format="JPEG", quality=encoding.quality, optimize=True)
            mime = "image/jpeg"
        elif isinstance(encoding, PngEncoding):
            image.save(destination, format="PNG", compress_level=encoding.compression_level)
            mime = "image/png"
        elif isinstance(encoding, WebpEncoding):
            image.save(
                destination,
                format="WEBP",
                quality=encoding.quality,
                lossless=encoding.lossless,
            )
            mime = "image/webp"
        else:
            raise VideoMCPError(ErrorCode.INVALID_INPUT, "Image encoding was not resolved.")
        width, height = image.size
    destination.chmod(0o600)
    return width, height, mime


def _hash_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _file_size(path: Path) -> int:
    return path.stat().st_size


def _perceptual_hash(path: Path) -> tuple[int, ...]:
    with _IMAGE.open(path) as image:
        reduced = image.convert("RGB").resize((8, 8), _IMAGE.Resampling.LANCZOS)
        flattened = getattr(reduced, "get_flattened_data", None)
        pixels = flattened() if callable(flattened) else reduced.getdata()
        return tuple(channel for pixel in pixels for channel in pixel)


def _similarity(left: tuple[int, ...], right: tuple[int, ...]) -> float:
    if len(left) != len(right) or not left:
        return 0.0
    difference = sum(abs(a - b) for a, b in zip(left, right, strict=True))
    return 1.0 - difference / (len(left) * 255)


def _coarse_bucket(signature: tuple[int, ...]) -> tuple[int, int, int]:
    samples = max(1, len(signature) // 3)
    averages = tuple(sum(signature[channel::3]) // samples for channel in range(3))
    return averages[0] // 16, averages[1] // 16, averages[2] // 16


async def _bounded_perceptual_hash(path: Path) -> tuple[int, ...]:
    """Finish at most one bounded image operation before propagating cancellation."""
    task = asyncio.create_task(asyncio.to_thread(_perceptual_hash, path))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


async def _deduplicate(
    candidates: list[_ExtractedCandidate], threshold: float, base_interval_ms: int | None
) -> tuple[list[_ExtractedCandidate], int]:
    retained: list[_ExtractedCandidate] = []
    hashes: list[tuple[int, ...]] = []
    buckets: dict[tuple[int, int, int], deque[int]] = defaultdict(lambda: deque(maxlen=8))
    base_times: list[int] = []
    base_indices: list[int] = []
    removed = 0
    for candidate in sorted(candidates, key=lambda item: (item.timestamp_ms, item.kind.value)):
        current_hash = await _bounded_perceptual_hash(candidate.source_path)
        match_index: int | None = None
        comparison_indices: list[int] = []
        if candidate.kind is not CandidateKind.ENDPOINT:
            if candidate.kind is CandidateKind.SCENE and base_interval_ms is not None:
                position = bisect_left(base_times, candidate.timestamp_ms)
                comparison_indices.extend(base_indices[max(0, position - 2) : position + 2])
            comparison_indices.extend(range(max(0, len(retained) - 32), len(retained)))
            bucket = _coarse_bucket(current_hash)
            for red in range(max(0, bucket[0] - 1), min(15, bucket[0] + 1) + 1):
                for green in range(max(0, bucket[1] - 1), min(15, bucket[1] + 1) + 1):
                    for blue in range(max(0, bucket[2] - 1), min(15, bucket[2] + 1) + 1):
                        comparison_indices.extend(buckets[(red, green, blue)])
        ordered_indices = list(dict.fromkeys(reversed(comparison_indices)))[:64]
        for index in ordered_indices:
            prior, prior_hash = retained[index], hashes[index]
            similarity = _similarity(current_hash, prior_hash)
            nearby_scene = (
                candidate.kind is CandidateKind.SCENE
                and prior.kind in {CandidateKind.BASE, CandidateKind.ENDPOINT}
                and base_interval_ms is not None
                and abs(candidate.timestamp_ms - prior.timestamp_ms) <= base_interval_ms // 2
            )
            if similarity >= threshold or (
                nearby_scene and similarity >= max(0.80, threshold - 0.08)
            ):
                match_index = index
                break
        if match_index is None:
            retained_index = len(retained)
            retained.append(candidate)
            hashes.append(current_hash)
            buckets[_coarse_bucket(current_hash)].append(retained_index)
            if candidate.kind in {CandidateKind.BASE, CandidateKind.ENDPOINT}:
                base_times.append(candidate.timestamp_ms)
                base_indices.append(retained_index)
        else:
            retained[match_index].requested_timestamps_ms.extend(candidate.requested_timestamps_ms)
            candidate.source_path.unlink(missing_ok=True)
            removed += 1
    return retained, removed


async def extract_frames(
    source: Path,
    destination: Path,
    *,
    plan: FramePlan,
    images: ImageSettings,
    source_width: int,
    source_height: int,
    chapters: tuple[Chapter, ...],
    settings: Settings,
) -> FrameExtractionResult:
    """Extract bounded candidates, reduce by value/deduplication, and publish numbered frames."""
    await asyncio.to_thread(destination.mkdir, mode=0o700, parents=True, exist_ok=True)
    temporary = destination.parent / "frame-candidates"
    await asyncio.to_thread(temporary.mkdir, mode=0o700, exist_ok=False)
    extension, _ = _output_identity(images, settings)
    final_width, final_height = _bounded_dimensions(source_width, source_height, images, settings)
    candidates: list[_ExtractedCandidate] = []
    base_count = scene_count = chapter_count = 0
    scene_budget = 0
    try:
        if plan.base_timestamps_ms and plan.mode != "timestamps":
            interval = plan.calculated_interval_seconds or (
                (plan.end_ms - plan.start_ms) / max(1, len(plan.base_timestamps_ms)) / 1000
            )
            base_files = await _extract_filtered(
                source,
                temporary / "base-%06d.jpg",
                start_ms=plan.start_ms,
                duration_ms=plan.end_ms - plan.start_ms,
                select_filter=f"'isnan(prev_selected_t)+gte(t-prev_selected_t\\,{interval:.6f})'",
                maximum=len(plan.base_timestamps_ms),
                bound_width=final_width,
                bound_height=final_height,
                settings=settings,
                stage="base",
                interval_seconds=interval,
            )
            for path, timestamp_ms in base_files:
                candidates.append(
                    _ExtractedCandidate(timestamp_ms, [timestamp_ms], CandidateKind.BASE, path)
                )
            base_count = len(base_files)

            end_target = max(plan.start_ms, plan.end_ms - 1)
            last_timestamp = candidates[-1].timestamp_ms if candidates else plan.start_ms
            if len(candidates) < plan.request_max_frames and end_target - last_timestamp > min(
                500, round(interval * 500)
            ):
                endpoint_path = temporary / "endpoint-000001.jpg"
                endpoint_ms = await _extract_exact(
                    source,
                    endpoint_path,
                    requested_ms=end_target,
                    upper_bound_exclusive_ms=plan.end_ms,
                    bound_width=final_width,
                    bound_height=final_height,
                    settings=settings,
                )
                candidates.append(
                    _ExtractedCandidate(
                        endpoint_ms, [end_target], CandidateKind.ENDPOINT, endpoint_path
                    )
                )

        chapter_capacity = min(
            max(0, plan.request_max_frames - len(candidates)),
            32,
            max(1, base_count // 5),
        )
        chapter_targets = (
            sorted(
                {
                    chapter.start_ms
                    for chapter in chapters
                    if plan.start_ms <= chapter.start_ms <= plan.end_ms
                }
            )[:chapter_capacity]
            if plan.mode != "timestamps"
            else []
        )
        for index, target_ms in enumerate(chapter_targets, start=1):
            path = temporary / f"chapter-{index:06d}.jpg"
            actual_ms = await _extract_exact(
                source,
                path,
                requested_ms=target_ms,
                bound_width=final_width,
                bound_height=final_height,
                settings=settings,
            )
            candidates.append(
                _ExtractedCandidate(actual_ms, [target_ms], CandidateKind.CHAPTER, path)
            )
        chapter_count = len(chapter_targets)

        remaining = max(0, plan.request_max_frames - len(candidates))
        wants_scenes = plan.mode in {"auto", "scene", "hybrid"} and remaining > 0
        raw_scene_limit = remaining
        if plan.mode == "auto":
            if plan.profile == "content_first":
                raw_scene_limit = min(remaining, math.ceil(base_count * 0.50))
            else:
                raw_scene_limit = min(
                    remaining,
                    max(0, (plan.soft_final_target or plan.request_max_frames) - base_count) * 2,
                )
        if wants_scenes and raw_scene_limit > 0:
            scene_files = await _extract_filtered(
                source,
                temporary / "scene-%06d.jpg",
                start_ms=plan.start_ms,
                duration_ms=plan.end_ms - plan.start_ms,
                select_filter=f"'gt(scene\\,{plan.scene_threshold:.6f})'",
                maximum=raw_scene_limit,
                bound_width=final_width,
                bound_height=final_height,
                settings=settings,
                stage="scene",
                scene_threshold=plan.scene_threshold,
                allow_empty=True,
            )
            for path, timestamp_ms in scene_files:
                candidates.append(
                    _ExtractedCandidate(
                        timestamp_ms, [timestamp_ms], CandidateKind.SCENE, path, 1.0
                    )
                )
            scene_count = len(scene_files)

        if plan.mode == "timestamps":
            for index, requested_ms in enumerate(plan.base_timestamps_ms, start=1):
                path = temporary / f"timestamp-{index:06d}.jpg"
                actual_ms = await _extract_exact(
                    source,
                    path,
                    requested_ms=requested_ms,
                    bound_width=final_width,
                    bound_height=final_height,
                    settings=settings,
                )
                candidates.append(
                    _ExtractedCandidate(actual_ms, [requested_ms], CandidateKind.TIMESTAMP, path)
                )
            base_count = len(candidates)
            scene_count = chapter_count = 0

        if plan.near_duplicate_enabled:
            deduped, removed = await _deduplicate(
                candidates,
                plan.near_duplicate_threshold,
                round((plan.calculated_interval_seconds or 0) * 1000) or None,
            )
        else:
            deduped, removed = candidates, 0
        if plan.profile == "content_first" and plan.mode == "auto":
            distinct_scenes = sum(item.kind is CandidateKind.SCENE for item in deduped)
            high_dynamic = distinct_scenes >= max(3, math.floor(base_count * 0.45))
            scene_budget = youtube_scene_budget(
                base_count,
                high_dynamic=high_dynamic,
                remaining_capacity=max(0, plan.request_max_frames - base_count),
            )
        elif plan.profile == "token_saver" and plan.mode == "auto":
            scene_budget = max(0, (plan.soft_final_target or 120) - base_count)
        else:
            scene_budget = max(0, plan.request_max_frames - base_count)

        scene_seen = 0
        budgeted: list[_ExtractedCandidate] = []
        for item in deduped:
            if item.kind is CandidateKind.SCENE:
                if scene_seen >= scene_budget:
                    item.source_path.unlink(missing_ok=True)
                    continue
                scene_seen += 1
            budgeted.append(item)

        soft_limit = plan.soft_final_target or plan.request_max_frames
        effective_limit = min(plan.request_max_frames, soft_limit)
        model_candidates = [
            FrameCandidate(
                timestamp_ms=item.timestamp_ms,
                kind=item.kind,
                scene_score=item.scene_score,
                decoded_index=index,
            )
            for index, item in enumerate(budgeted)
        ]
        selected_models = select_candidates(
            model_candidates,
            start_ms=plan.start_ms,
            end_ms=plan.end_ms,
            maximum=effective_limit,
            profile=plan.profile,
        )
        selected_keys = {(item.timestamp_ms, item.kind) for item in selected_models}
        selected = [item for item in budgeted if (item.timestamp_ms, item.kind) in selected_keys][
            :effective_limit
        ]

        records: list[FrameRecord] = []
        output_bytes = 0
        for index, item in enumerate(selected, start=1):
            frame_id = f"f_{index:06d}"
            filename = f"{frame_id}_{item.timestamp_ms:012d}{extension}"
            output_path = destination / filename
            width, height, mime = await finish_thread_before_cancel(
                _resize_and_save,
                item.source_path,
                output_path,
                images=images,
                timestamp_ms=item.timestamp_ms,
            )
            size = await asyncio.to_thread(_file_size, output_path)
            output_bytes += size
            if output_bytes > settings.max_completed_output_bytes:
                raise VideoMCPError(
                    ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Generated frames exceed output byte limit."
                )
            requested = tuple(sorted(set(item.requested_timestamps_ms)))
            records.append(
                FrameRecord(
                    frame_id=frame_id,
                    filename=filename,
                    timestamp_ms=item.timestamp_ms,
                    requested_timestamps_ms=requested,
                    signed_differences_ms=tuple(item.timestamp_ms - value for value in requested),
                    kind=item.kind,
                    width=width,
                    height=height,
                    mime_type=mime,
                    size_bytes=size,
                    sha256=await finish_thread_before_cancel(_hash_file, output_path),
                )
            )
        retained_scenes = sum(record.kind is CandidateKind.SCENE for record in records)
        return FrameExtractionResult(
            records=tuple(records),
            base_candidates=base_count,
            scene_candidates=scene_count,
            retained_scene_candidates=retained_scenes,
            chapter_candidates=chapter_count,
            duplicate_frames_removed=removed,
            scene_budget=scene_budget,
        )
    finally:
        await asyncio.to_thread(shutil.rmtree, temporary, True)
