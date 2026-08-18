from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from mon_agent_server.native_runtime import NativeRuntimeClient

from .tool_plugins import load_tool_plugins, run_plugin_tests


async def _load_skills_native(root: Path) -> dict[str, Any]:
    client = NativeRuntimeClient(server_version="skill-loader")
    await client.start()
    try:
        return await client.load_skills([str(root)])
    finally:
        await client.close()


@dataclass(frozen=True, slots=True)
class SkillDefinition:
    id: str
    name: str
    description: str
    tool_names: tuple[str, ...]
    instructions: tuple[str, ...]
    profiles: tuple[str, ...] = ("user_chat", "self_awake")
    model_invocable: bool = True
    source: str = "builtin"
    file_path: str | None = None
    scope: str = "system"


def _frontmatter(skill_file: Path) -> dict[str, Any]:
    text = skill_file.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    parsed = yaml.safe_load(parts[1]) or {}
    return parsed if isinstance(parsed, dict) else {}


def _string_tuple(value: Any, fallback: tuple[str, ...] = ()) -> tuple[str, ...]:
    if not isinstance(value, list):
        return fallback
    return tuple(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))


def load_skill_package(
    root: Path,
    *,
    source: str,
    scope: str,
    known_tools: set[str] | None = None,
    reserved_names: set[str] | None = None,
    run_tests: bool = False,
) -> tuple[SkillDefinition, str]:
    """Load every MonAgent skill, builtin or installed, through one package contract."""
    plugins = load_tool_plugins(root)
    if run_tests:
        run_plugin_tests(plugins)
    plugin_names = {plugin.name for plugin in plugins}
    if known_tools is not None:
        collisions = sorted(plugin_names & known_tools)
        if collisions:
            raise ValueError(f"代码工具名称与宿主工具冲突：{', '.join(collisions)}")

    coroutine = _load_skills_native(root)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        result = asyncio.run(coroutine)
    else:
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="skill-package-load") as executor:
            result = executor.submit(asyncio.run, coroutine).result()
    skills = result.get("skills") or []
    diagnostics = result.get("diagnostics") or []
    if len(skills) != 1:
        message = "; ".join(str(item.get("message") or item) for item in diagnostics) or "必须且只能包含一个有效技能"
        raise ValueError(message)

    skill = dict(skills[0])
    skill_file = Path(str(skill["filePath"]))
    frontmatter = _frontmatter(skill_file)
    metadata = frontmatter.get("metadata")
    metadata = metadata.get("monagent") if isinstance(metadata, dict) else {}
    metadata = metadata if isinstance(metadata, dict) else {}
    name = str(skill["name"]).strip()
    if reserved_names and name in reserved_names:
        raise ValueError(f"技能名称与基础技能冲突：{name}")
    tool_names = _string_tuple(metadata.get("tools"))
    if known_tools is not None:
        unknown = sorted(set(tool_names) - known_tools - plugin_names)
        if unknown:
            raise ValueError(f"技能声明了未知工具：{', '.join(unknown)}")
    profiles = _string_tuple(metadata.get("profiles"), ("user_chat", "self_awake"))
    invalid_profiles = sorted(set(profiles) - {"user_chat", "self_awake"})
    if invalid_profiles:
        raise ValueError(f"技能声明了未知运行档案：{', '.join(invalid_profiles)}")
    display_name = str(metadata.get("display_name") or frontmatter.get("display-name") or name).strip()
    version = str(metadata.get("version") or frontmatter.get("version") or "0.0.0").strip()
    return (
        SkillDefinition(
            id=name,
            name=display_name,
            description=str(skill["description"]).strip(),
            tool_names=tool_names,
            instructions=(str(skill["content"]).strip(),),
            profiles=profiles,
            model_invocable=not bool(skill.get("disableModelInvocation")),
            source=source,
            file_path=str(skill_file.resolve()),
            scope=scope,
        ),
        version,
    )
