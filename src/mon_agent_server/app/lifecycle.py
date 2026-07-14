from __future__ import annotations

from ..logging import get_logger
from .state import AppState

server_logger = get_logger("MonAgent", "Server")


def render_startup_summary(app: AppState) -> None:
    config = app.config
    if not config.display_enabled:
        return
    try:
        from ..display import render_table

        rows = [
            ["服务", "MonAgent Server"],
            ["状态", "[bold green]运行中[/bold green]"],
            ["监听地址", f"http://{config.host}:{config.port}"],
            ["工作区", str(config.workspace_root)],
            ["Core 地址", app.core_client.base_url],
            ["AgentCore", "Python AgentCore"],
            ["日志文件", str(config.log_file)],
            ["纯文本日志", str(config.plain_log_file)],
            ["渲染日志", str(config.render_log_dir)],
            ["渲染索引", str(config.render_panels_file)],
            ["外部邮件", "Core 用户配置 -> MonOs Email"],
        ]
        render_table(["项目", "值"], rows, title="[AGENT-STARTUP] MonAgent 启动检查", width=100)
    except Exception as error:
        server_logger.warning(f"启动检查表渲染失败：{error}")
