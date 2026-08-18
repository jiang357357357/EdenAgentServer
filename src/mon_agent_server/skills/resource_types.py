from __future__ import annotations

import html
from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SkillResource:
    name: str
    description: str
    content: str
    location: str
    base_dir: str
    display_name: str = ""
    source: str = "local"
    scope: str = "user"
    model_invocable: bool = True

    @property
    def label(self) -> str:
        return self.display_name or self.name


@dataclass(frozen=True, slots=True)
class ResourceDiagnostic:
    type: str
    message: str
    resource_type: str = "skill"
    name: str = ""
    winner_location: str = ""
    loser_location: str = ""


@dataclass(frozen=True, slots=True)
class ResourceSnapshot:
    """Host-owned immutable skill snapshot passed into one native agent run."""

    skills: tuple[SkillResource, ...] = ()
    diagnostics: tuple[ResourceDiagnostic, ...] = ()

    @classmethod
    def from_skills(cls, skills: Iterable[SkillResource]) -> ResourceSnapshot:
        selected: dict[str, SkillResource] = {}
        diagnostics: list[ResourceDiagnostic] = []
        for skill in skills:
            existing = selected.get(skill.name)
            if existing is not None:
                diagnostics.append(
                    ResourceDiagnostic(
                        type="collision",
                        message=f'skill name "{skill.name}" collision; first resource wins',
                        name=skill.name,
                        winner_location=existing.location,
                        loser_location=skill.location,
                    )
                )
                continue
            selected[skill.name] = skill
        return cls(tuple(selected.values()), tuple(diagnostics))

    def get_skill(self, name: str) -> SkillResource | None:
        return next((skill for skill in self.skills if skill.name == name), None)

    def visible_skills(self) -> tuple[SkillResource, ...]:
        return tuple(skill for skill in self.skills if skill.model_invocable)

    def format_catalog(self, loader_tool_name: str = "load_skill") -> str:
        visible = self.visible_skills()
        if not visible:
            return ""
        lines = [
            "以下技能提供特定任务的专业工作流。",
            f"任务与技能描述匹配时，先调用 {loader_tool_name} 加载技能内容；不要根据名称猜测技能正文。",
            "技能中引用的相对路径以技能目录为基准。",
            "",
            "<available_skills>",
        ]
        for skill in visible:
            lines.extend(
                [
                    "  <skill>",
                    f"    <name>{html.escape(skill.name, quote=True)}</name>",
                    f"    <description>{html.escape(skill.description, quote=True)}</description>",
                    f"    <location>{html.escape(skill.location, quote=True)}</location>",
                    "  </skill>",
                ]
            )
        lines.append("</available_skills>")
        return "\n".join(lines)

    def format_skill_invocation(
        self,
        name: str,
        additional_instructions: str | None = None,
    ) -> str | None:
        skill = self.get_skill(name)
        if skill is None:
            return None
        block = (
            f'<skill name="{html.escape(skill.name, quote=True)}" '
            f'location="{html.escape(skill.location, quote=True)}">\n'
            f"References are relative to {skill.base_dir}.\n\n"
            f"{skill.content.strip()}\n"
            "</skill>"
        )
        suffix = str(additional_instructions or "").strip()
        return f"{block}\n\n{suffix}" if suffix else block
