from __future__ import annotations

import logging
import sys
from datetime import datetime
from typing import TextIO

RESET = "\033[0m"
DIM = "\033[90m"
LEVEL_COLORS = {
    "DEBUG": "\033[36m",
    "INFO": "\033[32m",
    "WARNING": "\033[1;33m",
    "ERROR": "\033[1;31m",
    "CRITICAL": "\033[1;41;37m",
}

PREDEFINED_COLORS = {
    "MonAgent": "\033[1;34m",
    "Server": "\033[1;36m",
    "Access": "\033[1;35m",
    "Discovery": "\033[1;33m",
    "SelfAwake": "\033[1;32m",
    "Runtime": "\033[1;37m",
}
DYNAMIC_COLORS = [
    "\033[31m",
    "\033[32m",
    "\033[33m",
    "\033[34m",
    "\033[35m",
    "\033[36m",
    "\033[91m",
    "\033[92m",
    "\033[93m",
    "\033[94m",
    "\033[95m",
    "\033[96m",
]


def get_dynamic_color(name: str) -> str:
    if not name:
        return RESET
    if name in PREDEFINED_COLORS:
        return PREDEFINED_COLORS[name]
    return DYNAMIC_COLORS[sum(ord(char) for char in name) % len(DYNAMIC_COLORS)]


def supports_color(stream: TextIO) -> bool:
    if not hasattr(stream, "isatty") or not stream.isatty():
        return False
    if sys.platform == "win32":
        try:
            import ctypes

            handle = ctypes.windll.kernel32.GetStdHandle(-11)
            mode = ctypes.c_uint()
            if ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                ctypes.windll.kernel32.SetConsoleMode(handle, mode.value | 4)
            return True
        except Exception:
            return False
    return True


class ColorFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created).strftime("%H:%M:%S")
        main = getattr(record, "main", "MonAgent")
        sub = getattr(record, "sub", record.name)
        level_name = record.levelname
        message = record.getMessage()
        ctx = f"[{record.filename}:{record.lineno}]"
        return (
            f"{DIM}[{ts}]{RESET}"
            f"{get_dynamic_color(main)}[{main}]{RESET}"
            f"{get_dynamic_color(sub)}[{sub}]{RESET}"
            f"{LEVEL_COLORS.get(level_name, '')}[{level_name}]{RESET}"
            f"\033[37m{ctx}{RESET} {message}"
        )
