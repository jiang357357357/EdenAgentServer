"""Fixed-policy yt-dlp worker. It accepts no arbitrary yt-dlp options."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn, cast

_LANGUAGE = re.compile(r"^[A-Za-z0-9_-]{2,24}$")
_ALLOWED_MEDIA_EXTENSIONS = {"avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"}
_FINAL_MEDIA_NAME = re.compile(r"^media\.([A-Za-z0-9]+)$")
_INCOMPLETE_SUFFIXES = (".part", ".ytdl", ".tmp", ".temp", ".frag", ".fragment")
_SAFE_RECOVERY_CATEGORY = "MaxDownloadsReached"


@dataclass(frozen=True)
class _RecoveryDiagnostic:
    category: str
    finalized_file_existed: bool
    finalized_file_count: int
    incomplete_file_count: int
    postconditions_passed: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "finalized_file_existed": self.finalized_file_existed,
            "finalized_file_count": self.finalized_file_count,
            "incomplete_file_count": self.incomplete_file_count,
            "postconditions_passed": self.postconditions_passed,
        }


class _MaxDownloadsRecoveryFailure(RuntimeError):
    def __init__(self, diagnostic: _RecoveryDiagnostic) -> None:
        super().__init__("post-download validation failed")
        self.diagnostic = diagnostic


class _QuietLogger:
    def debug(self, _message: str) -> None:
        pass

    def info(self, _message: str) -> None:
        pass

    def warning(self, _message: str) -> None:
        pass

    def error(self, _message: str) -> None:
        pass


def _base_options(*, retries: int, timeout: int) -> Any:
    return {
        "quiet": True,
        "no_warnings": True,
        "logger": _QuietLogger(),
        "noplaylist": True,
        "extract_flat": False,
        "socket_timeout": timeout,
        "retries": retries,
        "fragment_retries": retries,
        "file_access_retries": retries,
        "ignoreerrors": False,
        "abort_on_error": True,
        "usenetrc": False,
        "cookiefile": None,
        "cookiesfrombrowser": None,
        "proxy": "",
        "http_headers": {},
        "remote_components": set(),
        "postprocessors": [],
        "max_downloads": 1,
        "writethumbnail": False,
        "writeinfojson": False,
        "writecomments": False,
        "writesubtitles": False,
        "writeautomaticsub": False,
        "allowed_extractors": ["youtube"],
        # One progressive HTTPS format prevents yt-dlp from spawning an implicit FFmpeg merger or
        # external downloader. The project performs all later media decoding through its own
        # supervised, protocol/demuxer-restricted wrappers.
        "format": "best[protocol=https][vcodec!=none][acodec!=none]",
        "compat_opts": set(),
    }


def _sanitized_summary(info: Mapping[str, Any]) -> dict[str, Any]:
    raw_formats = info.get("formats")
    formats: list[Any] = raw_formats if isinstance(raw_formats, list) else []
    estimated_sizes: list[int] = []
    for item in formats:
        if not isinstance(item, dict):
            continue
        value = item.get("filesize") or item.get("filesize_approx")
        if isinstance(value, (int, float)) and value > 0:
            estimated_sizes.append(int(value))
    raw_chapters = info.get("chapters")
    chapters: list[Any] = raw_chapters if isinstance(raw_chapters, list) else []
    raw_subtitles = info.get("subtitles")
    subtitles = cast(dict[str, Any], raw_subtitles) if isinstance(raw_subtitles, dict) else {}
    raw_automatic = info.get("automatic_captions")
    automatic = cast(dict[str, Any], raw_automatic) if isinstance(raw_automatic, dict) else {}
    title = str(info.get("title") or "YouTube video")
    title = " ".join(title.replace("\x00", " ").replace("\t", " ").splitlines())
    selected_size = info.get("filesize") or info.get("filesize_approx")
    estimated_download_bytes = (
        int(selected_size)
        if isinstance(selected_size, (int, float)) and selected_size > 0
        else max(estimated_sizes, default=0) or None
    )
    return {
        "id": str(info.get("id") or ""),
        "title": " ".join(title.split())[:160],
        "duration": info.get("duration"),
        "width": info.get("width"),
        "height": info.get("height"),
        "fps": info.get("fps"),
        "vcodec": info.get("vcodec"),
        "acodec": info.get("acodec"),
        "ext": info.get("ext"),
        "format_id": info.get("format_id"),
        "protocol": info.get("protocol"),
        "estimated_download_bytes": estimated_download_bytes,
        "chapters": [
            {"start_time": chapter.get("start_time"), "end_time": chapter.get("end_time")}
            for chapter in chapters[:1600]
            if isinstance(chapter, dict)
        ],
        "creator_caption_languages": sorted(str(key) for key in subtitles)[:200],
        "automatic_caption_languages": sorted(str(key) for key in automatic)[:200],
        "language": info.get("language"),
        "extractor_key": info.get("extractor_key"),
        "_type": info.get("_type"),
    }


def _validated_single_video(info: Mapping[str, Any], expected_id: str) -> dict[str, Any]:
    summary = _sanitized_summary(info)
    if summary["_type"] in {"playlist", "multi_video"}:
        raise RuntimeError("playlist results are not allowed")
    if summary["id"] != expected_id:
        raise RuntimeError("extractor returned an unexpected video identity")
    if str(summary["extractor_key"]).lower() not in {"youtube"}:
        raise RuntimeError("unexpected extractor")
    entries = info.get("entries")
    if entries is not None and entries != []:
        raise RuntimeError("additional video entries are not allowed")
    requested_downloads = info.get("requested_downloads")
    if requested_downloads is not None and (
        not isinstance(requested_downloads, list) or len(requested_downloads) > 1
    ):
        raise RuntimeError("multiple requested downloads are not allowed")
    return summary


def _validated_progressive_format(info: Mapping[str, Any], expected_id: str) -> dict[str, Any]:
    summary = _validated_single_video(info, expected_id)
    if summary["protocol"] != "https":
        raise RuntimeError("selected format protocol is not allowed")
    if summary["vcodec"] in {None, "none"} or summary["acodec"] in {None, "none"}:
        raise RuntimeError("selected format is not progressive")
    extension = str(summary["ext"] or "").lower()
    if extension not in _ALLOWED_MEDIA_EXTENSIONS:
        raise RuntimeError("selected format container is not allowed")
    format_id = summary["format_id"]
    if not isinstance(format_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", format_id):
        raise RuntimeError("selected format identity is invalid")
    return summary


def _is_incomplete_artifact(path: Path) -> bool:
    name = path.name.lower()
    return (
        name.startswith(".")
        or name.endswith(_INCOMPLETE_SUFFIXES)
        or ".part-" in name
        or ".frag" in name
    )


def _validated_media_candidate(candidate: Path, output_dir: Path) -> tuple[Path, int]:
    if candidate.is_symlink() or not candidate.is_file():
        raise RuntimeError("finalized media is not a regular file")
    resolved_root = output_dir.resolve(strict=True)
    resolved = candidate.resolve(strict=True)
    if not resolved.is_relative_to(resolved_root) or candidate.parent != output_dir:
        raise RuntimeError("finalized media escaped the output directory")
    match = _FINAL_MEDIA_NAME.fullmatch(candidate.name)
    if match is None or match.group(1).lower() not in _ALLOWED_MEDIA_EXTENSIONS:
        raise RuntimeError("finalized media filename is not allowed")
    size = candidate.stat().st_size
    if size <= 0:
        raise RuntimeError("finalized media is empty")
    return candidate, size


def _recover_max_downloads(
    *,
    output_dir: Path,
    preflight: Mapping[str, Any],
    completed_info: Mapping[str, Any] | None,
    expected_id: str,
    max_bytes: int,
) -> tuple[Path, dict[str, Any], _RecoveryDiagnostic]:
    entries = [path for path in output_dir.rglob("*") if path.is_file() or path.is_symlink()]
    finalized = [
        path for path in entries if path.suffix.lstrip(".").lower() in _ALLOWED_MEDIA_EXTENSIONS
    ]
    incomplete = [path for path in entries if _is_incomplete_artifact(path)]
    failed = _RecoveryDiagnostic(
        category=_SAFE_RECOVERY_CATEGORY,
        finalized_file_existed=bool(finalized),
        finalized_file_count=len(finalized),
        incomplete_file_count=len(incomplete),
        postconditions_passed=False,
    )

    def reject() -> NoReturn:
        raise _MaxDownloadsRecoveryFailure(failed)

    if len(finalized) != 1 or incomplete or any(path.is_symlink() for path in entries):
        reject()
    try:
        media_path, media_size = _validated_media_candidate(finalized[0], output_dir)
    except (OSError, RuntimeError):
        reject()
    aggregate_bytes = 0
    try:
        for path in entries:
            if path.is_symlink() or not path.is_file():
                reject()
            aggregate_bytes += path.stat().st_size
    except OSError:
        reject()
    if media_size > max_bytes or aggregate_bytes > max_bytes:
        reject()
    if completed_info is None:
        reject()
    try:
        expected = _validated_progressive_format(preflight, expected_id)
        completed = _validated_progressive_format(completed_info, expected_id)
    except RuntimeError:
        reject()
    format_fields = ("id", "format_id", "protocol", "ext", "vcodec", "acodec")
    if any(completed.get(field) != expected.get(field) for field in format_fields):
        reject()
    if media_path.suffix.lstrip(".").lower() != str(completed["ext"]).lower():
        reject()
    passed = _RecoveryDiagnostic(
        category=_SAFE_RECOVERY_CATEGORY,
        finalized_file_existed=True,
        finalized_file_count=1,
        incomplete_file_count=0,
        postconditions_passed=True,
    )
    summary = dict(completed)
    summary["media_filename"] = media_path.name
    summary["media_size_bytes"] = media_size
    return media_path, summary, passed


def _choose_caption_language(
    info: Mapping[str, Any], *, language: str, allow_automatic: bool
) -> tuple[str | None, bool]:
    raw_manual = info.get("subtitles")
    manual = cast(dict[str, Any], raw_manual) if isinstance(raw_manual, dict) else {}
    raw_automatic = info.get("automatic_captions")
    automatic = cast(dict[str, Any], raw_automatic) if isinstance(raw_automatic, dict) else {}
    preferred = None if language == "auto" else language
    original = info.get("language") if isinstance(info.get("language"), str) else None
    if preferred is not None:
        if _LANGUAGE.fullmatch(preferred) and preferred in manual:
            return preferred, False
        if allow_automatic and _LANGUAGE.fullmatch(preferred) and preferred in automatic:
            return preferred, True
        return None, False
    if original and _LANGUAGE.fullmatch(original) and original in manual:
        return original, False
    valid_manual = sorted(
        key for key in manual if isinstance(key, str) and _LANGUAGE.fullmatch(key)
    )
    if valid_manual:
        return valid_manual[0], False
    if allow_automatic:
        if original and _LANGUAGE.fullmatch(original) and original in automatic:
            return original, True
        valid_auto = sorted(
            key for key in automatic if isinstance(key, str) and _LANGUAGE.fullmatch(key)
        )
        if valid_auto:
            return valid_auto[0], True
    return None, False


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            os.chmod(temporary, 0o600)
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _preflight(args: argparse.Namespace) -> dict[str, Any]:
    import yt_dlp

    options = _base_options(retries=args.retries, timeout=args.socket_timeout)
    with yt_dlp.YoutubeDL(options) as ydl:
        raw = ydl.extract_info(args.url, download=False)
        info = ydl.sanitize_info(raw)
    if not isinstance(info, dict):
        raise RuntimeError("yt-dlp returned invalid metadata")
    return _validated_single_video(info, args.video_id)


def _download(args: argparse.Namespace) -> tuple[dict[str, Any], _RecoveryDiagnostic | None]:
    import yt_dlp

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    options = _base_options(retries=args.retries, timeout=args.socket_timeout)
    completed_info: Mapping[str, Any] | None = None

    def output_bytes() -> int:
        total = 0
        for path in output_dir.rglob("*"):
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
        return total

    def progress_hook(status: dict[str, Any]) -> None:
        nonlocal completed_info
        downloaded = status.get("downloaded_bytes")
        if (
            isinstance(downloaded, int) and downloaded > args.max_bytes
        ) or output_bytes() > args.max_bytes:
            raise yt_dlp.utils.DownloadError("download byte limit exceeded")
        if status.get("status") == "finished" and isinstance(status.get("info_dict"), Mapping):
            completed_info = cast(Mapping[str, Any], status["info_dict"])

    options.update(
        {
            "paths": {"home": str(output_dir)},
            "outtmpl": {
                "default": str(output_dir / "media.%(ext)s"),
                "subtitle": str(output_dir / "caption.%(ext)s"),
            },
            "max_filesize": args.max_bytes,
            "continuedl": False,
            "overwrites": False,
            "progress_hooks": [progress_hook],
        }
    )
    with yt_dlp.YoutubeDL(options) as ydl:
        preflight_raw = ydl.extract_info(args.url, download=False)
        preflight = ydl.sanitize_info(preflight_raw)
    if not isinstance(preflight, dict):
        raise RuntimeError("yt-dlp returned invalid metadata")
    summary = _validated_progressive_format(preflight, args.video_id)
    duration = summary.get("duration")
    if not isinstance(duration, (int, float)) or duration <= 0 or duration > args.max_duration:
        raise RuntimeError("video duration exceeds the configured limit")
    estimated = summary.get("estimated_download_bytes")
    if isinstance(estimated, int) and estimated > args.max_bytes:
        raise RuntimeError("estimated download exceeds the configured byte limit")

    allow_automatic = args.caption_policy == "captions_then_whisper"
    wants_captions = args.caption_policy != "whisper_only"
    language, automatic = _choose_caption_language(
        preflight, language=args.language, allow_automatic=allow_automatic
    )
    if wants_captions and language is not None:
        options["writesubtitles"] = not automatic
        options["writeautomaticsub"] = automatic
        options["subtitleslangs"] = [language]
        options["subtitlesformat"] = "vtt/best"

    diagnostic: _RecoveryDiagnostic | None = None
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            raw = ydl.extract_info(args.url, download=True)
            downloaded_info = ydl.sanitize_info(raw)
        if not isinstance(downloaded_info, dict):
            raise RuntimeError("yt-dlp returned invalid download metadata")
        downloaded_summary = _validated_progressive_format(downloaded_info, args.video_id)
    except yt_dlp.utils.MaxDownloadsReached:
        media_path, downloaded_summary, diagnostic = _recover_max_downloads(
            output_dir=output_dir,
            preflight=preflight,
            completed_info=completed_info,
            expected_id=args.video_id,
            max_bytes=args.max_bytes,
        )
    else:
        media_files = [
            path
            for path in output_dir.rglob("*")
            if (path.is_file() or path.is_symlink())
            and path.suffix.lstrip(".").lower() in _ALLOWED_MEDIA_EXTENSIONS
        ]
        if len(media_files) != 1:
            raise RuntimeError("yt-dlp did not produce exactly one supported media file")
        media_path, media_size = _validated_media_candidate(media_files[0], output_dir)
        if media_size > args.max_bytes or output_bytes() > args.max_bytes:
            raise RuntimeError("downloaded media exceeds the configured byte limit")
        if media_path.suffix.lstrip(".").lower() != str(downloaded_summary["ext"]).lower():
            raise RuntimeError("downloaded media container is inconsistent")

    caption_files = [str(path.name) for path in output_dir.glob("caption.*") if path.is_file()]
    downloaded_summary.update(
        {
            "media_filename": media_path.name,
            "media_size_bytes": media_path.stat().st_size,
            "caption_filenames": sorted(caption_files),
            "selected_caption_language": language,
            "selected_caption_is_automatic": automatic if language else None,
        }
    )
    return downloaded_summary, diagnostic


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--operation", choices=("preflight", "download"), required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--output-dir")
    parser.add_argument("--max-bytes", type=int, default=1)
    parser.add_argument("--max-duration", type=float, default=1)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--socket-timeout", type=int, default=30)
    parser.add_argument("--language", default="auto")
    parser.add_argument(
        "--caption-policy",
        choices=(
            "whisper_only",
            "creator_captions_then_whisper",
            "captions_then_whisper",
            "captions_only",
        ),
        default="creator_captions_then_whisper",
    )
    return parser


def main() -> int:
    os.environ["YTDLP_NO_PLUGINS"] = "1"
    args = _parser().parse_args()
    try:
        diagnostic: _RecoveryDiagnostic | None = None
        if args.operation == "preflight":
            result = _preflight(args)
        else:
            result, diagnostic = _download(args)
        payload: dict[str, Any] = {"ok": True, "result": result}
        if diagnostic is not None:
            payload["diagnostic"] = diagnostic.as_dict()
        _write_json(Path(args.result), payload)
        return 0
    except _MaxDownloadsRecoveryFailure as exc:
        try:
            _write_json(
                Path(args.result),
                {
                    "ok": False,
                    "error": _SAFE_RECOVERY_CATEGORY,
                    "message": "yt-dlp operation failed",
                    "diagnostic": exc.diagnostic.as_dict(),
                },
            )
        except Exception:
            print("yt-dlp worker failed and could not write its result.", file=sys.stderr)
        return 1
    except Exception as exc:
        try:
            _write_json(
                Path(args.result),
                {
                    "ok": False,
                    "error": type(exc).__name__,
                    "message": "yt-dlp operation failed",
                },
            )
        except Exception:
            print("yt-dlp worker failed and could not write its result.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
