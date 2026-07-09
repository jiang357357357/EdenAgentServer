from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from rich.markup import escape

from mon_agent_server.display.core.printer import print_direct
from .table import _prepare_table


def render_context(
    context_materials: Dict[str, Any],
    character_name: str = "未知",
    user_name: str = "用户",
    system_prompt: Optional[str] = None,
    messages: Optional[List[Dict[str, Any]]] = None,
    stage_name: str = "上下文预览",
    width: Optional[int] = None,
) -> None:
    """渲染上下文内容为表格面板。"""

    headers = ["类型", "消息Role", "内容"]
    rows: List[List[str]] = []

    if messages is not None:
        for i, msg in enumerate(messages, 1):
            role = msg.get("role") or ""
            content = msg.get("content") or ""
            display_role = str(role or "unknown")

            tool_calls = msg.get("tool_calls")
            if tool_calls:
                tool_info = []
                for tool in tool_calls:
                    func = tool.get("function") or {}
                    tool_name = func.get("name") or "未知工具"
                    tool_args = func.get("arguments") or "{}"
                    tool_info.append(
                        f"调用工具: {tool_name}\n参数: {tool_args}"
                    )
                content = f"{content}\n\n" + "\n".join(tool_info) if content else "\n".join(tool_info)

            rows.append([f"消息-{i}", display_role, escape(str(content))])

        if not rows:
            rows.append(["-", "-", "当前无可用上下文"])

        title = f"{stage_name} - {character_name}"
        table = _prepare_table(
            headers,
            rows,
            title,
            compact_rows={
                "head": 5,
                "tail": 5,
                "label_col": 0,
                "role_col": 1,
                "text_col": 2,
                "omitted_text": "中间省略 {count} 条消息",
            },
            compact_cells={
                "columns": [2],
                "head": 30,
                "tail": 30,
                "omitted_text": "中间省略 {count} 行",
            },
        )
        print_direct(table, title=title, width=width, panel_type="CONTEXT")
        return

    if system_prompt:
        rows.append(["指令模板", "系统", escape(system_prompt)])

    special_keys = {
        "长期记忆",
        "短期记忆",
        "历史",
        "tools",
        "world_name",
        "character_name",
        "user_name",
    }

    for key, value in context_materials.items():
        if key in special_keys:
            continue
        if not isinstance(value, dict) or not value.get("content"):
            continue
        content = value.get("content")
        display_content = f"[{key}]\n{content}"
        rows.append([key, "系统", escape(display_content)])

    tools = context_materials.get("tools") or []
    if tools:
        tools_str = ""
        for tool in tools:
            if isinstance(tool, dict):
                func = tool.get("function", {})
                name = func.get("name", "未知工具")
                desc = func.get("description", "无描述")
                tools_str += f"- {escape(name)}: {escape(desc)}\n"
            else:
                tools_str += f"- {escape(str(tool))}\n"
        rows.append(["可用工具", "系统", tools_str.strip()])

    for idx, mem in enumerate(context_materials.get("长期记忆") or [], 1):
        title = mem.get("title", "")
        content = mem.get("content", "")
        rows.append(
            [f"长期记忆-{idx}", "助手", f"{escape(title)}\n{escape(content)}"]
        )

    for idx, mem in enumerate(context_materials.get("短期记忆") or [], 1):
        title = mem.get("title", "")
        content = mem.get("content", "")
        rows.append(
            [f"短期记忆-{idx}", "助手", f"{escape(title)}\n{escape(content)}"]
        )

    history_entries = context_materials.get("历史") or []
    if history_entries:
        display_idx = 1
        for entry in history_entries:
            sender_type = entry.get("sender_type") or entry.get("role")
            content = entry.get("content") or ""

            if sender_type == "tool":
                tool_name = entry.get("name") or entry.get("tool_name") or "task_finish"
                tool_args = entry.get("tool_args") or {}
                tool_call_id = entry.get("tool_call_id") or "unknown"
                content = (
                    "[任务执行结果]\n"
                    f"ID: {tool_call_id}\n"
                    f"{content}\n"
                    f"调用工具: {tool_name}\n"
                    f"参数: {json.dumps(tool_args, ensure_ascii=False)}"
                )
                rows.append([f"历史-{display_idx}", "系统", escape(content)])
                display_idx += 1
                continue

            tool_calls = entry.get("tool_calls")
            if tool_calls:
                extra = ""
                for tool in tool_calls:
                    func = tool.get("function", {})
                    name = func.get("name", "未知")
                    args = func.get("arguments", "{}")
                    extra += f"\n调用工具: {escape(name)}\n参数: {escape(str(args))}"
                content = f"{content}{extra}"

            role_label = "用户" if sender_type == "user" else "助手"
            rows.append([f"历史-{display_idx}", role_label, escape(content)])
            display_idx += 1

    if not rows:
        rows.append(["-", "-", "当前无可用上下文"])

    title = f"{stage_name} - {character_name}"
    table = _prepare_table(headers, rows, title)
    print_direct(table, title=title, width=width, panel_type="CONTEXT")
