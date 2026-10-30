"""Bounded transcript data exchanged between processing stages."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class TranscriptSource(StrEnum):
    CREATOR_CAPTIONS = "creator_captions"
    AUTOMATIC_CAPTIONS = "automatic_captions"
    WHISPER = "whisper"
    NONE = "none"


@dataclass(frozen=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class TranscriptResult:
    status: str
    source: TranscriptSource
    language: str | None
    segments: tuple[TranscriptSegment, ...]
    warnings: tuple[str, ...] = ()
    model: str | None = None
