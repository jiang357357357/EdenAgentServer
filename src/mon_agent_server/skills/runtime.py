from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool

from ..tools import MonToolContext, create_mon_agent_tools
from ..tools.result import text_result
from .catalog import (
    BASE_TOOL_NAMES_BY_PROFILE,
    initial_skill_ids,
    normalize_skill_ids,
)
from .resources import ResolvedSkillResources, resolve_skill_resources


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
        self.profile = profile
        self._all_tools = create_mon_agent_tools(workspace_root, context, profile)
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
        active_names = set(BASE_TOOL_NAMES_BY_PROFILE.get(self.profile, ()))
        # Skills progressively disclose workflow instructions. They do not
        # register or unregister capabilities: the profile and tool policy own
        # the stable tool set for the whole agent run.
        active_names.update(
            self.resources.tools_for(tuple(skill.name for skill in self.resources.snapshot.skills))
        )
        tools = [self._loader_tool]
        tools.extend(
            tool
            for tool in self._all_tools
            if tool.name != "loaded_tools" and tool.name in active_names
        )
        return [tool for tool in tools if self._tool_filter is None or self._tool_filter(tool)]

    def load(self, requested_skill_ids: list[str]) -> dict[str, Any]:
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

        return AgentTool(
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
        )


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
