"""Strict YouTube URL validation and canonicalization."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

from ..constants import YOUTUBE_HOSTS, YOUTUBE_ID_PATTERN
from ..errors import ErrorCode, VideoMCPError

_VIDEO_ID = re.compile(YOUTUBE_ID_PATTERN)


@dataclass(frozen=True)
class ValidatedYoutubeUrl:
    canonical_url: str
    video_id: str
    hostname: str


def _valid_video_id(value: str | None) -> str:
    if value is None or not _VIDEO_ID.fullmatch(value):
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "The YouTube URL lacks a valid video ID.")
    return value


def validate_youtube_url(raw_url: str) -> ValidatedYoutubeUrl:
    if "\x00" in raw_url or len(raw_url) > 2048:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "The YouTube URL is malformed.")
    try:
        parsed = urlsplit(raw_url)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
        username = parsed.username
        password = parsed.password
    except ValueError as exc:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "The YouTube URL is malformed.") from exc
    if parsed.scheme.lower() != "https":
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "Only HTTPS YouTube URLs are supported.")
    if host not in YOUTUBE_HOSTS:
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT, "The URL hostname is not an allowed YouTube host."
        )
    if username or password or port not in (None, 443):
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT, "Credentials and custom ports are not allowed."
        )

    query = parse_qs(parsed.query, keep_blank_values=True)
    if "list" in query or "index" in query:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "Playlist URLs are not supported.")

    parts = [part for part in parsed.path.split("/") if part]
    video_id: str | None = None
    if host == "youtu.be":
        if len(parts) != 1:
            raise VideoMCPError(
                ErrorCode.INVALID_INPUT, "Only single-video YouTube URLs are supported."
            )
        video_id = parts[0]
    elif parsed.path.rstrip("/") == "/watch":
        values = query.get("v", [])
        if len(values) != 1:
            raise VideoMCPError(ErrorCode.INVALID_INPUT, "A single YouTube video ID is required.")
        video_id = values[0]
    elif len(parts) == 2 and parts[0] in {"embed", "live", "shorts"}:
        video_id = parts[1]
    else:
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT, "Only direct single-video YouTube URLs are supported."
        )

    checked_id = _valid_video_id(video_id)
    return ValidatedYoutubeUrl(
        canonical_url=f"https://www.youtube.com/watch?v={checked_id}",
        video_id=checked_id,
        hostname=host,
    )
