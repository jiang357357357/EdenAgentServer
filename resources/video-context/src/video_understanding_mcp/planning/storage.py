"""Conservative peak/completed storage estimates."""

from __future__ import annotations

from ..schemas import ImageSettings, JpegEncoding, PngEncoding, StorageEstimate, WebpEncoding


def estimate_storage(
    *,
    source_bytes: int,
    duration_seconds: float,
    frame_count: int,
    width: int,
    height: int,
    images: ImageSettings,
    required_reserve: int,
    retain_source: bool,
    contact_sheets: bool,
) -> StorageEstimate:
    pixels = width * height
    encoding = images.encoding
    if isinstance(encoding, PngEncoding):
        per_frame = pixels * 4 + 64 * 1024
    elif isinstance(encoding, WebpEncoding):
        per_frame = pixels * (4 if encoding.lossless else 3) + 64 * 1024
    elif isinstance(encoding, JpegEncoding):
        per_frame = pixels * 3 + 64 * 1024
    else:
        per_frame = pixels * 3 + 64 * 1024
    final_frames = per_frame * frame_count
    audio = int(duration_seconds * 32_000) + 1024 * 1024
    thumbnails = frame_count * (160 * 90 * 3 + 4096)
    sheets = int(final_frames * 0.15) if contact_sheets else 0
    text_outputs = min(32 * 1024 * 1024, int(duration_seconds * 4096) + 1024 * 1024)
    completed = final_frames + sheets + text_outputs + (source_bytes if retain_source else 0)
    peak = source_bytes + audio + thumbnails + final_frames * 2 + sheets + text_outputs
    peak = int(peak * 1.10)
    return StorageEstimate(
        peak_bytes=peak,
        completed_bytes=completed,
        required_free_bytes=peak + required_reserve,
    )
