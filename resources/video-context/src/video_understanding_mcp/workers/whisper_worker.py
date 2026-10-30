"""Isolated faster-whisper worker that may only load an installed local model."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel  # type: ignore[import-untyped]

_LANGUAGE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--task", choices=("transcribe", "translate"), default="transcribe")
    parser.add_argument("--word-timestamps", choices=("true", "false"), default="false")
    parser.add_argument("--max-chars", type=int, required=True)
    return parser


def _clean_text(value: str) -> str:
    return " ".join(value.replace("\x00", " ").replace("\t", " ").splitlines()).strip()


def _transcribe(args: argparse.Namespace) -> dict[str, Any]:
    audio = Path(args.audio).resolve(strict=True)
    model_path = Path(args.model_path).resolve(strict=True)
    if not audio.is_file() or not model_path.is_dir():
        raise RuntimeError("local audio or model directory is unavailable")
    language = None if args.language == "auto" else args.language
    if language is not None and _LANGUAGE.fullmatch(language) is None:
        raise RuntimeError("language is invalid")
    model = WhisperModel(
        str(model_path),
        device="cpu",
        compute_type="int8",
        local_files_only=True,
    )
    raw_segments, info = model.transcribe(
        str(audio),
        language=language,
        task=args.task,
        word_timestamps=args.word_timestamps == "true",
        vad_filter=True,
    )
    segments: list[dict[str, Any]] = []
    total_chars = 0
    for item in raw_segments:
        text = _clean_text(item.text)
        if not text:
            continue
        total_chars += len(text)
        if total_chars > args.max_chars:
            raise RuntimeError("transcript character limit exceeded")
        start_ms = max(0, round(float(item.start) * 1000))
        end_ms = max(start_ms + 1, round(float(item.end) * 1000))
        segments.append({"start_ms": start_ms, "end_ms": end_ms, "text": text})
    return {
        "language": str(getattr(info, "language", "")) or None,
        "segments": segments,
        "status": "complete" if segments else "no_speech",
    }


def _write_result(path: Path, payload: dict[str, Any]) -> None:
    with path.open("x", encoding="utf-8") as handle:
        os.chmod(path, 0o600)
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))


def main() -> int:
    args = _parser().parse_args()
    try:
        result = _transcribe(args)
        payload: dict[str, Any] = {"ok": True, "result": result}
        code = 0
    except Exception as exc:
        payload = {"ok": False, "error_type": type(exc).__name__}
        code = 1
    _write_result(Path(args.result), payload)
    return code


if __name__ == "__main__":
    sys.exit(main())
