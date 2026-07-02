from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


MAX_DEPTH = 10


def _parse_monconfig(path: Path) -> dict[str, dict[str, str]]:
    data: dict[str, dict[str, str]] = {}
    section = "default"
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            data.setdefault(section, {})
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        data.setdefault(section, {})[key.strip().upper()] = value.strip()
    return data


def _find_monconfig_files(start: Path) -> list[Path]:
    files: list[Path] = []
    current = start.resolve()
    for _ in range(MAX_DEPTH):
        candidate = current / ".monconfig"
        if candidate.exists():
            files.append(candidate)
        if current.parent == current:
            break
        current = current.parent
    return files


@dataclass(slots=True)
class MonConfig:
    data: dict[str, dict[str, str]]
    workspace_root: Path
    files: list[Path]

    def get(self, section: str, key: str, fallback: str | None = None) -> str | None:
        section_key = section.lower()
        value_key = key.upper()
        env_key = f"{section_key.upper()}_{value_key}"
        return self.data.get(section_key, {}).get(value_key) or os.environ.get(env_key) or fallback

    def number(self, section: str, key: str, fallback: int) -> int:
        raw = self.get(section, key)
        if raw is None or raw == "":
            return fallback
        try:
            return int(float(raw))
        except ValueError:
            return fallback

    def path(self, section: str, key: str, fallback: str) -> Path:
        raw = self.get(section, key, fallback) or fallback
        value = Path(raw)
        return value if value.is_absolute() else self.workspace_root / value


def load_mon_config(start: Path) -> MonConfig:
    files = _find_monconfig_files(start)
    data: dict[str, dict[str, str]] = {}
    for file in reversed(files):
        parsed = _parse_monconfig(file)
        for section, values in parsed.items():
            data[section] = {**data.get(section, {}), **values}
    workspace_root = files[0].parent if files else start.resolve()
    return MonConfig(data=data, workspace_root=workspace_root, files=files)


def _normalize_base_url(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    value = value.replace("://0.0.0.0:", "://127.0.0.1:")
    value = value.replace("://[::]:", "://127.0.0.1:")
    return value


def create_core_base_url(base_url: str | None, host: str | None, port: int) -> str:
    if base_url and base_url.strip():
        return _normalize_base_url(base_url)
    resolved_host = host or "127.0.0.1"
    if resolved_host in {"0.0.0.0", "::"}:
        resolved_host = "127.0.0.1"
    return _normalize_base_url(f"http://{resolved_host}:{port}")


@dataclass(slots=True)
class HubConfig:
    enabled: bool
    address: str
    heartbeat_interval_seconds: int
    service_id: str
    service_name: str
    service_type: str
    version: str
    description: str
    public_host: str


@dataclass(slots=True)
class ServerConfig:
    host: str
    port: int
    vite_port: int
    is_dev: bool
    workspace_root: Path
    log_level: str
    log_file: Path
    plain_log_file: Path
    core_base_url: str
    auth_dev_username: str
    auth_dev_password: str
    startup_self_awake_enabled: bool
    startup_self_awake_delay_seconds: int
    hub: HubConfig


def default_agent_root() -> Path:
    return Path(__file__).resolve().parents[3]


def load_server_config(agent_root: Path | None = None) -> ServerConfig:
    root = (agent_root or default_agent_root()).resolve()
    config = load_mon_config(root)
    core_config = load_mon_config((config.workspace_root / ".." / "Backend" / "Server").resolve())
    hub_host = os.environ.get("MON_AGENT_HUB_HOST") or config.get("hub", "HUB_ZMQ_HOST", "127.0.0.1") or "127.0.0.1"
    hub_port = int(os.environ.get("MON_AGENT_HUB_PORT") or config.number("hub", "HUB_ZMQ_PORT", 40051))

    return ServerConfig(
        host=os.environ.get("MON_AGENT_HOST") or config.get("server", "HOST", "0.0.0.0") or "0.0.0.0",
        port=int(os.environ.get("MON_AGENT_PORT") or config.number("server", "PORT", 40092)),
        vite_port=config.number("server", "WEB_PORT", 40091),
        is_dev=not bool(os.environ.get("MON_AGENT_PROD")),
        workspace_root=Path(os.environ.get("MON_AGENT_WORKSPACE") or str(config.workspace_root)).resolve(),
        log_level=config.get("log", "LEVEL", "INFO") or "INFO",
        log_file=config.path("log", "FILE", "Data/Logs/Text/MonAgent/MonAgent.log"),
        plain_log_file=config.path("log", "PLAIN_FILE", "Data/Logs/Text/MonAgent/MonAgent_plain.log"),
        core_base_url=create_core_base_url(
            os.environ.get("MON_CORE_BASE_URL") or core_config.get("server", "BASE_URL"),
            core_config.get("server", "HOST", "127.0.0.1"),
            core_config.number("server", "PORT", 40011),
        ),
        auth_dev_username=os.environ.get("MON_AGENT_CORE_USERNAME") or config.get("auth_dev", "USERNAME", "") or "",
        auth_dev_password=os.environ.get("MON_AGENT_CORE_PASSWORD") or config.get("auth_dev", "PASSWORD", "") or "",
        startup_self_awake_enabled=(
            os.environ.get("MON_AGENT_STARTUP_SELFAWAKE_ENABLED")
            or config.get("self_awake", "STARTUP_WAKE_ENABLED", "false")
            or "false"
        ).lower()
        == "true",
        startup_self_awake_delay_seconds=int(
            os.environ.get("MON_AGENT_STARTUP_SELFAWAKE_DELAY_SECONDS")
            or config.number("self_awake", "STARTUP_WAKE_DELAY_SECONDS", 2)
        ),
        hub=HubConfig(
            enabled=(os.environ.get("MON_AGENT_HUB_ENABLED") or config.get("hub", "ENABLED", "true") or "true")
            != "false",
            address=os.environ.get("MON_AGENT_HUB_ADDRESS") or f"tcp://{hub_host}:{hub_port}",
            heartbeat_interval_seconds=int(
                os.environ.get("MON_AGENT_HUB_HEARTBEAT_INTERVAL")
                or config.number("hub", "HEARTBEAT_INTERVAL", 30)
            ),
            service_id=config.get("hub", "SERVICE_ID", "monagent-001") or "monagent-001",
            service_name=config.get("hub", "SERVICE_NAME", config.get("service", "NAME", "MonAgent") or "MonAgent")
            or "MonAgent",
            service_type=config.get("hub", "SERVICE_TYPE", "agent_service") or "agent_service",
            version=config.get("service", "VERSION", "0.1.0") or "0.1.0",
            description=config.get("hub", "DESCRIPTION", "MonAgent 本地智能体服务") or "MonAgent 本地智能体服务",
            public_host=config.get("service", "PUBLIC_HOST", config.get("server", "PUBLIC_HOST", "auto") or "auto")
            or "auto",
        ),
    )
