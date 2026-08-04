from __future__ import annotations

import asyncio
from typing import Any

from mon_agent_core import AgentTool

from ..ids import now_ms
from .context import MonToolContext
from .core_access import core_call, require_core_access
from .result import text_result

HOLD_ACTION = "保持当前"
MOTION_CODES = {
    "无": "none",
    "上下跳动": "jump",
    "向前靠近": "approach",
    "向后退开": "retreat",
    "左右摇晃": "shake",
    "连续弹跳": "bounce",
    "轻微上下浮动": "float",
    "快速颤抖": "tremble",
    "垂直震动": "vertical_shake",
    "轻微下沉": "sink",
    "强调放大": "emphasize",
}
EFFECT_CODES = {
    "无": "none",
    "疑问": "question",
    "惊讶": "exclamation",
    "汗滴": "sweat",
    "爱心": "heart",
    "生气": "anger",
    "叹气": "sigh",
    "无语": "speechless",
    "低落": "gloomy",
    "困倦": "sleepy",
}


def _as_list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _action_label(action: dict[str, Any]) -> str:
    return str(action.get("name") or action.get("action_label") or action.get("intent") or action.get("id") or "").strip()


def _action_key(action: dict[str, Any]) -> str:
    return str(action.get("intent") or action.get("action_key") or action.get("name") or action.get("id") or "").strip()


def _action_image_url(action: dict[str, Any], visual_preference: str | None = None) -> str:
    static_url = str(action.get("static_image_url") or "").strip()
    dynamic_url = str(action.get("dynamic_preview_url") or "").strip()
    frames = _as_list(action.get("dynamic_frames"))
    if not dynamic_url and frames:
        dynamic_url = str(frames[0].get("file_url") or "").strip()
    if visual_preference == "dynamic":
        return dynamic_url or static_url
    return static_url or dynamic_url


def _required_chinese_choice(params: dict[str, Any], field: str, choices: dict[str, str]) -> tuple[str, str]:
    label = str(params.get(field) or "").strip()
    if not label:
        raise RuntimeError(f"缺少必填参数「{field}」。")
    if label not in choices:
        raise RuntimeError(f"「{field}」不支持“{label}”，可选值：{'、'.join(choices)}。")
    return label, choices[label]


def _action_identity(action: dict[str, Any] | None) -> str:
    if not isinstance(action, dict):
        return ""
    for key in ("id", "intent", "name", "action_key", "action_label"):
        value = str(action.get(key) or "").strip()
        if value:
            return f"{key}:{value}"
    return ""


def _same_action(left: dict[str, Any] | None, right: dict[str, Any] | None) -> bool:
    left_id = _action_identity(left)
    right_id = _action_identity(right)
    return bool(left_id and right_id and left_id == right_id)


def _current_action(context: MonToolContext) -> dict[str, Any] | None:
    return context.current_character_action if isinstance(context.current_character_action, dict) else None


def _character_action_state(
    context: MonToolContext,
    character: dict[str, Any],
    action: dict[str, Any],
    group: dict[str, Any] | None,
    group_item: dict[str, Any] | None,
    image_url: str,
    reason: str,
    source: str = "tool",
    motion: str = "none",
    effect: str = "none",
    intensity: str = "normal",
    effect_anchor: str = "head_right",
) -> dict[str, Any]:
    return {
        "sessionID": context.session_id or "",
        "characterID": character.get("id"),
        "characterName": character.get("name") or "",
        "action": action,
        "group": group,
        "groupItem": group_item,
        "imageUrl": image_url,
        "reason": reason,
        "source": source,
        "motion": motion,
        "effect": effect,
        "intensity": intensity,
        "effectAnchor": effect_anchor,
        "performanceID": f"perf_{now_ms()}",
        "time": now_ms(),
    }


def _enabled_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [action for action in actions if action.get("enabled", True) is not False]


def _match_action(action: dict[str, Any], selector: str) -> bool:
    if not selector:
        return False
    normalized = selector.strip().lower()
    candidates = {
        str(action.get("id") or "").strip().lower(),
        str(action.get("intent") or "").strip().lower(),
        str(action.get("action_key") or "").strip().lower(),
        str(action.get("name") or "").strip().lower(),
        str(action.get("action_label") or "").strip().lower(),
    }
    aliases = action.get("aliases") if isinstance(action.get("aliases"), list) else []
    candidates.update(str(alias or "").strip().lower() for alias in aliases)
    return normalized in candidates


async def _load_character_action_data(context: MonToolContext) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    character = context.character if isinstance(context.character, dict) else None
    if not character or not character.get("id"):
        core, token = require_core_access(context)
        assistant = await asyncio.to_thread(core_call, core.get_current_assistant, token)
        character = assistant.get("character") if isinstance(assistant, dict) and isinstance(assistant.get("character"), dict) else None
    if not character or not character.get("id"):
        raise RuntimeError("当前助手没有绑定可读取的角色。")

    actions = _as_list(character.get("visual_actions"))
    if context.core_client and context.core_token:
        core, token = require_core_access(context)
        try:
            actions = await asyncio.to_thread(core_call, core.list_character_visual_actions, token, character["id"])
        except Exception:
            if not actions:
                raise
    return character, _enabled_actions(actions)


def _format_current_action(current: dict[str, Any] | None) -> str:
    if not current:
        return "当前角色动作：未知。"
    action = current.get("action") if isinstance(current.get("action"), dict) else {}
    group = current.get("group") if isinstance(current.get("group"), dict) else {}
    return "\n".join(
        [
            f"当前角色动作：{_action_label(action) or current.get('actionName') or '-'}",
            f"   意图: {action.get('intent') or current.get('intent') or '-'} | 图片: {current.get('imageUrl') or _action_image_url(action) or '-'}",
            f"   动作组: {group.get('name') or '-'} | 来源: {current.get('source') or '-'}",
            f"   最近小动作: {current.get('motion') or 'none'} | 最近特效: {current.get('effect') or 'none'}",
        ]
    )


def _format_actions(actions: list[dict[str, Any]], current: dict[str, Any] | None = None) -> str:
    if not actions:
        return "暂无可用角色动作。"
    current_action = current.get("action") if isinstance(current, dict) and isinstance(current.get("action"), dict) else None
    lines = []
    for action in actions:
        image = _action_image_url(action)
        marker = " [当前]" if _same_action(action, current_action) else ""
        lines.append(
            "\n".join(
                [
                    f"#{action.get('id')} {_action_label(action)}{marker}",
                    f"   意图: {action.get('intent') or '-'} | 图片: {'有' if image else '无'} | 动态: {'有' if action.get('has_dynamic') else '无'} | Spine: {'有' if action.get('has_spine') or action.get('spine') else '无'}",
                    f"   说明: {action.get('description') or '-'}",
                ]
            )
        )
    return "\n\n".join(lines)


def create_character_action_tools(context: MonToolContext) -> list[AgentTool]:
    async def list_character_actions_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        character, actions = await _load_character_action_data(context)
        current = _current_action(context)
        body = "\n\n".join(
            [
                f"当前角色：{character.get('name') or character.get('id')}",
                _format_current_action(current),
                f"可用立绘动作（也可以明确选择“{HOLD_ACTION}”）：",
                _format_actions(actions, current),
            ]
        )
        return text_result(body, {"character": character, "current": current, "actions": actions})

    async def switch_character_action_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        if not context.emit_event:
            raise RuntimeError("当前运行环境不能向前端发送角色动作事件。")
        character, actions = await _load_character_action_data(context)
        selector = str(params.get("立绘动作") or "").strip()
        if not selector:
            raise RuntimeError("缺少必填参数「立绘动作」。")
        motion_label, motion = _required_chinese_choice(params, "立绘动效", MOTION_CODES)
        effect_label, effect = _required_chinese_choice(params, "表情符号", EFFECT_CODES)
        selected_group = None
        group_item = None
        image_url = ""
        current = _current_action(context)
        if selector == HOLD_ACTION:
            action = current.get("action") if isinstance(current, dict) and isinstance(current.get("action"), dict) else {}
            selected_group = current.get("group") if isinstance(current, dict) and isinstance(current.get("group"), dict) else None
            group_item = current.get("groupItem") if isinstance(current, dict) and isinstance(current.get("groupItem"), dict) else None
            image_url = str((current or {}).get("imageUrl") or "").strip()
        else:
            action = next((item for item in actions if _match_action(item, selector)), None)
        if not action:
            available = "、".join(filter(None, (_action_label(item) for item in actions))) or "暂无"
            raise RuntimeError(f"没有找到立绘动作“{selector}”。可用立绘动作：{available}；或选择“{HOLD_ACTION}”。")
        if not image_url:
            image_url = _action_image_url(action, str(character.get("visual_preference") or "static"))
        current_action = current.get("action") if isinstance(current, dict) else None
        if (
            _same_action(action, current_action)
            and str((current or {}).get("motion") or "none") == motion
            and str((current or {}).get("effect") or "none") == effect
        ):
            return text_result(
                "角色动作状态没有变化，保持当前显示。",
                {"unchanged": True, "current": current},
            )
        state = _character_action_state(
            context,
            character,
            action,
            selected_group,
            group_item,
            image_url,
            "智能体自主选择角色表现",
            motion=motion,
            effect=effect,
            intensity="normal",
            effect_anchor="head_right",
        )
        context.current_character_action = state
        if context.set_character_action:
            context.set_character_action(state)
        event = {
            "type": "character.action.changed",
            "properties": state,
        }
        context.emit_event(event)
        summary = [f"立绘动作：{selector if selector == HOLD_ACTION else _action_label(action)}"]
        if image_url and selector != HOLD_ACTION:
            summary.append(f"图片: {image_url}")
        summary.append(f"表情符号：{effect_label}")
        summary.append(f"立绘动效：{motion_label}")
        return text_result(
            "\n".join(summary),
            event["properties"],
        )

    return [
        AgentTool(
            "list_character_actions",
            "读取角色动作",
            "读取当前助手绑定角色的可用立绘动作和动作组。",
            {"type": "object", "properties": {}},
            list_character_actions_execute,
        ),
        AgentTool(
            "switch_character_action",
            "选择角色表现",
            "在回复正文前提交与本轮语气匹配的角色表现。情绪化或角色化表达应主动调用；三个中文字段必须完整提供。",
            {
                "type": "object",
                "properties": {
                    "立绘动作": {
                        "type": "string",
                        "description": "当前角色实际拥有的立绘动作名称；不切换图片时填写“保持当前”。",
                    },
                    "表情符号": {
                        "type": "string",
                        "description": "叠加在角色附近并短暂显示的中文表情符号。",
                        "enum": list(EFFECT_CODES),
                    },
                    "立绘动效": {
                        "type": "string",
                        "description": "让静态立绘整体摇晃、跳动、靠近或点头的中文动效。",
                        "enum": list(MOTION_CODES),
                    },
                },
                "required": ["立绘动作", "表情符号", "立绘动效"],
                "additionalProperties": False,
            },
            switch_character_action_execute,
            execution_mode="sequential",
        ),
    ]
