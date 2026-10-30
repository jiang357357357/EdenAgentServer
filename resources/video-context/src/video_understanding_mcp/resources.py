"""Strict custom-resource URI parsing and bounded resource reads."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

from .config import Settings
from .errors import ErrorCode, VideoMCPError
from .jobs.store import JobStore
from .retrieval import read_timeline
from .schemas import TimelineReadRequest

_RESOURCE = re.compile(
    r"^videoctx://jobs/(?P<job>[A-Za-z0-9_-]{32})/"
    r"(?:(?P<text>metadata|timeline|transcript)|frames/(?P<frame>f_[0-9]{6,9}))$"
)


class ResourceKind(StrEnum):
    METADATA = "metadata"
    TIMELINE = "timeline"
    TRANSCRIPT = "transcript"
    FRAME = "frame"


@dataclass(frozen=True)
class ParsedResource:
    job_id: str
    kind: ResourceKind
    frame_id: str | None = None


@dataclass(frozen=True)
class ResourceData:
    mime_type: str
    text: str | None = None
    blob: bytes | None = None


def parse_resource_uri(uri: str) -> ParsedResource:
    match = _RESOURCE.fullmatch(uri)
    if match is None:
        raise VideoMCPError(ErrorCode.RESOURCE_INVALID, "The video resource URI is invalid.")
    frame_id = match.group("frame")
    if frame_id is not None:
        return ParsedResource(match.group("job"), ResourceKind.FRAME, frame_id)
    return ParsedResource(match.group("job"), ResourceKind(match.group("text")))


def read_resource(uri: str, settings: Settings) -> ResourceData:
    parsed = parse_resource_uri(uri)
    store = JobStore(settings)
    paths = store.get(parsed.job_id)
    if parsed.kind is ResourceKind.FRAME:
        if parsed.frame_id is None:
            raise VideoMCPError(ErrorCode.RESOURCE_INVALID, "The frame resource is invalid.")
        path = store.frame_path(parsed.job_id, parsed.frame_id)
        manifest = store.read_json(paths.root / "frame-manifest.json")
        raw = manifest.get("frames")
        if not isinstance(raw, list):
            raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "Frame metadata is unavailable.")
        item = next(
            (
                value
                for value in raw
                if isinstance(value, dict) and value.get("frame_id") == parsed.frame_id
            ),
            None,
        )
        mime = item.get("mime_type") if isinstance(item, dict) else None
        if mime not in {"image/jpeg", "image/png", "image/webp"}:
            raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "Frame metadata is invalid.")
        width = item.get("width") if isinstance(item, dict) else None
        height = item.get("height") if isinstance(item, dict) else None
        if not isinstance(width, int) or not isinstance(height, int):
            raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "Frame metadata is invalid.")
        try:
            size = path.stat().st_size
        except OSError as exc:
            raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "The frame is unavailable.") from exc
        if (
            size > settings.max_frame_retrieval_bytes
            or width * height > settings.max_frame_retrieval_pixels
        ):
            raise VideoMCPError(
                ErrorCode.RESOURCE_LIMIT_EXCEEDED,
                "The frame exceeds the administrator resource-read limit.",
            )
        try:
            blob = path.read_bytes()
        except OSError as exc:
            raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "The frame is unavailable.") from exc
        return ResourceData(mime_type=mime, blob=blob)
    if parsed.kind is ResourceKind.TIMELINE:
        result = read_timeline(TimelineReadRequest(job_id=parsed.job_id), settings)
        suffix = (
            "\n# TRUNCATED: use read_video_timeline for continuation.\n" if result.truncated else ""
        )
        return ResourceData(mime_type="text/tab-separated-values", text=result.content + suffix)
    filename = "metadata.json" if parsed.kind is ResourceKind.METADATA else "transcript.vtt"
    maximum = (
        settings.max_transcript_chars
        if parsed.kind is ResourceKind.TRANSCRIPT
        else settings.timeline_max_chars
    )
    try:
        content = (paths.root / filename).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise VideoMCPError(ErrorCode.JOB_NOT_FOUND, "The video resource is unavailable.") from exc
    truncated = len(content) > maximum
    if truncated:
        content = content[:maximum] + "\n# TRUNCATED by administrator text limit.\n"
    mime = "application/json" if parsed.kind is ResourceKind.METADATA else "text/vtt"
    return ResourceData(mime_type=mime, text=content)
