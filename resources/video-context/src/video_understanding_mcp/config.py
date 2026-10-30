"""Typed administrator configuration loaded outside ordinary MCP tool input."""

from __future__ import annotations

import sys
from contextlib import suppress
from pathlib import Path
from typing import Any

from platformdirs import user_cache_path
from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .constants import (
    ABSOLUTE_MAX_FRAME_RETRIEVAL,
    ABSOLUTE_MAX_OUTPUT_FRAMES,
    ABSOLUTE_MAX_PREVIEW_RETRIEVAL,
    APPROVED_WHISPER_MODELS,
)

GIB = 1024**3


class Settings(BaseSettings):
    """Administrator-owned limits. MCP calls cannot mutate this object."""

    model_config = SettingsConfigDict(
        env_prefix="VIDEO_MCP_",
        env_file=None,
        extra="forbid",
        frozen=True,
    )

    allowed_directories: tuple[Path, ...] = ()
    cache_dir: Path = Field(default_factory=lambda: user_cache_path("video-understanding-mcp"))
    model_cache_dir: Path | None = None
    ffmpeg_path: Path | None = None
    ffprobe_path: Path | None = None
    python_path: Path | None = None

    max_source_bytes: int = 10 * GIB
    max_duration_seconds: float = 6 * 60 * 60
    max_source_width: int = 4096
    max_source_height: int = 4096
    max_source_pixels: int = 4096 * 4096
    max_source_fps: float = 120.0
    max_streams: int = 16
    max_output_frames: int = 3000
    max_output_image_pixels: int = 12_000_000
    max_completed_output_bytes: int = 2 * GIB
    max_transcript_chars: int = 2_000_000
    default_frame_retrieval: int = 4
    max_frame_retrieval: int = 8
    max_frame_retrieval_bytes: int = 64 * 1024 * 1024
    max_frame_retrieval_pixels: int = 48_000_000
    default_preview_retrieval: int = 8
    max_preview_retrieval: int = 12
    max_preview_retrieval_bytes: int = 16 * 1024 * 1024
    max_preview_retrieval_pixels: int = 16_000_000
    max_concurrent_retrievals: int = 1
    max_pending_retrievals: int = 2
    default_preview_width: int = 640
    max_preview_width: int = 1280
    preview_ttl_seconds: int = 300
    timeline_default_chars: int = 20_000
    timeline_max_chars: int = 100_000
    max_concurrent_jobs: int = 1
    max_queued_jobs: int = 2
    max_job_wall_seconds: int = 8 * 60 * 60
    normal_ttl_seconds: int = 24 * 60 * 60
    ephemeral_ttl_seconds: int = 15 * 60
    max_cache_bytes: int = 20 * GIB
    min_free_bytes: int = 5 * GIB
    download_retries: int = 2
    subprocess_timeout_seconds: int = 30 * 60
    max_subprocess_cpu_seconds: int = 8 * 60 * 60
    max_subprocess_memory_bytes: int = 8 * GIB
    enable_webp: bool = False
    reject_hardlinks: bool = True
    debug: bool = False
    default_whisper_model: str = "base"
    approved_whisper_models: tuple[str, ...] = APPROVED_WHISPER_MODELS

    @field_validator("allowed_directories")
    @classmethod
    def resolve_allowed_directories(cls, value: tuple[Path, ...]) -> tuple[Path, ...]:
        return tuple(path.expanduser().resolve(strict=True) for path in value)

    @field_validator("cache_dir", "model_cache_dir")
    @classmethod
    def expand_admin_paths(cls, value: Path | None) -> Path | None:
        return None if value is None else value.expanduser().resolve(strict=False)

    @field_validator(
        "max_source_bytes",
        "max_source_width",
        "max_source_height",
        "max_source_pixels",
        "max_streams",
        "max_output_frames",
        "max_output_image_pixels",
        "max_completed_output_bytes",
        "max_transcript_chars",
        "default_frame_retrieval",
        "max_frame_retrieval",
        "max_frame_retrieval_bytes",
        "max_frame_retrieval_pixels",
        "default_preview_retrieval",
        "max_preview_retrieval",
        "max_preview_retrieval_bytes",
        "max_preview_retrieval_pixels",
        "max_concurrent_retrievals",
        "max_pending_retrievals",
        "default_preview_width",
        "max_preview_width",
        "preview_ttl_seconds",
        "timeline_default_chars",
        "timeline_max_chars",
        "max_concurrent_jobs",
        "max_queued_jobs",
        "max_job_wall_seconds",
        "normal_ttl_seconds",
        "ephemeral_ttl_seconds",
        "max_cache_bytes",
        "min_free_bytes",
        "download_retries",
        "subprocess_timeout_seconds",
        "max_subprocess_cpu_seconds",
        "max_subprocess_memory_bytes",
    )
    @classmethod
    def positive_integers(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("administrator limits must be positive")
        return value

    @field_validator("max_output_frames")
    @classmethod
    def absolute_frame_ceiling(cls, value: int) -> int:
        if value > ABSOLUTE_MAX_OUTPUT_FRAMES:
            raise ValueError("max_output_frames cannot exceed the absolute 3,000-frame ceiling")
        return value

    @field_validator("max_frame_retrieval")
    @classmethod
    def absolute_frame_retrieval_ceiling(cls, value: int) -> int:
        if value > ABSOLUTE_MAX_FRAME_RETRIEVAL:
            raise ValueError("max_frame_retrieval cannot exceed 8")
        return value

    @field_validator("max_preview_retrieval")
    @classmethod
    def absolute_preview_retrieval_ceiling(cls, value: int) -> int:
        if value > ABSOLUTE_MAX_PREVIEW_RETRIEVAL:
            raise ValueError("max_preview_retrieval cannot exceed 12")
        return value

    @model_validator(mode="after")
    def consistent_defaults_and_maxima(self) -> Settings:
        if self.default_frame_retrieval > self.max_frame_retrieval:
            raise ValueError("default_frame_retrieval cannot exceed max_frame_retrieval")
        if self.default_preview_retrieval > self.max_preview_retrieval:
            raise ValueError("default_preview_retrieval cannot exceed max_preview_retrieval")
        if self.default_preview_width > self.max_preview_width:
            raise ValueError("default_preview_width cannot exceed max_preview_width")
        return self

    @field_validator("max_duration_seconds", "max_source_fps")
    @classmethod
    def positive_floats(cls, value: float) -> float:
        if not value > 0:
            raise ValueError("administrator limits must be positive")
        return value

    @property
    def resolved_model_cache_dir(self) -> Path:
        return self.model_cache_dir or (self.cache_dir / "models")

    @property
    def resolved_python_path(self) -> Path:
        return self.python_path or Path(sys.executable)

    def prepare_private_directories(self) -> None:
        for path in (self.cache_dir, self.resolved_model_cache_dir):
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
            with suppress(OSError):
                path.chmod(0o700)


def load_settings(**overrides: Any) -> Settings:
    return Settings(**overrides)
