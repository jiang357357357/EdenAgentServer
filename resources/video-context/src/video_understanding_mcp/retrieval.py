"""Bounded timeline, preview, and full-frame retrieval."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Settings
from .errors import ErrorCode, VideoMCPError
from .jobs.storage_ledger import storage_ledger
from .jobs.store import JobStore
from .schemas import (
    FrameDescriptor,
    FrameRetrievalRequest,
    PreviewDescriptor,
    PreviewRequest,
    TimelineReadRequest,
    TimelineReadResult,
)
from .security.threads import finish_thread_before_cancel

_CONTINUATION = re.compile(r"^c_([0-9]{1,9})_([0-9a-f]{16})$")
_IMAGE: Any = importlib.import_module("PIL.Image")
_IMAGE_OPS: Any = importlib.import_module("PIL.ImageOps")
_PREVIEW_CACHE_LOCK = asyncio.Lock()


@dataclass(frozen=True)
class RetrievedFrame:
    descriptor: FrameDescriptor
    data: bytes


@dataclass(frozen=True)
class RetrievedPreview:
    descriptor: PreviewDescriptor
    data: bytes


def _selection_digest(job_id: str, start_ms: int | None, end_ms: int | None) -> str:
    value = f"{job_id}:{start_ms}:{end_ms}".encode()
    return hashlib.sha256(value).hexdigest()[:16]


def _timeline_time(row: str) -> int | None:
    fields = row.split("\t", 3)
    if len(fields) < 2 or fields[0] not in {"T", "F"}:
        return None
    try:
        return int(fields[1])
    except ValueError:
        return None


def read_timeline(request: TimelineReadRequest, settings: Settings) -> TimelineReadResult:
    maximum = request.max_chars or settings.timeline_default_chars
    if maximum > settings.timeline_max_chars:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED, "max_chars exceeds the timeline retrieval limit."
        )
    store = JobStore(settings)
    paths = store.get(request.job_id)
    try:
        raw = (paths.root / "timeline.tsv").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise VideoMCPError(ErrorCode.JOB_NOT_FOUND, "The timeline is unavailable.") from exc
    selected_rows: list[str] = []
    for row in raw.splitlines(keepends=True):
        timestamp = _timeline_time(row)
        if timestamp is None:
            continue
        if request.start_ms is not None and timestamp < request.start_ms:
            continue
        if request.end_ms is not None and timestamp >= request.end_ms:
            continue
        selected_rows.append(row)
    selected = "".join(selected_rows)
    digest = _selection_digest(request.job_id, request.start_ms, request.end_ms)
    offset = 0
    if request.continuation_token is not None:
        match = _CONTINUATION.fullmatch(request.continuation_token)
        if match is None or match.group(2) != digest:
            raise VideoMCPError(ErrorCode.RESOURCE_INVALID, "Continuation token is invalid.")
        offset = int(match.group(1))
        if offset > len(selected):
            raise VideoMCPError(ErrorCode.RESOURCE_INVALID, "Continuation token is stale.")
    content = selected[offset : offset + maximum]
    next_offset = offset + len(content)
    truncated = next_offset < len(selected)
    token = f"c_{next_offset}_{digest}" if truncated else None
    return TimelineReadResult(
        job_id=request.job_id,
        content=content,
        applied_start_ms=request.start_ms,
        applied_end_ms=request.end_ms,
        returned_chars=len(content),
        truncated=truncated,
        continuation_token=token,
    )


def _manifest_frames(store: JobStore, job_id: str) -> list[dict[str, Any]]:
    paths = store.get(job_id)
    manifest = store.read_json(paths.root / "frame-manifest.json")
    raw = manifest.get("frames")
    if not isinstance(raw, list):
        raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "The frame manifest is unavailable.")
    return [item for item in raw if isinstance(item, dict)]


def _descriptor(item: dict[str, Any]) -> FrameDescriptor:
    try:
        return FrameDescriptor(
            frame_id=item["frame_id"],
            timestamp_ms=item["timestamp_ms"],
            width=item["width"],
            height=item["height"],
            mime_type=item["mime_type"],
            resource_uri=item["resource_uri"],
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "Frame metadata is invalid.") from exc


def retrieve_frames(
    request: FrameRetrievalRequest, settings: Settings
) -> tuple[RetrievedFrame, ...]:
    if request.max_frames > settings.max_frame_retrieval:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED, "max_frames exceeds the frame retrieval limit."
        )
    if len(request.frame_ids) > settings.max_frame_retrieval:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Too many frame IDs requested.")
    store = JobStore(settings)
    by_id = {item.get("frame_id"): item for item in _manifest_frames(store, request.job_id)}
    selected: list[tuple[FrameDescriptor, Path]] = []
    total_bytes = 0
    total_pixels = 0
    for frame_id in request.frame_ids:
        item = by_id.get(frame_id)
        if not isinstance(item, dict):
            raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "The requested frame was not found.")
        descriptor = _descriptor(item)
        path = store.frame_path(request.job_id, frame_id)
        try:
            total_bytes += path.stat().st_size
        except OSError as exc:
            raise VideoMCPError(
                ErrorCode.FRAME_NOT_FOUND, "The requested frame is unavailable."
            ) from exc
        total_pixels += descriptor.width * descriptor.height
        selected.append((descriptor, path))
    if total_bytes > settings.max_frame_retrieval_bytes:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "The selected frames exceed the aggregate retrieval byte limit.",
        )
    if total_pixels > settings.max_frame_retrieval_pixels:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "The selected frames exceed the aggregate retrieval pixel limit.",
        )
    result: list[RetrievedFrame] = []
    for descriptor, path in selected:
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise VideoMCPError(
                ErrorCode.FRAME_NOT_FOUND, "The requested frame is unavailable."
            ) from exc
        result.append(RetrievedFrame(descriptor, data))
    return tuple(result)


def _even_subset(items: list[dict[str, Any]], maximum: int) -> list[dict[str, Any]]:
    if len(items) <= maximum:
        return items
    if maximum == 1:
        return [items[len(items) // 2]]
    return [items[round(index * (len(items) - 1) / (maximum - 1))] for index in range(maximum)]


def _preview_file(
    source: Path,
    destination: Path,
    *,
    width: int,
) -> tuple[int, int, int, int]:
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with _IMAGE.open(source) as opened:
        source_width, source_height = opened.size
        image = _IMAGE_OPS.exif_transpose(opened).convert("RGB")
        image.thumbnail(
            (width, max(1, round(width * source_height / source_width))), _IMAGE.Resampling.LANCZOS
        )
        temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
        image.save(temporary, format="JPEG", quality=78, optimize=True)
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        preview_width, preview_height = image.size
    return preview_width, preview_height, source_width, source_height


async def retrieve_previews(
    request: PreviewRequest, settings: Settings
) -> tuple[RetrievedPreview, ...]:
    if request.max_previews > settings.max_preview_retrieval:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED, "max_previews exceeds the preview retrieval limit."
        )
    if request.preview_width > settings.max_preview_width:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED, "preview_width exceeds the preview width limit."
        )
    store = JobStore(settings)
    store.initialize()
    store.cleanup_previews()
    frames = _manifest_frames(store, request.job_id)
    if request.frame_ids is not None:
        by_id = {item.get("frame_id"): item for item in frames}
        selected: list[dict[str, Any]] = []
        for frame_id in request.frame_ids:
            item = by_id.get(frame_id)
            if not isinstance(item, dict):
                raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "The requested frame was not found.")
            selected.append(item)
    else:
        if request.time_range is None:
            raise VideoMCPError(ErrorCode.INVALID_INPUT, "A preview time range is required.")
        ranged = [
            item
            for item in frames
            if isinstance(item.get("timestamp_ms"), int)
            and request.time_range.start_ms <= item["timestamp_ms"] < request.time_range.end_ms
        ]
        selected = _even_subset(ranged, request.max_previews)
    if len(selected) > request.max_previews:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Too many previews requested.")

    selected_pixels = 0
    for item in selected:
        descriptor = _descriptor(item)
        output_width = min(request.preview_width, descriptor.width)
        output_height = max(1, round(output_width * descriptor.height / descriptor.width))
        selected_pixels += output_width * output_height
    if selected_pixels > settings.max_preview_retrieval_pixels:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "The selected previews exceed the aggregate retrieval pixel limit.",
        )

    result: list[RetrievedPreview] = []
    response_bytes = 0
    async with _PREVIEW_CACHE_LOCK:
        for item in selected:
            descriptor = _descriptor(item)
            source = store.frame_path(request.job_id, descriptor.frame_id)
            preview_job_root = store.preview_root / request.job_id
            preview = preview_job_root / str(request.preview_width) / f"{descriptor.frame_id}.jpg"
            output_width = min(request.preview_width, descriptor.width)
            output_height = max(1, round(output_width * descriptor.height / descriptor.width))
            conservative_bytes = output_width * output_height * 3 + 1024 * 1024
            if not preview.is_file():
                reservation = (
                    f"preview:{request.job_id}:{request.preview_width}:{descriptor.frame_id}"
                )
                ledger = storage_ledger(settings.cache_dir)
                await ledger.reserve(store, reservation, conservative_bytes)
                try:
                    dimensions = await finish_thread_before_cancel(
                        _preview_file, source, preview, width=request.preview_width
                    )
                finally:
                    await ledger.release(reservation)
            else:
                dimensions = (
                    output_width,
                    output_height,
                    descriptor.width,
                    descriptor.height,
                )
            await asyncio.to_thread(os.utime, preview_job_root)
            data = await finish_thread_before_cancel(preview.read_bytes)
            response_bytes += len(data)
            if response_bytes > settings.max_preview_retrieval_bytes:
                raise VideoMCPError(
                    ErrorCode.RESOURCE_LIMIT_EXCEEDED,
                    "The selected previews exceed the aggregate retrieval byte limit.",
                )
            result.append(
                RetrievedPreview(
                    PreviewDescriptor(
                        frame_id=descriptor.frame_id,
                        timestamp_ms=descriptor.timestamp_ms,
                        preview_width=dimensions[0],
                        preview_height=dimensions[1],
                        source_width=dimensions[2],
                        source_height=dimensions[3],
                    ),
                    data,
                )
            )
    return tuple(result)
