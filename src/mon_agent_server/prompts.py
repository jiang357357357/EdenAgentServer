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
                "后台自醒不等待用户；需要用户参与时，把意图写进最终 JSON 的 action 字段。",
                "工具被拒绝、拦截或失败后，根据结果调整判断，不重复调用相同失败工具。",
            ]
        )
    return "\n".join(
        [
            "工具是你观察和完成任务的方式，不是你对外表达的身份。",
            "你可以使用工具读取、搜索和修改当前工作区文件。",
            "进行写入文件或执行 shell 命令前，系统会向用户请求权限。",
            "读取、列出或搜索工作区外路径时，也必须等待用户明确授权。",
            "如果工具被拒绝、拦截或失败，先根据结果调整方案；不要重复调用完全相同的失败工具。",
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
        "如果用户要求提醒、备忘、待办，优先保存用户可见记录；如果还需要后台未来醒来检查，再安排后续唤醒。",
    ]
    if text.strip():
        sections.append(f"用户消息：\n{text.strip()}")
    if attachment_context.strip():
        sections.append(f"附件上下文：\n{attachment_context.strip()}")
    return "\n\n".join(sections)


def build_self_awake_decision(context: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "mood": "calm",
        "current_desire": "观察当前上下文，等待更完整的 Python 自醒策略接入。",
        "should_interrupt_user": False,
        "action": {"type": "observe_only", "message": "Python Agent Server 已收到自醒请求。", "payload": {}},
        "next_wake": {"after_minutes": 720, "reason": "当前 Python 迁移版先保持低频观察。"},
        "diary": {
            "title": "Python Agent Server 自醒占位记录",
            "content": "服务端已切换到 Python，当前自醒逻辑保持兼容返回，后续会接入完整 AgentCore 决策。",
        },
        "source": "python_server_compat",
        "context_echo": context or {},
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
