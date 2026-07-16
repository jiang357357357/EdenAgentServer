from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool

from ..tools import MonToolContext, create_mon_agent_tools
from ..tools.result import text_result
from .catalog import (
    BASE_TOOL_NAMES_BY_PROFILE,
    SKILLS_BY_ID,
    initial_skill_ids,
    normalize_skill_ids,
    render_active_skill_instructions,
    render_skill_catalog,
    skill_definitions_for_profile,
    tool_names_for_skills,
)


class MonAgentSkillRuntime:
    def __init__(
        self,
        workspace_root: str | Path,
        context: MonToolContext | None = None,
        profile: str = "user_chat",
        active_skill_ids: tuple[str, ...] | None = None,
    ) -> None:
        self.profile = profile
        self._all_tools = create_mon_agent_tools(workspace_root, context, profile)
        self._tools_by_name = {tool.name: tool for tool in self._all_tools}
        self._active_skill_ids = list(normalize_skill_ids(active_skill_ids or initial_skill_ids(profile)))
        self._revision = 0
        self._applied_revision = 0
        self._activation_tool = self._create_activation_tool()

    @property
    def active_skill_ids(self) -> tuple[str, ...]:
        return tuple(self._active_skill_ids)

    @property
    def available_skill_ids(self) -> tuple[str, ...]:
        return tuple(skill.id for skill in skill_definitions_for_profile(self.profile, model_invocable_only=True))

    def active_tools(self) -> list[AgentTool]:
        active_names = set(BASE_TOOL_NAMES_BY_PROFILE.get(self.profile, ()))
        active_names.update(tool_names_for_skills(self._active_skill_ids))
        tools = [self._activation_tool]
        tools.extend(
            tool
            for tool in self._all_tools
            if tool.name != "loaded_tools" and tool.name in active_names
        )
        return tools

    def activate(self, requested_skill_ids: list[str]) -> dict[str, Any]:
        requested = normalize_skill_ids(requested_skill_ids)
        allowed = set(self.available_skill_ids)
        unknown = [skill_id for skill_id in requested if skill_id not in allowed]
        if unknown:
            return {
                "success": False,
                "unknown": unknown,
                "available": list(self.available_skill_ids),
                "activated": [],
            }

        activated = [skill_id for skill_id in requested if skill_id not in self._active_skill_ids]
        if activated:
            self._active_skill_ids.extend(activated)
            self._revision += 1
        return {
            "success": True,
            "unknown": [],
            "available": list(self.available_skill_ids),
            "activated": activated,
            "active": list(self._active_skill_ids),
            "instructions": render_active_skill_instructions(activated),
        }

    def prepare_next_turn(
        self,
        turn: dict[str, Any],
        system_prompt_builder: Callable[[tuple[str, ...]], str],
    ) -> dict[str, Any] | None:
        if self._revision == self._applied_revision:
            return None
        current_context = turn.get("context") if isinstance(turn.get("context"), dict) else {}
        next_context = {
            **current_context,
            "systemPrompt": system_prompt_builder(self.active_skill_ids),
            "tools": self.active_tools(),
        }
        self._applied_revision = self._revision
        return {"context": next_context}

    def _create_activation_tool(self) -> AgentTool:
        available_ids = list(self.available_skill_ids)
        catalog = render_skill_catalog(self.profile, self._active_skill_ids)

        async def activate_skill_execute(
            _tool_call_id: str,
            params: dict[str, Any],
            _signal: Any = None,
            _on_update: Any = None,
        ) -> dict[str, Any]:
            raw_skills = params.get("skills") if isinstance(params, dict) else None
            requested = [str(item) for item in raw_skills] if isinstance(raw_skills, list) else []
            result = self.activate(requested)
            if not result["success"]:
                return text_result(
                    f"无法激活未知技能：{', '.join(result['unknown'])}。\n\n可用技能：{', '.join(result['available'])}",
                    result,
                )
            activated = result["activated"]
            if not activated:
                return text_result("请求的技能已经激活，无需重复加载。", result)
            instructions = str(result.get("instructions") or "").strip()
            body = [f"已激活技能：{', '.join(activated)}。相关工具会从下一次模型调用开始可用。"]
            if instructions:
                body.extend(["", "请立即遵循以下技能说明：", instructions])
            return text_result("\n".join(body), result)

        return AgentTool(
            name="activate_skill",
            label="激活技能",
            description=(
                "按当前任务激活一个或多个技能。调用后，技能说明会返回，相关工具 schema 会在同一轮的下一次模型调用中出现。"
                f"\n\n可用技能：\n{catalog}"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "skills": {
                        "type": "array",
                        "items": {"type": "string", "enum": available_ids},
                        "minItems": 1,
                        "description": "需要为当前任务激活的技能 ID，可一次选择多个。",
                    }
                },
                "required": ["skills"],
            },
            execute=activate_skill_execute,
            execution_mode="sequential",
        )


def create_skill_runtime(
    workspace_root: str | Path,
    context: MonToolContext | None = None,
    profile: str = "user_chat",
    active_skill_ids: tuple[str, ...] | None = None,
) -> MonAgentSkillRuntime:
    return MonAgentSkillRuntime(workspace_root, context, profile, active_skill_ids)
