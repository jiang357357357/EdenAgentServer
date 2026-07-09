from __future__ import annotations

import os
from pathlib import Path

START_DIR_PREFIX = "start_"


def parse_start_index(path: Path) -> int:
    if not path.name.startswith(START_DIR_PREFIX):
        return -1
    try:
        return int(path.name[len(START_DIR_PREFIX):])
    except ValueError:
        return -1


def start_dirs(log_root: Path) -> list[Path]:
    if not log_root.exists():
        return []
    return sorted(
        [
            path
            for path in log_root.iterdir()
            if path.is_dir() and path.name.startswith(START_DIR_PREFIX)
        ],
        key=lambda path: (parse_start_index(path), path.stat().st_mtime if path.exists() else 0),
    )


def current_start_dir(log_root: Path) -> Path | None:
    try:
        current = (log_root / "current_start.txt").read_text(encoding="utf-8").strip()
    except OSError:
        current = ""

    if current:
        candidate = Path(current)
        if not candidate.is_absolute():
            candidate = log_root / candidate
        if candidate.is_dir():
            return candidate

    dirs = start_dirs(log_root)
    return dirs[-1] if dirs else None


def read_start_counter(log_root: Path) -> int:
    try:
        return int((log_root / "startup_counter.txt").read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return 0


def prune_old_start_dirs(log_root: Path, keep: int = 10) -> None:
    dirs = start_dirs(log_root)
    remove_count = len(dirs) - keep
    if remove_count <= 0:
        return
    for path in dirs[:remove_count]:
        import shutil

        shutil.rmtree(path, ignore_errors=True)


def create_start_dir(log_root: Path) -> Path:
    log_root.mkdir(parents=True, exist_ok=True)
    highest_existing = max((parse_start_index(path) for path in start_dirs(log_root)), default=0)
    next_index = max(read_start_counter(log_root), highest_existing) + 1

    for index in range(next_index, next_index + 1000):
        candidate = log_root / f"{START_DIR_PREFIX}{index:06d}"
        try:
            candidate.mkdir(parents=True)
        except FileExistsError:
            continue
        (candidate / "Process").mkdir(parents=True, exist_ok=True)
        (candidate / "Text" / "MonAgent").mkdir(parents=True, exist_ok=True)
        (candidate / "Render").mkdir(parents=True, exist_ok=True)
        (log_root / "startup_counter.txt").write_text(str(index), encoding="utf-8")
        (log_root / "current_start.txt").write_text(candidate.name, encoding="utf-8")
        prune_old_start_dirs(log_root)
        return candidate

    raise RuntimeError("无法创建新的 MonAgent 启动日志目录")


def active_logs_root(workspace_root: Path, *, create: bool = True) -> Path:
    log_root = workspace_root / "Data" / "Logs"
    start_dir = os.environ.get("MON_LOG_START_DIR", "").strip()
    if start_dir:
        candidate = Path(start_dir)
        if not candidate.is_absolute():
            candidate = workspace_root / candidate
        if create:
            candidate.mkdir(parents=True, exist_ok=True)
            (candidate / "Process").mkdir(parents=True, exist_ok=True)
            (candidate / "Text" / "MonAgent").mkdir(parents=True, exist_ok=True)
            (candidate / "Render").mkdir(parents=True, exist_ok=True)
        return candidate

    current = current_start_dir(log_root)
    if current is not None:
        return current

    if create:
        return create_start_dir(log_root)
    return log_root


def publish_log_env_defaults(
    *,
    log_start_dir: Path,
    log_file: Path,
    plain_log_file: Path,
    render_log_dir: Path,
    render_log_file: Path,
    render_plain_log_file: Path,
    render_panels_file: Path,
) -> None:
    os.environ.setdefault("MON_LOG_START_DIR", str(log_start_dir))
    os.environ.setdefault("MON_AGENT_SERVER_LOG_FILE", str(log_file))
    os.environ.setdefault("MON_AGENT_SERVER_PLAIN_LOG_FILE", str(plain_log_file))
    os.environ.setdefault("MON_AGENT_RENDER_LOG_DIR", str(render_log_dir))
    os.environ.setdefault("MON_AGENT_RENDER_LOG_FILE", str(render_log_file))
    os.environ.setdefault("MON_AGENT_RENDER_PLAIN_LOG_FILE", str(render_plain_log_file))
    os.environ.setdefault("MON_AGENT_RENDER_PANELS_FILE", str(render_panels_file))
