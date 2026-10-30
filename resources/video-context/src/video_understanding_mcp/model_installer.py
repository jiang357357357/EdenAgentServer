"""Explicit-only Whisper model installation."""

from __future__ import annotations

import os
import secrets
import shutil
from pathlib import Path

from faster_whisper.utils import download_model  # type: ignore[import-untyped]

from .config import Settings
from .errors import ErrorCode, VideoMCPError
from .transcription.whisper import installed_model_path


def _private_permissions(root: Path) -> None:
    root.chmod(0o700)
    for path in root.rglob("*"):
        path.chmod(0o700 if path.is_dir() else 0o600)


def install_model(model: str, settings: Settings) -> Path:
    """Download an approved model only when this explicit CLI command is invoked."""
    if model not in settings.approved_whisper_models:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "The Whisper model is not approved.")
    settings.prepare_private_directories()
    existing = installed_model_path(model, settings)
    if existing is not None:
        return existing
    target = settings.resolved_model_cache_dir / model
    temporary = settings.resolved_model_cache_dir / f".install-{model}-{secrets.token_hex(8)}"
    temporary.mkdir(mode=0o700, exist_ok=False)
    try:
        download_model(model, output_dir=str(temporary), local_files_only=False)
        if not (temporary / "config.json").is_file() or not (temporary / "model.bin").is_file():
            raise VideoMCPError(ErrorCode.DEPENDENCY_MISSING, "Model download was incomplete.")
        _private_permissions(temporary)
        if target.exists():
            shutil.rmtree(target)
        os.replace(temporary, target)
        return target
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
