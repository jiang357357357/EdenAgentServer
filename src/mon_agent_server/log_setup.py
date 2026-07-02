from __future__ import annotations

import sys
from pathlib import Path
from typing import TextIO

from .config import ServerConfig


class TeeStream:
    def __init__(self, original: TextIO, files: list[TextIO]) -> None:
        self.original = original
        self.files = files
        self.encoding = getattr(original, "encoding", "utf-8")

    def write(self, data: str) -> int:
        written = self.original.write(data)
        for file in self.files:
            file.write(data)
        return written

    def flush(self) -> None:
        self.original.flush()
        for file in self.files:
            file.flush()

    def isatty(self) -> bool:
        return self.original.isatty()


def _open_log_file(path: Path) -> TextIO:
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.open("a", encoding="utf-8", buffering=1)


def setup_process_logs(config: ServerConfig) -> None:
    files = []
    seen: set[Path] = set()
    for path in (config.log_file, config.plain_log_file):
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        files.append(_open_log_file(resolved))

    if not files:
        return

    sys.stdout = TeeStream(sys.stdout, files)  # type: ignore[assignment]
    sys.stderr = TeeStream(sys.stderr, files)  # type: ignore[assignment]
    setattr(sys, "_mon_agent_log_files", files)
