"""Strict, size-bounded WebVTT caption ingestion."""

from __future__ import annotations

import html
import re
from pathlib import Path

from ..errors import ErrorCode, VideoMCPError
from .models import TranscriptResult, TranscriptSegment, TranscriptSource

_CUE = re.compile(
    r"^(?P<start>(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+"
    r"(?P<end>(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$"
)
_TAG = re.compile(r"<[^>]{0,200}>")


def _timestamp_ms(value: str) -> int:
    normalized = value.replace(",", ".")
    pieces = normalized.split(":")
    try:
        if len(pieces) == 3:
            hours, minutes, seconds = int(pieces[0]), int(pieces[1]), float(pieces[2])
        elif len(pieces) == 2:
            hours, minutes, seconds = 0, int(pieces[0]), float(pieces[1])
        else:
            raise ValueError
    except ValueError as exc:
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "Caption timestamp is invalid.") from exc
    return round((hours * 3600 + minutes * 60 + seconds) * 1000)


def sanitize_text(value: str) -> str:
    """Flatten untrusted cue text for TSV/VTT without interpreting it."""
    without_tags = _TAG.sub(" ", value)
    decoded = html.unescape(without_tags).replace("\x00", " ").replace("\t", " ")
    return " ".join(decoded.split())


def parse_webvtt(
    path: Path,
    *,
    max_chars: int,
    source: TranscriptSource,
    language: str | None,
) -> TranscriptResult:
    if path.stat().st_size > max_chars * 4:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Caption file exceeds text limits.")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "Caption file is unreadable.") from exc
    if len(text) > max_chars * 4:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Caption file exceeds text limits.")

    lines = text.splitlines()
    segments: list[TranscriptSegment] = []
    total_chars = 0
    index = 0
    while index < len(lines):
        match = _CUE.match(lines[index].strip())
        if match is None and index + 1 < len(lines):
            index += 1
            match = _CUE.match(lines[index].strip())
        if match is None:
            index += 1
            continue
        start_ms = _timestamp_ms(match.group("start"))
        end_ms = _timestamp_ms(match.group("end"))
        index += 1
        cue_lines: list[str] = []
        while index < len(lines) and lines[index].strip():
            cue_lines.append(lines[index])
            index += 1
        cue_text = sanitize_text(" ".join(cue_lines))
        if cue_text and 0 <= start_ms < end_ms:
            total_chars += len(cue_text)
            if total_chars > max_chars:
                raise VideoMCPError(
                    ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Caption transcript exceeds text limits."
                )
            current = TranscriptSegment(start_ms=start_ms, end_ms=end_ms, text=cue_text)
            if not segments or current != segments[-1]:
                segments.append(current)
        index += 1
    status = "complete" if segments else "no_speech"
    return TranscriptResult(status, source, language, tuple(segments))
