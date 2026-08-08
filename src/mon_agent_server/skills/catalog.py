from __future__ import annotations

from pathlib import Path
from typing import Iterable

from .package import SkillDefinition, load_skill_package


BUILTIN_SKILL_ROOT = Path(__file__).resolve().parent / "builtin"


_builtin_cache: tuple[tuple[tuple[str, int, int], ...], tuple[SkillDefinition, ...]] | None = None


def _builtin_signature() -> tuple[tuple[str, int, int], ...]:
    return tuple(
        (str(path), path.stat().st_mtime_ns, path.stat().st_size)
        for path in sorted(BUILTIN_SKILL_ROOT.glob("*/SKILL.md"))
    )


def load_builtin_skill_definitions(*, force_reload: bool = False) -> tuple[SkillDefinition, ...]:
    global _builtin_cache
    signature = _builtin_signature()
    if not force_reload and _builtin_cache is not None and _builtin_cache[0] == signature:
        return _builtin_cache[1]
    definitions: list[SkillDefinition] = []
    if not BUILTIN_SKILL_ROOT.is_dir():
        raise RuntimeError(f"基础技能目录不存在：{BUILTIN_SKILL_ROOT}")
    for directory in sorted(BUILTIN_SKILL_ROOT.iterdir()):
        if not directory.is_dir() or not (directory / "SKILL.md").is_file():
            continue
        definition, _version = load_skill_package(
            directory,
            source="builtin",
            scope="system",
        )
        definitions.append(definition)
    loaded = tuple(definitions)
    _builtin_cache = (signature, loaded)
    return loaded


SKILL_DEFINITIONS = load_builtin_skill_definitions()
SKILLS_BY_ID = {skill.id: skill for skill in SKILL_DEFINITIONS}

BASE_TOOL_NAMES_BY_PROFILE: dict[str, tuple[str, ...]] = {
    "user_chat": (
        "ask_user",
        "list_character_actions",
        "switch_character_action",
        "read",
        "ls",
        "grep",
        "find",
        "external_ls",
        "external_read",
        "external_find",
        "external_grep",
        "spawn_agent",
        "send_message",
        "followup_task",
        "list_agents",
        "interrupt_agent",
        "remember_memory",
        "search_memories",
        "update_memory",
        "forget_memory",
        "list_character_stickers",
        "remember_character_sticker",
        "send_character_sticker",
        "delete_character_sticker",
    ),
    "self_awake": ("read", "ls", "grep", "find"),
}

INITIAL_SKILLS_BY_PROFILE: dict[str, tuple[str, ...]] = {
    "user_chat": (),
    "self_awake": (
        "self-awake",
        "due-reminder-dispatch",
        "external-communication",
        "external-connectors",
        "visual-observation",
    ),
}


def initial_skill_ids(profile: str) -> tuple[str, ...]:
    return INITIAL_SKILLS_BY_PROFILE.get(profile, ())


def skill_definitions_for_profile(
    profile: str,
    *,
    model_invocable_only: bool = False,
    definitions: Iterable[SkillDefinition] | None = None,
) -> tuple[SkillDefinition, ...]:
    return tuple(
        skill
        for skill in (definitions or SKILL_DEFINITIONS)
        if profile in skill.profiles and (skill.model_invocable or not model_invocable_only)
    )


def normalize_skill_ids(skill_ids: Iterable[str]) -> tuple[str, ...]:
    normalized: list[str] = []
    for raw_id in skill_ids:
        skill_id = str(raw_id or "").strip()
        if skill_id and skill_id not in normalized:
            normalized.append(skill_id)
    return tuple(normalized)


def tool_names_for_skills(
    skill_ids: Iterable[str], definitions_by_id: dict[str, SkillDefinition] | None = None
) -> set[str]:
    catalog = definitions_by_id or SKILLS_BY_ID
    names: set[str] = set()
    for skill_id in normalize_skill_ids(skill_ids):
        skill = catalog.get(skill_id)
        if skill:
            names.update(skill.tool_names)
    return names


def render_skill_catalog(
    profile: str,
    active_skill_ids: Iterable[str] = (),
    definitions: Iterable[SkillDefinition] | None = None,
) -> str:
    active = set(normalize_skill_ids(active_skill_ids))
    lines = []
    for skill in skill_definitions_for_profile(
        profile, model_invocable_only=True, definitions=definitions
    ):
        status = "（已加载）" if skill.id in active else ""
        lines.append(f"- {skill.id}{status}：{skill.name}。{skill.description}")
    return "\n".join(lines)


def render_active_skill_instructions(
    skill_ids: Iterable[str], definitions_by_id: dict[str, SkillDefinition] | None = None
) -> str:
    catalog = definitions_by_id or SKILLS_BY_ID
    sections: list[str] = []
    for skill_id in normalize_skill_ids(skill_ids):
        skill = catalog.get(skill_id)
        if not skill:
            continue
        sections.append(f"## {skill.name}（{skill.id}）\n{skill.instructions[0]}")
    return "\n\n".join(sections)
