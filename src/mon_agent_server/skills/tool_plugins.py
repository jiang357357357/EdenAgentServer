from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool, ToolExecutionError

from ..tools.result import text_result, truncate


TOOL_MANIFEST_GLOB = "tools/*.json"
TOOL_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
MAX_TIMEOUT_SECONDS = 120


@dataclass(frozen=True, slots=True)
class SkillToolPlugin:
    name: str
    label: str
    description: str
    parameters: dict[str, Any]
    output_schema: dict[str, Any] | None
    command: tuple[str, ...]
    timeout_seconds: int
    root: Path
    manifest_path: Path
    test_command: tuple[str, ...] = ()


def _command(value: Any, *, field: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item.strip() for item in value):
        raise ValueError(f"代码工具 {field} 必须是非空字符串数组")
    return tuple(item.strip() for item in value)


def _validate_local_paths(root: Path, command: tuple[str, ...]) -> None:
    """Reject path traversal while allowing interpreters resolved from PATH."""
    for token in command:
        if token.startswith("-") or "/" not in token:
            continue
        candidate = Path(token)
        if candidate.is_absolute() or ".." in candidate.parts:
            raise ValueError(f"代码工具命令只能引用技能目录内的相对路径：{token}")
        resolved = (root / candidate).resolve()
        if root != resolved and root not in resolved.parents:
            raise ValueError(f"代码工具命令越过技能目录：{token}")
        if not resolved.exists():
            raise ValueError(f"代码工具命令引用的文件不存在：{token}")


def load_tool_plugins(root: Path) -> tuple[SkillToolPlugin, ...]:
    plugins: list[SkillToolPlugin] = []
    names: set[str] = set()
    for manifest_path in sorted(root.glob(TOOL_MANIFEST_GLOB)):
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as error:
            raise ValueError(f"代码工具清单不是有效 JSON：{manifest_path.relative_to(root)}") from error
        if not isinstance(data, dict) or data.get("schemaVersion") != 1:
            raise ValueError(f"代码工具清单 schemaVersion 必须为 1：{manifest_path.relative_to(root)}")
        name = str(data.get("name") or "").strip()
        if not TOOL_NAME_PATTERN.fullmatch(name):
            raise ValueError(f"代码工具名称无效：{name or manifest_path.stem}")
        if name in names:
            raise ValueError(f"代码工具名称重复：{name}")
        names.add(name)
        description = str(data.get("description") or "").strip()
        if not description:
            raise ValueError(f"代码工具缺少 description：{name}")
        parameters = data.get("parameters", {"type": "object", "properties": {}})
        if not isinstance(parameters, dict) or parameters.get("type") != "object":
            raise ValueError(f"代码工具 parameters 必须是 object JSON Schema：{name}")
        output_schema = data.get("outputSchema")
        if output_schema is not None and (
            not isinstance(output_schema, dict) or not isinstance(output_schema.get("type"), str)
        ):
            raise ValueError(f"代码工具 outputSchema 必须是有效 JSON Schema：{name}")
        command = _command(data.get("command"), field="command")
        test_command = _command(data["testCommand"], field="testCommand") if "testCommand" in data else ()
        _validate_local_paths(root, command)
        if test_command:
            _validate_local_paths(root, test_command)
        timeout = int(data.get("timeoutSeconds") or 30)
        if not 1 <= timeout <= MAX_TIMEOUT_SECONDS:
            raise ValueError(f"代码工具 timeoutSeconds 必须在 1–{MAX_TIMEOUT_SECONDS}：{name}")
        plugins.append(
            SkillToolPlugin(
                name=name,
                label=str(data.get("label") or name).strip(),
                description=description,
                parameters=parameters,
                output_schema=output_schema,
                command=command,
                timeout_seconds=timeout,
                root=root,
                manifest_path=manifest_path,
                test_command=test_command,
            )
        )
    return tuple(plugins)


def run_plugin_tests(plugins: tuple[SkillToolPlugin, ...]) -> None:
    import subprocess

    for plugin in plugins:
        if not plugin.test_command:
            continue
        result = subprocess.run(
            plugin.test_command,
            cwd=plugin.root,
            input="{}",
            capture_output=True,
            text=True,
            timeout=plugin.timeout_seconds,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "没有错误输出").strip()
            raise ValueError(f"代码工具自测失败 {plugin.name}：{detail[-1000:]}")


def plugin_agent_tools(plugins: tuple[SkillToolPlugin, ...]) -> list[AgentTool]:
    result: list[AgentTool] = []
    for plugin in plugins:
        async def execute(
            _tool_call_id: str,
            params: dict[str, Any],
            _signal: Any = None,
            _on_update: Any = None,
            *,
            current: SkillToolPlugin = plugin,
        ) -> dict[str, Any]:
            process = await asyncio.create_subprocess_exec(
                *current.command,
                cwd=current.root,
                env={**os.environ, "MONAGENT_SKILL_ROOT": str(current.root)},
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await process.communicate(json.dumps(params, ensure_ascii=False).encode("utf-8"))
            except asyncio.CancelledError:
                process.kill()
                await process.wait()
                raise
            output = stdout.decode("utf-8", errors="replace").strip()
            error = stderr.decode("utf-8", errors="replace").strip()
            if process.returncode != 0:
                raise ToolExecutionError(
                    "process_failed",
                    f"代码工具执行失败 {current.name}：{truncate(error or output, 2000)}",
                    details={"exitCode": process.returncode},
                )
            details: dict[str, Any] = {"tool": current.name, "exitCode": process.returncode}
            try:
                parsed = json.loads(output)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                details["result"] = parsed
                display = str(parsed.get("text") or parsed.get("message") or output)
            else:
                display = output
            result = text_result(truncate(display or "代码工具执行完成。"), details)
            if current.output_schema is not None:
                if parsed is None:
                    raise ToolExecutionError(
                        "invalid_tool_output",
                        f"代码工具 {current.name} 声明了 outputSchema，但标准输出不是 JSON 对象。",
                    )
                result["structuredContent"] = parsed
            return result

        result.append(
            AgentTool(
                name=plugin.name,
                label=plugin.label,
                description=plugin.description,
                parameters=plugin.parameters,
                execute=execute,
                execution_mode="sequential",
                timeout_seconds=float(plugin.timeout_seconds),
                source="skill",
                version="1",
                capabilities=frozenset({"skill", "process"}),
                output_schema=plugin.output_schema,
            )
        )
    return result
