from __future__ import annotations

import asyncio
import random
from typing import Any

from mon_agent_core import AgentTool

from ..ids import now_ms
from .context import MonToolContext
from .core_access import core_call, require_core_access
from .result import text_result

MOTIONS = {"none", "jump", "approach", "retreat", "shake", "nod", "bounce"}
EFFECTS = {"none", "question", "exclamation", "sweat", "heart", "anger"}
INTENSITIES = {"light", "normal", "strong"}
EFFECT_ANCHORS = {"head_left", "head_right", "above", "body_left", "body_right"}


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


def _clean_choice(value: Any, allowed: set[str], default: str = "none") -> str:
    text = str(value or default).strip().lower()
    return text if text in allowed else default


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


def _match_group(group: dict[str, Any], selector: str) -> bool:
    if not selector:
        return False
    normalized = selector.strip().lower()
    candidates = {
        str(group.get("id") or "").strip().lower(),
        str(group.get("trigger") or "").strip().lower(),
        str(group.get("name") or "").strip().lower(),
    }
    return normalized in candidates


def _choose_group_action(group: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    items = [item for item in _as_list(group.get("items")) if item.get("enabled", True) is not False]
    if not items:
        return None, None
    mode = str(group.get("selection_mode") or "weighted_random")
    if mode == "first" or mode == "sequence":
        item = sorted(items, key=lambda value: (int(value.get("priority") or 100), int(value.get("id") or 0)))[0]
        return item.get("action") if isinstance(item.get("action"), dict) else None, item
    weights = [max(int(item.get("weight") or 1), 1) for item in items]
    item = random.choices(items, weights=weights, k=1)[0]
    return item.get("action") if isinstance(item.get("action"), dict) else None, item


async def _load_character_action_data(context: MonToolContext) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    character = context.character if isinstance(context.character, dict) else None
    if not character or not character.get("id"):
        core, token = require_core_access(context)
        assistant = await asyncio.to_thread(core_call, core.get_default_assistant, token)
        character = assistant.get("character") if isinstance(assistant, dict) and isinstance(assistant.get("character"), dict) else None
    if not character or not character.get("id"):
        raise RuntimeError("当前默认助手没有绑定可读取的角色。")

    actions = _as_list(character.get("visual_actions"))
    groups = _as_list(character.get("visual_action_groups"))
    if context.core_client and context.core_token:
        core, token = require_core_access(context)
        try:
            actions = await asyncio.to_thread(core_call, core.list_character_visual_actions, token, character["id"])
            groups = await asyncio.to_thread(core_call, core.list_character_visual_action_groups, token, character["id"])
        except Exception:
            if not actions:
                raise
    return character, _enabled_actions(actions), [group for group in groups if group.get("enabled", True) is not False]


def _format_current_action(current: dict[str, Any] | None) -> str:
    if not current:
        return "当前前端显示动作：未知。"
    action = current.get("action") if isinstance(current.get("action"), dict) else {}
    group = current.get("group") if isinstance(current.get("group"), dict) else {}
    return "\n".join(
        [
            f"当前前端显示动作：{_action_label(action) or current.get('actionName') or '-'}",
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
                    f"   意图: {action.get('intent') or '-'} | 图片: {'有' if image else '无'} | 动态: {'有' if action.get('has_dynamic') else '无'}",
                    f"   说明: {action.get('description') or '-'}",
                ]
            )
        )
    return "\n\n".join(lines)


def _format_groups(groups: list[dict[str, Any]]) -> str:
    if not groups:
        return "暂无可用动作组。"
    lines = []
    for group in groups:
        actions = []
        for item in _as_list(group.get("items")):
            action = item.get("action") if isinstance(item.get("action"), dict) else {}
            if action:
                actions.append(_action_label(action))
        lines.append(
            f"#{group.get('id')} {group.get('name')} | 触发: {group.get('trigger')} | 选择: {group.get('selection_mode')} | 动作: {', '.join(actions) or '-'}"
        )
    return "\n".join(lines)


def create_character_action_tools(context: MonToolContext) -> list[AgentTool]:
    async def list_character_actions_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        character, actions, groups = await _load_character_action_data(context)
        current = _current_action(context)
        body = "\n\n".join(
            [
                f"当前角色：{character.get('name') or character.get('id')}",
                _format_current_action(current),
                "可用动作：",
                _format_actions(actions, current),
                "动作组：",
                _format_groups(groups),
            ]
        )
        return text_result(body, {"character": character, "current": current, "actions": actions, "groups": groups})

    async def switch_character_action_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        if not context.emit_event:
            raise RuntimeError("当前运行环境不能向前端发送角色动作事件。")
        character, actions, groups = await _load_character_action_data(context)
        selector = str(params.get("action") or params.get("action_id") or params.get("intent") or params.get("name") or "").strip()
        group_selector = str(params.get("group") or params.get("group_id") or params.get("trigger") or "").strip()
        motion = _clean_choice(params.get("motion"), MOTIONS)
        effect = _clean_choice(params.get("effect"), EFFECTS)
        intensity = _clean_choice(params.get("intensity"), INTENSITIES, "normal")
        effect_anchor = _clean_choice(params.get("effect_anchor") or params.get("effectAnchor"), EFFECT_ANCHORS, "head_right")
        if not selector and not group_selector and motion == "none" and effect == "none":
            raise RuntimeError("请至少提供 action/group/motion/effect 之一，用于切换立绘或播放角色表现。")
        selected_group = next((group for group in groups if _match_group(group, group_selector)), None) if group_selector else None
        group_item = None
        image_url = ""
        if selected_group:
            action, group_item = _choose_group_action(selected_group)
        elif selector:
            action = next((item for item in actions if _match_action(item, selector)), None)
        else:
            current = _current_action(context)
            action = current.get("action") if isinstance(current, dict) and isinstance(current.get("action"), dict) else {}
            image_url = str((current or {}).get("imageUrl") or "").strip()
        if not action:
            raise RuntimeError("没有找到匹配的角色动作。请先调用 list_character_actions 查看可用动作。")
        if not image_url:
            image_url = _action_image_url(action, str(character.get("visual_preference") or "static"))
        reason = str(params.get("reason") or "").strip()
        state = _character_action_state(
            context,
            character,
            action,
            selected_group,
            group_item,
            image_url,
            reason,
            motion=motion,
            effect=effect,
            intensity=intensity,
            effect_anchor=effect_anchor,
        )
        context.current_character_action = state
        if context.set_character_action:
            context.set_character_action(state)
        event = {
            "type": "character.action.changed",
            "properties": state,
        }
        context.emit_event(event)
        summary = [f"已切换角色动作：{_action_label(action)}" if selector or group_selector else "已播放角色表现。"]
        if image_url and (selector or group_selector):
            summary.append(f"图片: {image_url}")
        if motion != "none":
            summary.append(f"小动作: {motion}")
        if effect != "none":
            summary.append(f"特效: {effect} ({effect_anchor})")
        return text_result(
            "\n".join(summary),
            event["properties"],
        )

    return [
        AgentTool(
            "list_character_actions",
            "读取角色动作",
            "读取当前默认助手绑定角色的可用立绘动作和动作组。",
            {"type": "object", "properties": {}},
            list_character_actions_execute,
        ),
        AgentTool(
            "switch_character_action",
            "切换角色动作",
            "统一控制当前前端角色表现：可切换立绘动作，也可播放小动作和头顶/身侧特效。action/group/motion/effect 至少提供一个。",
            {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "动作名称、意图、别名或 ID。"},
                    "intent": {"type": "string", "description": "内置动作意图，如 idle、talk、think、happy。"},
                    "action_id": {"type": "number", "description": "动作 ID。"},
                    "group": {"type": "string", "description": "动作组名称、触发场景或 ID。"},
                    "trigger": {"type": "string", "description": "动作组触发场景，如 idle、click、slow_walk、drag。"},
                    "group_id": {"type": "number", "description": "动作组 ID。"},
                    "motion": {
                        "type": "string",
                        "description": "不换图时也可播放的小动作。",
                        "enum": ["none", "jump", "approach", "retreat", "shake", "nod", "bounce"],
                    },
                    "effect": {
                        "type": "string",
                        "description": "叠加在角色附近的短特效。",
                        "enum": ["none", "question", "exclamation", "sweat", "heart", "anger"],
                    },
                    "intensity": {"type": "string", "enum": ["light", "normal", "strong"], "description": "小动作/特效强度。"},
                    "effect_anchor": {
                        "type": "string",
                        "enum": ["head_left", "head_right", "above", "body_left", "body_right"],
                        "description": "特效锚点位置。",
                    },
                    "reason": {"type": "string", "description": "切换原因，供前端调试显示。"},
                },
            },
            switch_character_action_execute,
            execution_mode="sequential",
        ),
    ]
