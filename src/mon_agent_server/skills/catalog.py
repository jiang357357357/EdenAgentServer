from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True, slots=True)
class SkillDefinition:
    id: str
    name: str
    description: str
    tool_names: tuple[str, ...]
    instructions: tuple[str, ...]
    profiles: tuple[str, ...] = ("user_chat", "self_awake")
    model_invocable: bool = True


SKILL_DEFINITIONS: tuple[SkillDefinition, ...] = (
    SkillDefinition(
        id="memo-management",
        name="备忘录与待办管理",
        description="创建、查询、完成、归档或推迟备忘录、待办和用户提醒。",
        tool_names=(
            "create_memo",
            "create_reminder",
            "list_memos",
            "list_due_memos",
            "dispatch_due_memos",
            "get_next_memo_wake",
            "complete_memo",
            "archive_memo",
            "snooze_memo",
            "mark_memo_triggered",
        ),
        instructions=(
            "当用户说“提醒我”“记一下”或“待办”时，使用 create_reminder 或 create_memo 保存用户可见记录。",
            "使用 list_memos 查询现有事项；只有用户明确完成、归档或推迟时，才调用对应的状态修改工具。",
            "到期提醒只有在已经产生真实通知后才能标记触发；普通一次性提醒标记触发后会自动完成。",
        ),
    ),
    SkillDefinition(
        id="due-reminder-dispatch",
        name="到期提醒派发",
        description="供系统到期事件检查、通知并收尾已到时间的提醒。",
        tool_names=(
            "list_due_memos",
            "dispatch_due_memos",
            "get_next_memo_wake",
            "notify_user",
            "mark_memo_triggered",
        ),
        instructions=(
            "先确认到期事项，再调用 notify_user 产生真实通知；通知成功后才能标记提醒已触发。",
            "仅观察到期事项时，dispatch_due_memos 必须使用 mark_dispatched=false。",
            "精准 memo_due 唤醒的状态回写由运行时统一完成，必须遵循本轮任务协议。",
        ),
        profiles=("self_awake",),
        model_invocable=False,
    ),
    SkillDefinition(
        id="self-awake",
        name="后台自醒与连续观察",
        description="读取自醒状态和工作日记，或安排后续后台自醒。",
        tool_names=(
            "get_self_awake_state",
            "list_self_awake_diaries",
            "read_self_awake_diary",
            "set_self_awake_timer",
        ),
        instructions=(
            "需要了解调度状态时读取 get_self_awake_state；需要延续工作线索时先列出日记，再按相关性读取正文。",
            "用户明确要求未来后台检查时可使用 set_self_awake_timer；后台自醒轮次的下一次时间按任务协议写入最终 JSON。",
            "后台自醒不等待用户，不无目的浏览文件，并以系统事件提供的触发原因为本轮首要任务。",
        ),
    ),
    SkillDefinition(
        id="web-research",
        name="网页搜索与研究",
        description="搜索实时网页信息并抓取相关网页正文。",
        tool_names=("web_search", "web_fetch"),
        instructions=(
            "需要实时或可变化的信息时先使用 web_search，再按结果使用 web_fetch 读取必要正文。",
            "不要伪造搜索结果；只抓取与当前问题直接相关的页面。",
        ),
    ),
    SkillDefinition(
        id="daily-context",
        name="日历天气与生活环境",
        description="查询节日、农历、特殊日期、实时天气和出行影响。",
        tool_names=("get_calendar_context", "get_weather"),
        instructions=(
            "询问天气、温度、降水或出行影响时使用 get_weather。",
            "询问节日、农历、纪念日或近期特殊日期时使用 get_calendar_context。",
        ),
    ),
    SkillDefinition(
        id="visual-observation",
        name="图片与屏幕观察",
        description="分析附件、本地图片，或经授权观察当前桌面屏幕。",
        tool_names=("analyze_image", "analyze_screen"),
        instructions=(
            "文本模型需要分析附件或本地图片时使用 analyze_image；需要观察当前桌面时使用 analyze_screen。",
            "多模态模型已经直接收到的用户图片不要重复分析；屏幕观察仍必须通过 analyze_screen。",
        ),
    ),
    SkillDefinition(
        id="qq-communication",
        name="QQ 通信",
        description="查看可用 QQBot 和已批准目标，并向好友或群聊发送消息。",
        tool_names=("qq_bot_list", "qq_bot_targets", "send_qq_message"),
        instructions=(
            "用户未指定 QQBot 或目标时，send_qq_message 省略对应参数，由工具使用默认 QQBot 和超级管理员。",
            "目标必须已经批准；需要选择目标时先查询 QQBot 和目标列表。",
            "用户没有给出具体正文但意图明确时，根据当前任务生成合适内容，不使用固定默认消息。",
        ),
        profiles=("user_chat",),
    ),
    SkillDefinition(
        id="email-communication",
        name="邮件通信",
        description="检查外部邮箱状态并向指定或默认收件人发送邮件。",
        tool_names=("external_email_status", "send_external_email"),
        instructions=(
            "发送前缺少邮箱可用性信息时先检查 external_email_status。",
            "收件人为空时使用用户默认收件人；根据用户意图生成明确主题和正文。",
        ),
        profiles=("user_chat",),
    ),
    SkillDefinition(
        id="workspace-development",
        name="工作区开发与操作",
        description="在当前工作区内写文件、编辑代码和执行命令。",
        tool_names=("write", "edit", "bash"),
        instructions=(
            "先使用基础只读工具了解相关文件，再进行最小范围的写入、编辑或命令执行。",
            "写文件和执行命令必须经过现有权限系统，不得把技能激活视为用户授权。",
            "保留用户已有修改，并在完成后运行与风险相称的验证。",
        ),
        profiles=("user_chat",),
    ),
)

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
    ),
    "self_awake": ("read", "ls", "grep", "find"),
}

INITIAL_SKILLS_BY_PROFILE: dict[str, tuple[str, ...]] = {
    "user_chat": (),
    "self_awake": ("self-awake", "due-reminder-dispatch"),
}


def initial_skill_ids(profile: str) -> tuple[str, ...]:
    return INITIAL_SKILLS_BY_PROFILE.get(profile, ())


def skill_definitions_for_profile(profile: str, *, model_invocable_only: bool = False) -> tuple[SkillDefinition, ...]:
    return tuple(
        skill
        for skill in SKILL_DEFINITIONS
        if profile in skill.profiles and (skill.model_invocable or not model_invocable_only)
    )


def normalize_skill_ids(skill_ids: Iterable[str]) -> tuple[str, ...]:
    normalized: list[str] = []
    for raw_id in skill_ids:
        skill_id = str(raw_id or "").strip()
        if skill_id and skill_id not in normalized:
            normalized.append(skill_id)
    return tuple(normalized)


def tool_names_for_skills(skill_ids: Iterable[str]) -> set[str]:
    names: set[str] = set()
    for skill_id in normalize_skill_ids(skill_ids):
        skill = SKILLS_BY_ID.get(skill_id)
        if skill:
            names.update(skill.tool_names)
    return names


def render_skill_catalog(profile: str, active_skill_ids: Iterable[str] = ()) -> str:
    active = set(normalize_skill_ids(active_skill_ids))
    lines = []
    for skill in skill_definitions_for_profile(profile, model_invocable_only=True):
        status = "（已激活）" if skill.id in active else ""
        lines.append(f"- {skill.id}{status}：{skill.name}。{skill.description}")
    return "\n".join(lines)


def render_active_skill_instructions(skill_ids: Iterable[str]) -> str:
    sections: list[str] = []
    for skill_id in normalize_skill_ids(skill_ids):
        skill = SKILLS_BY_ID.get(skill_id)
        if not skill:
            continue
        lines = [f"## {skill.name}（{skill.id}）"]
        lines.extend(f"- {instruction}" for instruction in skill.instructions)
        sections.append("\n".join(lines))
    return "\n\n".join(sections)
