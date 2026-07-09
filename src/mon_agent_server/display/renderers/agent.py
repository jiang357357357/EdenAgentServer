from typing import Any, Dict, List, Optional
import json
from rich.markup import escape
from .table import render_table


def _format_display_value(value: Any, indent: int = 0) -> str:
    prefix = " " * indent
    child_indent = indent + 2

    if isinstance(value, dict):
        if not value:
            return "{}"
        lines: List[str] = []
        for key, item in value.items():
            formatted = _format_display_value(item, child_indent)
            if "\n" in formatted:
                lines.append(f"{prefix}{key}:")
                lines.append(formatted)
            else:
                lines.append(f"{prefix}{key}: {formatted}")
        return "\n".join(lines)

    if isinstance(value, list):
        if not value:
            return "[]"
        lines = []
        for item in value:
            formatted = _format_display_value(item, child_indent)
            if "\n" in formatted:
                lines.append(f"{prefix}-")
                lines.append(formatted)
            else:
                lines.append(f"{prefix}- {formatted}")
        return "\n".join(lines)

    if isinstance(value, str):
        return value.replace("\\n", "\n")

    return str(value)


def _parse_json_string(value: str) -> Any:
    if not value.startswith("{") and not value.startswith("["):
        return value
    try:
        return json.loads(value)
    except Exception:
        return value

def render_decision_table(
    decision_data: Dict[str, Any],
    character_name: str = "δ֪",
    stage_name: str = "决策结果",
    width: Optional[int] = None
) -> None:
    """专门用于渲染智能体决策结果的表格"""
    headers = ["项目", "详情"]
    rows: List[List[str]] = []
    
    # 预定义顺序
    order = ["步骤类型", "决策类型", "使用工具", "工具参数", "内容", "伴随回复", "思考过程", "计划名称"]
    
    # 先处理预定义顺序的 key
    processed_keys = set()
    for key in order:
        if key in decision_data:
            val = decision_data[key]
            if isinstance(val, str):
                val = _parse_json_string(val)
            
            style = "[bold cyan]" if "类型" in key or "工具" in key else ""
            
            display_key = f"{style}{key}[/]" if style else key
            display_val = escape(_format_display_value(val))
            
            rows.append([display_key, display_val])
            processed_keys.add(key)
    
    # 再处理其他 key
    for key, val in decision_data.items():
        if key not in processed_keys:
            if isinstance(val, str):
                val = _parse_json_string(val)
            rows.append([escape(str(key)), escape(_format_display_value(val))])
            
    title = f"{stage_name} - {character_name}"
    # 直接使用 print_direct，指定面板类型为 DECISION
    from mon_agent_server.display.core.printer import print_direct
    from .table import _prepare_table
    table = _prepare_table(headers, rows, title)
    print_direct(table, title=title, width=width, panel_type="DECISION")

def render_response_table(
    ai_response: str,
    usage: Dict[str, Any],
    character_name: str = "δ֪",
    parsed_data: Optional[Dict[str, Any]] = None,
    stage_name: str = "AI 响应结果",
    width: Optional[int] = None
) -> None:
    """渲染 AI 响应结果和 Token 使用情况"""
    headers = ["项目", "内容"]
    rows: List[List[str]] = []
    
    # 1. 解析后的数据 (如果有)
    if parsed_data:
        for key, val in parsed_data.items():
            display_val = val
            if val in (None, {}, []):
                display_val = "未解析到"
            elif isinstance(val, str):
                display_val = _parse_json_string(val)

            # 特殊处理对话内容，使用醒目样式
            if key == "对话内容":
                rows.append([f"[bold magenta]✨ {key}[/]", f"[bold white]{escape(_format_display_value(display_val))}[/]"])
            elif key == "思考过程":
                rows.append([f"[dim cyan]💭 {key}[/]", f"[dim]{escape(_format_display_value(display_val))}[/]"])
            else:
                rows.append([f"[bold green]解析:{key}[/]", escape(_format_display_value(display_val))])
    
    # 2. Token 使用情况
    if usage:
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        total_tokens = usage.get("total_tokens", 0)
        
        rows.append(["[bold yellow]输入 Tokens (Prompt)[/]", str(prompt_tokens)])
        rows.append(["[bold yellow]输出 Tokens (Completion)[/]", str(completion_tokens)])
        rows.append(["[bold green]总消耗 Tokens (Total)[/]", f"[bold green]{total_tokens}[/]"])
        
    title = f"{stage_name} - {character_name}"
    # 直接使用 print_direct，指定面板类型为 RESPONSE
    from mon_agent_server.display.core.printer import print_direct
    from .table import _prepare_table
    table = _prepare_table(headers, rows, title)
    print_direct(table, title=title, width=width, panel_type="RESPONSE")
