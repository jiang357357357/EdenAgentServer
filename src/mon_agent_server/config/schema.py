from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


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
class EnvironmentConfig:
    timezone: str
    locale: str
    country: str
    region: str
    city: str
    latitude: float | None
    longitude: float | None


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
    display_enabled: bool
    render_log_dir: Path
    render_log_file: Path
    render_plain_log_file: Path
    render_panels_file: Path
    log_console_enabled: bool
    log_file_enabled: bool
    log_color_enabled: bool
    log_dual_file_enabled: bool
    log_max_bytes: int
    log_backup_count: int
    core_base_url: str
    auth_dev_username: str
    auth_dev_password: str
    startup_self_awake_enabled: bool
    startup_self_awake_delay_seconds: int
    environment: EnvironmentConfig
    hub: HubConfig
