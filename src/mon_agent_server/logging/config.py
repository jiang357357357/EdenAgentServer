from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .levels import normalize_level

if TYPE_CHECKING:
    from mon_agent_server.config import ServerConfig


@dataclass
class LoggerConfig:
    console_enabled: bool = True
    file_enabled: bool = True
    color_enabled: bool = True
    dual_file_enabled: bool = True
    level: str = "INFO"
    log_file: Path | None = None
    plain_log_file: Path | None = None
    max_bytes: int = 10 * 1024 * 1024
    backup_count: int = 5


_config = LoggerConfig()


def configure(
    *,
    console_enabled: bool = True,
    file_enabled: bool = True,
    color_enabled: bool = True,
    dual_file_enabled: bool = True,
    level: str = "INFO",
    log_file: Path | str | None = None,
    plain_log_file: Path | str | None = None,
    max_bytes: int = 10 * 1024 * 1024,
    backup_count: int = 5,
) -> None:
    _config.console_enabled = console_enabled
    _config.file_enabled = file_enabled
    _config.color_enabled = color_enabled
    _config.dual_file_enabled = dual_file_enabled
    _config.level = normalize_level(level)
    _config.log_file = Path(log_file) if log_file is not None else None
    _config.plain_log_file = Path(plain_log_file) if plain_log_file is not None else None
    _config.max_bytes = max_bytes
    _config.backup_count = backup_count


def configure_from_server_config(config: ServerConfig) -> None:
    configure(
        console_enabled=config.log_console_enabled,
        file_enabled=config.log_file_enabled,
        color_enabled=config.log_color_enabled,
        dual_file_enabled=config.log_dual_file_enabled,
        level=config.log_level,
        log_file=config.log_file,
        plain_log_file=config.plain_log_file,
        max_bytes=config.log_max_bytes,
        backup_count=config.log_backup_count,
    )


def get_config() -> LoggerConfig:
    return _config
