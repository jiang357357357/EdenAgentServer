from __future__ import annotations

import json
from typing import Any


def build_character_identity_section(character: dict[str, Any] | None = None) -> str:
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
        lines.append(f"角色签名：{character['signature']}")
    if character.get("description"):
        lines.append(f"角色描述：{character['description']}")
    return "\n".join(lines)


def build_agent_tool_section(source: str = "user_chat") -> str:
    if source == "self_awake":
        return "\n".join(
            [
                "本轮是后台自醒，只使用和观察、提醒派发、备忘录维护、下次唤醒有关的工具。",
                "优先使用观察上下文里的 self_diary、workspace、system_health、policy 等摘要；没有明确调试目标时，不浏览工作区文件。",
                "如果需要处理到期提醒，使用 dispatch_due_memos，并在确认派发后标记，避免重复提醒。",
                "如果需要安排下一次后台醒来，使用 set_self_awake_timer；它只负责唤醒，不等同于保存备忘录。",
                "后台自醒不等待用户；需要用户参与时，把意图写进最终 JSON 的 action 字段。",
                "工具被拒绝、拦截或失败后，根据结果调整判断，不重复调用相同失败工具。",
            ]
        )
    return "\n".join(
        [
            "工具是你观察和完成任务的方式，不是你对外表达的身份。",
            "你可以使用工具读取、搜索和修改当前工作区文件。",
            "你可以使用 web_search 搜索实时网页信息，使用 web_fetch 抓取网页正文，使用 analyze_image 分析图片，使用 analyze_screen 在用户授权后分析当前屏幕。",
            "你可以使用 ask_user 向用户确认关键信息；如果本轮任务声明为后台或非交互任务，不要调用 ask_user 等待用户。",
            "你可以使用 create_memo/create_reminder/list_memos/complete_memo/snooze_memo 管理用户备忘录、提醒和待办；当用户说“提醒我”“记一下”“待办”时优先使用这些工具。",
            "你可以使用 dispatch_due_memos 派发已到期提醒，使用 get_next_memo_wake 取得下一次提醒唤醒时间；list_due_memos 仅用于兼容查询。",
            "派发提醒后，确认已经对用户产生提醒或记录动作时，使用 mark_memo_triggered 或 dispatch_due_memos 的 mark_dispatched 标记，避免后台重复提醒。",
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


def build_agent_system_prompt(core: dict[str, Any] | None = None, source: str = "user_chat") -> str:
    character = (core or {}).get("character")
    return "\n\n".join(
        [
            "# 身份",
            build_character_identity_section(character),
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


def build_user_chat_task_prompt(text: str = "", attachment_context: str = "") -> str:
    sections = [
        "本轮事件来源：用户对话。",
        "请理解用户当前消息，并在需要时使用工具完成任务。",
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
            "把这次醒来当作短暂后台自检：读上下文，判断提醒、风险和连续工作线索；上下文足够时直接输出最终 JSON。",
            "只有出现明确调试目标、事故日志或待核验文件时，才使用工具补充观察；到期提醒优先调用 dispatch_due_memos，下次醒来用 set_self_awake_timer。",
            "observations 写 2 到 5 条事实；diary 写角色自己的工作日记，可以分段、有角色语气和细微情绪，但必须基于 observations 和工具结果。",
            "工作日记、动作说明和面向用户的文字使用本地时间；不要使用角色设定之外的昵称或自称。",
            "后台自醒不等待用户；需要通知或需要用户参与时，只写入 action。",
            "should_interrupt_user 表示本轮是否需要主动通知用户，例如到期提醒、明确风险或需要用户参与；它不是负面的打扰含义。",
            "最终回复只包含一个 JSON 对象，不要 Markdown 或额外解释。",
            "动作只能使用：observe_only、write_diary、remind_user、create_task、ask_user、run_safe_check、sync_context。",
            "最终 JSON schema 如下：",
            json.dumps(schema, ensure_ascii=False, indent=2),
            "当前观察上下文：",
            json.dumps(context or {}, ensure_ascii=False, indent=2),
        ]
    )


def parse_self_awake_decision(text: str) -> dict[str, Any]:
    fenced = None
    if "```" in text:
        parts = text.split("```")
        if len(parts) >= 3:
            fenced = parts[1]
            if fenced.lstrip().lower().startswith("json"):
                fenced = fenced.lstrip()[4:]
    source = fenced or text
    start = source.find("{")
    end = source.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("自醒模型未返回 JSON 对象")
    data = json.loads(source[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("自醒模型返回的不是 JSON 对象")
    return sanitize_self_awake_decision(data)


def sanitize_self_awake_decision(raw: dict[str, Any]) -> dict[str, Any]:
    allowed_actions = {"observe_only", "write_diary", "remind_user", "create_task", "ask_user", "run_safe_check", "sync_context"}
    action = raw.get("action") if isinstance(raw.get("action"), dict) else {}
    next_wake = raw.get("next_wake") if isinstance(raw.get("next_wake"), dict) else {}
    diary = raw.get("diary") if isinstance(raw.get("diary"), dict) else {}
    observations = raw.get("observations")
    action_type = str(action.get("type") or "write_diary")
    try:
        after_minutes = int(float(next_wake.get("after_minutes") or 720))
    except (TypeError, ValueError):
        after_minutes = 720
    return {
        "mood": str(raw.get("mood") or "安静观察"),
        "current_desire": str(raw.get("current_desire") or "想先观察当前状态，不急着通知用户。"),
        "observations": [str(item).strip() for item in observations[:8] if str(item).strip()] if isinstance(observations, list) else [],
        "should_interrupt_user": bool(raw.get("should_interrupt_user")),
        "action": {
            "type": action_type if action_type in allowed_actions else "write_diary",
            "message": str(action.get("message") or "记录这次后台自醒判断。"),
            "payload": action.get("payload") if isinstance(action.get("payload"), dict) else {},
        },
        "next_wake": {
            "after_minutes": max(1, min(after_minutes, 7 * 24 * 60)),
            "reason": str(next_wake.get("reason") or "当前没有紧急问题，稍后再醒来观察。"),
        },
        "diary": {
            "title": str(diary.get("title") or "一次后台自醒"),
            "content": str(diary.get("content") or "我完成了一次后台自醒。当前没有必须通知用户的事项，因此选择记录状态并安排下一次醒来。"),
        },
        "source": "fallback" if raw.get("source") == "fallback" else "agent",
        "error": str(raw.get("error") or ""),
    }


def fallback_self_awake_decision(
    context: dict[str, Any] | None = None,
    reason: str = "",
    character: dict[str, Any] | None = None,
) -> dict[str, Any]:
    name = str((character or {}).get("name") or "我")
    user_activity = (context or {}).get("user_activity")
    activity_text = str(user_activity).strip() if isinstance(user_activity, str) and user_activity.strip() else "暂未观察到明确的新活动。"
    return {
        "mood": "安静、谨慎",
        "current_desire": "想先保持观察，确认系统和用户状态是否稳定。",
        "observations": ["本轮自醒 Agent 调用失败，已进入保守 fallback。", activity_text],
        "should_interrupt_user": False,
        "action": {"type": "write_diary", "message": "模型自醒暂不可用，先写入保守日记并稍后重试。", "payload": {"fallback_reason": reason}},
        "next_wake": {"after_minutes": 720, "reason": "当前没有足够可靠的模型判断，12 小时后再次尝试自醒。"},
        "diary": {
            "title": "一次保守的自醒",
            "content": f"{name}尝试进行后台自醒，但模型判断暂不可用。当前观察：{activity_text} 因此我选择不通知用户，只记录这次状态。",
        },
        "source": "fallback",
        "error": reason,
    }


def attachment_context(files: list[dict[str, Any]], images_provided_to_model: bool = True) -> str:
    if not files:
        return ""
    sections: list[str] = []
    for index, file in enumerate(files, start=1):
        filename = file.get("filename") or f"附件-{index}"
        mime = file.get("mime") or "application/octet-stream"
        size_text = f"，大小 {file['size']} bytes" if isinstance(file.get("size"), int) else ""
        if str(mime).startswith("image/"):
            sections.append(
                f"### 附件 {index}: {filename}\n类型: {mime}{size_text}\n说明: 这是图片附件，"
                + ("已通过视觉通道提供给模型。" if images_provided_to_model else "当前对话模型不支持直接看图。")
            )
        elif str(file.get("url") or "").startswith("data:"):
            sections.append(f"### 附件 {index}: {filename}\n类型: {mime}{size_text}\n内容以 data URL 提供，长度 {len(file.get('url') or '')}。")
        else:
            sections.append(f"### 附件 {index}: {filename}\n类型: {mime}{size_text}\n位置: {file.get('url') or ''}")
    return "用户本轮上传了以下附件：\n\n" + "\n\n".join(sections)


def dump_context(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
