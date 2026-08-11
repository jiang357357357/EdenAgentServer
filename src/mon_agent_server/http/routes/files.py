from __future__ import annotations

from pathlib import Path
from typing import Any

from ...core import require_core_token


def _workspace_path(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError("文件路径必须位于当前工作区内") from error
    if not target.is_dir():
        raise ValueError("目标目录不存在")
    return target


def _workspace_file(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError("文件路径必须位于当前工作区内") from error
    if not target.is_file():
        raise ValueError("目标文件不存在")
    return target


def handle_files(handler: Any, path: str, query: dict[str, list[str]], method: str) -> bool:
    if path not in {"/files", "/files/content"} or method != "GET":
        return False

    token = require_core_token(handler.headers)
    handler.app.core_client.get_user_profile(token)
    root = handler.app.config.workspace_root.resolve()
    relative = handler.query_value(query, "path") or ""
    if path == "/files/content":
        target_file = _workspace_file(root, relative)
        size = target_file.stat().st_size
        if size > 1_048_576:
            handler.json_response({"path": relative, "name": target_file.name, "size": size, "binary": False, "truncated": True, "content": ""})
            return True
        data = target_file.read_bytes()
        if b"\x00" in data:
            handler.json_response({"path": relative, "name": target_file.name, "size": size, "binary": True, "truncated": False, "content": ""})
            return True
        handler.json_response({"path": relative, "name": target_file.name, "size": size, "binary": False, "truncated": False, "content": data.decode("utf-8", errors="replace")})
        return True

    target = _workspace_path(root, relative)
    entries: list[dict[str, Any]] = []
    for item in target.iterdir():
        try:
            resolved = item.resolve()
            resolved.relative_to(root)
            is_directory = item.is_dir()
            is_file = item.is_file()
        except (OSError, ValueError):
            continue
        if not is_directory and not is_file:
            continue
        entries.append(
            {
                "name": item.name,
                "path": item.relative_to(root).as_posix(),
                "type": "directory" if is_directory else "file",
                "size": item.stat().st_size if is_file else None,
            }
        )
    entries.sort(key=lambda entry: (entry["type"] != "directory", entry["name"].casefold()))
    handler.json_response({"root": root.name, "path": relative, "entries": entries})
    return True
