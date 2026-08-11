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
    try:
        os.kill(instance.pid, 0)
    except (ProcessLookupError, PermissionError) as error:
        raise RuntimeError(f"OpenTTD 实例已经退出：{instance.instance_id}") from error
    return instance
