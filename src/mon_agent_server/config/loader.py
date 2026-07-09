from __future__ import annotations

import os
from pathlib import Path

from .environment import environment_context, localize_environment_times, merge_environment_context
from .logs import active_logs_root, publish_log_env_defaults
from .monconfig import MonConfig, load_mon_config
from .schema import EnvironmentConfig, HubConfig, ServerConfig
from .utils import create_core_base_url, env_float, env_path


def default_agent_root() -> Path:
    return Path(__file__).resolve().parents[3]


def load_server_config(agent_root: Path | None = None) -> ServerConfig:
    root = (agent_root or default_agent_root()).resolve()
    config = load_mon_config(root)
    core_config = load_mon_config((config.workspace_root / ".." / "Backend" / "Server").resolve())
    hub_host = os.environ.get("MON_AGENT_HUB_HOST") or config.get("hub", "HUB_ZMQ_HOST", "127.0.0.1") or "127.0.0.1"
    hub_port = int(os.environ.get("MON_AGENT_HUB_PORT") or config.number("hub", "HUB_ZMQ_PORT", 40051))
    log_start_dir = active_logs_root(config.workspace_root)
    log_file = env_path(
        "MON_AGENT_SERVER_LOG_FILE",
        log_start_dir / "Text" / "MonAgent" / "MonAgent.log",
        config.workspace_root,
    )
    plain_log_file = env_path(
        "MON_AGENT_SERVER_PLAIN_LOG_FILE",
        log_start_dir / "Text" / "MonAgent" / "MonAgent_plain.log",
        config.workspace_root,
    )
    render_log_dir = env_path("MON_AGENT_RENDER_LOG_DIR", log_start_dir / "Render", config.workspace_root)
    render_log_file = env_path("MON_AGENT_RENDER_LOG_FILE", render_log_dir / "render.log", config.workspace_root)
    render_plain_log_file = env_path(
        "MON_AGENT_RENDER_PLAIN_LOG_FILE",
        render_log_dir / "render_plain.log",
        config.workspace_root,
    )
    render_panels_file = env_path(
        "MON_AGENT_RENDER_PANELS_FILE",
        render_log_dir / "panels.json",
        config.workspace_root,
    )
    publish_log_env_defaults(
        log_start_dir=log_start_dir,
        log_file=log_file,
        plain_log_file=plain_log_file,
        render_log_dir=render_log_dir,
        render_log_file=render_log_file,
        render_plain_log_file=render_plain_log_file,
        render_panels_file=render_panels_file,
    )

    return ServerConfig(
        host=os.environ.get("MON_AGENT_HOST") or config.get("server", "HOST", "0.0.0.0") or "0.0.0.0",
        port=int(os.environ.get("MON_AGENT_PORT") or config.number("server", "PORT", 40092)),
        vite_port=config.number("server", "WEB_PORT", 40091),
        is_dev=not bool(os.environ.get("MON_AGENT_PROD")),
        workspace_root=Path(os.environ.get("MON_AGENT_WORKSPACE") or str(config.workspace_root)).resolve(),
        log_level=config.get("log", "LEVEL", "INFO") or "INFO",
        log_file=log_file,
        plain_log_file=plain_log_file,
        display_enabled=(
            os.environ.get("MON_AGENT_DISPLAY_ENABLED")
            or config.get("log", "DISPLAY_ENABLED", "true")
            or "true"
        ).lower()
        != "false",
        render_log_dir=render_log_dir,
        render_log_file=render_log_file,
        render_plain_log_file=render_plain_log_file,
        render_panels_file=render_panels_file,
        log_console_enabled=config.boolean("log", "CONSOLE_ENABLED", True),
        log_file_enabled=config.boolean("log", "FILE_ENABLED", True),
        log_color_enabled=config.boolean("log", "COLOR_ENABLED", True),
        log_dual_file_enabled=config.boolean("log", "DUAL_FILE_ENABLED", True),
        log_max_bytes=config.number("log", "MAX_BYTES", 10 * 1024 * 1024),
        log_backup_count=config.number("log", "BACKUP_COUNT", 5),
        core_base_url=create_core_base_url(
            os.environ.get("MON_CORE_BASE_URL") or core_config.get("server", "BASE_URL"),
            core_config.get("server", "HOST", "127.0.0.1"),
            core_config.number("server", "PORT", 40011),
        ),
        auth_dev_username=os.environ.get("MON_AGENT_CORE_USERNAME") or config.get("auth_dev", "USERNAME", "") or "",
        auth_dev_password=os.environ.get("MON_AGENT_CORE_PASSWORD") or config.get("auth_dev", "PASSWORD", "") or "",
        startup_self_awake_enabled=(
            os.environ.get("MON_AGENT_STARTUP_SELFAWAKE_ENABLED")
            or config.get("self_awake", "STARTUP_WAKE_ENABLED", "true")
            or "true"
        ).lower()
        == "true",
        startup_self_awake_delay_seconds=int(
            os.environ.get("MON_AGENT_STARTUP_SELFAWAKE_DELAY_SECONDS")
            or config.number("self_awake", "STARTUP_WAKE_DELAY_SECONDS", 0)
        ),
        environment=EnvironmentConfig(
            timezone=os.environ.get("MON_AGENT_TIMEZONE") or config.get("environment", "TIMEZONE", "Asia/Shanghai") or "Asia/Shanghai",
            locale=os.environ.get("MON_AGENT_LOCALE") or config.get("environment", "LOCALE", "zh-CN") or "zh-CN",
            country=os.environ.get("MON_AGENT_LOCATION_COUNTRY") or config.get("environment", "COUNTRY", "") or "",
            region=os.environ.get("MON_AGENT_LOCATION_REGION") or config.get("environment", "REGION", "") or "",
            city=os.environ.get("MON_AGENT_LOCATION_CITY") or config.get("environment", "CITY", "") or "",
            latitude=env_float("MON_AGENT_LOCATION_LATITUDE", config.get("environment", "LATITUDE")),
            longitude=env_float("MON_AGENT_LOCATION_LONGITUDE", config.get("environment", "LONGITUDE")),
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


__all__ = [
    "MonConfig",
    "EnvironmentConfig",
    "HubConfig",
    "ServerConfig",
    "active_logs_root",
    "create_core_base_url",
    "default_agent_root",
    "environment_context",
    "load_mon_config",
    "load_server_config",
    "localize_environment_times",
    "merge_environment_context",
]
