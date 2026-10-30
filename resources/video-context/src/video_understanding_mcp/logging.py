"""Structured logging with recursive sensitive-data redaction."""

from __future__ import annotations

import re
import sys
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any, cast

import structlog

_SECRET_KEY = re.compile(r"(?i)(authorization|cookie|credential|netrc|password|proxy|secret|token)")
_HOME = str(Path.home())


def redact_value(value: Any, *, key: str = "") -> Any:
    if _SECRET_KEY.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(k): redact_value(v, key=str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_value(item) for item in value]
    if isinstance(value, Path):
        value = str(value)
    if isinstance(value, str):
        result = value.replace(_HOME, "$HOME") if _HOME else value
        result = re.sub(r"(?i)(bearer\s+)[^\s]+", r"\1[REDACTED]", result)
        return result
    return value


def redact_event(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    return cast(MutableMapping[str, Any], redact_value(dict(event_dict)))


def configure_logging(*, debug: bool = False) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            redact_event,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(10 if debug else 20),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )


def get_logger() -> Any:
    return structlog.get_logger("video_understanding_mcp")
