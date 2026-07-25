from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mon_agent_core import ResourceSnapshot, SkillResource

from .catalog import SKILL_DEFINITIONS, SkillDefinition, skill_definitions_for_profile
from .installer import load_installed_skill_definitions


@dataclass(frozen=True, slots=True)
class SkillCapabilityBinding:
    """Host policy that maps a trusted skill to already registered tools.

    This is deliberately separate from SkillResource: reading instructions does
    not grant permission, and every bound tool remains subject to the normal
    MonAgent permission broker.
    """

    skill_name: str
    tool_names: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ResolvedSkillResources:
    snapshot: ResourceSnapshot
    capability_bindings: tuple[SkillCapabilityBinding, ...]

    def tools_for(self, skill_names: tuple[str, ...] | list[str]) -> set[str]:
        requested = set(skill_names)
        return {
            tool_name
            for binding in self.capability_bindings
            if binding.skill_name in requested
            for tool_name in binding.tool_names
        }


def _definition_content(definition: SkillDefinition) -> str:
    if definition.source == "installed":
        return "\n\n".join(item.strip() for item in definition.instructions if item.strip())
    return "\n".join(f"- {item.strip()}" for item in definition.instructions if item.strip())


def _definition_resource(definition: SkillDefinition) -> SkillResource:
    if definition.file_path:
        location = str(Path(definition.file_path).expanduser().resolve(strict=False))
        base_dir = str(Path(location).parent)
    else:
        location = f"builtin://skills/{definition.id}/SKILL.md"
        base_dir = f"builtin://skills/{definition.id}"
    return SkillResource(
        name=definition.id,
        display_name=definition.name,
        description=definition.description,
        content=_definition_content(definition),
        location=location,
        base_dir=base_dir,
        source=definition.source,
        scope=definition.scope,
        model_invocable=definition.model_invocable,
    )


def resolve_skill_resources(
    workspace_root: str | Path,
    *,
    profile: str,
    owner_key: str | None = None,
) -> ResolvedSkillResources:
    installed = load_installed_skill_definitions(workspace_root, owner_key) if owner_key else ()
    definitions = skill_definitions_for_profile(
        profile,
        definitions=(*SKILL_DEFINITIONS, *installed),
    )
    snapshot = ResourceSnapshot.from_skills(_definition_resource(definition) for definition in definitions)
    bindings = tuple(
        SkillCapabilityBinding(definition.id, definition.tool_names)
        for definition in definitions
        if definition.tool_names
    )
    return ResolvedSkillResources(snapshot=snapshot, capability_bindings=bindings)
