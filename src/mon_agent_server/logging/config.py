from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Mapping

from .levels import normalize_level

if TYPE_CHECKING:
    from mon_agent_server.config import ServerConfig


@dataclass(frozen=True)
class LogFilePair:
    colored: Path | None = None
    plain: Path | None = None


def _to_path(value: Path | str | None) -> Path | None:
    return Path(value) if value is not None else None


def _safe_log_name(name: str) -> str:
    value = re.sub(r"[^0-9A-Za-z._-]+", "_", name.strip() or "MonAgent")
    return value.strip("._-") or "MonAgent"


def _infer_text_log_root(log_file: Path | None, default_main: str) -> Path | None:
    if log_file is None:
        return None
    parent = log_file.parent
    if parent.name == default_main and parent.parent.name:
        return parent.parent
    return parent


@dataclass
class LoggerConfig:
    console_enabled: bool = True
    file_enabled: bool = True
    color_enabled: bool = True
    dual_file_enabled: bool = True
    level: str = "INFO"
    log_root: Path | None = None
    text_log_root: Path | None = None
    log_file: Path | None = None
    plain_log_file: Path | None = None
    max_bytes: int = 10 * 1024 * 1024
    backup_count: int = 5
    default_main: str = "MonAgent"
    module_files: dict[str, LogFilePair] = field(default_factory=dict)

    def files_for(self, main: str) -> LogFilePair:
        module_name = main or self.default_main
        configured = self.module_files.get(module_name)
        if configured is not None:
            return configured

        text_root = self.text_log_root or _infer_text_log_root(self.log_file, self.default_main)
        if text_root is None:
            return LogFilePair()

        safe_name = _safe_log_name(module_name)
        log_dir = text_root / safe_name
        return LogFilePair(
            colored=log_dir / f"{safe_name}.log",
            plain=log_dir / f"{safe_name}_plain.log",
        )


_config = LoggerConfig()


def configure(
    *,
    console_enabled: bool = True,
    file_enabled: bool = True,
    color_enabled: bool = True,
    dual_file_enabled: bool = True,
    level: str = "INFO",
    log_root: Path | str | None = None,
    text_log_root: Path | str | None = None,
    log_file: Path | str | None = None,
    plain_log_file: Path | str | None = None,
    max_bytes: int = 10 * 1024 * 1024,
    backup_count: int = 5,
    default_main: str = "MonAgent",
    module_files: Mapping[str, LogFilePair] | None = None,
) -> None:
    _config.console_enabled = console_enabled
    _config.file_enabled = file_enabled
    _config.color_enabled = color_enabled
    _config.dual_file_enabled = dual_file_enabled
    _config.level = normalize_level(level)
    _config.log_root = _to_path(log_root)
    _config.text_log_root = _to_path(text_log_root) or _infer_text_log_root(_to_path(log_file), default_main)
    _config.log_file = _to_path(log_file)
    _config.plain_log_file = _to_path(plain_log_file)
    _config.max_bytes = max_bytes
    _config.backup_count = backup_count
    _config.default_main = default_main
    _config.module_files = dict(module_files or {})
    if _config.log_file is not None:
        _config.module_files.setdefault(
            default_main,
            LogFilePair(colored=_config.log_file, plain=_config.plain_log_file),
        )


def configure_from_server_config(config: ServerConfig) -> None:
    log_root = config.log_file.parent.parent.parent if config.log_file.parent.parent.name == "Text" else None
    configure(
        console_enabled=config.log_console_enabled,
        file_enabled=config.log_file_enabled,
        color_enabled=config.log_color_enabled,
        dual_file_enabled=config.log_dual_file_enabled,
        level=config.log_level,
        log_root=log_root,
        text_log_root=_infer_text_log_root(config.log_file, "MonAgent"),
        log_file=config.log_file,
        plain_log_file=config.plain_log_file,
        max_bytes=config.log_max_bytes,
        backup_count=config.log_backup_count,
        default_main="MonAgent",
    )


def get_config() -> LoggerConfig:
    return _config
