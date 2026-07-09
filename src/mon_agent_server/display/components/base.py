from rich.console import Console, RenderableType
from rich.panel import Panel
from rich import box
from rich.tree import Tree
from rich.live import Live
from io import StringIO
from typing import Any, Optional, Callable, Iterable, Tuple, List, Union
from mon_agent_server.display.config import monagent_theme
import time
import shutil
from mon_agent_server.display.core.printer import print_direct


def render_panel(
    content: Any,
    title: Optional[str] = None,
    subtitle: Optional[str] = None,
    border_style: str = "panel.border",
    box_style: Any = box.ROUNDED,
    width: Optional[int] = None,
    expand: bool = True,
) -> None:
    """渲染并直接输出面板到终端"""
    panel = _prepare_panel(content, title, subtitle, border_style, box_style, width, expand)
    print_direct(panel, title=title, width=width, panel_type="PANEL")


def _prepare_panel(
    content: Any,
    title: Optional[str] = None,
    subtitle: Optional[str] = None,
    border_style: str = "panel.border",
    box_style: Any = box.ROUNDED,
    width: Optional[int] = None,
    expand: bool = True,
) -> Panel:
    return Panel(
        content,
        title=title,
        subtitle=subtitle,
        border_style=border_style,
        box=box_style,
        width=width,
        padding=(0, 1),
        expand=expand,
    )


def render_progress(
    tasks: Iterable[Tuple[str, int]],
    width: Optional[int] = None,
) -> None:
    """渲染进度条并直接输出"""
    buffer = StringIO()
    console_kwargs = {
        "file": buffer,
        "theme": monagent_theme,
        "force_terminal": True,
    }
    if width is None:
        try:
            console_kwargs["width"] = shutil.get_terminal_size().columns
        except OSError:
            pass
    else:
        console_kwargs["width"] = width
    console = Console(**console_kwargs)

    for description, total in tasks:
        bar_width = 30
        bar = "━" * bar_width
        line = f"{description} {bar} 100%"
        console.print(line)

    output = buffer.getvalue()
    print_direct(output, title="Progress", panel_type="PROGRESS")


def render_tree(
    label: str,
    children: Iterable[Tuple[str, Optional[List[Tuple[str, Any]]]]],
    width: Optional[int] = None,
) -> None:
    """渲染并直接输出树状图到终端"""
    tree = _prepare_tree(label, children)
    print_direct(tree, title=label, width=width, panel_type="TREE")


def _prepare_tree(
    label: str,
    children: Iterable[Tuple[str, Optional[List[Tuple[str, Any]]]]]
) -> Tree:
    tree = Tree(label)

    def add_children(node: Tree, items: Iterable[Tuple[str, Optional[List[Tuple[str, Any]]]]]) -> None:
        for child_label, grand_children in items:
            child_node = node.add(child_label)
            if grand_children:
                add_children(child_node, grand_children)

    add_children(tree, children)
    return tree


def run_live(
    renderable: Union[RenderableType, Callable[[], RenderableType]],
    width: Optional[int] = None,
    refresh_per_second: float = 4.0,
    screen: bool = False,
    transient: bool = False,
) -> None:
    console_kwargs = {"theme": monagent_theme}
    if width is None:
        try:
            console_kwargs["width"] = shutil.get_terminal_size().columns
        except OSError:
            pass
    else:
        console_kwargs["width"] = width
    console = Console(**console_kwargs)

    def get_renderable() -> RenderableType:
        if callable(renderable):
            return renderable()
        return renderable

    with Live(
        get_renderable(),
        console=console,
        refresh_per_second=refresh_per_second,
        screen=screen,
        transient=transient,
    ) as live:
        if callable(renderable):
            interval = 1.0 / refresh_per_second if refresh_per_second > 0 else 0.25
            try:
                while True:
                    live.update(get_renderable())
                    time.sleep(interval)
            except KeyboardInterrupt:
                pass
        else:
            pass
