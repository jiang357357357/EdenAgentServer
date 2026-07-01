from __future__ import annotations

import json
import socket
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from .config import ServerConfig


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def resolve_public_host(configured: str, bind_host: str) -> str:
    value = configured.strip()
    if value and value != "auto":
        return value
    if bind_host not in {"", "0.0.0.0", "::", "[::]"}:
        return "127.0.0.1" if bind_host in {"localhost", "127.0.0.1"} else bind_host
    probe = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        if probe:
            try:
                probe.close()
            except Exception:
                pass


class HubRegistryClient:
    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self.started_at = now_iso()
        self.stopped = threading.Event()
        self._socket: Any = None
        self._context: Any = None
        self._heartbeat_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._registered = False

    def start(self) -> None:
        if not self.config.hub.enabled:
            print("[Hub] MonHub 注册已关闭", flush=True)
            return
        try:
            import zmq  # type: ignore
        except Exception as error:
            print(f"[Hub] 未安装 pyzmq，跳过 MonHub 注册：{error}", flush=True)
            return
        try:
            self._context = zmq.Context.instance()
            self._socket = self._context.socket(zmq.DEALER)
            self._socket.setsockopt(zmq.IDENTITY, self.config.hub.service_name.encode("utf-8"))
            self._socket.connect(self.config.hub.address)
            self.send({"type": "HEARTBEAT", "source": self.config.hub.service_name, "target": "MonHub", "payload": {"status": "alive"}})
            self.register("startup")
            self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
            self._heartbeat_thread.start()
            print(f"[Hub] MonHub 注册客户端已启动：{self.config.hub.address}", flush=True)
        except Exception as error:
            print(f"[Hub] MonHub 注册失败，Agent 将继续本地运行：{error}", flush=True)
            self.stop("startup_failed")

    def stop(self, reason: str = "shutdown") -> None:
        self.stopped.set()
        with self._lock:
            socket_obj = self._socket
            registered = self._registered
        if socket_obj and registered:
            try:
                self.send(
                    {
                        "type": "SERVICE_UNREGISTER",
                        "source": self.config.hub.service_name,
                        "target": "MonHub",
                        "payload": {"service_id": self.config.hub.service_id, "reason": reason},
                    }
                )
            except Exception as error:
                print(f"[Hub] MonHub 注销失败：{error}", flush=True)
        with self._lock:
            if self._socket:
                try:
                    self._socket.close(0)
                except Exception:
                    pass
            self._socket = None
            self._registered = False

    def register(self, reason: str) -> None:
        host = resolve_public_host(self.config.hub.public_host, self.config.host)
        self.send(
            {
                "type": "SERVICE_REGISTER",
                "source": self.config.hub.service_name,
                "target": "MonHub",
                "payload": {
                    "service_id": self.config.hub.service_id,
                    "service_name": self.config.hub.service_name,
                    "service_type": self.config.hub.service_type,
                    "version": self.config.hub.version,
                    "status": "online",
                    "description": self.config.hub.description,
                    "started_at": self.started_at,
                    "endpoints": [
                        {
                            "protocol": "http",
                            "host": host,
                            "port": self.config.port,
                            "path": "/api",
                            "primary": True,
                            "secure": False,
                            "metadata": {"local_host": self.config.host},
                        },
                        {"protocol": "web", "host": host, "port": self.config.vite_port, "path": "/", "primary": False, "secure": False},
                    ],
                    "capabilities": ["agent.chat", "agent.py_runtime", "agent.tool_call", "agent.self_awake"],
                    "metadata": {"reason": reason, "workspace_root": str(self.config.workspace_root), "core_base_url": self.config.core_base_url},
                },
            }
        )
        self._registered = True
        print(f"[Hub] 已发送 MonHub 服务注册：http://{host}:{self.config.port}", flush=True)

    def send(self, message: dict[str, Any]) -> None:
        with self._lock:
            socket_obj = self._socket
        if not socket_obj:
            raise RuntimeError("MonHub socket 尚未初始化")
        payload = {
            "protocol": "MonHub",
            "version": "2.0.0",
            "msg_id": str(uuid.uuid4()),
            "timestamp": now_iso(),
            **message,
        }
        socket_obj.send_multipart([b"", json.dumps(payload, ensure_ascii=False).encode("utf-8")])

    def _heartbeat_loop(self) -> None:
        interval = max(5, self.config.hub.heartbeat_interval_seconds)
        while not self.stopped.wait(interval):
            try:
                self.send(
                    {
                        "type": "SERVICE_HEARTBEAT",
                        "source": self.config.hub.service_name,
                        "target": "MonHub",
                        "payload": {"service_id": self.config.hub.service_id, "status": "online", "health": 100},
                    }
                )
            except Exception as error:
                print(f"[Hub] MonHub 心跳发送失败：{error}", flush=True)
                time.sleep(2)
