from __future__ import annotations

import json
from typing import Any


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
