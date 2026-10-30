"""Command-line entry point for stdio serving, diagnostics, and explicit model setup."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from .config import Settings, load_settings
from .doctor import run_doctor
from .errors import VideoMCPError
from .logging import configure_logging
from .model_installer import install_model
from .security.subprocesses import ensure_not_root
from .server import serve_stdio


def _common_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--allow-dir", action="append", default=None, metavar="PATH")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--model-cache-dir", type=Path)
    parser.add_argument("--ffmpeg-path", type=Path)
    parser.add_argument("--ffprobe-path", type=Path)
    parser.add_argument("--max-source-bytes", type=int)
    parser.add_argument("--max-duration-seconds", type=float)
    parser.add_argument("--max-source-width", type=int)
    parser.add_argument("--max-source-height", type=int)
    parser.add_argument("--max-source-pixels", type=int)
    parser.add_argument("--max-source-fps", type=float)
    parser.add_argument("--max-streams", type=int)
    parser.add_argument("--max-output-frames", type=int)
    parser.add_argument("--max-output-image-pixels", type=int)
    parser.add_argument("--max-completed-output-bytes", type=int)
    parser.add_argument("--max-frame-retrieval-bytes", type=int)
    parser.add_argument("--max-frame-retrieval-pixels", type=int)
    parser.add_argument("--max-preview-retrieval-bytes", type=int)
    parser.add_argument("--max-preview-retrieval-pixels", type=int)
    parser.add_argument("--max-concurrent-retrievals", type=int)
    parser.add_argument("--max-pending-retrievals", type=int)
    parser.add_argument("--max-job-wall-seconds", type=int)
    parser.add_argument("--max-subprocess-cpu-seconds", type=int)
    parser.add_argument("--max-subprocess-memory-bytes", type=int)
    parser.add_argument("--max-cache-bytes", type=int)
    parser.add_argument("--min-free-bytes", type=int)
    parser.add_argument("--debug", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--reject-hardlinks", action=argparse.BooleanOptionalAction, default=None)
    return parser


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="video-mcp")
    subparsers = parser.add_subparsers(dest="command", required=True)
    common = _common_parser()
    subparsers.add_parser("serve", parents=[common], help="Run the local stdio MCP server.")
    subparsers.add_parser(
        "doctor", parents=[common], help="Report dependency and configuration health."
    )
    installer = subparsers.add_parser(
        "install-model",
        parents=[common],
        help="Explicitly download one administrator-approved Whisper model.",
    )
    installer.add_argument("model")
    return parser


def _settings(args: argparse.Namespace) -> Settings:
    overrides: dict[str, Any] = {}
    if args.allow_dir is not None:
        overrides["allowed_directories"] = tuple(Path(value) for value in args.allow_dir)
    for name in (
        "cache_dir",
        "model_cache_dir",
        "ffmpeg_path",
        "ffprobe_path",
        "max_source_bytes",
        "max_duration_seconds",
        "max_source_width",
        "max_source_height",
        "max_source_pixels",
        "max_source_fps",
        "max_streams",
        "max_output_frames",
        "max_output_image_pixels",
        "max_completed_output_bytes",
        "max_frame_retrieval_bytes",
        "max_frame_retrieval_pixels",
        "max_preview_retrieval_bytes",
        "max_preview_retrieval_pixels",
        "max_concurrent_retrievals",
        "max_pending_retrievals",
        "max_job_wall_seconds",
        "max_subprocess_cpu_seconds",
        "max_subprocess_memory_bytes",
        "max_cache_bytes",
        "min_free_bytes",
        "debug",
        "reject_hardlinks",
    ):
        value = getattr(args, name, None)
        if value is not None:
            overrides[name] = value
    return load_settings(**overrides)


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        settings = _settings(args)
        configure_logging(debug=settings.debug)
        if args.command == "serve":
            ensure_not_root()
            serve_stdio(settings)
            return 0
        if args.command == "doctor":
            result = asyncio.run(run_doctor(settings))
            print(result.model_dump_json(indent=2))
            return 0 if result.healthy else 1
        if args.command == "install-model":
            destination = install_model(str(args.model), settings)
            print(
                json.dumps(
                    {"installed": str(args.model), "path": str(destination)},
                    sort_keys=True,
                )
            )
            return 0
    except (VideoMCPError, ValueError) as exc:
        if isinstance(exc, VideoMCPError):
            payload = exc.as_dict()
        else:
            payload = {"code": "INVALID_CONFIGURATION", "message": str(exc)}
        print(json.dumps(payload, sort_keys=True), file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
