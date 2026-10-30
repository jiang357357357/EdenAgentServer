"""Private, atomic filesystem-backed job storage."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import Settings
from ..constants import FRAME_ID_PATTERN, JOB_ID_PATTERN
from ..errors import ErrorCode, VideoMCPError

_JOB_ID = re.compile(JOB_ID_PATTERN)
_FRAME_ID = re.compile(FRAME_ID_PATTERN)


@dataclass(frozen=True)
class JobPaths:
    job_id: str
    root: Path
    source: Path
    audio: Path
    frames: Path
    previews: Path


class JobStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.staging_root = settings.cache_dir / "staging"
        self.jobs_root = settings.cache_dir / "jobs"
        self.preview_root = settings.cache_dir / "previews"

    def initialize(self) -> None:
        self.settings.prepare_private_directories()
        for path in (self.staging_root, self.jobs_root, self.preview_root):
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
            with suppress(OSError):
                path.chmod(0o700)

    @staticmethod
    def new_job_id() -> str:
        return secrets.token_urlsafe(24)

    @staticmethod
    def validate_job_id(job_id: str) -> None:
        if not _JOB_ID.fullmatch(job_id):
            raise VideoMCPError(ErrorCode.RESOURCE_INVALID, "The job ID is invalid.")

    @staticmethod
    def validate_frame_id(frame_id: str) -> None:
        if not _FRAME_ID.fullmatch(frame_id):
            raise VideoMCPError(ErrorCode.RESOURCE_INVALID, "The frame ID is invalid.")

    def create_staging(self, job_id: str | None = None) -> JobPaths:
        self.initialize()
        identifier = job_id or self.new_job_id()
        self.validate_job_id(identifier)
        root = self.staging_root / identifier
        root.mkdir(mode=0o700, exist_ok=False)
        source = root / "source"
        audio = root / "audio"
        frames = root / "frames"
        previews = root / "previews"
        for path in (source, audio, frames, previews):
            path.mkdir(mode=0o700)
        return JobPaths(identifier, root, source, audio, frames, previews)

    def publish(self, paths: JobPaths) -> JobPaths:
        destination = self.jobs_root / paths.job_id
        if destination.exists():
            raise VideoMCPError(ErrorCode.INTERNAL_ERROR, "A completed job ID collision occurred.")
        os.replace(paths.root, destination)
        return JobPaths(
            paths.job_id,
            destination,
            destination / "source",
            destination / "audio",
            destination / "frames",
            destination / "previews",
        )

    def get(self, job_id: str) -> JobPaths:
        self.validate_job_id(job_id)
        root = self.jobs_root / job_id
        if (
            not root.is_dir()
            or root.is_symlink()
            or not root.resolve().is_relative_to(self.jobs_root.resolve())
        ):
            raise VideoMCPError(ErrorCode.JOB_NOT_FOUND, "The video job was not found or expired.")
        try:
            metadata = self.read_json(root / "metadata.json")
            expired = float(metadata["expires_epoch"]) <= time.time()
        except (VideoMCPError, KeyError, TypeError, ValueError):
            try:
                expired = root.stat().st_mtime + self.settings.normal_ttl_seconds <= time.time()
            except OSError:
                expired = True
        if expired:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(self.preview_root / job_id, ignore_errors=True)
            raise VideoMCPError(ErrorCode.JOB_NOT_FOUND, "The video job was not found or expired.")
        return JobPaths(
            job_id, root, root / "source", root / "audio", root / "frames", root / "previews"
        )

    def frame_path(self, job_id: str, frame_id: str) -> Path:
        self.validate_frame_id(frame_id)
        paths = self.get(job_id)
        manifest = self.read_json(paths.root / "frame-manifest.json")
        frames = manifest.get("frames")
        if not isinstance(frames, list):
            raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "The frame manifest is unavailable.")
        for item in frames:
            if isinstance(item, dict) and item.get("frame_id") == frame_id:
                filename = item.get("filename")
                if not isinstance(filename, str) or Path(filename).name != filename:
                    break
                candidate = paths.frames / filename
                if candidate.is_file() and candidate.resolve().is_relative_to(
                    paths.frames.resolve()
                ):
                    return candidate
        raise VideoMCPError(ErrorCode.FRAME_NOT_FOUND, "The requested frame was not found.")

    def find_cached(self, key: str, *, now: float | None = None) -> JobPaths | None:
        if not re.fullmatch(r"[0-9a-f]{64}", key) or not self.jobs_root.exists():
            return None
        current = time.time() if now is None else now
        for root in self.jobs_root.iterdir():
            if not root.is_dir() or root.is_symlink() or _JOB_ID.fullmatch(root.name) is None:
                continue
            try:
                cache_data = self.read_json(root / "cache.json")
                metadata = self.read_json(root / "metadata.json")
                expires = float(metadata["expires_epoch"])
            except (VideoMCPError, KeyError, TypeError, ValueError):
                continue
            if cache_data.get("cache_key") == key and expires > current:
                return self.get(root.name)
        return None

    @staticmethod
    def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
        temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
        data = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with temporary.open("x", encoding="utf-8") as handle:
            os.chmod(temporary, 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

    @staticmethod
    def read_json(path: Path) -> dict[str, Any]:
        try:
            with path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            raise VideoMCPError(
                ErrorCode.JOB_NOT_FOUND, "The job metadata is unavailable."
            ) from exc
        if not isinstance(payload, dict):
            raise VideoMCPError(ErrorCode.JOB_NOT_FOUND, "The job metadata is invalid.")
        return payload

    def delete(self, job_id: str) -> bool:
        self.validate_job_id(job_id)
        deleted = False
        for root in (self.jobs_root, self.staging_root, self.preview_root):
            path = root / job_id
            if path.is_symlink():
                path.unlink()
                deleted = True
            elif path.exists():
                shutil.rmtree(path, ignore_errors=False)
                deleted = True
        return deleted

    def cleanup_expired(self, now: float | None = None) -> list[str]:
        current = time.time() if now is None else now
        deleted: list[str] = []
        if not self.jobs_root.exists():
            return deleted
        for root in self.jobs_root.iterdir():
            if not root.is_dir() or root.is_symlink() or not _JOB_ID.fullmatch(root.name):
                continue
            metadata_path = root / "metadata.json"
            try:
                metadata = self.read_json(metadata_path)
                expires = float(metadata["expires_epoch"])
            except (VideoMCPError, KeyError, TypeError, ValueError):
                expires = root.stat().st_mtime + self.settings.normal_ttl_seconds
            if expires <= current:
                shutil.rmtree(root)
                deleted.append(root.name)
        self.cleanup_previews(current)
        return deleted

    def cleanup_previews(self, now: float | None = None) -> None:
        current = time.time() if now is None else now
        if not self.preview_root.exists():
            return
        for root in self.preview_root.iterdir():
            if root.is_symlink():
                root.unlink(missing_ok=True)
            elif (
                root.is_dir() and current - root.stat().st_mtime > self.settings.preview_ttl_seconds
            ):
                shutil.rmtree(root, ignore_errors=True)

    def cleanup_staging(self) -> None:
        """Remove unpublished leftovers before accepting work after a process restart."""
        if not self.staging_root.exists():
            return
        for root in self.staging_root.iterdir():
            if root.is_symlink() and _JOB_ID.fullmatch(root.name):
                root.unlink(missing_ok=True)
            elif root.is_dir() and _JOB_ID.fullmatch(root.name):
                shutil.rmtree(root, ignore_errors=True)

    def cache_bytes(self) -> int:
        total = 0
        for root in (self.staging_root, self.jobs_root, self.preview_root):
            if not root.exists():
                continue
            for path in root.rglob("*"):
                with suppress(OSError):
                    if not path.is_symlink() and path.is_file():
                        total += path.stat().st_size
        return total

    @staticmethod
    def path_bytes(root: Path) -> int:
        total = 0
        if not root.exists() or root.is_symlink():
            return total
        for path in root.rglob("*"):
            with suppress(OSError):
                if not path.is_symlink() and path.is_file():
                    total += path.stat().st_size
        return total

    def evict_oldest(self, required_bytes: int) -> list[str]:
        deleted: list[str] = []
        if not self.jobs_root.exists():
            return deleted
        entries = sorted(
            (path for path in self.jobs_root.iterdir() if path.is_dir() and not path.is_symlink()),
            key=lambda path: path.stat().st_atime,
        )
        for entry in entries:
            if self.cache_bytes() + required_bytes <= self.settings.max_cache_bytes:
                break
            shutil.rmtree(entry)
            deleted.append(entry.name)
        return deleted
