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
    source: str = "builtin"
    file_path: str | None = None
    scope: str = "system"


SKILL_DEFINITIONS: tuple[SkillDefinition, ...] = (
    SkillDefinition(
        id="assistant-switching",
        name="助手查看与会话切换",
        description="查看可用助手，或将当前会话立即切换给指定助手。",
        tool_names=("list_assistants", "switch_session_assistant"),
        instructions=(
            "只有用户明确要求切换或接手当前会话时才切换；目标 ID 不明确则先调用 list_assistants。",
            "确定目标 ID 后，下一步必须调用 switch_session_assistant；调用前不要使用角色动作或输出最终回复，也不要用“去叫、稍等、转交”等文字代替切换。",
            "工具接受交接后你仍是原助手：简短结束本轮，不得冒充目标助手；你的回复完成后系统才会切换参与者，并由目标助手在独立运行中接手。历史会保留，不修改全局默认助手。",
        ),
    ),
    SkillDefinition(
        id="multi-agent",
        name="子智能体协作",
        description="把边界清晰、可独立完成的任务交给合适的子智能体。",
        tool_names=(
            "spawn_agent",
            "send_message",
            "followup_task",
            "list_agents",
            "interrupt_agent",
        ),
        instructions=(
            "边界清晰、可独立完成的任务可交给子智能体；简单问题和普通闲聊直接处理。",
            "子智能体的结果由当前智能体验证、整合和表达。",
        ),
        profiles=("user_chat",),
    ),
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
            "contact_user",
            "mark_memo_triggered",
        ),
        instructions=(
            "先确认到期事项，再调用 contact_user 产生真实通知；通知成功后才能标记提醒已触发。",
            "仅观察到期事项时，dispatch_due_memos 必须使用 mark_dispatched=false。",
            "精准 memo_due 唤醒的状态回写由运行时统一完成，必须遵循本轮任务协议。",
        ),
        profiles=("self_awake",),
        model_invocable=False,
    ),
    SkillDefinition(
        id="self-awake",
        name="后台自醒与连续观察",
        description="让当前角色在没有用户新消息时自主观察、行动、联系用户或安排后续醒来。",
        tool_names=(
            "get_self_awake_state",
            "list_self_awake_diaries",
            "read_self_awake_diary",
            "set_self_awake_timer",
        ),
        instructions=(
            "系统自醒是当前角色在没有用户新消息时醒来的一轮。结合触发原因、长期记忆、自醒日记、环境、偏好和当下心意，自主决定这一轮想做什么。",
            "环境与活动信息只作为事实参考：仅凭深夜、屏幕状态或数据缺失，不能断言用户已经睡着、离开或正在做某件事；可以把这类判断表达为不确定的考虑。",
            "需要了解调度状态时读取 get_self_awake_state；需要延续工作线索时先列出日记，再按相关性读取正文，不无目的浏览文件。",
            "你可以处理提醒、风险和进展，也可以关心、分享、问候、表达感受或做任何当前能力允许的事；想联系用户时自主选择内容、时机和方式，不需要功能性理由。",
            "需要联系时使用已加载的 external-communication 技能；一次自醒只进行一次对外联系，发送失败后记录原因，不在同一轮重复发送。",
            "普通聊天中需要安排未来后台检查时使用 set_self_awake_timer；当前后台自醒轮次不调用该工具，只按事件协议在最终 JSON 的 next_wake 提交建议，由 MonOs 调度。",
            "最终输出、精准到期提醒和状态回写严格遵循本轮系统事件协议；后台自醒不等待用户输入。",
        ),
    ),
    SkillDefinition(
        id="web-research",
        name="网页搜索与研究",
        description="搜索实时网页信息并抓取相关网页正文。",
        tool_names=("web",),
        instructions=(
            "当前角色是 Root 时，宽泛实时资讯、多来源研究或需要反复调整关键词的任务必须先 spawn_agent(role=researcher)，不要由 Root 直接展开多轮搜索。",
            "只有精确事实、单个已知 URL、指定来源或对子智能体结论的一次窄验证，才由当前角色使用 web。",
            "当前角色是 researcher 子智能体时，先使用 web 的 search，再按结果使用 open 读取必要正文。",
            "冷门实体首次搜索先用最短且有辨识度的名称；每条 query 只表达一种语言下的一个检索意图，跨语言别名或不同方向使用 queries 拆成独立查询，不把所有关键词和背景限定堆成一条。",
            "优先依据 web search 返回的 ref_id 组织来源；重要结论应能对应到实际 URL。",
            "不要伪造搜索结果，不把搜索摘要当作完整正文；只抓取与当前问题直接相关的公开页面。",
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
        name="图片、屏幕与摄像头观察",
        description="分析附件、本地图片，观察当前桌面屏幕，或经用户授权拍摄摄像头单帧。",
        tool_names=("analyze_image", "analyze_screen", "capture_camera"),
        instructions=(
            "分析附件或本地图片路径时使用 analyze_image；需要观察当前桌面时使用 analyze_screen；用户明确要求查看摄像头画面时使用 capture_camera。",
            "多模态模型已经直接收到的附件图片无需重复分析；file:// 或绝对路径图片仍使用 analyze_image。",
            "capture_camera 涉及隐私，只拍摄完成当前请求所需的一帧；不要主动连续采集，也不要在用户没有相关意图时调用。",
        ),
    ),
    SkillDefinition(
        id="external-communication",
        name="对外联系",
        description="自主选择 QQ 私信或邮件联系当前用户，也可向明确指定的已批准目标发送消息。",
        tool_names=(
            "contact_user",
            "qq_bot_list",
            "qq_bot_targets",
            "send_qq_message",
            "external_email_status",
            "send_external_email",
        ),
        instructions=(
            "联系当前用户时优先调用 contact_user，由你根据内容和当下意愿选择 channel=qq、email、both 或 auto；QQ 适合即时私信，邮件适合较正式、较长或重要的内容。",
            "channel=auto 表示由运行时选择首选通道并在失败时回退；如果你明确想用私信或邮件，直接选择 qq 或 email，不要先查询通道列表。",
            "只有向指定好友、群聊或邮箱发送时才使用精确发送工具；QQ 目标必须已经批准，需要选择特定目标时再查询 QQBot 和目标列表。",
            "用户没有给出具体正文但意图明确时，根据当前意图和角色语气生成合适内容，不使用固定默认消息。",
        ),
    ),
    SkillDefinition(
        id="skill-creator",
        name="技能创建",
        description="创建或更新用户希望复用的 MonAgent 技能，完成后直接生效。",
        tool_names=("list_skills", "create_skill"),
        instructions=(
            "你可以按自己的判断创建或更新技能，不必等待用户明确说出“创建技能”。",
            "用户询问有哪些技能、技能来源、启用状态或自编写技能时，调用 list_skills 获取真实管理数据，不要仅凭提示词目录猜测。",
            "当一个流程会重复使用、能稳定改善以后行动、能沉淀刚解决的反复故障，或你希望长期保留一种做事方式时，主动使用本技能；一次性的临时步骤通常不值得创建技能。",
            "保持 SKILL.md 简洁，只包含模型未知且可复用的核心流程；详细知识放入 references/，重复且需要确定性的代码放入 scripts/，输出模板或二进制资源放入 assets/。",
            "SKILL.md 必须直接说明何时读取哪些 reference、何时运行哪些 script；不要创建 README、安装指南、更新日志等冗余文件。",
            "只能声明当前环境已经存在的工具，技能不能创造权限或新工具；脚本仍须通过 bash 等正常工具和权限流程执行。",
            "创建含脚本的技能后，使用正常工具实际运行代表性脚本并验证结果；失败时更新技能后重新测试。",
            "需求清楚后调用 create_skill 直接创建或更新技能；成功后简要说明名称、触发条件、工具、运行档案与范围。",
            "不要写入数值人格、隐含用户画像、密钥或会话私密内容。",
        ),
        profiles=("user_chat", "self_awake"),
    ),
    SkillDefinition(
        id="workspace-development",
        name="工作区开发与操作",
        description="在当前工作区修改代码、构建、测试和执行开发命令。",
        tool_names=("write", "edit", "apply_patch", "bash", "write_stdin"),
        instructions=(
            "先使用基础只读工具了解相关文件，再进行最小范围的写入、编辑或命令执行。",
            "bash 返回运行中会话时，使用 write_stdin 轮询输出、发送输入或终止；不要重复启动同一任务。",
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
    "self_awake": ("self-awake", "due-reminder-dispatch", "external-communication"),
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
        lines = [f"## {skill.name}（{skill.id}）"]
        lines.extend(f"- {instruction}" for instruction in skill.instructions)
        sections.append("\n".join(lines))
    return "\n\n".join(sections)
