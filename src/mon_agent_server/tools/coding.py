from __future__ import annotations

from pathlib import Path
from typing import Any

from ..agent_api import AgentTool


async def _native_only(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
    raise RuntimeError("This coding tool must execute in the native AgentCore runtime")


def _tool(name: str, label: str, description: str, properties: dict[str, Any], required: list[str] | None = None, *, sequential: bool = False, output: bool = False) -> AgentTool:
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return AgentTool(
        name=name,
        label=label,
        description=description,
        parameters=schema,
        execute=_native_only,
        execution_mode="sequential" if sequential else None,
        output_schema={"type": "object", "additionalProperties": True} if output else None,
    )


def create_all_tools(_workspace_root: str | Path, _options: dict[str, Any] | None = None) -> dict[str, AgentTool]:
    tools = [
        _tool("read", "read", "Read the contents of a file. Supports text files and images. For text files, output is truncated to 2000 lines or 50KB. Use offset/limit for large files.", {"path": {"type": "string", "description": "Filesystem path to read. Do not pass builtin:// skill identifiers; load those with load_skill."}, "offset": {"type": "number", "description": "Line number to start reading from"}, "limit": {"type": "number", "description": "Maximum number of lines to read"}}, ["path"]),
        _tool("bash", "bash", "Execute a Bash command in the current working directory. On Windows this is Git Bash, not PowerShell; use the powershell tool for PowerShell scripts and Windows cmdlets. Short commands return normally; long-running commands yield a process session ID for use with write_stdin.", {"command": {"type": "string", "minLength": 1, "description": "Bash command to execute. Do not wrap PowerShell scripts containing $ variables inside Bash double quotes; use the powershell tool instead."}, "yield_time_ms": {"type": "integer", "minimum": 250, "maximum": 30000}}, ["command"], sequential=True, output=True),
        _tool("powershell", "powershell", "Execute a PowerShell script directly in the current working directory without Bash interpolation. Output is normalized to UTF-8. Prefer this tool for Windows system inspection, PowerShell variables, and cmdlets. Short scripts return normally; long-running scripts yield a process session ID for use with write_stdin.", {"command": {"type": "string", "minLength": 1, "description": "PowerShell script to execute directly; do not add an outer powershell -Command wrapper"}, "yield_time_ms": {"type": "integer", "minimum": 250, "maximum": 30000}}, ["command"], sequential=True, output=True),
        _tool("write_stdin", "process input", "Poll a running bash or PowerShell session, send characters, or terminate its process group.", {"session_id": {"type": "string"}, "chars": {"type": "string"}, "yield_time_ms": {"type": "integer", "minimum": 0, "maximum": 30000}, "terminate": {"type": "boolean"}}, ["session_id"], sequential=True, output=True),
        _tool("edit", "edit", "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file.", {"path": {"type": "string"}, "edits": {"type": "array", "items": {"type": "object", "properties": {"oldText": {"type": "string"}, "newText": {"type": "string"}}, "required": ["oldText", "newText"]}}}, ["path", "edits"], output=True),
        _tool("write", "write", "Write content to a file. Creates parent directories and overwrites existing files.", {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"], output=True),
        _tool("apply_patch", "apply_patch", "Apply a Codex-style patch to add, update, delete, or move one or more files inside the workspace.", {"patch": {"type": "string"}}, ["patch"], sequential=True, output=True),
        _tool("grep", "grep", "Search file contents for a pattern. Returns matching lines with file paths and line numbers.", {"pattern": {"type": "string"}, "path": {"type": "string"}, "glob": {"type": "string"}, "ignoreCase": {"type": "boolean"}, "literal": {"type": "boolean"}, "context": {"type": "number"}, "limit": {"type": "number"}}, ["pattern"]),
        _tool("find", "find", "Search for files by glob pattern. Respects ignore files and returns relative paths.", {"pattern": {"type": "string"}, "path": {"type": "string"}, "limit": {"type": "number"}}, ["pattern"]),
        _tool("ls", "ls", "List directory contents, sorted alphabetically with '/' suffix for directories.", {"path": {"type": "string"}, "limit": {"type": "number"}}),
        _tool("get_diff", "workspace diff", "Inspect Git workspace changes as a structured review diff without modifying files.", {"scope": {"type": "string", "enum": ["working_tree", "staged", "all"], "description": "Diff scope"}, "path": {"type": "string", "description": "Optional workspace-relative path filter"}}, output=True),
    ]
    return {tool.name: tool for tool in tools}
