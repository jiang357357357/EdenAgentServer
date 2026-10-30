"""Stable, redacted application errors."""

from __future__ import annotations

from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    INVALID_INPUT = "INVALID_INPUT"
    LOCAL_INPUT_DISABLED = "LOCAL_INPUT_DISABLED"
    PATH_NOT_ALLOWED = "PATH_NOT_ALLOWED"
    UNSAFE_PATH = "UNSAFE_PATH"
    SOURCE_CHANGED = "SOURCE_CHANGED"
    UNSUPPORTED_MEDIA = "UNSUPPORTED_MEDIA"
    DEPENDENCY_MISSING = "DEPENDENCY_MISSING"
    MODEL_NOT_INSTALLED = "MODEL_NOT_INSTALLED"
    DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
    TRANSCRIPTION_FAILED = "TRANSCRIPTION_FAILED"
    FRAME_EXTRACTION_FAILED = "FRAME_EXTRACTION_FAILED"
    RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED"
    INSUFFICIENT_DISK = "INSUFFICIENT_DISK"
    TIMEOUT = "TIMEOUT"
    CANCELLED = "CANCELLED"
    QUEUE_FULL = "QUEUE_FULL"
    JOB_NOT_FOUND = "JOB_NOT_FOUND"
    FRAME_NOT_FOUND = "FRAME_NOT_FOUND"
    RESOURCE_INVALID = "RESOURCE_INVALID"
    WEBP_DISABLED = "WEBP_DISABLED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class VideoMCPError(Exception):
    """An expected failure safe to convert to a concise MCP tool error."""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        retryable: bool = False,
        field: str | None = None,
        safe_details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.field = field
        self.safe_details = safe_details or {}

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "code": self.code.value,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.field is not None:
            result["field"] = self.field
        if self.safe_details:
            result["safe_details"] = self.safe_details
        return result
