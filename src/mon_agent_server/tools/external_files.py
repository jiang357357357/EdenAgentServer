from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any, Iterable

from ..agent_api import AgentTool

from .context import MonToolContext
from .result import text_result, tool_failure
MAX_LIST_ENTRIES = 500
MAX_FIND_RESULTS = 500
MAX_READ_BYTES = 256 * 1024
MAX_GREP_FILES = 500
MAX_GREP_BYTES = 2 * 1024 * 1024
MAX_GREP_MATCHES = 500


def _validate_root(value: Any) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise tool_failure("invalid_arguments", "root 必须是一个目录")
    root = Path(raw).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise tool_failure("not_found", f"外部读取根目录不存在或不是目录: {raw}")
    return root


def _resolve_scoped(root: Path, relative_path: Any = ".", *, require_file: bool = False) -> Path:
    raw = str(relative_path or ".").strip() or "."
    candidate = Path(raw).expanduser()
    resolved = candidate.resolve(strict=True) if candidate.is_absolute() else (root / candidate).resolve(strict=True)
    if require_file and not resolved.is_file():
        raise tool_failure("not_found", f"目标不是普通文件: {raw}")
    return resolved


def _display_path(root: Path, target: Path) -> str:
    try:
        return str(target.relative_to(root))
    except ValueError:
        return str(target)


def _walk_files(root: Path, start: Path, max_depth: int) -> Iterable[Path]:
    start_depth = len(start.parts)
    for current, dirs, files in os.walk(start, followlinks=False):
        current_path = Path(current)
        depth = len(current_path.parts) - start_depth
        dirs[:] = sorted(name for name in dirs if not (current_path / name).is_symlink())
        if depth >= max_depth:
            dirs[:] = []
        for name in sorted(files):
            path = current_path / name
            if path.is_symlink():
                continue
            try:
                path.resolve(strict=True).relative_to(root)
            except (OSError, ValueError):
                continue
            yield path


def _find_entries(root: Path, start: Path, query: str, max_depth: int) -> list[dict[str, str]]:
    matches: list[dict[str, str]] = []
    start_depth = len(start.parts)
    for current, dirs, files in os.walk(start, followlinks=False):
        current_path = Path(current)
        depth = len(current_path.parts) - start_depth
        dirs[:] = sorted(name for name in dirs if not (current_path / name).is_symlink())
        if depth >= max_depth:
            dirs[:] = []
        for name, kind in [(name, "directory") for name in dirs] + [(name, "file") for name in sorted(files)]:
            path = current_path / name
            if path.is_symlink():
                continue
            try:
                path.resolve(strict=True).relative_to(root)
            except (OSError, ValueError):
                continue
            if query in name.lower():
                matches.append({"path": str(path.relative_to(root)), "type": kind})
                if len(matches) >= MAX_FIND_RESULTS:
                    return matches
    return matches


def create_external_file_tools(workspace_root: Path, context: MonToolContext) -> list[AgentTool]:
    async def external_ls(call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        root = _validate_root(params.get("root"))
        target = _resolve_scoped(root, params.get("path", "."))
        if not target.is_dir():
            raise RuntimeError("external_ls 的目标必须是目录")
        entries = []
        for item in sorted(target.iterdir(), key=lambda value: value.name.lower())[:MAX_LIST_ENTRIES]:
            kind = "symlink" if item.is_symlink() else "directory" if item.is_dir() else "file"
            entries.append({"name": item.name, "type": kind})
        truncated = len(entries) == MAX_LIST_ENTRIES
        lines = [f"{item['type']}: {item['name']}" for item in entries]
        if truncated:
            lines.append(f"[结果最多显示 {MAX_LIST_ENTRIES} 项]")
        return text_result("\n".join(lines) or "目录为空", {"root": str(root), "path": _display_path(root, target), "entries": entries, "truncated": truncated})

    async def external_read(call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        root = _validate_root(params.get("root"))
        target = _resolve_scoped(root, params.get("path"), require_file=True)
        size = target.stat().st_size
        if size > MAX_READ_BYTES:
            raise RuntimeError(f"文件超过 external_read 的 {MAX_READ_BYTES} 字节上限")
        data = await asyncio.to_thread(target.read_bytes)
        if b"\x00" in data:
            raise RuntimeError("external_read 仅支持文本文件")
        text = data.decode(str(params.get("encoding") or "utf-8"), errors="replace")
        return text_result(text, {"root": str(root), "path": _display_path(root, target), "bytes": len(data)})

    async def external_find(call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        root = _validate_root(params.get("root"))
        start = _resolve_scoped(root, params.get("path", "."))
        if not start.is_dir():
            raise RuntimeError("external_find 的起点必须是目录")
        query = str(params.get("name") or "").strip().lower()
        if not query:
            raise RuntimeError("name 不能为空")
        max_depth = min(max(int(params.get("max_depth", 6)), 1), 8)
        matches = _find_entries(root, start, query, max_depth)
        rendered = "\n".join(f"{item['type']}: {item['path']}" for item in matches)
        return text_result(rendered or "未找到匹配文件或目录", {"root": str(root), "matches": matches, "truncated": len(matches) >= MAX_FIND_RESULTS})

    async def external_grep(call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        root = _validate_root(params.get("root"))
        start = _resolve_scoped(root, params.get("path", "."))
        pattern = str(params.get("pattern") or "")
        if not pattern:
            raise RuntimeError("pattern 不能为空")
        try:
            regex = re.compile(pattern, re.IGNORECASE if params.get("ignore_case", True) else 0)
        except re.error as exc:
            raise RuntimeError(f"无效正则表达式: {exc}") from exc
        max_depth = min(max(int(params.get("max_depth", 6)), 1), 8)
        files = [start] if start.is_file() else _walk_files(root, start, max_depth)
        results: list[dict[str, Any]] = []
        files_seen = bytes_seen = 0
        for file_path in files:
            if files_seen >= MAX_GREP_FILES or bytes_seen >= MAX_GREP_BYTES:
                break
            try:
                size = file_path.stat().st_size
                if size > MAX_READ_BYTES or bytes_seen + size > MAX_GREP_BYTES:
                    continue
                data = file_path.read_bytes()
            except OSError:
                continue
            files_seen += 1
            bytes_seen += len(data)
            if b"\x00" in data:
                continue
            for line_number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
                if regex.search(line):
                    results.append({"path": str(file_path.relative_to(root)), "line": line_number, "text": line[:500]})
                    if len(results) >= MAX_GREP_MATCHES:
                        break
            if len(results) >= MAX_GREP_MATCHES:
                break
        rendered = "\n".join(f"{item['path']}:{item['line']}: {item['text']}" for item in results)
        return text_result(rendered or "未找到匹配内容", {"root": str(root), "matches": results, "filesScanned": files_seen, "bytesScanned": bytes_seen, "truncated": len(results) >= MAX_GREP_MATCHES})

    root_property = {"type": "string", "description": "只读操作的起始目录，可以是 /、/home、用户主目录或其他绝对目录。"}
    path_property = {"type": "string", "description": "目标路径，默认 .；可以是相对于 root 的路径，也可以是绝对路径。"}
    common = {"root": root_property, "path": path_property}
    return [
        AgentTool("external_ls", "列出外部目录", "列出工作区外的目录。", {"type": "object", "properties": common, "required": ["root"]}, external_ls),
        AgentTool("external_read", "读取外部文本", "直接读取具体目录中的小型文本文件；不会读取二进制或超过 256 KiB 的文件。", {"type": "object", "properties": {**common, "encoding": {"type": "string"}}, "required": ["root", "path"]}, external_read),
        AgentTool("external_find", "查找外部文件或目录", "在任意目录内按名称递归查找文件或目录；用于游戏存档等个人文件定位，结果和深度有限。", {"type": "object", "properties": {**common, "name": {"type": "string"}, "max_depth": {"type": "integer", "minimum": 1, "maximum": 8}}, "required": ["root", "name"]}, external_find),
        AgentTool("external_grep", "搜索外部文本", "在任意目录内搜索文本内容，跳过符号链接、二进制和大文件。", {"type": "object", "properties": {**common, "pattern": {"type": "string"}, "ignore_case": {"type": "boolean"}, "max_depth": {"type": "integer", "minimum": 1, "maximum": 8}}, "required": ["root", "pattern"]}, external_grep),
    ]
