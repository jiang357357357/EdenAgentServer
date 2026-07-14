from __future__ import annotations

import threading
import signal

from .app import AppState
from .app.lifecycle import render_startup_summary
from .config import load_server_config
from .hub import HubRegistryClient
from .http_server import AgentHTTPServer, AgentRequestHandler
from .logging import (
    configure_from_server_config,
    get_logger,
    install_standard_logging_bridge,
    shutdown as shutdown_logging,
)

server_logger = get_logger("MonAgent", "Server")


def main(argv: list[str] | None = None) -> int:
    _ = argv
    config = load_server_config()
    configure_from_server_config(config)
    install_standard_logging_bridge(level=config.log_level)
    app = AppState(config)
    hub = HubRegistryClient(config)
    server = AgentHTTPServer((config.host, config.port), AgentRequestHandler)
    server.app = app
    stopping = threading.Event()

    def shutdown_worker(reason: str) -> None:
        hub.stop(reason)
        server.shutdown()

    def shutdown(signum: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        server_logger.info(f"收到信号 {signum}，正在退出")
        threading.Thread(target=shutdown_worker, args=("signal",), daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    server_logger.info(f"Agent server 正在监听 http://{config.host}:{config.port}")
    server_logger.info(f"工作区路径：{config.workspace_root}")
    server_logger.info(f"日志文件：{config.log_file}")
    if config.log_dual_file_enabled:
        server_logger.info(f"纯文本日志文件：{config.plain_log_file}")
    if config.display_enabled:
        server_logger.info(f"渲染日志目录：{config.render_log_dir}")
    server_logger.info("session 存储：Core Server（当前进程仅保留运行期内存缓存）")
    server_logger.info(f"Core 地址：{app.core_client.base_url}")
    server_logger.info("Python AgentCore 已启用")
    server_logger.info("外部邮件能力：Core 用户配置 -> MonOs Email")
    render_startup_summary(app)
    hub.start()
    try:
        server.serve_forever()
    finally:
        hub.stop("shutdown")
        server.server_close()
        shutdown_logging()
    return 0
