from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool, ToolRegistry

from ..tools import MonToolContext, create_mon_agent_tools
from ..tools.result import text_result
from .catalog import (
    BASE_TOOL_NAMES_BY_PROFILE,
    initial_skill_ids,
    normalize_skill_ids,
)
from .resources import ResolvedSkillResources, resolve_skill_resources
from .installer import INSTALLATION_MANIFEST, skill_roots
from .tool_plugins import load_tool_plugins, plugin_agent_tools
from ..tools.contracts import finalize_tool


SKILL_COMMAND_PATTERN = re.compile(r"^/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$")


class MonAgentSkillRuntime:
    def __init__(
        self,
        workspace_root: str | Path,
        context: MonToolContext | None = None,
        profile: str = "user_chat",
        active_skill_ids: tuple[str, ...] | None = None,
        owner_key: str | None = None,
        tool_filter: Callable[[AgentTool], bool] | None = None,
    ) -> None:
        self._workspace_root = Path(workspace_root).resolve()
        self._context = context
        self._owner_key = owner_key
        self.profile = profile
        self._all_tools = self._registered_tools(
            create_mon_agent_tools(workspace_root, context, profile),
            self._discover_plugin_tools(),
        )
        self._tools_by_name = {tool.name: tool for tool in self._all_tools}
        self.resources: ResolvedSkillResources = resolve_skill_resources(
            workspace_root,
            profile=profile,
            owner_key=owner_key,
        )
        available_names = {skill.name for skill in self.resources.snapshot.skills}
        self._loaded_skill_ids = [
            skill_id
            for skill_id in normalize_skill_ids(active_skill_ids or initial_skill_ids(profile))
            if skill_id in available_names
        ]
        self._revision = 0
        self._applied_revision = 0
        self._tool_filter = tool_filter
        self._loader_tool = self._create_loader_tool()
        self._search_tool = self._create_search_tool()

    def _discover_plugin_tools(self) -> list[AgentTool]:
        if not self._owner_key:
            return []
        selected: dict[str, AgentTool] = {}
        # user first, project second: project packages shadow user packages.
        for root in skill_roots(self._workspace_root, self._owner_key).values():
            if not root.exists():
                continue
            for directory in sorted(root.iterdir()):
                manifest_path = directory / INSTALLATION_MANIFEST
                if not directory.is_dir() or not manifest_path.is_file():
                    continue
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    if not manifest.get("enabled", True) or manifest.get("trustStatus") != "trusted":
                        continue
                    for tool in plugin_agent_tools(load_tool_plugins(directory)):
                        selected[tool.name] = tool
                except Exception:
                    continue
        return list(selected.values())

    @staticmethod
    def _registered_tools(base_tools: list[AgentTool], plugin_tools: list[AgentTool]) -> list[AgentTool]:
        registry = ToolRegistry()
        registry.register_many(base_tools)
        registry.register_many((finalize_tool(tool, source="skill") for tool in plugin_tools), source="skill")
        return list(registry.snapshot())

    def _refresh_resources(self) -> None:
        """Re-discover packages so a skill created during this run is immediately loadable."""
        refreshed = resolve_skill_resources(
            self._workspace_root,
            profile=self.profile,
            owner_key=self._owner_key,
        )
        if refreshed.snapshot.skills == self.resources.snapshot.skills:
            return
        self.resources = refreshed
        self._all_tools = self._registered_tools(
            create_mon_agent_tools(self._workspace_root, self._context, self.profile),
            self._discover_plugin_tools(),
        )
        self._tools_by_name = {tool.name: tool for tool in self._all_tools}
        available = {skill.name for skill in refreshed.snapshot.skills}
        self._loaded_skill_ids = [name for name in self._loaded_skill_ids if name in available]
        self._loader_tool = self._create_loader_tool()
        self._search_tool = self._create_search_tool()
        self._revision += 1

    @property
    def active_skill_ids(self) -> tuple[str, ...]:
        """Compatibility alias for callers that previously tracked active skills."""
        return tuple(self._loaded_skill_ids)

    @property
    def loaded_skill_ids(self) -> tuple[str, ...]:
        return tuple(self._loaded_skill_ids)

    @property
    def available_skill_ids(self) -> tuple[str, ...]:
        return tuple(skill.name for skill in self.resources.snapshot.visible_skills())

    def active_tools(self) -> list[AgentTool]:
        self._refresh_resources()
        active_names = set(BASE_TOOL_NAMES_BY_PROFILE.get(self.profile, ()))
        # Skills progressively disclose workflow instructions. They do not
        # register or unregister capabilities: the profile and tool policy own
        # the stable tool set for the whole agent run.
        active_names.update(
            self.resources.tools_for(tuple(skill.name for skill in self.resources.snapshot.skills))
        )
        tools = [self._loader_tool, self._search_tool]
        tools.extend(
            tool
            for tool in self._all_tools
            if tool.name != "loaded_tools" and tool.name in active_names
        )
        return [tool for tool in tools if self._tool_filter is None or self._tool_filter(tool)]

    def _create_search_tool(self) -> AgentTool:
        registry = ToolRegistry()
        registry.register_many(self._all_tools)

        async def tool_search_execute(
            _tool_call_id: str,
            params: dict[str, Any],
            _signal: Any = None,
            _on_update: Any = None,
        ) -> dict[str, Any]:
            query = str(params.get("query") or "").strip()
            limit = int(params.get("limit") or 8)
            namespace = str(params.get("namespace") or "").strip() or None
            source = str(params.get("source") or "").strip() or None
            matches = registry.search(query, limit=limit, namespace=namespace, source=source)
            namespace_fallback = False
            if namespace and not matches:
                # Discovery should not require the model to guess an internal
                # namespace perfectly. Keep source filtering, but retry once
                # across namespaces and report that the fallback occurred.
                matches = registry.search(query, limit=limit, source=source)
                namespace_fallback = bool(matches)
            registry.reveal(tool.name for tool in matches)
            revealed = []
            for match in matches:
                tool = self._tools_by_name.get(match.name)
                if tool is None or tool.exposure == "hidden":
                    continue
                tool.exposure = "direct"
                revealed.append(tool)
            entries = [
                {
                    "name": tool.name,
                    "label": tool.label,
                    "description": tool.description,
                    "parameters": dict(tool.parameters),
                    "outputSchema": dict(tool.output_schema) if tool.output_schema is not None else None,
                    "source": tool.source,
                    "namespace": tool.namespace,
                }
                for tool in revealed
            ]
            if not entries:
                return text_result(
                    f"没有找到与“{query}”匹配的延迟工具。",
                    {
                        "query": query,
                        "tools": [],
                        "namespace": namespace,
                        "source": source,
                        "namespaceFallback": False,
                        "matchedNamespaces": [],
                    },
                )
            summary = "\n\n".join(
                f"{index}. {item['name']}：{item['description']}"
                for index, item in enumerate(entries, start=1)
            )
            fallback_notice = (
                f"指定命名空间 {namespace} 无匹配，已自动跨命名空间搜索。\n"
                if namespace_fallback else ""
            )
            return text_result(
                f"{fallback_notice}已加载 {len(entries)} 个匹配工具；下一轮可以直接调用。\n\n{summary}",
                {
                    "query": query,
                    "tools": entries,
                    "namespace": namespace,
                    "source": source,
                    "namespaceFallback": namespace_fallback,
                    "matchedNamespaces": sorted({str(item["namespace"]) for item in entries}),
                },
            )

        return finalize_tool(AgentTool(
            name="tool_search",
            label="搜索工具",
            description="按任务语义搜索并加载已注册但尚未暴露的工具。技能说明和工具发现彼此独立。",
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "minLength": 1,
                        "description": "用自然语言描述要完成的任务、目标系统或所需能力。",
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                    "namespace": {
                        "type": "string",
                        "description": "可选；优先搜索指定能力域，例如 connector、coding、communication、plugin。无结果时自动跨命名空间重试。",
                    },
                    "source": {
                        "type": "string",
                        "enum": ["builtin", "coding", "skill", "connector", "runtime", "sdk", "extension"],
                    },
                },
                "required": ["query"],
            },
            execute=tool_search_execute,
            execution_mode="sequential",
            output_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "tools": {"type": "array", "items": {"type": "object"}},
                    "namespace": {"type": ["string", "null"]},
                    "source": {"type": ["string", "null"]},
                    "namespaceFallback": {"type": "boolean"},
                    "matchedNamespaces": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["query", "tools", "namespaceFallback", "matchedNamespaces"],
                "additionalProperties": False,
            },
        ), source="builtin")

    def load(self, requested_skill_ids: list[str]) -> dict[str, Any]:
        self._refresh_resources()
        requested = normalize_skill_ids(requested_skill_ids)
        allowed = set(self.available_skill_ids)
        unknown = [skill_id for skill_id in requested if skill_id not in allowed]
        if unknown:
            return {
                "success": False,
                "unknown": unknown,
                "available": list(self.available_skill_ids),
                "loaded": [],
            }

        loaded = [skill_id for skill_id in requested if skill_id not in self._loaded_skill_ids]
        if loaded:
            self._loaded_skill_ids.extend(loaded)
            self._revision += 1
        invocations = [
            invocation
            for skill_id in loaded
            if (invocation := self.resources.snapshot.format_skill_invocation(skill_id))
        ]
        return {
            "success": True,
            "unknown": [],
            "available": list(self.available_skill_ids),
            "loaded": loaded,
            "activated": loaded,
            "active": list(self._loaded_skill_ids),
            "instructions": "\n\n".join(invocations),
        }

    def activate(self, requested_skill_ids: list[str]) -> dict[str, Any]:
        """Backward-compatible host API; model-facing calls use load_skill."""
        return self.load(requested_skill_ids)

    def load_command(self, text: str) -> dict[str, Any] | None:
        match = SKILL_COMMAND_PATTERN.fullmatch(str(text or "").strip())
        if match is None:
            return None
        result = self.load([match.group(1)])
        result["userMessage"] = str(match.group(2) or "").strip()
        return result

    def prompt_section(self) -> str:
        self._refresh_resources()
        sections: list[str] = []
        catalog = self.resources.snapshot.format_catalog("load_skill")
        if catalog:
            sections.append(catalog)
        loaded = [
            invocation
            for skill_id in self._loaded_skill_ids
            if (invocation := self.resources.snapshot.format_skill_invocation(skill_id))
        ]
        if loaded:
            sections.extend(["当前已加载技能：", "\n\n".join(loaded)])
        return "\n\n".join(sections)

    def prepare_next_turn(
        self,
        turn: dict[str, Any],
        system_prompt_builder: Callable[[tuple[str, ...]], str],
    ) -> dict[str, Any] | None:
        if self._revision == self._applied_revision:
            return None
        current_context = turn.get("context") if isinstance(turn.get("context"), dict) else {}
        system_prompt = system_prompt_builder(self.active_skill_ids)
        next_context = {
            **current_context,
            "systemPrompt": system_prompt,
            "tools": self.active_tools(),
        }
        self._applied_revision = self._revision
        return {"context": next_context}

    def _create_loader_tool(self) -> AgentTool:
        available_ids = list(self.available_skill_ids)

        async def load_skill_execute(
            _tool_call_id: str,
            params: dict[str, Any],
            _signal: Any = None,
            _on_update: Any = None,
        ) -> dict[str, Any]:
            raw_skills = params.get("skills") if isinstance(params, dict) else None
            requested = [str(item) for item in raw_skills] if isinstance(raw_skills, list) else []
            result = self.load(requested)
            if not result["success"]:
                return text_result(
                    f"无法加载未知技能：{', '.join(result['unknown'])}。\n\n可用技能：{', '.join(result['available'])}",
                    result,
                )
            loaded = result["loaded"]
            if not loaded:
                return text_result("请求的技能已经加载，无需重复读取。", result)
            instructions = str(result.get("instructions") or "").strip()
            body = [f"已加载技能：{', '.join(loaded)}。请遵循下面的技能说明。"]
            if instructions:
                body.extend(["", instructions])
            return text_result("\n".join(body), result)

        return finalize_tool(AgentTool(
            name="load_skill",
            label="加载技能",
            description=(
                "按当前任务读取一个或多个技能的完整工作流说明。工具能力由当前运行环境和权限策略独立提供。"
                f"\n\n{self.resources.snapshot.format_catalog('load_skill')}"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "skills": {
                        "type": "array",
                        "items": {"type": "string", "enum": available_ids},
                        "minItems": 1,
                        "description": "需要为当前任务加载的技能 ID，可一次选择多个。",
                    }
                },
                "required": ["skills"],
            },
            execute=load_skill_execute,
            execution_mode="sequential",
            output_schema={
                "type": "object",
                "properties": {
                    "success": {"type": "boolean"},
                    "loaded": {"type": "array", "items": {"type": "string"}},
                    "available": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["success", "loaded", "available"],
                "additionalProperties": True,
            },
        ), source="builtin")


def create_skill_runtime(
    workspace_root: str | Path,
    context: MonToolContext | None = None,
    profile: str = "user_chat",
    active_skill_ids: tuple[str, ...] | None = None,
    owner_key: str | None = None,
    tool_filter: Callable[[AgentTool], bool] | None = None,
) -> MonAgentSkillRuntime:
    return MonAgentSkillRuntime(
        workspace_root,
        context,
        profile,
        active_skill_ids,
        owner_key,
        tool_filter,
    )
