from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# This module is loaded inside the OpenTTD connector worker. Its content hash
# participates in the connector revision, so registry-discovery fixes can be
# deployed without restarting the Agent Server.


def default_instance_registry() -> Path:
    runtime = os.environ.get("XDG_RUNTIME_DIR", "").strip() or "/tmp"
    return Path(runtime) / "monagent-openttd" / "active-instance.json"


@dataclass(frozen=True)
class OpenTTDInstance:
    instance_id: str
    host: str
    game_port: int
    admin_port: int
    pid: int
    mode: str
    started_at: str


def _process_is_alive(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            return False
        return True

    # Windows has no POSIX signal-0 probe: os.kill(pid, 0) can deliver a
    # console control event. Query a process handle without signalling it.
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ctypes.get_last_error() == 5  # Access denied still means it exists.
    kernel32.CloseHandle(handle)
    return True


def load_active_instance(path: str | os.PathLike[str] | None = None) -> OpenTTDInstance:
    registry = Path(path) if path else default_instance_registry()
    try:
        payload: Any = json.loads(registry.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RuntimeError(f"没有活动的 OpenTTD 游戏实例：{registry}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"OpenTTD 实例注册文件无效：{registry}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"OpenTTD 实例注册文件不是对象：{registry}")

    try:
        instance = OpenTTDInstance(
            instance_id=str(payload["instance_id"]).strip(),
            host=str(payload["host"]).strip(),
            game_port=int(payload["game_port"]),
            admin_port=int(payload["admin_port"]),
            pid=int(payload["pid"]),
            mode=str(payload["mode"]).strip(),
            started_at=str(payload["started_at"]).strip(),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError(f"OpenTTD 实例注册字段不完整：{registry}") from error
    if not instance.instance_id or not instance.host or instance.pid <= 0:
        raise RuntimeError(f"OpenTTD 实例注册身份无效：{registry}")
    if not 1 <= instance.game_port <= 65535 or not 1 <= instance.admin_port <= 65535:
        raise RuntimeError(f"OpenTTD 实例端口无效：{registry}")
    if not _process_is_alive(instance.pid):
        raise RuntimeError(f"OpenTTD 实例已经退出：{instance.instance_id}")
    return instance
