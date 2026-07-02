from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import TextIO

from ..config import get_config
from .base import BaseHandler, LogRecord


class FileHandler(BaseHandler):
    def __init__(self, path: Path, colored: bool = False) -> None:
        self.path = path
        self.colored = colored
        self.stream: TextIO | None = None
        self._lock = threading.Lock()
        self._open()

    def _open(self) -> None:
        if self.stream and not self.stream.closed:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a", encoding="utf-8")

    def _should_rotate(self, record_len: int) -> bool:
        config = get_config()
        if config.max_bytes <= 0:
            return False
        try:
            return self.path.exists() and self.path.stat().st_size + record_len >= config.max_bytes
        except Exception:
            return False

    def _rotate(self) -> None:
        config = get_config()
        if config.backup_count <= 0:
            return

        if self.stream:
            self.stream.close()
            self.stream = None

        try:
            for index in range(config.backup_count - 1, 0, -1):
                src = self.path.with_name(f"{self.path.name}.{index}")
                dst = self.path.with_name(f"{self.path.name}.{index + 1}")
                if src.exists():
                    if dst.exists():
                        dst.unlink()
                    src.rename(dst)

            first_backup = self.path.with_name(f"{self.path.name}.1")
            if self.path.exists():
                if first_backup.exists():
                    first_backup.unlink()
                self.path.rename(first_backup)
        except OSError:
            pass
        finally:
            self._open()

    def _format_colored(self, record: LogRecord) -> str:
        from ..format.color import DIM, LEVEL_COLORS, RESET, get_dynamic_color

        ts = record.timestamp.strftime("%Y-%m-%d %H:%M:%S")
        ctx = f" {record.filename}:{record.lineno} {record.func_name}()" if record.filename else ""
        line = (
            f"{DIM}[{ts}]{RESET}"
            f"{get_dynamic_color(record.main)}[{record.main}]{RESET}"
            f"{get_dynamic_color(record.sub)}[{record.sub}]{RESET}"
            f"{LEVEL_COLORS.get(record.level_name, '')}[{record.level_name}]{RESET}"
            f"\033[37m{ctx}{RESET} {record.message}"
        )
        if record.exc_info:
            line += f"\n{DIM}{record.exc_info}{RESET}"
        return line + "\n"

    def _format_plain(self, record: LogRecord) -> str:
        ts = record.timestamp.strftime("%Y-%m-%d %H:%M:%S")
        ctx = f" {record.filename}:{record.lineno} {record.func_name}()" if record.filename else ""
        line = f"[{ts}][{record.main}][{record.sub}][{record.level_name}]{ctx} {record.message}"
        if record.exc_info:
            line += f"\n{record.exc_info}"
        return line + "\n"

    def emit(self, record: LogRecord) -> None:
        text = self._format_colored(record) if self.colored else self._format_plain(record)
        if not self.colored:
            text = re.sub(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])", "", text)
        encoded_len = len(text.encode("utf-8"))

        with self._lock:
            try:
                self._open()
                if self._should_rotate(encoded_len):
                    self._rotate()
                if self.stream:
                    self.stream.write(text)
                    self.stream.flush()
            except Exception as error:
                import sys

                print(f"[MonAgentLogs] 无法写入日志文件: {self.path}: {error}", file=sys.stderr)

    def close(self) -> None:
        with self._lock:
            if self.stream and not self.stream.closed:
                self.stream.close()
