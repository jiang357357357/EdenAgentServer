from __future__ import annotations

from typing import Any

from .datetime_utils import format_local_datetime, to_local_iso
from .result import compact_text


def memo_with_local_time(memo: dict[str, Any]) -> dict[str, Any]:
    return {
        **memo,
        "remind_at_local": format_local_datetime(memo.get("remind_at")),
        "due_at_local": format_local_datetime(memo.get("due_at")),
        "trigger_at_local": format_local_datetime(memo.get("trigger_at") or memo.get("remind_at") or memo.get("due_at")),
        "snoozed_until_local": format_local_datetime(memo.get("snoozed_until")),
        "last_triggered_at_local": format_local_datetime(memo.get("last_triggered_at")),
    }


def memo_line(memo: dict[str, Any]) -> str:
    trigger = format_local_datetime(memo.get("trigger_at") or memo.get("remind_at") or memo.get("due_at"))
    content = f"\n   {memo.get('content')}" if memo.get("content") else ""
    return "\n".join(
        [
            f"#{memo.get('id')} {memo.get('title')}",
            f"   类型: {memo.get('kind')} | 状态: {memo.get('status')} | 优先级: {memo.get('priority')}",
            f"   触发/截止（本地时间）: {trigger}",
            content,
        ]
    ).strip()


def self_awake_diary_summary(diary: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": diary.get("id"),
        "run_id": diary.get("run_id") or diary.get("run"),
        "title": diary.get("title") or "",
        "summary": compact_text(diary.get("summary") or diary.get("content_excerpt") or "", 700),
        "content_excerpt": compact_text(diary.get("content_excerpt") or "", 480),
        "tags": diary.get("tags") if isinstance(diary.get("tags"), list) else [],
        "importance": diary.get("importance") or "",
        "continuity_key": diary.get("continuity_key") or "",
        "created_at": to_local_iso(diary.get("created_at")),
        "updated_at": to_local_iso(diary.get("updated_at")),
    }


def self_awake_diary_line(diary: dict[str, Any]) -> str:
    tags = diary.get("tags") if isinstance(diary.get("tags"), list) else []
    tag_text = ", ".join(str(tag) for tag in tags) if tags else "-"
    return "\n".join(
        [
            f"#{diary.get('id')} {diary.get('title') or '未命名日记'}",
            f"   时间: {format_local_datetime(diary.get('created_at'))}",
            f"   重要性: {diary.get('importance') or '-'} | 连续性: {diary.get('continuity_key') or '-'}",
            f"   标签: {tag_text}",
            f"   摘要: {diary.get('summary') or diary.get('content_excerpt') or '-'}",
        ]
    )


def format_memo_list(title: str, memos: list[dict[str, Any]]) -> str:
    if not memos:
        return f"{title}\n暂无记录。"
    return f"{title}\n\n" + "\n\n".join(memo_line(memo) for memo in memos)
