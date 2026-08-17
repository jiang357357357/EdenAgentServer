from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


class OsEnvironmentAwarenessImportError(RuntimeError):
    pass


def _find_base_os_code_dir() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidates = [parent / "归档" / "BaseOs" / "Code"]
        for candidate in candidates:
            if candidate.exists():
                return candidate
    raise OsEnvironmentAwarenessImportError("无法定位归档/BaseOs/Code，环境感知能力不可用。")


def _ensure_base_os_code_path() -> None:
    code_dir = _find_base_os_code_dir()
    code_dir_text = str(code_dir)
    if code_dir_text not in sys.path:
        sys.path.insert(0, code_dir_text)


_ensure_base_os_code_path()

try:
    from Module.EnvironmentAwareness import EnvironmentAwarenessService, build_calendar_context, calendar_context_summary
except Exception as error:  # pragma: no cover - import failure is environment dependent.
    raise OsEnvironmentAwarenessImportError(f"BaseOs EnvironmentAwareness 模块加载失败: {error}") from error


def build_environment_awareness(
    environment: dict[str, Any] | None = None,
    now: Any = None,
    nearby_days: int = 45,
) -> dict[str, Any]:
    return EnvironmentAwarenessService.build_context(environment, now, nearby_days)


def environment_awareness_summary(context: dict[str, Any]) -> str:
    return EnvironmentAwarenessService.summary(context)


__all__ = [
    "EnvironmentAwarenessService",
    "build_calendar_context",
    "calendar_context_summary",
    "build_environment_awareness",
    "environment_awareness_summary",
]
