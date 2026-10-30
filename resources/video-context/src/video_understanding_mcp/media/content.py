"""Small deterministic visual-complexity heuristic for adaptive image defaults."""

from __future__ import annotations

import asyncio
import importlib
import shutil
from pathlib import Path
from typing import Any

from ..config import Settings
from ..constants import LOCAL_FORMAT_WHITELIST, LOCAL_PROTOCOL_WHITELIST
from ..security.subprocesses import run_process
from ..security.threads import finish_thread_before_cancel
from .probe import resolve_executable

_IMAGE: Any = importlib.import_module("PIL.Image")
_IMAGE_FILTER: Any = importlib.import_module("PIL.ImageFilter")


def _pixels(image: Any) -> list[int]:
    flattened = getattr(image, "get_flattened_data", None)
    return list(flattened() if callable(flattened) else image.getdata())


def _edge_score(paths: list[Path]) -> float:
    scores: list[float] = []
    for path in paths:
        with _IMAGE.open(path) as image:
            grayscale = image.convert("L")
            edges = grayscale.filter(_IMAGE_FILTER.FIND_EDGES)
            pixels = _pixels(edges)
        if pixels:
            scores.append(sum(value >= 36 for value in pixels) / len(pixels))
    return sum(scores) / len(scores) if scores else 0.0


async def infer_text_heavy(
    source: Path,
    *,
    duration_seconds: float,
    working_directory: Path,
    settings: Settings,
) -> bool:
    """Sample at most three tiny images; failures conservatively resolve to general content."""
    sample_dir = working_directory / "content-samples"
    await asyncio.to_thread(sample_dir.mkdir, mode=0o700, exist_ok=False)
    try:
        ffmpeg = resolve_executable(settings.ffmpeg_path, "ffmpeg")
        interval = max(1.0, duration_seconds / 3.0)
        output = sample_dir / "sample-%02d.jpg"
        arguments = [
            str(ffmpeg),
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            LOCAL_PROTOCOL_WHITELIST,
            "-format_whitelist",
            LOCAL_FORMAT_WHITELIST,
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            f"fps=1/{interval:.6f},scale=640:360:force_original_aspect_ratio=decrease",
            "-frames:v",
            "3",
            "-q:v",
            "4",
            "-y",
            str(output),
        ]
        result = await run_process(
            arguments,
            timeout_seconds=min(settings.subprocess_timeout_seconds, 180),
            cwd=sample_dir,
            cpu_time_limit_seconds=settings.max_subprocess_cpu_seconds,
            memory_limit_bytes=settings.max_subprocess_memory_bytes,
        )
        if result.returncode != 0:
            return False
        paths = sorted(sample_dir.glob("sample-*.jpg"))[:3]
        return await finish_thread_before_cancel(_edge_score, paths) >= 0.12
    finally:
        await asyncio.to_thread(shutil.rmtree, sample_dir, True)
