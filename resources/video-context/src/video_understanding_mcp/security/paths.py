"""Local-file allowlist, file-identity, and secure-copy boundary."""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from ..constants import VIDEO_EXTENSIONS
from ..errors import ErrorCode, VideoMCPError


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int
    size: int
    mtime_ns: int
    links: int


@dataclass(frozen=True)
class ValidatedLocalSource:
    resolved_path: Path
    identity: FileIdentity
    display_name: str


@dataclass(frozen=True)
class CopiedSource:
    path: Path
    sha256: str
    size: int


def is_windows_network_path(raw_path: str) -> bool:
    normalized = raw_path.replace("/", "\\")
    path = PureWindowsPath(normalized)
    return normalized.startswith("\\\\") or bool(path.drive.startswith("\\\\"))


def _identity(info: os.stat_result) -> FileIdentity:
    return FileIdentity(
        device=int(info.st_dev),
        inode=int(info.st_ino),
        size=int(info.st_size),
        mtime_ns=int(info.st_mtime_ns),
        links=int(info.st_nlink),
    )


def _inside(path: Path, roots: tuple[Path, ...]) -> bool:
    return any(path == root or path.is_relative_to(root) for root in roots)


def validate_local_source(
    raw_path: str,
    *,
    allowed_directories: tuple[Path, ...],
    max_source_bytes: int,
    reject_hardlinks: bool = True,
) -> ValidatedLocalSource:
    if not allowed_directories:
        raise VideoMCPError(
            ErrorCode.LOCAL_INPUT_DISABLED,
            "Local input is disabled until an allowed directory is configured.",
        )
    if "\x00" in raw_path or is_windows_network_path(raw_path):
        raise VideoMCPError(ErrorCode.UNSAFE_PATH, "Network and malformed paths are not allowed.")

    requested = Path(raw_path).expanduser()
    try:
        resolved = requested.resolve(strict=True)
        info = resolved.stat(follow_symlinks=False)
    except (FileNotFoundError, OSError) as exc:
        raise VideoMCPError(ErrorCode.INVALID_INPUT, "The local source does not exist.") from exc

    if not _inside(resolved, allowed_directories):
        raise VideoMCPError(
            ErrorCode.PATH_NOT_ALLOWED, "The local source is outside allowed directories."
        )
    if not stat.S_ISREG(info.st_mode):
        raise VideoMCPError(ErrorCode.UNSAFE_PATH, "The local source must be a regular file.")
    if resolved.suffix.lower() not in VIDEO_EXTENSIONS:
        raise VideoMCPError(
            ErrorCode.UNSUPPORTED_MEDIA, "The local source extension is not allowed."
        )
    if info.st_size <= 0:
        raise VideoMCPError(ErrorCode.UNSUPPORTED_MEDIA, "The local source is empty.")
    if info.st_size > max_source_bytes:
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            "The local source exceeds the configured byte limit.",
        )
    if reject_hardlinks and os.name != "nt" and info.st_nlink > 1:
        raise VideoMCPError(
            ErrorCode.UNSAFE_PATH,
            "Files with multiple hard links are rejected by the configured local-file policy.",
        )
    return ValidatedLocalSource(
        resolved_path=resolved,
        identity=_identity(info),
        display_name=_sanitize_display_name(resolved.name),
    )


def _sanitize_display_name(name: str, max_chars: int = 120) -> str:
    clean = " ".join(name.replace("\x00", " ").replace("\t", " ").splitlines())
    clean = " ".join(clean.split())
    return clean[:max_chars] or "unnamed-video"


def secure_copy_source(
    source: ValidatedLocalSource,
    destination: Path,
    *,
    max_source_bytes: int,
    reject_hardlinks: bool = True,
) -> CopiedSource:
    try:
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise VideoMCPError(
            ErrorCode.INSUFFICIENT_DISK, "The private staging directory is unavailable."
        ) from exc
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        source_fd = os.open(source.resolved_path, flags)
    except OSError as exc:
        raise VideoMCPError(
            ErrorCode.SOURCE_CHANGED, "The local source could not be securely reopened."
        ) from exc
    destination_fd = -1
    try:
        opened = os.fstat(source_fd)
        opened_identity = _identity(opened)
        if not stat.S_ISREG(opened.st_mode) or opened_identity != source.identity:
            raise VideoMCPError(
                ErrorCode.SOURCE_CHANGED, "The local source changed before copying."
            )
        if reject_hardlinks and os.name != "nt" and opened.st_nlink > 1:
            raise VideoMCPError(ErrorCode.UNSAFE_PATH, "The local source has multiple hard links.")

        destination_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        digest = hashlib.sha256()
        copied = 0
        with (
            os.fdopen(source_fd, "rb", closefd=False) as src,
            os.fdopen(destination_fd, "wb", closefd=False) as dst,
        ):
            while chunk := src.read(1024 * 1024):
                copied += len(chunk)
                if copied > max_source_bytes:
                    raise VideoMCPError(
                        ErrorCode.RESOURCE_LIMIT_EXCEEDED,
                        "The local source exceeded the byte limit while copying.",
                    )
                digest.update(chunk)
                dst.write(chunk)
            dst.flush()
            os.fsync(destination_fd)

        final_identity = _identity(os.fstat(source_fd))
        if final_identity != opened_identity or copied != opened_identity.size:
            raise VideoMCPError(ErrorCode.SOURCE_CHANGED, "The local source changed while copying.")
        destination.chmod(0o600)
        return CopiedSource(path=destination, sha256=digest.hexdigest(), size=copied)
    except VideoMCPError:
        destination.unlink(missing_ok=True)
        raise
    except OSError as exc:
        destination.unlink(missing_ok=True)
        raise VideoMCPError(
            ErrorCode.INSUFFICIENT_DISK, "The private source copy could not be completed."
        ) from exc
    finally:
        os.close(source_fd)
        if destination_fd >= 0:
            os.close(destination_fd)


def hardened_transient_copy(
    source: ValidatedLocalSource,
    directory: Path,
    *,
    max_source_bytes: int,
    reject_hardlinks: bool,
) -> CopiedSource:
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    destination = directory / f"source{source.resolved_path.suffix.lower()}"
    try:
        return secure_copy_source(
            source,
            destination,
            max_source_bytes=max_source_bytes,
            reject_hardlinks=reject_hardlinks,
        )
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
