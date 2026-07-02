from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Dict, List, Optional, TextIO, Tuple

from ..config import get_config
from .base import BaseHandler
from .console import ConsoleHandler
from .file import FileHandler

_console_handler: Optional[ConsoleHandler] = None
_file_handlers: Dict[Tuple[Path, bool], FileHandler] = {}
_lock = threading.Lock()


def get_handlers(_main: str, _sub: str, stream: Optional[TextIO]) -> List[BaseHandler]:
    if stream is not None:
        return [ConsoleHandler(stream)]

    config = get_config()
    handlers: List[BaseHandler] = []
    global _console_handler

    with _lock:
        if config.console_enabled:
            if _console_handler is None:
                _console_handler = ConsoleHandler(sys.stdout)
            handlers.append(_console_handler)

        if config.file_enabled and config.log_file is not None:
            key = (config.log_file.resolve(), True)
            handler = _file_handlers.get(key)
            if handler is None:
                handler = FileHandler(key[0], colored=True)
                _file_handlers[key] = handler
            handlers.append(handler)

        if config.file_enabled and config.dual_file_enabled and config.plain_log_file is not None:
            key = (config.plain_log_file.resolve(), False)
            handler = _file_handlers.get(key)
            if handler is None:
                handler = FileHandler(key[0], colored=False)
                _file_handlers[key] = handler
            handlers.append(handler)

    return handlers


def shutdown() -> None:
    global _console_handler
    with _lock:
        if _console_handler is not None:
            _console_handler.close()
            _console_handler = None
        for handler in _file_handlers.values():
            handler.close()
        _file_handlers.clear()
