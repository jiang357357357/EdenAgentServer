from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable

from .catalog import BUILTIN_SKILL_ROOT, load_builtin_skill_definitions


class SkillDirectoryWatcher:
    """Small cross-platform watcher for every local MonAgent skill package root."""

    def __init__(
        self,
        workspace_root: str | Path,
        emit: Callable[[dict[str, Any]], None],
        *,
        interval_seconds: float = 1.0,
    ) -> None:
        workspace = Path(workspace_root).resolve()
        self._roots = (
            BUILTIN_SKILL_ROOT,
            workspace / ".pi" / "skills" / "monagent",
            Path.home() / ".pi" / "agent" / "skills" / "monagent",
        )
        self._emit = emit
        self._interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._revision = 0
        self._signature = self._snapshot()
        self._thread = threading.Thread(target=self._run, name="skill-directory-watcher", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=max(2.0, self._interval_seconds * 2))

    def _snapshot(self) -> tuple[tuple[str, int, int], ...]:
        items: list[tuple[str, int, int]] = []
        for root in self._roots:
            if not root.exists():
                continue
            for path in sorted(root.rglob("*")):
                if not path.is_file() or any(part.startswith(".staging") for part in path.parts):
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                items.append((str(path), stat.st_mtime_ns, stat.st_size))
        return tuple(items)

    def _run(self) -> None:
        while not self._stop.wait(self._interval_seconds):
            current = self._snapshot()
            if current == self._signature:
                continue
            try:
                load_builtin_skill_definitions(force_reload=True)
            except Exception:
                # Editors may briefly expose an incomplete file. Keep watching;
                # the next stable write will produce another signature.
                continue
            self._signature = current
            self._revision += 1
            self._emit(
                {
                    "type": "tools.changed",
                    "properties": {
                        "ownerKey": "*",
                        "revision": self._revision,
                        "reason": "files_changed",
                    },
                }
            )
