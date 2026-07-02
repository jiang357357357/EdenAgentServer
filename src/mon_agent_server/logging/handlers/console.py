from __future__ import annotations

import threading
from typing import TextIO

from ..config import get_config
from ..format.color import DIM, LEVEL_COLORS, RESET, get_dynamic_color, supports_color
from .base import BaseHandler, LogRecord


class ConsoleHandler(BaseHandler):
    def __init__(self, stream: TextIO) -> None:
        self.stream = stream
        self.use_color = supports_color(stream)
        self._lock = threading.Lock()

    def emit(self, record: LogRecord) -> None:
        ts = record.timestamp.strftime("%H:%M:%S")
        ctx = f"[{record.filename}:{record.lineno}]" if record.filename else ""
        plain = f"[{ts}][{record.main}][{record.sub}][{record.level_name}]{ctx} {record.message}"
        if record.exc_info:
            plain += f"\n{record.exc_info}"

        with self._lock:
            if not self.use_color or not get_config().color_enabled:
                self.stream.write(plain + "\n")
                self.stream.flush()
                return

            out = (
                f"{DIM}[{ts}]{RESET}"
                f"{get_dynamic_color(record.main)}[{record.main}]{RESET}"
                f"{get_dynamic_color(record.sub)}[{record.sub}]{RESET}"
                f"{LEVEL_COLORS.get(record.level_name, '')}[{record.level_name}]{RESET}"
                f"\033[37m{ctx}{RESET} {record.message}"
            )
            if record.exc_info:
                out += f"\n{DIM}{record.exc_info}{RESET}"
            self.stream.write(out + "\n")
            self.stream.flush()

    def close(self) -> None:
        pass
