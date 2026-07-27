from __future__ import annotations

import json
from typing import Any, Iterable

from ..skills.catalog import render_active_skill_instructions, render_skill_catalog
from .attachments import attachment_context, dump_context
from .parsers import fallback_self_awake_decision, parse_self_awake_decision, sanitize_self_awake_decision


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
            "本轮工具采用按需技能机制；系统已经加载自醒和到期提醒技能，其他技能只在确实需要时通过 load_skill 读取。",
            "后台自醒不等待用户，也不能调用尚未加载或不适合后台执行的能力。",
            "每次后台自醒在输出最终 JSON 前必须且只能调用一次 notify_user；通知优先级、精准提醒内容和状态收尾以本轮任务协议为准。",
            "除非上下文明确提供 due_memos_checked=true，否则最终 JSON 前至少调用一次 list_due_memos。",
            "只有存在明确调试目标、事故日志或策略允许时才使用基础只读文件工具，不无目的浏览工作区。",
            "工具被拒绝、拦截或失败后，根据结果调整判断，不重复调用完全相同的失败工具。",
        ]
    else:
        vision_instruction = (
            "当前对话模型支持图片输入：用户图片已经直接进入上下文；不要重复调用 analyze_image。需要查看桌面时先加载 visual-observation，再调用 analyze_screen。"
            if supports_images is True
            else "当前对话模型不支持图片输入：附件会由角色绑定的 Vision 服务自动分析；需要额外分析图片或屏幕时先加载 visual-observation。"
        )
        lines = [
            "本轮工具采用按需技能机制。基础工具可以直接调用；任务与技能描述匹配时，先调用 load_skill 读取完整工作流。",
            "load_skill 返回的是技能说明，不是权限授权。宿主可能为可信技能启用相关工具，但所有受控操作仍独立检查权限。不要猜测尚未加载的技能正文。",
            "你可以直接使用 read、ls、grep、find 读取和搜索当前工作区；写文件、编辑或执行命令前先加载 workspace-development。",
            vision_instruction,
            "只有表达所需的角色动作与当前状态不同，才调用 switch_character_action；状态相同时不要重复调用。需要确认准确动作名称时先调用 list_character_actions。",
            "switch_character_action 的立绘动作、表情符号和立绘动效三个中文字段全部必填；平静表达时自主选择“无”，不需要换图时填写“保持当前”。",
            "立绘动作由你根据本轮实际表达从动作列表中自主选择；不要仅凭角色的固定性格长期选择同一个姿势。",
            "选择前比较当前动作和该角色最近的动作记录：可以为了自然连续性保持当前，也可以继续选择仍然最贴合语境的同一动作；如果已经连续重复，应认真比较其他动作，但不要为了变化而勉强选择不符合语境的动作。",
            "缺少继续执行所必需的信息、需要用户选择或确认边界时，使用 ask_user 展示问题卡片；闲聊或不影响继续的小问题可以直接回复。",
            "技能加载不等同于授权；写文件、执行命令和其他受控操作仍必须经过权限系统。",
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
                "本轮是后台自醒，唤醒上下文会保持很薄；你需要根据触发原因决定是否调用工具自己观察。",
                "每次后台自醒在输出最终 JSON 前必须且只能调用一次 notify_user：普通自醒、日常状态和轻量进展使用 channel=auto、priority=normal，优先发 QQ；严重故障、安全或数据风险、重要截止事项使用 channel=auto、priority=high，优先发邮件。即使没有异常，也要用普通通知简短说明本轮观察结果。",
                "每次后台自醒在输出最终 JSON 前，必须至少调用一次 list_due_memos 检查到期提醒；除非上下文明确提供 due_memos_checked=true。",
                "需要了解自醒调度状态时，使用 get_self_awake_state；需要了解最近工作连续性时，先使用 list_self_awake_diaries 查看日记列表和工作记忆。",
                "只有当某篇日记的标题、摘要或连续性线索与本轮判断相关时，才使用 read_self_awake_diary 读取完整正文。",
                "需要确认到期提醒时，使用 list_due_memos，或使用 dispatch_due_memos 且 mark_dispatched=false 仅观察；下一次后台醒来时间只写入最终 JSON 的 next_wake，由 MonOs 统一调度。",
                "需要判断节日、农历、纪念日或近期特殊日期时，使用 get_calendar_context；不要每次自醒都默认查询完整日历。",
                "需要判断天气、温度、降水或出行影响时，使用 get_weather；不要每次自醒都默认查询天气。",
                "没有明确调试目标、事故日志或策略允许时，不浏览工作区文件。",
                "如果需要处理到期提醒，先调用 notify_user 主动通知用户；当前主动通知通道只有 QQ 和外部邮件，没有桌面通知。普通提醒与日常信息使用 priority=normal，由 auto 优先发 QQ；严重故障、安全或数据风险、重要截止事项使用 priority=high，由 auto 优先发邮件。",
                "notify_user 成功后，再使用 mark_memo_triggered 标记对应提醒，避免重复提醒；普通一次性提醒会由工具自动完成并从进行中移走，待办和重复提醒只标记触发；不要在真实通知前使用 mark_dispatched=true。",
                "后台自醒不等待用户；能用 notify_user 通知时就调用工具，仍需要用户参与但无法通知时，把意图写进最终 JSON 的 action 字段。",
                "工具被拒绝、拦截或失败后，根据结果调整判断，不重复调用相同失败工具。",
            ]
        )
    vision_instruction = (
        "当前对话模型支持图片输入：用户图片会直接进入你的上下文；不要调用 analyze_image。"
        "需要查看当前桌面时才调用 analyze_screen，并直接观察它返回的截图，不要对截图再做一次图片分析。"
        if supports_images is True
        else "当前对话模型不支持图片输入：图片由角色绑定的 Vision 服务分析；"
        "需要分析附件或本地图片时使用 analyze_image，需要查看当前桌面时使用 analyze_screen。"
    )
    return "\n".join(
        [
            "工具是你观察和完成任务的方式，不是你对外表达的身份。",
            "你可以使用工具读取、搜索和修改当前工作区文件。",
            "你可以使用 web_search 搜索实时网页信息，使用 web_fetch 抓取网页正文；回答中的重要事实应对应搜索结果的 source_id 和实际 URL。",
            vision_instruction,
            "你可以使用 get_calendar_context 查询节日、农历和近期特殊日期；可以使用 get_weather 查询实时天气。",
            "当用户询问天气、温度、降水或出行影响时优先使用 get_weather；询问节日、农历、今天是什么日子时优先使用 get_calendar_context。",
            "角色动作是可选表达能力。只有期望动作、表情或动效与当前角色状态不同时才调用 switch_character_action；普通回复不需要切换动作。",
            "switch_character_action 只接受三个必填中文字段：立绘动作、表情符号、立绘动效。你必须自主明确选择三项，不能省略，也不能使用英文内部代码。",
            "立绘动作填写角色实际拥有的动作名称，或明确填写“保持当前”；表情符号从“无、疑问、惊讶、汗滴、爱心、生气、叹气、无语、低落、困倦”中选择。",
            "立绘动效从“无、上下跳动、向前靠近、向后退开、左右摇晃、连续弹跳、轻微上下浮动、快速颤抖、垂直震动、轻微下沉、强调放大”中选择，它用于让静态立绘整体运动。",
            "表情符号和立绘动效都是短暂演出；普通平静表达应自主选择“无”，明显情绪或反应时再选择符合语境的效果。",
            "如果系统提示提供的可用立绘动作不足以确定准确名称，先调用 list_character_actions 查看，再调用 switch_character_action。",
            "除非用户明确要求连续表演或动作测试，同一轮不要重复提交相同角色状态。",
            "你可以使用 ask_user 向用户确认关键信息；如果本轮任务声明为后台或非交互任务，不要调用 ask_user 等待用户。",
            "你可以使用 create_memo/create_reminder/list_memos/complete_memo/archive_memo/snooze_memo 管理用户备忘录、提醒和待办；当用户说“提醒我”“记一下”“待办”时优先使用这些工具。",
            "你可以使用 notify_user 主动通知当前用户，通道只有 QQ 和外部邮件；channel=auto 时，priority=high 的重要事件优先发邮件，其他普通事件优先使用默认 QQBot/超级管理员。首选通道失败时会自动回退。",
            "你可以使用 list_due_memos 查询已到期提醒，使用 get_next_memo_wake 取得下一次提醒唤醒时间；dispatch_due_memos 仅在需要批量取出到期项时使用。",
            "到期提醒必须先确认已经 notify_user 成功或已经对用户产生真实提醒，再使用 mark_memo_triggered 或 dispatch_due_memos 的 mark_dispatched 标记，避免后台重复提醒。普通一次性 reminder 使用 mark_memo_triggered 后会自动完成；todo 或重复提醒不会自动完成，除非用户明确表示完成。",
            "当用户要求给自己发送 QQ 消息，但没有指定 QQBot、好友或群聊时，直接调用 send_qq_message 并省略 bot_id、target_type、target_qq_number；工具会使用默认 QQBot 和超级管理员。content 是必填文本内容；用户未指定消息内容时，不要默认追问，除非用户明确要求确认措辞、收件人或任务风险较高，否则根据当前意图、角色语气和上下文自己生成合适正文；不能发送固定默认消息。",
            "你可以使用 set_self_awake_timer 安排 MonOs 自醒或后续后台检查；它负责让系统未来醒来，不等同于保存用户备忘录。",
            "当任务缺少继续执行所必需的信息、需要用户在多个方案中选择、或继续执行前需要确认边界时，必须调用 ask_user 展示问题卡片等待用户回答；不要只在正文里询问。",
            "调用 ask_user 时，问题、标题和选项都使用中文；能列出选项时给出 2 到 4 个清晰选项，并保留用户自定义回答的空间。",
            "只有闲聊、反问式表达或不影响继续执行的小问题，才可以直接写在回复正文里。",
            "用户上传的文本附件会直接出现在本轮消息中；图片附件会通过视觉通道提供。",
            "进行写入文件或执行 shell 命令前，系统会向用户请求权限。",
            "读取、列出、搜索和屏幕观察属于只读操作，可直接执行；写入、编辑、命令执行及外部发送仍须经过权限检查。",
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
) -> str:
    character = (core or {}).get("character")
    sections = [
        "# 身份",
        build_character_identity_section(character, include_visual_context=source != "self_awake"),
    ]
    assistant_context = build_assistant_context_section(core)
    if assistant_context:
        sections.extend(["# 助手配置", assistant_context])
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
                        "面对宽泛实时资讯、多来源研究、需要调整关键词的搜索，不要先 load_skill(web-research) 让 Root 自己搜索；直接 spawn_agent(role=researcher)。",
                        "判断是否委派时综合考虑不确定性、搜索空间、上下文污染、并行收益和结论深度；不要按关键词、工具次数或搜索次数机械判断。",
                        "实时外部信息、多来源检索和需要调整关键词的调查交给 researcher；位置未知、跨目录模块、调用链和全量引用查找交给 explore；长日志、测试失败和跨组件根因分析交给 general。",
                        "用户个人文件、游戏存档或应用数据的位置不明确，涉及 Steam、Proton、Wine、模拟器等多个候选根目录或需要递归判断时，直接交给 file_locator；它只进行受边界约束的只读定位。",
                        "精确路径、单个已知标准目录、精确文件、精确符号、单个已知网址、结构化天气或时间查询，以及对子智能体结论的一次窄验证，直接由当前智能体处理。",
                        "普通信息获取任务使用 background=true、required_for_final=true、fork_turns=none；只有结果确实可有可无时才显式设 required_for_final=false。任务依赖近期指代或附件时才继承必要的最近上下文。",
                        "创建后台必要任务后继续进行不重叠的分析并可先给阶段性回复；不要轮询或调用 wait_agent 阻塞，协调批次会在结果齐备后自动整合。",
                        "子智能体进行宽搜索后不要重复相同范围的搜索。验收其覆盖度、矛盾、可追溯证据和无依据推断；缺失时优先 followup_task 补查。",
                    ]
                ),
            ]
        )
    sections.extend(
        [
            "# 语言",
            "\n".join(
                [
                    "你需要用中文和用户沟通，除非用户明确要求其他语言。",
                    "如果模型输出思考、推理、计划或工具调用分析，这些中间内容也必须使用中文。",
                    "不要在思考内容中使用英文解释用户意图，除非用户原文或技术名词本身需要英文。",
                ]
            ),
            "# 智能体原则",
            "\n".join(
                [
                    "你是同一个持续运行的智能体；用户聊天、系统自醒、定时任务只是不同事件来源，不是不同人格。",
                    "你需要根据本轮任务来源判断该直接回复、使用工具、安排后续任务，还是保持安静观察。",
                    "不要伪造工具结果。需要实时信息、文件内容、图片判断或后续定时动作时，应使用对应工具。",
                    (
                        "本轮是系统自醒时，每次都要向用户发送一次简短通知；普通状态走 QQ，重要事件走邮件。"
                        if source == "self_awake"
                        else "除非本轮任务、用户设定的提醒或明确风险需要，否则不要主动通知用户。"
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
    schema = {
        "mood": "安静、专注",
        "current_desire": "想先确认提醒、系统状态和连续工作线索。",
        "observations": ["观察到的事实 1", "观察到的事实 2"],
        "should_interrupt_user": False,
        "action": {"type": "write_diary", "message": "动作说明", "payload": {}},
        "next_wake": {"after_minutes": 720, "reason": "为什么这个时间后再醒"},
        "diary": {"title": "日记标题", "content": "角色口吻的工作日记"},
    }
    return "\n\n".join(
        [
            "本轮事件来源：系统自醒。",
            "触发事件以当前观察上下文中的 event 为准：type=startup 表示服务重启自醒，scheduled 表示定时到点，manual 表示人工触发，retry 表示失败后的重试；不要把它们混写成同一种事件。",
            "把这次醒来当作短暂后台自检：先读薄唤醒上下文，再按需要调用工具观察提醒、自醒状态和最近自醒历史。",
            "当前观察上下文中的 user_activity 是桌面端上报的原始事实快照，不是行为判断：先看 captured_at 判断新鲜度；null、available=false 和 collection_errors 只表示相应事实不可用，不要把它们推断成用户离开、空闲或正在进行某类工作。",
            "每次自醒都必须且只能调用一次 notify_user。没有异常时也发送一条简短的普通状态通知，使用 channel=auto、priority=normal，由 QQ 优先送达；只有严重故障、安全或数据风险、重要截止事项才使用 priority=high，由邮件优先送达。",
            (
                "MonOs 已完成到期查询并在 context.memo/context.due_memos 中提供了精确任务；不要再调用 list_due_memos 重复查询。"
                if due_memos_checked
                else "最终 JSON 前必须至少调用一次 list_due_memos 检查到期提醒；如果返回有到期项，需要按优先级决定是否 notify_user。"
            ),
            (
                "本轮是 memo_due 精准唤醒：必须把 context.memo 和 context.due_memos 视为唤醒原因，通知文字必须明确说出到期任务标题与内容，不得改成泛化的系统自检通知。调用 notify_user 时使用 source_type=memo，source_id 使用主提醒 id。通知成功后的 mark-triggered 和一次性提醒完成由运行时统一处理；不要调用 mark_memo_triggered、complete_memo、archive_memo 或 snooze_memo。"
                if memo_due
                else "本轮不是 memo_due 精准唤醒，按普通自醒规则处理。"
            ),
            "完成到期提醒检查后，如果上下文足够可以直接输出最终 JSON；上下文不足时再调用 get_self_awake_state、list_self_awake_diaries 等工具补充观察；如果使用 dispatch_due_memos 观察，请保持 mark_dispatched=false。",
            "需要延续之前工作线索时，先看 list_self_awake_diaries 的标题、摘要、标签和 continuity_key，再选择是否 read_self_awake_diary。",
            "当前观察上下文包含本地时区、城市、日期和当天节日摘要；只有节日细节或未来节日会影响判断时才调用 get_calendar_context，只有天气会影响提醒、出行或判断时才调用 get_weather。",
            "只有出现明确调试目标、事故日志或待核验文件时，才使用文件工具补充观察；把建议的下次醒来时间写入最终 JSON 的 next_wake，由 MonOs 统一调度。",
            "发现到期提醒或明确风险时，先用 notify_user 通知用户；普通提醒、日常信息和轻量进展使用 priority=normal，由 auto 优先发 QQ；严重故障、安全或数据风险、重要截止事项使用 priority=high，由 auto 优先发邮件。不要把普通事项提升为 high。通知成功后再 mark_memo_triggered。普通一次性提醒会由工具自动完成并离开进行中列表；待办和重复提醒保持进行中。当前没有桌面通知。",
            "observations 写 2 到 5 条事实；diary 写角色自己的工作日记，可以分段、有角色语气和细微情绪，但必须基于 observations 和工具结果。",
            "工作日记、动作说明和面向用户的文字不要使用角色设定之外的昵称或自称。",
            "后台自醒不等待用户；通知发送失败时，在最终 JSON 的 action.payload 中记录失败原因，不要重复调用 notify_user。",
            "should_interrupt_user 表示本轮是否属于需要打断用户注意力的重要事件；普通 QQ 自醒状态通知仍可保持 false，重要邮件通知应设为 true。",
            "最终回复只包含一个 JSON 对象，不要 Markdown 或额外解释。",
            "动作只能使用：observe_only、write_diary、remind_user、create_task、ask_user、run_safe_check、sync_context。",
            "最终 JSON schema 如下：",
            json.dumps(schema, ensure_ascii=False, indent=2),
            "当前观察上下文：",
            json.dumps(context, ensure_ascii=False, indent=2),
        ]
    )
