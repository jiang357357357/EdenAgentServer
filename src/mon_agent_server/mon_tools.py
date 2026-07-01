from __future__ import annotations

import asyncio
import base64
import html
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from mon_agent_core import AgentTool
from mon_agent_core.coding_agent.tools import create_all_tools

from .brokers import PermissionBroker, QuestionBroker
from .core import CoreClient, to_storage_iso
from .ids import now_ms


@dataclass(slots=True)
class MonToolContext:
    session_id: str | None = None
    core_client: CoreClient | None = None
    core_token: str | None = None
    permissions: PermissionBroker | None = None
    questions: QuestionBroker | None = None
    current_model_supports_images: bool = True
    vision_config: dict[str, Any] | None = None
    get_message_id: Callable[[], str | None] | None = None
    get_current_files: Callable[[], list[dict[str, Any]]] | None = None


def text_result(content: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": content}]}
    if details is not None:
        result["details"] = details
    return result


def truncate(content: str, max_chars: int = 24_000) -> str:
    if len(content) <= max_chars:
        return content
    return f"{content[:max_chars]}\n\n[输出已截断，原始长度 {len(content)}]"


def format_local_datetime(value: Any) -> str:
    if not value:
        return "-"
    if isinstance(value, (int, float)):
        dt = datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    elif isinstance(value, datetime):
        dt = value
    else:
        raw = str(value).strip()
        if not raw:
            return "-"
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return raw
    return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def parse_local_datetime(value: str) -> datetime:
    raw = value.strip()
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return parsed


def normalize_memo_date(value: Any, field: str) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是日期时间字符串。")
    try:
        return to_storage_iso(parse_local_datetime(value).timestamp() * 1000)
    except ValueError as error:
        raise ValueError(f"无法解析 {field}: {value}") from error


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


def format_memo_list(title: str, memos: list[dict[str, Any]]) -> str:
    if not memos:
        return f"{title}\n暂无记录。"
    return f"{title}\n\n" + "\n\n".join(memo_line(memo) for memo in memos)


def require_core_access(context: MonToolContext) -> tuple[CoreClient, str]:
    if not context.core_client or not context.core_token:
        raise RuntimeError("该工具需要 Core 登录态。请确认本轮请求携带 Core Token。")
    return context.core_client, context.core_token


def html_to_text(value: str) -> str:
    text = re.sub(r"<(script|style|noscript)\b[^>]*>[\s\S]*?</\1>", "\n", value, flags=re.I)
    text = re.sub(r"<(br|p|div|section|article|li|tr|h[1-6])\b[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def html_title(value: str) -> str | None:
    match = re.search(r"<title\b[^>]*>([\s\S]*?)</title>", value, re.I)
    if not match:
        return None
    return html.unescape(re.sub(r"<[^>]+>", " ", match.group(1)).strip())


def normalize_duck_url(raw_url: str) -> str:
    decoded = html.unescape(raw_url.strip())
    if decoded.startswith("//"):
        decoded = f"https:{decoded}"
    try:
        parsed = urllib.parse.urlparse(decoded)
        query = urllib.parse.parse_qs(parsed.query)
        if query.get("uddg"):
            return query["uddg"][0]
    except Exception:
        pass
    return decoded


def parse_duck_results(raw: str, max_results: int) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    for block in re.split(r'<div class="result results_links', raw, flags=re.I)[1:]:
        title_match = re.search(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>', block, re.I)
        if not title_match:
            continue
        title = re.sub(r"\s+", " ", html_to_text(title_match.group(2))).strip()
        url = normalize_duck_url(title_match.group(1))
        if not title or not url:
            continue
        snippet_match = re.search(r'<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)</a>', block, re.I)
        host_match = re.search(r'<a[^>]+class="result__url"[^>]*>([\s\S]*?)</a>', block, re.I)
        results.append(
            {
                "title": title,
                "url": url,
                "snippet": re.sub(r"\s+", " ", html_to_text(snippet_match.group(1))).strip() if snippet_match else "",
                "hostname": re.sub(r"\s+", " ", html_to_text(host_match.group(1))).strip() if host_match else "",
            }
        )
        if len(results) >= max_results:
            break
    return results


def web_search(query: str, max_results: int = 5, language: str | None = None, time_range: str | None = None) -> dict[str, Any]:
    params = {"q": query, "kl": language or "cn-zh", "kp": "-1"}
    if time_range:
        mapping = {"day": "d", "week": "w", "month": "m", "year": "y"}
        params["df"] = mapping.get(time_range, time_range)
    url = f"https://html.duckduckgo.com/html/?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "accept": "text/html,application/xhtml+xml",
            "accept-language": language or "zh-CN,zh;q=0.9,en;q=0.6",
            "user-agent": "Mozilla/5.0 MonAgent/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read().decode("utf-8", errors="replace")
    if re.search(r"anomalyDetectionBlock|detected an anomaly|captcha", raw, re.I):
        raise RuntimeError("DuckDuckGo 拒绝了本次搜索请求，可能是短时间请求过多或网络出口被限制。")
    return {"endpoint": url, "results": parse_duck_results(raw, max_results)}


def fetch_web_page(url_text: str) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url_text)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"只支持 http/https URL: {url_text}")
    request = urllib.request.Request(
        url_text,
        headers={"accept": "text/html, text/plain, application/json;q=0.9, */*;q=0.2", "user-agent": "MonAgent/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read().decode("utf-8", errors="replace")
        content_type = response.headers.get("content-type", "")
        final_url = response.url
    body = html_to_text(raw) if "html" in content_type else raw
    return {"url": final_url, "contentType": content_type, "title": html_title(raw) if "html" in content_type else None, "body": body}


def find_mon_root(workspace_root: Path) -> Path:
    current = workspace_root.resolve()
    for _ in range(8):
        if (current / "Backend" / "BaseOs" / ".monconfig").exists():
            return current
        if current.parent == current:
            break
        current = current.parent
    raise RuntimeError(f"无法从工作区定位 Mon 根目录: {workspace_root}")


def read_ini_value(content: str, section: str, key: str) -> str | None:
    current_section = ""
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current_section = line[1:-1].strip()
            continue
        if current_section != section or "=" not in line:
            continue
        item_key, value = line.split("=", 1)
        if item_key.strip() == key:
            return value.strip()
    return None


def resolve_self_awake_state_path(workspace_root: Path) -> dict[str, Any]:
    mon_root = find_mon_root(workspace_root)
    base_os_root = mon_root / "Backend" / "BaseOs"
    config_path = base_os_root / ".monconfig"
    content = config_path.read_text(encoding="utf-8", errors="replace") if config_path.exists() else ""
    data_dir = read_ini_value(content, "self_awake", "DATA_DIR") or "Data/SelfAwake"
    data_path = Path(data_dir)
    state_path = data_path if data_path.suffix == ".json" else data_path / "state.json"
    if not state_path.is_absolute():
        state_path = base_os_root / state_path
    return {
        "state_path": state_path,
        "min_minutes": int(read_ini_value(content, "self_awake", "MIN_WAKE_MINUTES") or 1),
        "max_minutes": int(read_ini_value(content, "self_awake", "MAX_WAKE_MINUTES") or 1440),
    }


def resolve_wake_time(input_value: dict[str, Any], min_minutes: int, max_minutes: int) -> tuple[datetime, int]:
    current = datetime.now().astimezone()
    if input_value.get("at"):
        target = parse_local_datetime(str(input_value["at"]))
        after_minutes = int((target - current).total_seconds() // 60)
        if after_minutes < min_minutes:
            raise ValueError(f"自醒时间过近，至少需要 {min_minutes} 分钟后。")
        if after_minutes > max_minutes:
            raise ValueError(f"自醒时间过远，最多允许 {max_minutes} 分钟后。")
        return target, after_minutes
    raw_minutes = int(round(float(input_value.get("after_minutes") or 720)))
    after_minutes = min(max(raw_minutes, min_minutes), max_minutes)
    return current + timedelta(minutes=after_minutes), after_minutes


async def maybe_ask_outside_workspace(
    workspace_root: Path,
    target: str,
    context: MonToolContext,
    tool_name: str,
    tool_call_id: str,
    action: str,
) -> Path:
    resolved = Path(target).expanduser().resolve()
    try:
        resolved.relative_to(workspace_root.resolve())
        return resolved
    except ValueError:
        pass
    permission = "访问工作区外路径"
    pattern = str(resolved)
    if context.permissions and context.permissions.is_always_allowed(permission, pattern):
        return resolved
    if not context.permissions or not context.session_id:
        raise RuntimeError(f"读取工作区外路径需要授权: {target}")
    reply = await asyncio.to_thread(
        context.permissions.ask,
        {
            "sessionID": context.session_id,
            "permission": permission,
            "patterns": [pattern],
            "metadata": {
                "action": action,
                "toolName": tool_name,
                "path": str(resolved),
                "workspaceRoot": str(workspace_root),
                "reason": "模型请求访问当前 MonAgent 工作区之外的路径，需要你确认。",
            },
            "tool": {"messageID": context.get_message_id(), "callID": tool_call_id}
            if context.get_message_id and context.get_message_id()
            else None,
        },
    )
    if reply == "reject":
        raise RuntimeError(f"用户拒绝访问工作区外路径: {target}")
    return resolved


def create_mon_agent_tools(workspace_root: str | Path, context: MonToolContext | None = None, profile: str = "user_chat") -> list[AgentTool]:
    context = context or MonToolContext()
    root = Path(workspace_root).resolve()
    tools: list[AgentTool] = []

    async def loaded_tools_execute(_tool_call_id: str, _params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        lines = []
        for index, tool in enumerate(tools, start=1):
            execution = f"\n   执行: {tool.execution_mode}" if tool.execution_mode else ""
            lines.append(f"{index}. {tool.name}\n   名称: {tool.label}\n   用途: {tool.description}{execution}")
        return text_result(
            "\n\n".join(lines),
            {"count": len(tools), "tools": [{"name": tool.name, "label": tool.label, "description": tool.description} for tool in tools]},
        )

    tools.append(
        AgentTool(
            name="loaded_tools",
            label="已加载工具",
            description="查看本轮 MonAgent 已注册的工具清单、用途和执行策略。",
            parameters={"type": "object", "properties": {}},
            execute=loaded_tools_execute,
        )
    )

    async def web_search_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        max_results = min(max(int(round(float(params.get("max_results") or 5))), 1), 10)
        result = await asyncio.to_thread(web_search, str(params["query"]), max_results, params.get("language"), params.get("time_range"))
        lines = [f"DuckDuckGo 搜索结果：{params['query']}"]
        for index, item in enumerate(result["results"], start=1):
            lines.append(
                "\n".join(
                    [
                        f"{index}. {item.get('title')}",
                        f"   URL: {item.get('url')}",
                        f"   摘要: {item.get('snippet')}" if item.get("snippet") else "",
                        f"   来源: {item.get('hostname')}" if item.get("hostname") else "",
                    ]
                ).strip()
            )
        return text_result(truncate("\n\n".join(lines), 20_000), {"provider": "duckduckgo", **result})

    tools.append(
        AgentTool(
            name="web_search",
            label="网页搜索",
            description="使用 DuckDuckGo 搜索实时网页信息，不需要本地搜索服务。",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词。"},
                    "max_results": {"type": "number", "description": "最多返回多少条结果，默认 5，最大 10。"},
                    "language": {"type": "string", "description": "搜索地区/语言，默认 zh-CN。"},
                    "time_range": {"type": "string", "description": "时间范围，例如 day、week、month、year。"},
                },
                "required": ["query"],
            },
            execute=web_search_execute,
        )
    )

    async def web_fetch_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        max_chars = min(max(int(round(float(params.get("max_chars") or 28_000))), 2_000), 60_000)
        result = await asyncio.to_thread(fetch_web_page, str(params["url"]))
        body = truncate(f"{'标题: ' + result['title'] + chr(10) + chr(10) if result.get('title') else ''}{result['body']}", max_chars)
        return text_result(body, {"provider": "direct", "final_url": result["url"], "content_type": result["contentType"], "max_chars": max_chars})

    tools.append(
        AgentTool(
            name="web_fetch",
            label="网页抓取",
            description="直接抓取网页并提取正文文本。",
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "要抓取的网页 URL。"},
                    "max_chars": {"type": "number", "description": "最多返回多少字符，默认 28000。"},
                },
                "required": ["url"],
            },
            execute=web_fetch_execute,
        )
    )

    async def ask_user_execute(tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        if not context.questions or not context.session_id:
            raise RuntimeError("ask_user 需要在会话运行时中调用。")
        answers = await asyncio.to_thread(
            context.questions.ask,
            {
                "sessionID": context.session_id,
                "questions": [
                    {
                        "header": params.get("header") or "需要确认",
                        "question": params["question"],
                        "options": [
                            {"label": option.get("label"), "description": option.get("description") or option.get("label")}
                            for option in params.get("options", [])
                        ],
                        "multiple": bool(params.get("multiple")),
                        "custom": params.get("allow_custom", True),
                    }
                ],
                "tool": {"messageID": context.get_message_id(), "callID": tool_call_id}
                if context.get_message_id and context.get_message_id()
                else None,
            },
        )
        if answers is None:
            raise RuntimeError("用户暂不处理该问题。")
        flattened = [item for group in answers for item in group if item]
        return text_result("\n".join(flattened) or "用户未提供回答。", {"answers": answers})

    tools.append(
        AgentTool(
            name="ask_user",
            label="询问用户",
            description="当缺少关键信息、需要用户选择方案或继续执行前需要确认边界时，向用户展示问题卡片并等待回答。",
            parameters={
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "要询问用户的问题。"},
                    "header": {"type": "string", "description": "问题分组标题，建议 12 个字以内。"},
                    "options": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"label": {"type": "string"}, "description": {"type": "string"}},
                            "required": ["label"],
                        },
                    },
                    "multiple": {"type": "boolean"},
                    "allow_custom": {"type": "boolean"},
                },
                "required": ["question"],
            },
            execute=ask_user_execute,
            execution_mode="sequential",
        )
    )

    def core_call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        return fn(*args, **kwargs)

    async def create_memo_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(
            core_call,
            core.create_memo,
            token,
            {
                "title": params["title"],
                "content": params.get("content") or "",
                "kind": params.get("kind") or "note",
                "priority": params.get("priority") or "normal",
                "remind_at": normalize_memo_date(params.get("remind_at"), "remind_at"),
                "due_at": normalize_memo_date(params.get("due_at"), "due_at"),
                "repeat_rule": params.get("repeat_rule") or "",
                "source": "monagent",
                "related_session_id": context.session_id or "",
                "metadata": params.get("metadata") or {},
            },
        )
        return text_result(f"已创建备忘录。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    async def create_reminder_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(
            core_call,
            core.create_memo,
            token,
            {
                "title": params["title"],
                "content": params.get("content") or "",
                "kind": "reminder",
                "priority": params.get("priority") or "normal",
                "remind_at": normalize_memo_date(params.get("remind_at"), "remind_at"),
                "source": "monagent",
                "related_session_id": context.session_id or "",
                "metadata": params.get("metadata") or {},
            },
        )
        return text_result(f"已创建提醒。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    async def list_memos_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memos = await asyncio.to_thread(
            core_call,
            core.list_memos,
            token,
            {
                "kind": params.get("kind"),
                "status": params.get("status"),
                "priority": params.get("priority"),
                "q": params.get("q"),
                "limit": min(max(int(params.get("limit") or 20), 1), 100),
            },
        )
        return text_result(format_memo_list("备忘录查询结果：", memos), {"memos": [memo_with_local_time(memo) for memo in memos], "count": len(memos)})

    async def list_due_memos_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memos = await asyncio.to_thread(
            core_call,
            core.list_due_memos,
            token,
            {
                "before": normalize_memo_date(params.get("before"), "before"),
                "limit": min(max(int(params.get("limit") or 20), 1), 100),
            },
        )
        return text_result(format_memo_list("到期提醒：", memos), {"memos": [memo_with_local_time(memo) for memo in memos], "count": len(memos)})

    async def dispatch_due_memos_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        result = await asyncio.to_thread(
            core_call,
            core.dispatch_due_memos,
            token,
            {
                "before": normalize_memo_date(params.get("before"), "before"),
                "limit": min(max(int(params.get("limit") or 20), 1), 100),
                "mark_dispatched": bool(params.get("mark_dispatched")),
            },
        )
        body = "\n\n".join(
            [
                format_memo_list("到期派发结果：", result.get("memos") or []),
                f"派发数量: {result.get('dispatched_count')}",
                f"已标记派发: {'是' if result.get('mark_dispatched') else '否'}",
                f"下一次唤醒（本地时间）: {format_local_datetime(result.get('next_wake_at'))}",
            ]
        )
        return text_result(body, result)

    async def get_next_memo_wake_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        result = await asyncio.to_thread(core_call, core.get_next_memo_wake, token, normalize_memo_date(params.get("after"), "after"))
        memo = result.get("memo") if isinstance(result, dict) else None
        body = (
            f"下一次提醒唤醒（本地时间）: {format_local_datetime(result.get('next_wake_at'))}\n\n{memo_line(memo)}"
            if memo
            else "当前没有需要安排唤醒的提醒/待办。"
        )
        return text_result(body, result if isinstance(result, dict) else {})

    async def complete_memo_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(core_call, core.complete_memo, token, int(params["id"]))
        return text_result(f"已完成备忘录。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    async def snooze_memo_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(
            core_call,
            core.snooze_memo,
            token,
            int(params["id"]),
            {"until": normalize_memo_date(params.get("until"), "until"), "minutes": params.get("minutes")},
        )
        return text_result(f"已设置稍后提醒。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    async def mark_memo_triggered_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        core, token = require_core_access(context)
        memo = await asyncio.to_thread(core_call, core.mark_memo_triggered, token, int(params["id"]))
        return text_result(f"已标记提醒触发。\n\n{memo_line(memo)}", {"memo": memo_with_local_time(memo)})

    memo_common = {
        "title": {"type": "string", "description": "简短标题。"},
        "content": {"type": "string", "description": "详细内容。"},
        "kind": {"type": "string", "description": "类型：note、reminder 或 todo。"},
        "priority": {"type": "string", "description": "优先级：low、normal 或 high。"},
        "remind_at": {"type": "string", "description": "提醒时间。"},
        "due_at": {"type": "string", "description": "截止时间。"},
        "repeat_rule": {"type": "string", "description": "重复规则。"},
        "metadata": {"type": "object", "description": "扩展数据。"},
    }
    tools.extend(
        [
            AgentTool("create_memo", "创建备忘录", "在 MonCore 创建一条用户备忘录、待办或提醒。", {"type": "object", "properties": memo_common, "required": ["title"]}, create_memo_execute, execution_mode="sequential"),
            AgentTool("create_reminder", "创建提醒", "在 MonCore 创建一条会在指定时间触发的提醒。", {"type": "object", "properties": {"title": memo_common["title"], "remind_at": memo_common["remind_at"], "content": memo_common["content"], "priority": memo_common["priority"], "metadata": memo_common["metadata"]}, "required": ["title", "remind_at"]}, create_reminder_execute, execution_mode="sequential"),
            AgentTool("list_memos", "查询备忘录", "查询当前用户的备忘录、提醒和待办。", {"type": "object", "properties": {"kind": {"type": "string"}, "status": {"type": "string"}, "priority": {"type": "string"}, "q": {"type": "string"}, "limit": {"type": "number"}}}, list_memos_execute),
            AgentTool("list_due_memos", "查询到期提醒", "查询当前时间之前应触发但尚未标记触发的提醒/待办。", {"type": "object", "properties": {"before": {"type": "string"}, "limit": {"type": "number"}}}, list_due_memos_execute),
            AgentTool("dispatch_due_memos", "派发到期提醒", "取出已到期且尚未派发的提醒/待办，并返回下一次应唤醒时间。", {"type": "object", "properties": {"before": {"type": "string"}, "limit": {"type": "number"}, "mark_dispatched": {"type": "boolean"}}}, dispatch_due_memos_execute, execution_mode="sequential"),
            AgentTool("get_next_memo_wake", "获取下一次提醒唤醒", "获取下一条未派发提醒/待办的触发时间。", {"type": "object", "properties": {"after": {"type": "string"}}}, get_next_memo_wake_execute),
            AgentTool("complete_memo", "完成备忘录", "将一条备忘录或待办标记为已完成。", {"type": "object", "properties": {"id": {"type": "number"}}, "required": ["id"]}, complete_memo_execute, execution_mode="sequential"),
            AgentTool("snooze_memo", "稍后提醒", "把一条备忘录/提醒推迟到稍后再次触发。", {"type": "object", "properties": {"id": {"type": "number"}, "until": {"type": "string"}, "minutes": {"type": "number"}}, "required": ["id"]}, snooze_memo_execute, execution_mode="sequential"),
            AgentTool("mark_memo_triggered", "标记提醒已触发", "将一条到期提醒标记为已触发，避免后台重复提醒。", {"type": "object", "properties": {"id": {"type": "number"}}, "required": ["id"]}, mark_memo_triggered_execute, execution_mode="sequential"),
        ]
    )

    async def set_self_awake_timer_execute(_tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        timer = resolve_self_awake_state_path(root)
        wake_at, after_minutes = resolve_wake_time(params, timer["min_minutes"], timer["max_minutes"])
        reason = str(params.get("reason") or "Agent 设置下一次自醒时间。").strip()
        state_path: Path = timer["state_path"]
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
        state.update(
            {
                "enabled": True,
                "next_wake_at": to_storage_iso(wake_at.timestamp() * 1000),
                "next_wake_after_minutes": after_minutes,
                "next_wake_reason": reason,
                "last_timer_tool_at": to_storage_iso(now_ms()),
                "last_timer_tool_source": "monagent",
            }
        )
        tmp_path = state_path.with_suffix(f"{state_path.suffix}.tmp")
        tmp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(state_path)
        return text_result(
            "\n".join(["已调用 MonOs 自醒定时器。", f"下次自醒（本地时间）: {format_local_datetime(wake_at)}", f"间隔: {after_minutes} 分钟", f"原因: {reason}"]),
            {"next_wake_at": state["next_wake_at"], "next_wake_at_local": format_local_datetime(wake_at), "after_minutes": after_minutes, "reason": reason, "state_path": str(state_path)},
        )

    tools.append(
        AgentTool(
            "set_self_awake_timer",
            "设置自醒定时器",
            "调用 MonOs 自醒定时器，设置下一次后台自醒时间。",
            {"type": "object", "properties": {"after_minutes": {"type": "number"}, "at": {"type": "string"}, "reason": {"type": "string"}}},
            set_self_awake_timer_execute,
            execution_mode="sequential",
        )
    )

    async def analyze_image_execute(tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        question = str(params.get("question") or "请分析这张图片。").strip()
        mime_type = "image/png"
        data = ""
        source = ""
        if params.get("path"):
            file_path = await maybe_ask_outside_workspace(root, str(params["path"]), context, "analyze_image", tool_call_id, "读取图片")
            mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
            if not mime_type.startswith("image/"):
                raise RuntimeError(f"不是支持的图片类型: {file_path}")
            data = base64.b64encode(file_path.read_bytes()).decode("ascii")
            source = str(file_path)
        else:
            files = context.get_current_files() if context.get_current_files else []
            image_files = [file for file in files if str(file.get("mime") or "").startswith("image/")]
            index = max(int(params.get("attachment_index") or 1) - 1, 0)
            file = image_files[index] if index < len(image_files) else None
            if not file:
                raise RuntimeError("本轮消息中没有可分析的图片附件。请先上传图片，或传入 path。")
            match = re.match(r"^data:([^;,]+);base64,(.*)$", file.get("url") or "")
            if not match:
                raise RuntimeError(f"图片附件不是 data URL，暂时无法直接交给模型分析: {file.get('filename') or '未命名图片'}")
            mime_type = match.group(1) or file.get("mime") or "image/png"
            data = match.group(2)
            source = file.get("filename") or f"附件图片 {index + 1}"
        if context.current_model_supports_images is False:
            core, token = require_core_access(context)
            if not context.vision_config or context.vision_config.get("status") != "active":
                raise RuntimeError("当前对话模型不支持图片输入，且 Core 没有可用的 active Vision 配置。")
            result = await asyncio.to_thread(
                core_call,
                core.analyze_vision,
                token,
                {
                    "config_id": context.vision_config.get("id"),
                    "images": [{"type": "base64", "source": data, "media_type": mime_type, "ref": source}],
                    "prompt": question,
                    "source": "monagent",
                    "related_session_id": context.session_id,
                    "related_message_id": context.get_message_id() if context.get_message_id else None,
                    "tool_call_id": tool_call_id,
                    "metadata": {"image_source": source, "fallback_reason": "current_model_does_not_support_images"},
                    "temperature": 0.2,
                    "max_tokens": 1200,
                },
            )
            if not result.get("success"):
                raise RuntimeError(result.get("error") or "Core Vision 分析失败。")
            return text_result(result.get("content") or result.get("summary") or "", {"source": source, "vision": result})
        return {"content": [{"type": "text", "text": f"请根据图片回答：{question}"}, {"type": "image", "mimeType": mime_type, "data": data}], "details": {"source": source, "mimeType": mime_type, "question": question}}

    async def analyze_screen_execute(tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        if os.name != "nt":
            raise RuntimeError(f"当前屏幕截图暂只支持 Windows，当前平台: {os.name}")
        if context.permissions and context.session_id:
            reply = await asyncio.to_thread(
                context.permissions.ask,
                {
                    "sessionID": context.session_id,
                    "permission": "读取当前屏幕",
                    "patterns": ["desktop-screenshot"],
                    "metadata": {"action": "截取当前屏幕", "toolName": "analyze_screen", "reason": "模型请求查看当前桌面画面，需要你确认。"},
                    "tool": {"messageID": context.get_message_id(), "callID": tool_call_id}
                    if context.get_message_id and context.get_message_id()
                    else None,
                },
            )
            if reply == "reject":
                raise RuntimeError("用户拒绝读取当前屏幕。")
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if not powershell:
            raise RuntimeError("未找到 PowerShell，无法截屏。")
        with tempfile.TemporaryDirectory(prefix="monagent-screen-") as tmp:
            output_path = Path(tmp) / "screen.png"
            script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
if (-not $screens -or $screens.Length -eq 0) {{ throw "No screen found" }}
$left = ($screens | ForEach-Object {{ $_.Bounds.Left }} | Measure-Object -Minimum).Minimum
$top = ($screens | ForEach-Object {{ $_.Bounds.Top }} | Measure-Object -Minimum).Minimum
$right = ($screens | ForEach-Object {{ $_.Bounds.Right }} | Measure-Object -Maximum).Maximum
$bottom = ($screens | ForEach-Object {{ $_.Bounds.Bottom }} | Measure-Object -Maximum).Maximum
$bitmap = New-Object System.Drawing.Bitmap ([int]($right - $left)), ([int]($bottom - $top))
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {{
  $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
  $bitmap.Save('{str(output_path).replace("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
}} finally {{
  $graphics.Dispose()
  $bitmap.Dispose()
}}
"""
            await asyncio.to_thread(subprocess.run, [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], check=True, timeout=15)
            data = base64.b64encode(output_path.read_bytes()).decode("ascii")
        return {"content": [{"type": "text", "text": f"请根据当前屏幕截图回答：{params.get('question') or '请分析当前屏幕。'}"}, {"type": "image", "mimeType": "image/png", "data": data}], "details": {"source": "当前屏幕截图"}}

    tools.extend(
        [
            AgentTool("analyze_image", "图片分析", "把本轮附件图片或指定路径图片交给当前视觉模型分析。", {"type": "object", "properties": {"path": {"type": "string"}, "attachment_index": {"type": "number"}, "question": {"type": "string"}}}, analyze_image_execute),
            AgentTool("analyze_screen", "屏幕分析", "经用户授权后截取当前桌面屏幕，并交给当前视觉模型分析。", {"type": "object", "properties": {"question": {"type": "string"}}}, analyze_screen_execute),
        ]
    )

    if profile == "self_awake":
        allowed = {
            "loaded_tools",
            "web_search",
            "web_fetch",
            "analyze_image",
            "create_memo",
            "create_reminder",
            "list_memos",
            "list_due_memos",
            "dispatch_due_memos",
            "get_next_memo_wake",
            "complete_memo",
            "snooze_memo",
            "mark_memo_triggered",
            "set_self_awake_timer",
            "read",
            "ls",
            "grep",
            "find",
        }
    else:
        allowed = {tool.name for tool in tools} | set(create_all_tools(str(root)).keys())

    for name, tool in create_all_tools(str(root)).items():
        if name in allowed:
            tools.append(tool)

    return [tool for tool in tools if tool.name in allowed]
