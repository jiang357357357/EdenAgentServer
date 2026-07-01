from __future__ import annotations

import signal
from typing import Any

from .app import AppState
from .config import load_server_config
from .http_server import AgentHTTPServer, AgentRequestHandler


def main(argv: list[str] | None = None) -> int:
    _ = argv
    config = load_server_config()
    app = AppState(config)
    server = AgentHTTPServer((config.host, config.port), AgentRequestHandler)
    server.app = app

    def shutdown(signum: int, _frame: Any) -> None:
        print(f"[Server] 收到信号 {signum}，正在退出", flush=True)
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(f"[Server] Agent server 正在监听 http://{config.host}:{config.port}", flush=True)
    print(f"[Server] 工作区路径：{config.workspace_root}", flush=True)
    print("[Server] session 存储：Core Server（当前进程仅保留运行期内存缓存）", flush=True)
    print(f"[Server] Core 地址：{app.core_client.base_url}", flush=True)
    print("[Server] Python AgentCore 已启用", flush=True)
    if config.startup_self_awake_enabled:
        print("[Server] 启动自醒暂以兼容占位返回，完整策略后续接入 Python AgentCore", flush=True)
    server.serve_forever()
    server.server_close()
    return 0
