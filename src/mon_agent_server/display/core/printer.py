"""
核心输出模块

负责将 Rich 可渲染对象输出到终端，并同时生成 SVG 文件
"""

from pathlib import Path
import os
import sys
import shutil
from typing import Any, Optional
from datetime import datetime
from io import StringIO
import json
from rich.console import Console
from mon_agent_server.display.config import monagent_theme
from .canvas import create_terminal_svg

_SILENT_BOOT = str(os.environ.get("MON_AGENT_SILENT_BOOT", "")).strip().lower() in {"1", "true", "yes", "y", "on"}

def _agent_root() -> Path:
    return Path(__file__).resolve().parents[5]


def _resolve_agent_path(value: str | None, fallback: str) -> Path:
    raw = value or fallback
    path = Path(raw)
    return path if path.is_absolute() else _agent_root() / path


def _config_path(key: str, fallback: str, env_key: str) -> Path:
    env_value = os.environ.get(env_key)
    if env_value:
        return _resolve_agent_path(env_value, fallback)
    try:
        from mon_agent_server.config import active_logs_root, default_agent_root

        log_root = active_logs_root(default_agent_root())
        paths = {
            "RENDER_DIR": log_root / "Render",
            "RENDER_FILE": log_root / "Render" / "render.log",
            "RENDER_PLAIN_FILE": log_root / "Render" / "render_plain.log",
            "RENDER_PANELS": log_root / "Render" / "panels.json",
        }
        return paths.get(key, _resolve_agent_path(None, fallback))
    except Exception:
        return _resolve_agent_path(None, fallback)


RENDER_LOGS_DIR = _config_path("RENDER_DIR", "Data/Logs/Render", "MON_AGENT_RENDER_LOG_DIR")
RENDER_LOG_FILE = _config_path("RENDER_FILE", "Data/Logs/Render/render.log", "MON_AGENT_RENDER_LOG_FILE")
RENDER_PLAIN_LOG_FILE = _config_path(
    "RENDER_PLAIN_FILE",
    "Data/Logs/Render/render_plain.log",
    "MON_AGENT_RENDER_PLAIN_LOG_FILE",
)
RENDER_INDEX_FILE = _config_path("RENDER_PANELS", "Data/Logs/Render/panels.json", "MON_AGENT_RENDER_PANELS_FILE")

# 渲染日志文件路径
SVG_OUTPUT_DIR = RENDER_LOGS_DIR / 'svg'
try:
    SVG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
except Exception as e:
    if not _SILENT_BOOT:
        print(f"❌ [MonAgentDisplay] 无法创建 SVG 输出目录: {e}", file=sys.stderr)

CONSOLE_COLOR_OPTIONS = {
    "color_system": "truecolor",
    "legacy_windows": False,
    "no_color": False,
}


def _capture_renderable(renderable: Any, width: int, *, color: bool) -> str:
    buffer = StringIO()
    console = Console(
        theme=monagent_theme,
        width=width,
        file=buffer,
        force_terminal=color,
        color_system="truecolor" if color else None,
        legacy_windows=False,
        no_color=not color,
    )
    console.print(renderable)
    return buffer.getvalue()


def _append_render_log(path: Path, text: str, *, panel_data: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"\n[{panel_data['timestamp']}][MonAgentDisplay][{panel_data['type']}] "
        f"{panel_data['title']}\n"
    )
    with open(path, "a", encoding="utf-8") as file:
        file.write(header)
        file.write(text.rstrip())
        file.write("\n")


def print_direct(
    renderable: Any, 
    title: Optional[str] = None, 
    width: Optional[int] = None,
    save_to_file: bool = True,
    panel_type: Optional[str] = None,
    export_html: bool = True,
    output_dir: Optional[Path] = None
):
    """直接将 Rich 可渲染对象输出到终端，并生成 SVG 文件
    
    Args:
        renderable: Rich 可渲染对象
        title: 标题（可选）
        width: 渲染宽度（可选）
        save_to_file: 是否同时保存到文件（默认True）
        panel_type: 面板类型标识
        export_html: 是否导出 SVG
        output_dir: SVG 输出目录（可选，默认使用 RENDER_LOGS_DIR/svg）
    """
    if not _SILENT_BOOT:
        print(
            f"🔍 [MonAgentDisplay] print_direct 被调用: title={title}, panel_type={panel_type}, save_to_file={save_to_file}, output_dir={output_dir}",
            file=sys.stderr,
        )
    # 自动计算宽度
    terminal_width = 100
    max_width = 80
    try:
        terminal_size = shutil.get_terminal_size()
        if terminal_size.columns > 40:
            terminal_width = terminal_size.columns
    except OSError:
        pass
    
    final_width = width or (min(terminal_width, max_width) if terminal_width > max_width else terminal_width)

    # 1. 输出到终端（带颜色）
    console = Console(
        theme=monagent_theme,
        force_terminal=True,
        width=final_width,
        file=sys.stdout,
        **CONSOLE_COLOR_OPTIONS,
    )
    
    sys.stdout.flush()
    console.print(renderable)
    sys.stdout.flush()
    
    # 2. 同时保存到文件
    if save_to_file:
        try:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            
            panel_id = panel_type or "UNKNOWN"
            
            stage_info = ""
            if title:
                import re
                stage_match = re.search(r'\[(AGENT-[^\]]+)\]', title)
                if stage_match:
                    stage_info = stage_match.group(1)
            
            base_filename = f"panel_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:-3]}"
            svg_filename = f"{base_filename}.svg"
            
            # 使用指定的输出目录，或默认使用 SVG_OUTPUT_DIR
            target_output_dir = Path(output_dir) if output_dir else SVG_OUTPUT_DIR
            target_output_dir.mkdir(parents=True, exist_ok=True)
            svg_file_path = target_output_dir / svg_filename
            
            panel_data = {
                "type": panel_id,
                "stage": stage_info,
                "timestamp": timestamp,
                "title": title or "",
                "svg": svg_filename
            }

            ansi_text = _capture_renderable(renderable, final_width, color=True)
            plain_text = _capture_renderable(renderable, final_width, color=False)
            _append_render_log(RENDER_LOG_FILE, ansi_text, panel_data=panel_data)
            _append_render_log(RENDER_PLAIN_LOG_FILE, plain_text, panel_data=panel_data)
            
            # 保存索引信息到 JSON 文件
            RENDER_INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
            panels = []
            if RENDER_INDEX_FILE.exists():
                try:
                    with open(RENDER_INDEX_FILE, 'r', encoding='utf-8') as f:
                        panels = json.load(f)
                except json.JSONDecodeError:
                    panels = []
            
            panels.append(panel_data)
            
            with open(RENDER_INDEX_FILE, 'w', encoding='utf-8') as f:
                json.dump(panels, f, ensure_ascii=False, indent=2)
            
            # 导出 SVG 版本到独立文件
            if export_html:
                try:
                    # 使用 SVG 渲染
                    svg_content = create_terminal_svg(ansi_text, final_width, title, panel_id, stage_info, timestamp)
                    
                    # 保存到 SVG 文件
                    with open(svg_file_path, 'w', encoding='utf-8') as f:
                        f.write(svg_content)
                    if not _SILENT_BOOT:
                        print(f"✅ [MonAgentDisplay] SVG 已保存: {svg_file_path}", file=sys.stderr)
                        
                except Exception as e:
                    import traceback
                    if not _SILENT_BOOT:
                        print(f"\n⚠️ [MonAgentDisplay] 无法导出SVG: {e}", file=sys.stderr)
                    traceback.print_exc(file=sys.stderr)
                
        except Exception as e:
            if not _SILENT_BOOT:
                print(f"\n⚠️ [MonAgentDisplay] 无法写入渲染日志: {e}", file=sys.stderr)
