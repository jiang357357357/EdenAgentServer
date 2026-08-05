from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


_AGENT_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh"}
_SANDBOX_MODES = {"inherit", "read-only", "workspace-write"}
STICKER_TOOL_NAMES = frozenset(
    {
        "list_character_stickers",
        "remember_character_sticker",
        "send_character_sticker",
        "delete_character_sticker",
    }
)

# Read-only is a mechanical allow-list, not merely a prompt instruction.  New
# mutation-capable tools therefore remain unavailable until explicitly audited.
READ_ONLY_TOOL_NAMES = frozenset(
    {
        "load_skill",
        "loaded_tools",
        "read",
        "ls",
        "grep",
        "find",
        "external_ls",
        "external_find",
        "external_read",
        "external_grep",
        "search_user_files",
        "web",
        "get_calendar_context",
        "get_weather",
        "analyze_image",
        "analyze_screen",
        "list_character_actions",
        "get_self_awake_state",
        "list_self_awake_diaries",
        "read_self_awake_diary",
        "list_memos",
        "list_due_memos",
        "get_next_memo_wake",
        "search_memories",
        "external_email_status",
        "qq_bot_list",
        "qq_bot_targets",
        "spawn_agent",
        "send_message",
        "followup_task",
        "list_agents",
        "interrupt_agent",
    }
)


def _string_tuple(value: Any, field_name: str) -> tuple[str, ...]:
    if value in (None, ""):
        return ()
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise ValueError(f"{field_name} 必须是非空字符串数组。")
    return tuple(dict.fromkeys(item.strip() for item in value))


def _bounded_positive_int(value: Any, field_name: str, default: int, maximum: int) -> int:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        raise ValueError(f"{field_name} 必须是正整数。")
    try:
        normalized = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} 必须是正整数。") from error
    if normalized < 1 or normalized > maximum:
        raise ValueError(f"{field_name} 必须在 1 到 {maximum} 之间。")
    return normalized


@dataclass(frozen=True, slots=True)
class SubagentBudget:
    max_turns: int = 64
    max_tool_calls: int = 128
    timeout_seconds: int = 1_800

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "SubagentBudget":
        value = payload if isinstance(payload, dict) else {}
        return cls(
            max_turns=_bounded_positive_int(value.get("maxTurns"), "budget.maxTurns", 64, 1_024),
            max_tool_calls=_bounded_positive_int(
                value.get("maxToolCalls"), "budget.maxToolCalls", 128, 10_000
            ),
            timeout_seconds=_bounded_positive_int(
                value.get("timeoutSeconds"), "budget.timeoutSeconds", 1_800, 86_400
            ),
        )

    @classmethod
    def from_toml(cls, payload: Any) -> "SubagentBudget":
        if payload in (None, ""):
            return cls()
        if not isinstance(payload, dict):
            raise ValueError("budget 必须是 TOML 表。")
        return cls(
            max_turns=_bounded_positive_int(payload.get("max_turns"), "budget.max_turns", 64, 1_024),
            max_tool_calls=_bounded_positive_int(
                payload.get("max_tool_calls"), "budget.max_tool_calls", 128, 10_000
            ),
            timeout_seconds=_bounded_positive_int(
                payload.get("timeout_seconds"), "budget.timeout_seconds", 1_800, 86_400
            ),
        )

    def restrict(self, current: "SubagentBudget") -> "SubagentBudget":
        return SubagentBudget(
            max_turns=min(self.max_turns, current.max_turns),
            max_tool_calls=min(self.max_tool_calls, current.max_tool_calls),
            timeout_seconds=min(self.timeout_seconds, current.timeout_seconds),
        )

    def to_payload(self) -> dict[str, int]:
        return {
            "maxTurns": self.max_turns,
            "maxToolCalls": self.max_tool_calls,
            "timeoutSeconds": self.timeout_seconds,
        }


@dataclass(frozen=True, slots=True)
class SubagentToolPolicy:
    sandbox_mode: str = "inherit"
    allowed_tools: frozenset[str] | None = None
    denied_tools: frozenset[str] = frozenset()

    @classmethod
    def create(
        cls,
        sandbox_mode: str = "inherit",
        *,
        allowed_tools: tuple[str, ...] = (),
        denied_tools: tuple[str, ...] = (),
    ) -> "SubagentToolPolicy":
        mode = str(sandbox_mode or "inherit").strip().lower()
        if mode not in _SANDBOX_MODES:
            raise ValueError(f"sandbox_mode 必须是 {', '.join(sorted(_SANDBOX_MODES))} 之一。")
        configured_allow = frozenset(allowed_tools) if allowed_tools else None
        if mode == "read-only":
            effective_allow = READ_ONLY_TOOL_NAMES
            if configured_allow is not None:
                effective_allow = effective_allow.intersection(configured_allow)
        else:
            effective_allow = configured_allow
        return cls(mode, effective_allow, frozenset(denied_tools).union(STICKER_TOOL_NAMES))

    def allows(self, tool_name: str) -> bool:
        name = str(tool_name or "")
        if name in self.denied_tools:
            return False
        return self.allowed_tools is None or name in self.allowed_tools

    def restrict(self, child: "SubagentToolPolicy") -> "SubagentToolPolicy":
        if self.allowed_tools is None:
            allowed = child.allowed_tools
        elif child.allowed_tools is None:
            allowed = self.allowed_tools
        else:
            allowed = self.allowed_tools.intersection(child.allowed_tools)
        mode = "read-only" if "read-only" in {self.sandbox_mode, child.sandbox_mode} else child.sandbox_mode
        return SubagentToolPolicy(mode, allowed, self.denied_tools.union(child.denied_tools))

    def filter(self) -> Callable[[Any], bool]:
        return lambda tool: self.allows(str(getattr(tool, "name", "")))

    def to_payload(self) -> dict[str, Any]:
        return {
            "sandboxMode": self.sandbox_mode,
            "allowedTools": sorted(self.allowed_tools) if self.allowed_tools is not None else None,
            "deniedTools": sorted(self.denied_tools),
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "SubagentToolPolicy":
        raw_allowed = payload.get("allowedTools")
        allowed = frozenset(str(item) for item in raw_allowed) if isinstance(raw_allowed, list) else None
        raw_denied = payload.get("deniedTools")
        denied = (
            frozenset(str(item) for item in raw_denied) if isinstance(raw_denied, list) else frozenset()
        ).union(STICKER_TOOL_NAMES)
        mode = str(payload.get("sandboxMode") or "inherit")
        if mode not in _SANDBOX_MODES:
            mode = "inherit"
        return cls(mode, allowed, denied)


@dataclass(frozen=True, slots=True)
class SubagentDefinition:
    name: str
    description: str
    developer_instructions: str
    skills: tuple[str, ...] = ()
    sandbox_mode: str = "inherit"
    allowed_tools: tuple[str, ...] = ()
    denied_tools: tuple[str, ...] = ()
    ai_entity_id: int | str | None = None
    thinking_level: str | None = None
    budget: SubagentBudget = SubagentBudget()
    source: str = "builtin"
    file_path: str | None = None

    @property
    def tool_policy(self) -> SubagentToolPolicy:
        return SubagentToolPolicy.create(
            self.sandbox_mode,
            allowed_tools=self.allowed_tools,
            denied_tools=self.denied_tools,
        )

    @property
    def initial_skills(self) -> tuple[str, ...]:
        return self.skills


BUILTIN_SUBAGENTS: tuple[SubagentDefinition, ...] = (
    SubagentDefinition(
        name="general",
        description="通用后台任务执行者",
        developer_instructions="严格围绕委派任务工作。给出可供父智能体直接使用的结论和证据。",
    ),
    SubagentDefinition(
        name="researcher",
        description="外部资料搜索、多来源核验与证据整理",
        developer_instructions="先定位可信来源，再归纳结论。明确区分事实、推断和未验证信息。",
        skills=("web-research",),
        sandbox_mode="read-only",
        budget=SubagentBudget(max_turns=24, max_tool_calls=48, timeout_seconds=300),
    ),
    SubagentDefinition(
        name="explore",
        description="只读探索代码位置、调用链和跨文件引用",
        developer_instructions="先缩小搜索范围，再读取关键实现。交付准确文件路径、符号、关联关系和可追溯证据，不修改工作区。",
        skills=("workspace-development",),
        sandbox_mode="read-only",
    ),
    SubagentDefinition(
        name="file_locator",
        description="在明确、有限的目录范围内只读定位个人文件、游戏存档和应用数据",
        developer_instructions=(
            "只进行定位和证据核验，不复制、修改、删除或执行文件。先根据平台和应用形成少量候选根目录，"
            "工作区外必须使用 external_ls、external_find、external_read、external_grep，不要使用受工作区限制的 ls/find/read/grep。"
            "优先从高概率目录开始，必要时可以只读搜索 /、/home 或整个用户主目录。"
            "优先返回真实路径、识别依据、最近修改时间和仍需确认的候选，不得执行任何写入。"
        ),
        sandbox_mode="read-only",
    ),
    SubagentDefinition(
        name="coder",
        description="在工作区实现边界清晰的代码改动",
        developer_instructions="先检查现有实现和用户修改。完成后运行与风险相称的验证并报告改动文件。",
        skills=("workspace-development",),
        sandbox_mode="workspace-write",
    ),
    SubagentDefinition(
        name="reviewer",
        description="只读审查实现、风险和测试覆盖",
        developer_instructions="以发现具体缺陷为主，不为了输出数量虚构问题。默认不修改文件。",
        sandbox_mode="read-only",
    ),
)


def _definition_from_toml(payload: dict[str, Any], path: Path, scope: str) -> SubagentDefinition:
    name = str(payload.get("name") or "").strip().lower()
    description = str(payload.get("description") or "").strip()
    instructions = str(payload.get("developer_instructions") or "").strip()
    if not _AGENT_NAME_PATTERN.fullmatch(name):
        raise ValueError("name 必须以小写字母开头，且只能包含小写字母、数字、下划线或连字符。")
    if not description:
        raise ValueError("description 不能为空。")
    if not instructions:
        raise ValueError("developer_instructions 不能为空。")
    thinking_level = str(payload.get("thinking_level") or "").strip().lower() or None
    if thinking_level and thinking_level not in _THINKING_LEVELS:
        raise ValueError(f"thinking_level 必须是 {', '.join(sorted(_THINKING_LEVELS))} 之一。")
    ai_entity_id = payload.get("ai_entity_id")
    if ai_entity_id == "":
        ai_entity_id = None
    definition = SubagentDefinition(
        name=name,
        description=description,
        developer_instructions=instructions,
        skills=_string_tuple(payload.get("skills"), "skills"),
        sandbox_mode=str(payload.get("sandbox_mode") or "inherit").strip().lower(),
        allowed_tools=_string_tuple(payload.get("allowed_tools"), "allowed_tools"),
        denied_tools=_string_tuple(payload.get("denied_tools"), "denied_tools"),
        ai_entity_id=ai_entity_id,
        thinking_level=thinking_level,
        budget=SubagentBudget.from_toml(payload.get("budget")),
        source=scope,
        file_path=str(path),
    )
    # Eagerly validate the policy so configuration errors include the file path.
    definition.tool_policy
    return definition


class SubagentCatalog:
    """Loads built-ins, then user definitions, then project overrides."""

    def __init__(self, definitions: tuple[SubagentDefinition, ...]) -> None:
        self._definitions = {definition.name: definition for definition in definitions}

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._definitions))

    @property
    def definitions(self) -> tuple[SubagentDefinition, ...]:
        return tuple(self._definitions[name] for name in self.names)

    @property
    def descriptions(self) -> dict[str, str]:
        return {definition.name: definition.description for definition in self.definitions}

    def resolve(self, name: Any) -> SubagentDefinition:
        normalized = str(name or "general").strip().lower()
        definition = self._definitions.get(normalized)
        if definition is None:
            raise ValueError(f"未知子智能体角色：{normalized}。可用角色：{', '.join(self.names)}")
        return definition


def load_subagent_catalog(
    workspace_root: str | Path,
    *,
    user_agent_dir: str | Path | None = None,
) -> SubagentCatalog:
    definitions = {definition.name: definition for definition in BUILTIN_SUBAGENTS}
    configured_user_dir = user_agent_dir or os.environ.get("MON_AGENT_USER_AGENT_DIR")
    user_dir = Path(configured_user_dir).expanduser() if configured_user_dir else Path.home() / ".monagent" / "agents"
    project_dir = Path(workspace_root).resolve() / ".monagent" / "agents"
    for scope, directory in (("user", user_dir), ("project", project_dir)):
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.toml")):
            try:
                payload = tomllib.loads(path.read_text(encoding="utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("顶层必须是 TOML 表。")
                definition = _definition_from_toml(payload, path, scope)
            except Exception as error:
                raise ValueError(f"无法加载子智能体配置 {path}: {error}") from error
            definitions[definition.name] = definition
    return SubagentCatalog(tuple(definitions.values()))


def build_subagent_system_prompt(
    definition: SubagentDefinition,
    *,
    agent_path: str,
    workspace_root: str,
    skill_prompt: str,
    tool_policy: SubagentToolPolicy | None = None,
    budget: SubagentBudget | None = None,
    environment: dict[str, Any] | None = None,
) -> str:
    from mon_agent_server.prompts.builder import build_environment_awareness_section

    effective_policy = tool_policy or definition.tool_policy
    effective_budget = budget or definition.budget
    sections = [
            "# 身份",
            (
                f"你是 MonAgent 的后台任务智能体，路径为 {agent_path}，任务角色为 {definition.name}。\n"
                "你向父智能体交付可验证的工作结果，由父智能体整合并面向用户表达。"
            ),
            "# 角色职责",
            f"{definition.description}\n{definition.developer_instructions}",
            "# 工作区",
            (
                f"当前共享工作区：{workspace_root}\n"
                "保留用户已有修改，只处理任务范围内的内容。"
            ),
            "# 协作协议",
            (
                "任务完成后返回简洁、可验证的结果，说明关键证据、改动文件和测试情况。\n"
                "如果任务可以继续拆分，可以加载子智能体协作技能；不要为简单步骤创建更多子智能体。\n"
                "不要询问用户；缺少信息时记录阻塞点并返回父智能体。"
            ),
            "# 运行预算",
            (
                f"最多 {effective_budget.max_turns} 个模型轮次、"
                f"{effective_budget.max_tool_calls} 次工具调用、"
                f"累计执行 {effective_budget.timeout_seconds} 秒。"
                "这些限制由运行时机械执行；接近上限时优先形成可交付结论。"
            ),
            "# 技能与工具",
            skill_prompt or "按需使用当前提供的基础只读工具。",
        ]
    environment_prompt = build_environment_awareness_section(environment)
    if environment_prompt:
        sections.extend(["# 当前环境感知", environment_prompt])
    return "\n\n".join(sections)


def resolve_subagent_role(name: Any) -> SubagentDefinition:
    """Compatibility helper for callers that only need built-in definitions."""

    return SubagentCatalog(BUILTIN_SUBAGENTS).resolve(name)
