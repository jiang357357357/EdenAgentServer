from __future__ import annotations

import threading
from datetime import datetime

from ..logging import get_logger
from ..self_awake import enrich_self_awake_context, run_self_awake_sync
from .state import AppState

server_logger = get_logger("MonAgent", "Server")
self_awake_logger = get_logger("MonAgent", "SelfAwake")


def local_iso_now() -> str:
    return datetime.now().astimezone().isoformat()


def run_startup_self_awake_once(app: AppState) -> None:
    config = app.config
    token = app.core_client.login_for_token(
        config.auth_dev_username,
        config.auth_dev_password,
        client_id="monagent-startup-self-awake",
        client_type="monagent",
    )
    context = {
        "trigger": "monagent_server_startup",
        "source": "startup",
        "current_time": local_iso_now(),
        "wake": {"source": "monagent_server", "reason": "server_startup"},
        "policy": {"allow_workspace_file_tools": False},
    }
    context = enrich_self_awake_context(context, app, token=token)
    self_awake_logger.info("启动自醒开始执行。")
    decision = run_self_awake_sync({"context": context}, app, token)
    app.core_client.persist_self_awake_run(token, decision, context)
    self_awake_logger.info("启动自醒已完成并写入 Core。")


def start_startup_self_awake(app: AppState) -> None:
    config = app.config
    if not config.startup_self_awake_enabled:
        self_awake_logger.info("启动自醒已关闭。")
        return
    if not config.auth_dev_username or not config.auth_dev_password:
        self_awake_logger.warning("启动自醒已开启，但缺少 auth_dev 用户名/密码，跳过。")
        return

    def worker() -> None:
        try:
            if config.startup_self_awake_delay_seconds > 0:
                threading.Event().wait(config.startup_self_awake_delay_seconds)
            run_startup_self_awake_once(app)
        except Exception as error:
            self_awake_logger.error(f"启动自醒失败：{error}", exc_info=True)

    threading.Thread(target=worker, name="monagent-startup-self-awake", daemon=True).start()
    self_awake_logger.info("启动自醒任务已提交。")


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
