from __future__ import annotations

import os
import sys
import threading
import traceback
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional, TextIO, Tuple

from ..config import get_config
from ..handlers.base import LogRecord
from ..handlers.registry import get_handlers
from ..levels import get_level_value


@dataclass
class LoggerIdentity:
    main: str
    sub: str


class ColoredLogger:
    def __init__(self, main: str, sub: str = "", stream: Optional[TextIO] = None) -> None:
        self.identity = LoggerIdentity(main=main, sub=sub)
        self.stream = stream
        self.name = f"{main}.{sub}" if sub else main

    def _log(self, level_name: str, message: str, exc_info: Any = None) -> None:
        config = get_config()
        current_level = get_level_value(level_name)
        if current_level < get_level_value(config.level):
            return

        filename, lineno, func_name = None, None, None
        try:
            frame = sys._getframe(2)
            filename = os.path.basename(frame.f_code.co_filename)
            lineno = frame.f_lineno
            func_name = frame.f_code.co_name
        except (ValueError, AttributeError):
            pass

        formatted_exc = None
        if exc_info:
            if isinstance(exc_info, bool):
                exc_info = sys.exc_info()
            if isinstance(exc_info, tuple):
                formatted_exc = "".join(traceback.format_exception(*exc_info))
            elif isinstance(exc_info, Exception):
                formatted_exc = "".join(traceback.format_exception(type(exc_info), exc_info, exc_info.__traceback__))

        record = LogRecord(
            timestamp=datetime.now(),
            main=self.identity.main,
            sub=self.identity.sub,
            level_name=level_name,
            level_no=current_level,
            message=str(message),
            filename=filename,
            lineno=lineno,
            func_name=func_name,
            exc_info=formatted_exc,
        )

        for handler in get_handlers(self.identity.main, self.identity.sub, self.stream):
            handler.emit(record)

    def debug(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("DEBUG", message.format(*args) if args else message, exc_info=kwargs.get("exc_info"))

    def info(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("INFO", message.format(*args) if args else message, exc_info=kwargs.get("exc_info"))

    def warning(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("WARNING", message.format(*args) if args else message, exc_info=kwargs.get("exc_info"))

    def error(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("ERROR", message.format(*args) if args else message, exc_info=kwargs.get("exc_info"))

    def exception(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an ERROR message with the active exception traceback.

        Match ``logging.Logger.exception`` by enabling ``exc_info`` by default,
        while still allowing callers to provide an explicit exception or
        ``exc_info`` tuple.
        """
        self._log(
            "ERROR",
            message.format(*args) if args else message,
            exc_info=kwargs.get("exc_info", True),
        )

    def critical(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("CRITICAL", message.format(*args) if args else message, exc_info=kwargs.get("exc_info"))


_logger_cache: Dict[Tuple[str, str, Optional[TextIO]], ColoredLogger] = {}
_cache_lock = threading.Lock()


def get_logger(main: str, sub: str = "", stream: Optional[TextIO] = None) -> ColoredLogger:
    key = (main, sub, stream)
    with _cache_lock:
        logger = _logger_cache.get(key)
        if logger is None:
            logger = ColoredLogger(main, sub, stream)
            _logger_cache[key] = logger
    return logger
