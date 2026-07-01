from __future__ import annotations

import threading
import signal
from datetime import datetime
from typing import Any

from .app import AppState
from .config import load_server_config
from .core import to_storage_iso
from .hub import HubRegistryClient
from .http_server import AgentHTTPServer, AgentRequestHandler
from .ids import now_ms
from .self_awake import run_self_awake_sync


def _parse_storage_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def start_startup_self_awake(app: AppState) -> None:
    config = app.config
    if not config.startup_self_awake_enabled:
        return
    if not config.auth_dev_username or not config.auth_dev_password:
        print("[SelfAwake] 启动自醒已开启，但缺少 auth_dev 用户名/密码，跳过。", flush=True)
        return

    def worker() -> None:
        try:
            if config.startup_self_awake_delay_seconds > 0:
                threading.Event().wait(config.startup_self_awake_delay_seconds)
            token = app.core_client.login_for_token(
                config.auth_dev_username,
                config.auth_dev_password,
                client_id="monagent-startup-self-awake",
                client_type="monagent",
            )
            runs = app.core_client.list_self_awake_runs(token, 1)
            latest = runs[0] if runs else None
            next_wake_at = _parse_storage_time((latest or {}).get("next_wake_at")) if latest else None
            if latest and latest.get("status") == "succeeded" and next_wake_at and next_wake_at.timestamp() * 1000 > now_ms():
                print(f"[SelfAwake] 最近自醒已安排未来唤醒，启动时跳过：{latest.get('next_wake_at')}", flush=True)
                return
            context = {
                "trigger": "monagent_server_startup",
                "source": "startup",
                "current_time": to_storage_iso(now_ms()),
                "current_time_local": datetime.now().astimezone().isoformat(),
                "user_activity": "MonAgent Python Server 启动完成，执行一次启动自醒检查。",
                "last_state": latest or {},
                "policy": {"allow_workspace_file_tools": False},
            }
            decision = run_self_awake_sync({"context": context}, app, token)
            app.core_client.persist_self_awake_run(token, decision, context)
            print("[SelfAwake] 启动自醒已完成并写入 Core。", flush=True)
        except Exception as error:
            print(f"[SelfAwake] 启动自醒失败：{error}", flush=True)

    threading.Thread(target=worker, name="monagent-startup-self-awake", daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    _ = argv
    config = load_server_config()
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
        print(f"[Server] 收到信号 {signum}，正在退出", flush=True)
        threading.Thread(target=shutdown_worker, args=("signal",), daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(f"[Server] Agent server 正在监听 http://{config.host}:{config.port}", flush=True)
    print(f"[Server] 工作区路径：{config.workspace_root}", flush=True)
    print("[Server] session 存储：Core Server（当前进程仅保留运行期内存缓存）", flush=True)
    print(f"[Server] Core 地址：{app.core_client.base_url}", flush=True)
    print("[Server] Python AgentCore 已启用", flush=True)
    hub.start()
    start_startup_self_awake(app)
    try:
        server.serve_forever()
    finally:
        hub.stop("shutdown")
        server.server_close()
    return 0
