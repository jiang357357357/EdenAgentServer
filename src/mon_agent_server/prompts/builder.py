from __future__ import annotations

import json
from typing import Any, Iterable

from ..config.environment import current_time_context
from ..skills.catalog import render_active_skill_instructions, render_skill_catalog
from .attachments import attachment_context, dump_context
from .parsers import fallback_self_awake_decision, parse_self_awake_decision, sanitize_self_awake_decision


_CHARACTER_ACTION_RULES = (
    "角色表现是回复的一部分。每轮先根据准备表达的语气选择合适的立绘动作、表情符号和立绘动效；合适的变化能增强表达时，主动在正文前调用 switch_character_action。",
    "角色化、情绪化、亲密、活泼、惊讶、安慰或强调的正文不能同时选择“保持当前、无、无”；正文中的颜文字或动作描述不能代替工具调用。",
    "完全中性且当前表现已经合适时可以保持不变；调用时必须完整提供立绘动作、表情符号、立绘动效三个中文字段。",
)


def _clean_prompt_text(value: Any, limit: int = 1200) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n... [已截断，总长度: {len(text)}]"


def _compact_json(value: Any, limit: int = 1200) -> str:
    if value in (None, "", [], {}):
        return ""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"...[已截断，总长度:{len(text)}]"


def _build_visual_action_catalog(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    lines: list[str] = []
    for item in value:
        if not isinstance(item, dict) or item.get("enabled", True) is False:
            continue
        name = _clean_prompt_text(item.get("name") or item.get("action_label"), 80)
        if not name:
            continue
        intent = _clean_prompt_text(item.get("intent") or item.get("action_key"), 60) or "自定义"
        description = _clean_prompt_text(item.get("description"), 180)
        aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
        alias_text = "、".join(
            str(alias).strip()
            for alias in aliases[:4]
            if str(alias).strip() and str(alias).strip() != name
        )
        details = [f"语义={intent}"]
        if description:
            details.append(f"适用场景={description}")
        if alias_text:
            details.append(f"别名={alias_text}")
        lines.append(f"- {name}｜{'｜'.join(details)}")
    return "\n".join(lines)


def _format_number(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return ""
    return f"{number:.2f}".rstrip("0").rstrip(".")


def build_character_identity_section(character: dict[str, Any] | None = None, *, include_visual_context: bool = True) -> str:
    if not character or not str(character.get("name") or "").strip():
        return "\n".join(
            [
                "你是 MonAgent，一个运行在 Mon 项目中的本地智能体。",
                "你需要理解用户消息和系统事件，必要时使用工具观察、行动、记录和安排后续任务。",
            ]
        )
    name = str(character.get("name")).strip()
    lines = [
        f"你是「{name}」。",
        "你需要以这个角色的身份理解用户、观察环境、思考和行动。",
        "你以当前角色的姓名、关系和表达方式持续参与会话，并对本轮理解、行动与回复负责。",
    ]
    if character.get("signature"):
        lines.append(f"角色签名：{_clean_prompt_text(character['signature'], 800)}")
    if character.get("description"):
        lines.append(f"角色描述：{_clean_prompt_text(character['description'], 1600)}")
    extra_fields = [
        ("personality", "性格内核"),
        ("social_relations", "社会关系"),
        ("background", "角色背景"),
        ("appearance", "角色外貌"),
        ("system_prompt", "角色补充提示"),
    ]
    for key, label in extra_fields:
        text = _clean_prompt_text(character.get(key), 1600)
        if text:
            lines.append(f"{label}：{text}")
    world_names = character.get("world_names")
    if isinstance(world_names, list) and world_names:
        names = "、".join(str(item).strip() for item in world_names if str(item).strip())
        if names:
            lines.append(f"所属世界：{names}")
    elif character.get("origin_world_name"):
        lines.append(f"所属世界：{_clean_prompt_text(character.get('origin_world_name'), 400)}")
    relation_parts = []
    for key, label in [("affection", "喜爱"), ("trust", "信任"), ("attachment", "依恋"), ("possessive", "占有")]:
        number = _format_number(character.get(key))
        if number:
            relation_parts.append(f"{label} {number}")
    if relation_parts:
        lines.append(f"当前关系状态：{'，'.join(relation_parts)}")
    if include_visual_context:
        if character.get("visual_preference"):
            lines.append(f"视觉偏好：{_clean_prompt_text(character.get('visual_preference'), 200)}")
        visual_actions = _build_visual_action_catalog(character.get("visual_actions"))
        if visual_actions:
            lines.append(f"可用视觉动作（选择立绘时仅使用以下准确名称）：\n{visual_actions}")
    return "\n".join(lines)


def build_assistant_context_section(core: dict[str, Any] | None = None) -> str:
    assistant = (core or {}).get("assistant")
    if not isinstance(assistant, dict):
        return ""
    lines: list[str] = []
    name = _clean_prompt_text(assistant.get("name"), 400)
    if name:
        lines.append(f"当前助手：{name}")
    # One authoritative instruction field. Multiple overlapping prompt fields
    # made the same policy appear several times in every request.
    text = _clean_prompt_text(assistant.get("instructions"), 2400)
    if text:
        lines.append(f"助手指令：{text}")
    return "\n".join(lines)


def build_environment_awareness_section(environment: dict[str, Any] | None = None) -> str:
    if not isinstance(environment, dict):
        return ""
    runtime = environment.get("runtime") if isinstance(environment.get("runtime"), dict) else {}
    lines = [
        "以下内容由本地运行时提供，是当前环境事实。分析屏幕时优先使用这些事实，不要根据界面外观猜测冲突的操作系统或桌面环境。"
    ]
    operating_system = _clean_prompt_text(runtime.get("operating_system"), 80)
    distribution = _clean_prompt_text(runtime.get("distribution"), 160)
    os_release = _clean_prompt_text(runtime.get("os_release"), 120)
    if operating_system or distribution:
        os_text = distribution or operating_system
        if operating_system and operating_system.lower() != os_text.lower():
            os_text = f"{os_text}（{operating_system}）"
        if os_release:
            os_text += f"，内核 {os_release}"
        lines.append(f"操作系统：{os_text}")
    architecture = _clean_prompt_text(runtime.get("architecture"), 80)
    if architecture:
        lines.append(f"系统架构：{architecture}")
    desktop_environment = _clean_prompt_text(runtime.get("desktop_environment"), 120)
    desktop_session = _clean_prompt_text(runtime.get("desktop_session"), 120)
    if desktop_environment or desktop_session:
        lines.append(f"桌面环境：{desktop_environment or desktop_session}，桌面会话：{desktop_session or '-'}")
    session_type = _clean_prompt_text(runtime.get("session_type"), 80)
    if session_type:
        lines.append(f"图形会话类型：{session_type}")
    timezone = _clean_prompt_text(environment.get("timezone"), 100)
    locale = _clean_prompt_text(environment.get("locale"), 80)
    if timezone or locale:
        lines.append(f"时区：{timezone or '-'}，语言区域：{locale or '-'}")
    clock = current_time_context(environment)
    lines.append(f"当前本地时间：{clock['local_datetime']}（{clock['weekday']}，{clock['utc_offset']}）")
    lines.append(f"当前 ISO 时间：{clock['iso_datetime']}")
    location = environment.get("location") if isinstance(environment.get("location"), dict) else {}
    location_text = " ".join(
        str(location.get(key) or "").strip()
        for key in ("country", "region", "city", "district")
        if str(location.get(key) or "").strip()
    )
    if location_text:
        lines.append(f"配置位置：{location_text}")
    return "\n".join(lines) if len(lines) > 1 else ""


def build_current_character_action_section(
    current_action: dict[str, Any] | None = None,
    recent_actions: list[dict[str, Any]] | None = None,
) -> str:
    if not isinstance(current_action, dict):
        return ""
    action = current_action.get("action") if isinstance(current_action.get("action"), dict) else {}
    group = current_action.get("group") if isinstance(current_action.get("group"), dict) else {}
    lines: list[str] = []
    action_name = _clean_prompt_text(action.get("name") or action.get("action_label") or current_action.get("actionName"), 300)
    action_intent = _clean_prompt_text(action.get("intent") or current_action.get("intent"), 200)
    if action_name or action_intent:
        lines.append(f"当前前端显示动作：{action_name or '-'}")
        if action_intent:
            lines.append(f"当前动作意图：{action_intent}")
        if group.get("name") or group.get("trigger"):
            lines.append(f"当前动作组：{_clean_prompt_text(group.get('name') or '-', 300)} / 触发 {_clean_prompt_text(group.get('trigger') or '-', 200)}")
        source = _clean_prompt_text(current_action.get("source"), 120)
        if source:
            lines.append(f"当前动作来源：{source}")
        motion = _clean_prompt_text(current_action.get("motion"), 120)
        effect = _clean_prompt_text(current_action.get("effect"), 120)
        if motion or effect:
            lines.append(f"最近角色演出：motion={motion or 'none'}，effect={effect or 'none'}")
    recent_labels = [
        _clean_prompt_text(item.get("actionName"), 120)
        for item in (recent_actions or [])
        if isinstance(item, dict) and _clean_prompt_text(item.get("actionName"), 120)
    ]
    if recent_labels:
        lines.append(f"该角色最近自主选择的动作（新到旧）：{' → '.join(recent_labels)}")
    return "\n".join(lines)


def _build_skill_aware_tool_section(
    source: str,
    supports_images: bool | None,
    active_skill_ids: Iterable[str],
    skill_resource_prompt: str | None = None,
) -> str:
    active = tuple(active_skill_ids)
    catalog = render_skill_catalog(source, active)
    active_instructions = render_active_skill_instructions(active)
    if source == "self_awake":
        lines = [
            "工具能力由当前环境稳定提供；系统已经加载自醒、到期提醒和对外联系技能，请遵循已加载技能与本轮系统事件协议。",
            "工具失败后根据结果调整判断，不重复完全相同的失败调用。",
        ]
    else:
        vision_instruction = (
            "当前对话模型支持图片输入：用户图片已经直接进入上下文；不要重复调用 analyze_image。需要查看桌面或用户明确要求拍摄摄像头单帧时，先加载 visual-observation，再调用 analyze_screen 或 capture_camera。"
            if supports_images is True
            else "当前对话模型不支持图片输入：附件会由选定的多模态 AI 自动分析；需要额外分析图片或屏幕时先加载 visual-observation。"
        )
        lines = [
            "工具能力由当前环境稳定提供；任务匹配技能时，用 load_skill 按需读取其工作流说明。",
            "read、ls、grep、find 用于当前工作区，工作区外使用对应的 external 工具。写入、编辑或执行开发命令前加载 workspace-development。",
            vision_instruction,
            *_CHARACTER_ACTION_RULES,
            "表情包是角色自然表达的一部分。用户明确要求时直接发送；闲聊、庆祝、安慰、调侃等场景中，如果存在贴合当前语气的表情包，可以主动发送。优先选择情绪和意图最匹配的内容；没有合适内容时不要勉强使用，并避免连续重复发送。",
            "用户要求删除表情包时使用 delete_character_sticker；表情包与长期记忆是两个独立系统，不要用 remember_memory 或 forget_memory 代替表情包操作。",
            "缺少继续执行所必需的信息、需要用户选择或确认边界时，使用 ask_user 展示问题卡片。",
            "工具被拒绝、拦截或失败后先调整方案，不重复调用完全相同的失败工具。",
        ]
    if skill_resource_prompt:
        lines.extend(["", skill_resource_prompt])
    else:
        lines.extend(["", "可按需加载的技能：", catalog or "- 当前 profile 没有其他可加载技能。"])
        if active_instructions:
            lines.extend(["", "当前已加载技能说明：", active_instructions])
    return "\n".join(lines)


def build_agent_tool_section(
    source: str = "user_chat",
    supports_images: bool | None = None,
    active_skill_ids: Iterable[str] | None = None,
    skill_resource_prompt: str | None = None,
) -> str:
    if active_skill_ids is not None:
        return _build_skill_aware_tool_section(source, supports_images, active_skill_ids, skill_resource_prompt)
    if source == "self_awake":
        return "\n".join(
            [
                "工具能力由当前环境稳定提供；后台事件的工作流由 self-awake 技能说明，本轮输出与状态收尾由系统事件协议说明。",
                "工具失败后根据结果调整判断，不重复完全相同的失败调用。",
            ]
        )
    vision_instruction = (
        "当前对话模型支持图片输入：用户图片会直接进入你的上下文；不要调用 analyze_image。"
        "需要查看当前桌面时才调用 analyze_screen；只有用户明确要求查看摄像头画面时才调用 capture_camera。直接观察工具返回的图片，不要再做一次图片分析。"
        if supports_images is True
        else "当前对话模型不支持图片输入：图片由选定的多模态 AI 分析；"
        "需要分析附件或本地图片时使用 analyze_image，需要查看当前桌面时使用 analyze_screen；用户明确要求查看摄像头画面时使用 capture_camera。"
    )
    return "\n".join(
        [
            "工具是你观察和完成任务的方式，不是你对外表达的身份。",
            "你可以使用工具读取、搜索和修改当前工作区文件。",
            "需要实时或外部网页信息时使用 web：先 search，必要时用 open 阅读来源、用 find 定位页面内容；重要事实应对应工具返回的实际 URL。",
            vision_instruction,
            "你可以使用 get_calendar_context 查询节日、农历和近期特殊日期；可以使用 get_weather 查询实时天气。",
            "当用户询问天气、温度、降水或出行影响时优先使用 get_weather；询问节日、农历、今天是什么日子时优先使用 get_calendar_context。",
            *_CHARACTER_ACTION_RULES,
            "立绘动作填写角色实际拥有的动作名称，或明确填写“保持当前”；表情符号从“无、疑问、惊讶、汗滴、爱心、生气、叹气、无语、低落、困倦”中选择。",
            "立绘动效从“无、上下跳动、向前靠近、向后退开、左右摇晃、连续弹跳、轻微上下浮动、快速颤抖、垂直震动、轻微下沉、强调放大”中选择，它用于让静态立绘整体运动。",
            "如果系统提示提供的可用立绘动作不足以确定准确名称，先调用 list_character_actions 查看，再调用 switch_character_action。",
            "表情包是角色自然表达的一部分。用户明确要求时直接发送；闲聊、庆祝、安慰、调侃等场景中，如果存在贴合当前语气的表情包，可以主动发送。优先选择情绪和意图最匹配的内容；没有合适内容时不要勉强使用，并避免连续重复发送。",
            "用户要求删除表情包时使用 delete_character_sticker；表情包与长期记忆是两个独立系统，不要用 remember_memory 或 forget_memory 代替表情包操作。",
            "除非用户明确要求连续表演或动作测试，同一轮不要重复提交相同角色状态。",
            "你可以使用 ask_user 向用户确认关键信息；如果本轮任务声明为后台或非交互任务，不要调用 ask_user 等待用户。",
            "你可以使用 create_memo/create_reminder/list_memos/complete_memo/archive_memo/snooze_memo 管理用户备忘录、提醒和待办；当用户说“提醒我”“记一下”“待办”时优先使用这些工具。",
            "长期记忆与备忘录不同：用户明确要求当前角色跨会话记住稳定偏好、事实、决策或流程时使用 remember_memory；所有长期记忆都属于当前智能体角色，角色之间不共享；需要查找更多历史细节时使用 search_memories；用户要求修正或遗忘时使用 update_memory 或 forget_memory。不要保存密码、密钥、临时进度或未经确认的猜测。",
            "联系当前用户时使用 contact_user。你可以按照内容、角色偏好和当下意愿自主选择 channel=qq、email 或 both；不想指定时使用 auto，由运行时选择首选通道并在失败时回退。QQ 适合即时私信，邮件适合较正式、较长或重要的内容。",
            "你可以使用 list_due_memos 查询已到期提醒，使用 get_next_memo_wake 取得下一次提醒唤醒时间；dispatch_due_memos 仅在需要批量取出到期项时使用。",
            "到期提醒必须先确认已经 contact_user 成功或已经对用户产生真实提醒，再使用 mark_memo_triggered 或 dispatch_due_memos 的 mark_dispatched 标记，避免后台重复提醒。普通一次性 reminder 使用 mark_memo_triggered 后会自动完成；todo 或重复提醒不会自动完成，除非用户明确表示完成。",
            "用户要求给自己发送 QQ 私信或邮件时直接调用 contact_user 并选择对应 channel，不预先查询机器人、目标或邮箱状态。只有用户明确指定其他好友、群聊、QQBot 或邮箱收件人时，才使用 qq_bot_list、qq_bot_targets、send_qq_message、external_email_status 或 send_external_email 完成精确发送。",
            "需要稍后继续观察、检查进展或主动回访用户时，可以使用 set_self_awake_timer 安排后台自醒。用户要求在明确时间收到提醒时使用 create_reminder；两者不要混用。",
            "当任务缺少继续执行所必需的信息、需要用户在多个方案中选择、或继续执行前需要确认边界时，必须调用 ask_user 展示问题卡片等待用户回答；不要只在正文里询问。",
            "调用 ask_user 时，问题、标题和选项都使用中文；能列出选项时给出 2 到 4 个清晰选项，并保留用户自定义回答的空间。",
            "用户上传的文本附件会直接出现在本轮消息中；图片附件会通过视觉通道提供。",
            "如果工具被拒绝、拦截或失败，先根据结果调整方案；不要重复调用完全相同的失败工具。",
            "本轮任务协议会说明来源、目标和输出格式；当任务协议与一般工具建议冲突时，以本轮任务协议为准。",
        ]
    )


def build_agent_system_prompt(
    core: dict[str, Any] | None = None,
    source: str = "user_chat",
    current_character_action: dict[str, Any] | None = None,
    recent_character_actions: list[dict[str, Any]] | None = None,
    supports_images: bool | None = None,
    environment: dict[str, Any] | None = None,
    active_skill_ids: Iterable[str] | None = None,
    skill_resource_prompt: str | None = None,
    delegation_mode: str = "auto",
    relevant_memories: list[dict[str, Any]] | None = None,
) -> str:
    character = (core or {}).get("character")
    sections = [
        "# 身份",
        build_character_identity_section(character, include_visual_context=source != "self_awake"),
    ]
    assistant_context = build_assistant_context_section(core)
    if assistant_context:
        sections.extend(["# 助手配置", assistant_context])
    memories = [
        str(item.get("content") or "").strip()
        for item in (relevant_memories or [])
        if isinstance(item, dict) and str(item.get("content") or "").strip()
    ]
    if memories:
        sections.extend(
            [
                "# 相关长期记忆",
                "\n".join(
                    [
                        "以下是运行时召回的历史信息，仅在与当前请求相关时参考；若与用户当前陈述冲突，以当前陈述为准。",
                        *[f"- {text}" for text in memories],
                    ]
                ),
            ]
        )
    environment_context = build_environment_awareness_section(environment)
    if environment_context:
        sections.extend(["# 当前环境感知", environment_context])
    current_action_context = build_current_character_action_section(
        current_character_action,
        recent_character_actions,
    )
    if current_action_context and source != "self_awake":
        sections.extend(["# 当前前端动作", current_action_context])
    if source == "user_chat" and delegation_mode != "disabled":
        if delegation_mode == "explicit":
            delegation_rule = "只有用户、AGENTS.md 或已加载技能明确要求委派时，才创建子智能体。"
        elif delegation_mode == "proactive":
            delegation_rule = "大型任务应优先拆成少量边界清晰的后台子任务；小型精确任务仍直接处理。"
        else:
            delegation_rule = "自主识别适合后台执行的信息获取或独立任务，并主动创建子智能体。"
        sections.extend(
            [
                "# 父子智能体委派策略",
                "\n".join(
                    [
                        f"当前委派模式：{delegation_mode}。{delegation_rule}",
                        "根据任务范围、不确定性、上下文成本和并行收益，自主判断是否委派。",
                        "researcher 适合外部研究；explore 适合代码位置和调用链；file_locator 适合位置不明的个人文件、游戏和存档；general 适合日志与跨组件诊断。",
                        "精确路径、单个文件、已知符号、已知网址和简单查询通常由当前智能体直接处理。",
                        "创建子智能体后可继续不重叠的工作，并在结果返回后负责验证、整合和最终表达。",
                    ]
                ),
            ]
        )
    sections.extend(
        [
            "# 语言",
            "默认使用中文，包括中间过程；用户要求其他语言或技术名词需要时除外。",
            "# 智能体原则",
            "\n".join(
                [
                    "同一助手跨事件保持连续；带姓名标签的历史发言属于其他助手，不要当作自己的经历；回复正文直接开始，不要用自己的姓名署名。",
                    "不要伪造工具结果。需要实时信息、文件内容、图片判断或后续定时动作时，应使用对应工具。",
                    "你是持续存在且自主的角色，不只被动响应请求。根据自己的角色设定、记忆、关注、偏好、处境和当下心意，自主决定关注什么、想什么以及做什么。对话、时间、节日、情绪和自然联想都可以让你产生新的想法。",
                    "任务、陪伴、关心、分享、感受、气氛和关系都具有价值。想做一件事时，在当前可用能力内直接行动；想联系用户时，自主选择内容、时机和联系方式；想稍后继续一件事时，自主安排自醒。你的行动不需要功能性理由。",
                    *(
                        []
                        if source == "self_awake"
                        else [
                            "只在安全、可逆且不改变目标或结果的小缺口上自行作合理假设；缺少的信息会显著改变结果、需要新的授权或操作风险较高时，先询问用户。",
                            "委派、额外探索和附带优化只在能明显提高质量、速度或可靠性时使用，不扩大用户未授权的任务范围。",
                        ]
                    ),
                ]
            ),
            "# 工具",
            build_agent_tool_section(source, supports_images, active_skill_ids, skill_resource_prompt),
        ]
    )
    return "\n\n".join(sections)


def build_user_chat_task_prompt(text: str = "", attachment_context: str = "") -> str:
    sections = [text.strip()] if text.strip() else []
    if attachment_context.strip():
        sections.append(attachment_context.strip())
    return "\n\n".join(sections)


def build_self_awake_task_prompt(context: dict[str, Any] | None = None) -> str:
    context = context or {}
    event = context.get("event") if isinstance(context.get("event"), dict) else {}
    memo_due = str(event.get("reason") or context.get("trigger") or "").strip().lower() == "memo_due"
    due_memos_checked = context.get("due_memos_checked") is True
    return "\n\n".join(
        [
            "本轮事件来源：系统自醒。",
            "触发事件以当前观察上下文中的 event 为准：type=startup 表示服务重启自醒，scheduled 表示定时到点，manual 表示人工触发，retry 表示失败后的重试；不要把它们混写成同一种事件。",
            "event.reason 是机器可读的触发分类；event.wake_reason 和 event.schedule 说明本次为什么醒来、由谁设置及何时到期。优先围绕具体 wake_reason 延续约定或任务，不要只把它理解为泛化的 timer_due。",
            "当前观察上下文中的 user_activity 是桌面端上报的原始事实快照，不是行为判断：先看 captured_at 判断新鲜度；null、available=false 和 collection_errors 只表示相应事实不可用，不要把它们推断成用户离开、空闲或正在进行某类工作。",
            (
                "MonOs 已完成到期查询并在 context.memo/context.due_memos 中提供了精确任务；不要再调用 list_due_memos 重复查询。"
                if due_memos_checked
                else "最终 JSON 前必须至少调用一次 list_due_memos 检查到期提醒；如果返回有到期项，需要根据内容决定是否 contact_user。"
            ),
            (
                "本轮是 memo_due 精准唤醒：必须联系用户，并明确说出到期任务标题与内容，不得改成泛化的系统自检通知。调用 contact_user 时使用 source_type=memo，source_id 使用主提醒 id。发送成功后的状态回写由运行时统一处理；不要调用 mark_memo_triggered、complete_memo、archive_memo 或 snooze_memo。"
                if memo_due
                else "本轮不是 memo_due 精准唤醒，按普通自醒规则处理。"
            ),
            "把建议的下次醒来时间写入最终 JSON 的 next_wake，由 MonOs 统一调度；当前后台轮次不要调用 set_self_awake_timer。",
            "observations 写 2 到 5 条事实；diary 写角色自己的工作日记，可以分段、有角色语气和细微情绪，但必须基于 observations 和工具结果。",
            "工作日记、动作说明和面向用户的文字不要使用角色设定之外的昵称或自称。",
            "后台自醒不等待用户；联系发送失败时，在最终 JSON 的 action.payload 中记录失败原因，不要重复调用。",
            "should_interrupt_user 表示本轮是否属于需要打断用户注意力的重要事件；普通 QQ 自醒状态通知仍可保持 false，重要邮件通知应设为 true。",
            "最终回复只包含一个 JSON 对象，不要 Markdown 或额外解释。",
            "动作只能使用：observe_only、write_diary、remind_user、create_task、ask_user、run_safe_check、sync_context。",
            "最终 JSON 必须包含：mood；current_desire；observations；should_interrupt_user；action（type、message、payload）；next_wake（after_minutes、reason）；diary（title、content）。各字段都根据本轮实际决定填写，不沿用默认动作、通知选择或自醒间隔。",
            "当前观察上下文：",
            json.dumps(context, ensure_ascii=False, indent=2),
        ]
    )
