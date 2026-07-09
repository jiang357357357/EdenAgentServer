from rich.table import Table
from rich import box
from typing import List, Optional, Dict, Any
from pathlib import Path
from mon_agent_server.display.core.printer import print_direct


def render_table(
    headers: List[str],
    rows: List[List[Any]],
    title: Optional[str] = None,
    box_style: Any = box.SQUARE,
    styles: Optional[Dict[str, str]] = None,
    width: Optional[int] = None,
    max_cell_length: Optional[int] = None,
    compact_rows: Optional[Dict[str, Any]] = None,
    compact_cells: Optional[Dict[str, Any]] = None,
    output_dir: Optional[Path] = None,
) -> None:
    """渲染并直接输出表格到终端
    
    Args:
        headers: 表格列标题
        rows: 表格行数据
        title: 表格标题
        box_style: 表格边框样式
        styles: 表格样式字典
        width: 渲染宽度
        max_cell_length: 单元格最大长度
        compact_rows: 行折叠配置，如 {"head": 5, "tail": 5, "label_col": 0}
        compact_cells: 单元格行折叠配置，如 {"columns": [2], "head": 30, "tail": 30}
        output_dir: SVG 输出目录（可选）
    """
    table = _prepare_table(headers, rows, title, box_style, styles, max_cell_length, compact_rows, compact_cells)
    print_direct(table, title=title, width=width, panel_type="TABLE", output_dir=output_dir)


def _prepare_table(
    headers: List[str],
    rows: List[List[Any]],
    title: Optional[str] = None,
    box_style: Any = box.SQUARE,
    styles: Optional[Dict[str, str]] = None,
    max_cell_length: Optional[int] = None,
    compact_rows: Optional[Dict[str, Any]] = None,
    compact_cells: Optional[Dict[str, Any]] = None,
) -> Table:
    styles = styles or {}
    table = Table(
        title=title,
        box=box_style,
        show_header=True,
        header_style=styles.get("header_style", "table.header"),
        title_style=styles.get("title_style", "table.title"),
        expand=False, 
        border_style=styles.get("border_style", "dim"),
        show_lines=True,
    )

    if headers == ["类型", "角色", "权重", "内容"]:
        table.add_column(headers[0], style=styles.get(headers[0], ""), width=10, no_wrap=True)
        table.add_column(headers[1], style=styles.get(headers[1], ""), width=10, no_wrap=True)
        table.add_column(headers[2], style=styles.get(headers[2], ""), width=10, no_wrap=True)
        table.add_column(headers[3], ratio=1, overflow="fold") 
    else:
        # 对于其他表格（如响应表格），也使用fold模式避免截断
        for header in headers:
            table.add_column(header, style=styles.get(header, ""), overflow="fold")

    for row in _iter_compact_rows(rows, compact_rows):
        str_row = []
        for col_idx, item in enumerate(row):
            s = str(item)
            if max_cell_length and len(s) > max_cell_length:
                s = s[:max_cell_length] + f"\n... [已截断，总长度: {len(s)}]"
            s = _compact_cell_text(s, col_idx, compact_cells)
            str_row.append(s)
        table.add_row(*str_row)
    
    return table


def _iter_compact_rows(rows: List[List[Any]], compact_rows: Optional[Dict[str, Any]] = None):
    if not compact_rows:
        yield from rows
        return

    head = int(compact_rows.get("head", 5))
    tail = int(compact_rows.get("tail", 5))
    min_omitted = int(compact_rows.get("min_omitted", 1))
    visible = max(0, head) + max(0, tail)
    total = len(rows)
    omitted = total - visible
    if total <= visible or omitted < min_omitted:
        yield from rows
        return

    for row in rows[:head]:
        yield row

    label_col = int(compact_rows.get("label_col", 0))
    text_col = int(compact_rows.get("text_col", len(rows[0]) - 1 if rows else 0))
    role_col = compact_rows.get("role_col")
    omitted_text = str(compact_rows.get("omitted_text", "中间省略 {count} 条")).format(count=omitted)
    omitted_row = [""] * (len(rows[0]) if rows else 1)
    if 0 <= label_col < len(omitted_row):
        omitted_row[label_col] = "..."
    if role_col is not None and 0 <= int(role_col) < len(omitted_row):
        omitted_row[int(role_col)] = "-"
    if 0 <= text_col < len(omitted_row):
        omitted_row[text_col] = f"[dim]{omitted_text}[/]"
    yield omitted_row

    for row in rows[-tail:]:
        yield row


def _compact_cell_text(value: str, col_idx: int, compact_cells: Optional[Dict[str, Any]] = None) -> str:
    if not compact_cells:
        return value

    columns = compact_cells.get("columns")
    if columns is not None and col_idx not in set(int(item) for item in columns):
        return value

    lines = value.splitlines()
    head = int(compact_cells.get("head", 30))
    tail = int(compact_cells.get("tail", 30))
    min_omitted = int(compact_cells.get("min_omitted", 1))
    visible = max(0, head) + max(0, tail)
    omitted = len(lines) - visible
    if len(lines) <= visible or omitted < min_omitted:
        return value

    omitted_text = str(compact_cells.get("omitted_text", "中间省略 {count} 行")).format(count=omitted)
    return "\n".join(
        [
            *lines[:head],
            f"[dim]... {omitted_text} ...[/]",
            *lines[-tail:],
        ]
    )
