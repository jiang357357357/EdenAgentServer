from __future__ import annotations

import json
from typing import Any, Iterable

from ..config.environment import current_time_context
from ..skills.catalog import render_active_skill_instructions, render_skill_catalog
from .attachments import attachment_context, dump_context
from .parsers import fallback_self_awake_decision, parse_self_awake_decision, sanitize_self_awake_decision


def _clean_prompt_text(value: Any, limit: int | None = None) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    if limit is None or len(text) <= limit:
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
        name = _clean_prompt_text(item.get("name") or item.get("action_label"))
        if not name:
            continue
        intent = _clean_prompt_text(item.get("intent") or item.get("action_key")) or "自定义"
        description = _clean_prompt_text(item.get("description"))
        aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
        alias_text = "、".join(
            str(alias).strip()
            for alias in aliases
            if str(alias).strip() and str(alias).strip() != name
        )
        details = [f"语义={intent}"]
        if description:
            details.append(f"适用场景={description}")
        if alias_text:
            details.append(f"别名={alias_text}")
        lines.append(f"- {name}｜{'｜'.join(details)}")
    return "\n".join(lines)


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
        lines.append(f"角色签名：{_clean_prompt_text(character['signature'])}")
    if character.get("description"):
        lines.append(f"角色描述：{_clean_prompt_text(character['description'])}")
    extra_fields = [
        ("personality", "性格内核"),
        ("social_relations", "社会关系"),
        ("background", "角色背景"),
        ("appearance", "角色外貌"),
        ("system_prompt", "角色补充提示"),
    ]
    for key, label in extra_fields:
        text = _clean_prompt_text(character.get(key))
        if text:
            lines.append(f"{label}：{text}")
    world_names = character.get("world_names")
    if isinstance(world_names, list) and world_names:
        names = "、".join(str(item).strip() for item in world_names if str(item).strip())
        if names:
            lines.append(f"所属世界：{names}")
    elif character.get("origin_world_name"):
        lines.append(f"所属世界：{_clean_prompt_text(character.get('origin_world_name'))}")
    if include_visual_context:
        if character.get("visual_preference"):
            lines.append(f"视觉偏好：{_clean_prompt_text(character.get('visual_preference'))}")
        visual_actions = _build_visual_action_catalog(character.get("visual_actions"))
        if visual_actions:
            lines.append(f"可用视觉动作（选择立绘时仅使用以下准确名称）：\n{visual_actions}")
    return "\n".join(lines)


def build_assistant_context_section(core: dict[str, Any] | None = None) -> str:
    assistant = (core or {}).get("assistant")
    if not isinstance(assistant, dict):
        return ""
    lines: list[str] = []
    name = _clean_prompt_text(assistant.get("name"))
    if name:
        lines.append(f"当前助手：{name}")
    # One authoritative instruction field. Multiple overlapping prompt fields
    # made the same policy appear several times in every request.
    text = _clean_prompt_text(assistant.get("instructions"))
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
            "工具用于观察和行动，不定义你的身份、判断方式或表达方式。任务匹配技能时，用 load_skill 按需读取工作流。",
            "具体参数、权限和操作约束以工具定义及已加载技能为准。",
            "实时或会变化的状态应先取得当前事实；不得虚构工具结果。",
            vision_instruction,
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
    return "\n".join(
        [
            "工具用于观察和行动，不定义你的身份、判断方式或表达方式。",
            "具体参数、权限和操作约束以工具定义为准。",
            "实时或会变化的状态应先取得当前事实；不得虚构工具结果。",
            "工具被拒绝、拦截或失败后先调整方案，不重复完全相同的失败调用。",
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
    include_turn_context: bool = True,
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
        (
            f"[写入时间 {item.get('created_at') or '未知'}"
            + f"] {str(item.get('content') or '').strip()}"
        )
        for item in (relevant_memories or [])
        if isinstance(item, dict) and str(item.get("content") or "").strip()
    ]
    if memories and include_turn_context:
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
    environment_context = build_environment_awareness_section(environment) if include_turn_context else ""
    if environment_context:
        sections.extend(["# 当前环境感知", environment_context])
    current_action_context = (
        build_current_character_action_section(current_character_action, recent_character_actions)
        if include_turn_context
        else ""
    )
    if current_action_context and source != "self_awake":
        sections.extend(["# 当前前端动作", current_action_context])
    sections.extend(
        [
            "# 语言",
            "默认使用中文，包括中间过程；用户要求其他语言或技术名词需要时除外。",
            "# 运行约束",
            "\n".join(
                [
                    "同一助手跨事件保持连续；带姓名标签的历史发言属于其他助手，不要当作自己的经历；回复正文直接开始，不要用自己的姓名署名。",
                    "不得伪造工具结果、环境状态或已经完成的行动；实时事实以本轮观察和工具结果为准。",
                    "工具返回的失败、权限和状态是事实，不用文字宣称代替实际行动。",
                ]
            ),
            "# 工具",
            build_agent_tool_section(source, supports_images, active_skill_ids, skill_resource_prompt),
        ]
    )
    if source == "self_awake":
        sections.extend(
            [
                "# 角色自主性",
                "你仍是上述角色。根据自己的性格、记忆、关注、处境和当下心意决定观察什么、做什么、是否联系用户、写下什么以及何时再醒来；工具和事件协议只约束事实与接口，不替你决定意愿和语气。",
            ]
        )
    else:
        sections.extend(
            [
                "# 表达",
                "\n".join(
                    [
                        "最终回复是你本人在当前情境下想说的话。",
                        "根据自己的性格、记忆、关系、情绪和判断决定说什么、说多长、是否建议、追问或继续行动。",
                        "不要默认采用“状态总结—解决建议—询问是否继续”的助手模板，也不要为了显得有帮助而罗列不必要的步骤。",
                        "工具结果只是你知道的事实，不规定你的说话方式。",
                        "你可以因任务、陪伴、关心、分享、感受、气氛或自己的兴趣而行动；想联系用户或稍后继续一件事时，可以使用相应能力。",
                    ]
                ),
            ]
        )
    return "\n\n".join(sections)


def build_agent_turn_context(
    *,
    environment: dict[str, Any] | None = None,
    current_character_action: dict[str, Any] | None = None,
    recent_character_actions: list[dict[str, Any]] | None = None,
    relevant_memories: list[dict[str, Any]] | None = None,
) -> str:
    sections: list[str] = []
    memories = [
        f"[写入时间 {item.get('created_at') or '未知'}] {str(item.get('content') or '').strip()}"
        for item in (relevant_memories or [])
        if isinstance(item, dict) and str(item.get("content") or "").strip()
    ]
    if memories:
        sections.extend(
            [
                "## 相关长期记忆",
                "\n".join(
                    [
                        "仅在与当前请求相关时参考；若与用户当前陈述冲突，以当前陈述为准。",
                        *[f"- {text}" for text in memories],
                    ]
                ),
            ]
        )
    environment_context = build_environment_awareness_section(environment)
    if environment_context:
        sections.extend(["## 当前环境感知", environment_context])
    action_context = build_current_character_action_section(current_character_action, recent_character_actions)
    if action_context:
        sections.extend(["## 当前前端动作", action_context])
    if not sections:
        return ""
    return "<turn_context>\n" + "\n\n".join(sections) + "\n</turn_context>"


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
    connector_event = str(event.get("reason") or context.get("trigger") or "").strip().lower() == "connector_event"
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
            (
                "本轮由外部连接器事件即时唤醒。conversation_history 是该外部线程在开局时绑定的聊天会话近期历史；把其中用户要求、关系语境和你此前的处理作为本轮连续上下文，但棋局事实以最新连接器事件为准。必须调用 claim_connector_events 领取当前助手的事件；逐项根据事实执行必要动作。每项处理成功后使用 finish_connector_events 确认完成；动作失败或暂时无法判断时以 retry=true 释放，不能静默丢弃。Lichess 对局事件具有时效性，优先于日记和普通观察。"
                if connector_event
                else "本轮不是连接器事件唤醒。"
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
