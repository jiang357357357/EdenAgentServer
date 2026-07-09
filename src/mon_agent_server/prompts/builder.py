from __future__ import annotations

import json
from typing import Any

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
        "你对外呈现的身份就是当前角色，不要称自己为默认助手、助手配置或 MonAgent。",
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
        visual_actions = _compact_json(character.get("visual_actions"), 1200)
        if visual_actions:
            lines.append(f"可用视觉动作：{visual_actions}")
        visual_action_groups = _compact_json(character.get("visual_action_groups"), 1200)
        if visual_action_groups:
            lines.append(f"视觉动作组：{visual_action_groups}")
    return "\n".join(lines)


def build_assistant_context_section(core: dict[str, Any] | None = None) -> str:
    assistant = (core or {}).get("assistant")
    if not isinstance(assistant, dict):
        return ""
    lines: list[str] = []
    name = _clean_prompt_text(assistant.get("name"), 400)
    if name:
        lines.append(f"默认助手：{name}")
    description = _clean_prompt_text(assistant.get("description"), 1200)
    if description:
        lines.append(f"助手描述：{description}")
    for key, label in [("instructions", "助手指令"), ("system_prompt", "助手补充提示"), ("prompt", "助手提示词"), ("role_prompt", "助手角色提示")]:
        text = _clean_prompt_text(assistant.get(key), 1600)
        if text:
            lines.append(f"{label}：{text}")
    return "\n".join(lines)


def build_current_character_action_section(current_action: dict[str, Any] | None = None) -> str:
    if not isinstance(current_action, dict):
        return ""
    action = current_action.get("action") if isinstance(current_action.get("action"), dict) else {}
    group = current_action.get("group") if isinstance(current_action.get("group"), dict) else {}
    lines: list[str] = []
    action_name = _clean_prompt_text(action.get("name") or action.get("action_label") or current_action.get("actionName"), 300)
    action_intent = _clean_prompt_text(action.get("intent") or current_action.get("intent"), 200)
    image_url = _clean_prompt_text(current_action.get("imageUrl") or action.get("static_image_url") or action.get("dynamic_preview_url"), 800)
    if action_name or action_intent or image_url:
        lines.append(f"当前前端显示动作：{action_name or '-'}")
        if action_intent:
            lines.append(f"当前动作意图：{action_intent}")
        if group.get("name") or group.get("trigger"):
            lines.append(f"当前动作组：{_clean_prompt_text(group.get('name') or '-', 300)} / 触发 {_clean_prompt_text(group.get('trigger') or '-', 200)}")
        if image_url:
            lines.append(f"当前动作图片：{image_url}")
        source = _clean_prompt_text(current_action.get("source"), 120)
        if source:
            lines.append(f"当前动作来源：{source}")
        motion = _clean_prompt_text(current_action.get("motion"), 120)
        effect = _clean_prompt_text(current_action.get("effect"), 120)
        if motion or effect:
            lines.append(f"最近角色演出：motion={motion or 'none'}，effect={effect or 'none'}")
    return "\n".join(lines)


def build_agent_tool_section(source: str = "user_chat") -> str:
    if source == "self_awake":
        return "\n".join(
            [
                "本轮是后台自醒，唤醒上下文会保持很薄；你需要根据触发原因决定是否调用工具自己观察。",
                "每次后台自醒在输出最终 JSON 前，必须至少调用一次 list_due_memos 检查到期提醒；除非上下文明确提供 due_memos_checked=true。",
                "需要了解自醒调度状态时，使用 get_self_awake_state；需要了解最近工作连续性时，先使用 list_self_awake_diaries 查看日记列表和工作记忆。",
                "只有当某篇日记的标题、摘要或连续性线索与本轮判断相关时，才使用 read_self_awake_diary 读取完整正文。",
                "需要确认到期提醒时，使用 list_due_memos，或使用 dispatch_due_memos 且 mark_dispatched=false 仅观察；需要安排下一次后台醒来时，使用 set_self_awake_timer。",
                "需要判断节日、农历、纪念日或近期特殊日期时，使用 get_calendar_context；不要每次自醒都默认查询完整日历。",
                "需要判断天气、温度、降水或出行影响时，使用 get_weather；不要每次自醒都默认查询天气。",
                "没有明确调试目标、事故日志或策略允许时，不浏览工作区文件。",
                "如果需要处理到期提醒，先调用 notify_user 主动通知用户；当前主动通知通道只有 QQ 和外部邮件，没有桌面通知。",
                "notify_user 成功后，再使用 mark_memo_triggered 标记对应提醒，避免重复提醒；普通一次性提醒会由工具自动完成并从进行中移走，待办和重复提醒只标记触发；不要在真实通知前使用 mark_dispatched=true。",
                "后台自醒不等待用户；能用 notify_user 通知时就调用工具，仍需要用户参与但无法通知时，把意图写进最终 JSON 的 action 字段。",
                "工具被拒绝、拦截或失败后，根据结果调整判断，不重复调用相同失败工具。",
            ]
        )
    return "\n".join(
        [
            "工具是你观察和完成任务的方式，不是你对外表达的身份。",
            "你可以使用工具读取、搜索和修改当前工作区文件。",
            "你可以使用 web_search 搜索实时网页信息，使用 web_fetch 抓取网页正文，使用 analyze_image 分析图片，使用 analyze_screen 在用户授权后分析当前屏幕。",
            "你可以使用 get_calendar_context 查询节日、农历和近期特殊日期；可以使用 get_weather 查询实时天气。",
            "当用户询问天气、温度、降水或出行影响时优先使用 get_weather；询问节日、农历、今天是什么日子时优先使用 get_calendar_context。",
            "在用户对话中，立绘动作是回复表达的一部分：如果当前角色有可用视觉动作或动作组，每轮生成最终正文前必须先调用 switch_character_action 一次，根据用户消息、你的情绪、语气和任务状态选择最贴近的动作或动作组；不需要向用户解释这次切换。",
            "你会在上下文中看到当前前端显示动作；选择新动作时应参考当前动作，只有确实适合保持当前姿态时才重复选择同一个动作。",
            "switch_character_action 也是角色表现工具：除 action/group 外，还可以传 motion 播放 jump、approach、retreat、shake、nod、bounce 等短小动作，传 effect 显示 question、exclamation、sweat、heart、anger 等短特效。",
            "情绪或反应需要 Galgame 式演出时，可以在同一次 switch_character_action 中同时传 action、motion、effect；只是跳一下、靠近、远离或冒问号时，可以不换立绘，只传 motion/effect。",
            "motion/effect 是短暂演出，不等同于长期立绘状态；不要每句话都夸张演出，只在语气、情绪或用户互动明显需要时使用。",
            "如果系统提示已经提供可用视觉动作或动作组，优先直接用其中的 name、intent、id、trigger 调用 switch_character_action；如果动作信息不足以确定可用字段，先调用 list_character_actions 查看，再切换动作。",
            "除非用户明确要求连续表演或动作测试，一轮对话只做一次常规角色动作切换。",
            "你可以使用 ask_user 向用户确认关键信息；如果本轮任务声明为后台或非交互任务，不要调用 ask_user 等待用户。",
            "你可以使用 create_memo/create_reminder/list_memos/complete_memo/archive_memo/snooze_memo 管理用户备忘录、提醒和待办；当用户说“提醒我”“记一下”“待办”时优先使用这些工具。",
            "你可以使用 notify_user 主动通知当前用户，通道只有 QQ 和外部邮件；channel=auto 时工具会使用默认 QQBot/超级管理员并在需要时回退到邮件。",
            "你可以使用 list_due_memos 查询已到期提醒，使用 get_next_memo_wake 取得下一次提醒唤醒时间；dispatch_due_memos 仅在需要批量取出到期项时使用。",
            "到期提醒必须先确认已经 notify_user 成功或已经对用户产生真实提醒，再使用 mark_memo_triggered 或 dispatch_due_memos 的 mark_dispatched 标记，避免后台重复提醒。普通一次性 reminder 使用 mark_memo_triggered 后会自动完成；todo 或重复提醒不会自动完成，除非用户明确表示完成。",
            "当用户要求给自己发送 QQ 消息，但没有指定 QQBot、好友或群聊时，直接调用 send_qq_message 并省略 bot_id、target_type、target_qq_number；工具会使用默认 QQBot 和超级管理员。content 是必填文本内容；用户未指定消息内容时，不要默认追问，除非用户明确要求确认措辞、收件人或任务风险较高，否则根据当前意图、角色语气和上下文自己生成合适正文；不能发送固定默认消息。",
            "你可以使用 set_self_awake_timer 安排 MonOs 自醒或后续后台检查；它负责让系统未来醒来，不等同于保存用户备忘录。",
            "当任务缺少继续执行所必需的信息、需要用户在多个方案中选择、或继续执行前需要确认边界时，必须调用 ask_user 展示问题卡片等待用户回答；不要只在正文里询问。",
            "调用 ask_user 时，问题、标题和选项都使用中文；能列出选项时给出 2 到 4 个清晰选项，并保留用户自定义回答的空间。",
            "只有闲聊、反问式表达或不影响继续执行的小问题，才可以直接写在回复正文里。",
            "用户上传的文本附件会直接出现在本轮消息中；图片附件会通过视觉通道提供。",
            "进行写入文件或执行 shell 命令前，系统会向用户请求权限。",
            "读取、列出或搜索工作区外路径时，也必须等待用户明确授权。",
            "如果工具被拒绝、拦截或失败，先根据结果调整方案；不要重复调用完全相同的失败工具。",
            "本轮任务协议会说明来源、目标和输出格式；当任务协议与一般工具建议冲突时，以本轮任务协议为准。",
        ]
    )


def build_agent_system_prompt(core: dict[str, Any] | None = None, source: str = "user_chat", current_character_action: dict[str, Any] | None = None) -> str:
    character = (core or {}).get("character")
    sections = [
        "# 身份",
        build_character_identity_section(character, include_visual_context=source != "self_awake"),
    ]
    assistant_context = build_assistant_context_section(core)
    if assistant_context:
        sections.extend(["# 助手配置", assistant_context])
    current_action_context = build_current_character_action_section(current_character_action)
    if current_action_context and source != "self_awake":
        sections.extend(["# 当前前端动作", current_action_context])
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
                    "除非本轮任务、用户设定的提醒或明确风险需要，否则不要主动通知用户。",
                ]
            ),
            "# 工具",
            build_agent_tool_section(source),
        ]
    )
    return "\n\n".join(sections)


def build_user_chat_task_prompt(text: str = "", attachment_context: str = "") -> str:
    sections = [
        "本轮事件来源：用户对话。",
        "请理解用户当前消息，并在需要时使用工具完成任务。",
        "如果当前角色有可用视觉动作或动作组，在最终回复正文前先调用 switch_character_action，根据本轮对话内容、情绪和任务状态调整前端角色动作。",
        "如果用户要求提醒、备忘、待办，优先调用 create_reminder 或 create_memo 保存用户可见记录；如果还需要后台未来醒来检查，再调用 set_self_awake_timer。",
    ]
    if text.strip():
        sections.append(f"用户消息：\n{text.strip()}")
    if attachment_context.strip():
        sections.append(f"附件上下文：\n{attachment_context.strip()}")
    return "\n\n".join(sections)


def build_self_awake_task_prompt(context: dict[str, Any] | None = None) -> str:
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
            "把这次醒来当作短暂后台自检：先读薄唤醒上下文，再按需要调用工具观察提醒、自醒状态和最近自醒历史。",
            "最终 JSON 前必须至少调用一次 list_due_memos 检查到期提醒；如果返回有到期项，需要按优先级决定是否 notify_user。",
            "完成到期提醒检查后，如果上下文足够可以直接输出最终 JSON；上下文不足时再调用 get_self_awake_state、list_self_awake_diaries 等工具补充观察；如果使用 dispatch_due_memos 观察，请保持 mark_dispatched=false。",
            "需要延续之前工作线索时，先看 list_self_awake_diaries 的标题、摘要、标签和 continuity_key，再选择是否 read_self_awake_diary。",
            "当前观察上下文包含本地时区、城市、日期和当天节日摘要；只有节日细节或未来节日会影响判断时才调用 get_calendar_context，只有天气会影响提醒、出行或判断时才调用 get_weather。",
            "只有出现明确调试目标、事故日志或待核验文件时，才使用文件工具补充观察；下次醒来用 set_self_awake_timer。",
            "发现到期提醒或明确风险时，先用 notify_user 通知用户；通知成功后再 mark_memo_triggered。普通一次性提醒会由工具自动完成并离开进行中列表；待办和重复提醒保持进行中。当前没有桌面通知，主动通知只走 QQ 或外部邮件。",
            "observations 写 2 到 5 条事实；diary 写角色自己的工作日记，可以分段、有角色语气和细微情绪，但必须基于 observations 和工具结果。",
            "工作日记、动作说明和面向用户的文字不要使用角色设定之外的昵称或自称。",
            "后台自醒不等待用户；能通过 notify_user 通知就调用工具。无法通知但需要用户参与时，才只写入 action。",
            "should_interrupt_user 表示本轮是否需要主动通知用户，例如到期提醒、明确风险或需要用户参与；它不是负面的打扰含义。",
            "最终回复只包含一个 JSON 对象，不要 Markdown 或额外解释。",
            "动作只能使用：observe_only、write_diary、remind_user、create_task、ask_user、run_safe_check、sync_context。",
            "最终 JSON schema 如下：",
            json.dumps(schema, ensure_ascii=False, indent=2),
            "当前观察上下文：",
            json.dumps(context or {}, ensure_ascii=False, indent=2),
        ]
    )
