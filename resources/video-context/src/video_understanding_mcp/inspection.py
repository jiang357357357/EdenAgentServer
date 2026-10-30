"""Safe source inspection without transcription or bulk final-frame extraction."""

from __future__ import annotations

import math
import shutil

from .config import Settings
from .errors import ErrorCode, VideoMCPError
from .jobs.storage_ledger import storage_ledger
from .jobs.store import JobStore
from .media.probe import ProbeResult, probe_media
from .media.youtube import preflight_youtube
from .planning.balanced import build_balanced_plan
from .planning.local_token_saver import build_local_token_saver_plan
from .planning.storage import estimate_storage
from .planning.youtube_content_first import build_youtube_content_first_plan
from .profiles import default_images, resolve_content_profile, resolve_optimization_profile
from .recommendations import recommendation_presets
from .schemas import (
    ContentProfile,
    ExactSizing,
    FitSizing,
    FrameEstimate,
    ImageSettings,
    InspectionResult,
    InspectLocalRequest,
    InspectYoutubeRequest,
    LocalInspectionMode,
    OptimizationProfile,
    ProcessingRange,
    SafeSourceMetadata,
    SourceType,
    StorageEstimate,
    WarningMessage,
)
from .security.limits import resolve_processing_range
from .security.paths import secure_copy_source, validate_local_source
from .security.threads import finish_thread_before_cancel
from .security.urls import validate_youtube_url


def _frame_estimate(
    *,
    profile: OptimizationProfile,
    start_ms: int,
    end_ms: int,
    settings: Settings,
) -> FrameEstimate:
    if profile is OptimizationProfile.TOKEN_SAVER:
        plan = build_local_token_saver_plan(
            start_ms=start_ms,
            end_ms=end_ms,
            administrator_max_frames=settings.max_output_frames,
        )
        low, high = 0, max(0, (plan.soft_final_target or 120) - plan.base_candidate_count)
    elif profile is OptimizationProfile.CONTENT_FIRST:
        plan = build_youtube_content_first_plan(
            start_ms=start_ms,
            end_ms=end_ms,
            administrator_max_frames=settings.max_output_frames,
        )
        low = math.floor(plan.base_candidate_count * 0.35)
        high = math.floor(plan.base_candidate_count * 0.50)
    else:
        plan = build_balanced_plan(
            start_ms=start_ms,
            end_ms=end_ms,
            administrator_max_frames=settings.max_output_frames,
            request_max_frames=None,
            soft_target_frames=None,
            scene_threshold=None,
            near_duplicate_threshold=None,
        )
        low, high = 0, math.floor(plan.base_candidate_count * 0.35)
    return FrameEstimate(
        calculated_interval_seconds=plan.calculated_interval_seconds,
        soft_base_target=plan.soft_base_target,
        soft_final_target=plan.soft_final_target,
        estimated_base_frames=plan.base_candidate_count,
        estimated_scene_additions_low=low,
        estimated_scene_additions_high=high,
        request_max_frames=plan.request_max_frames,
        administrator_max_frames=settings.max_output_frames,
    )


def _storage_for_inspection(
    *,
    metadata: SafeSourceMetadata,
    estimate: FrameEstimate,
    images: ImageSettings,
    settings: Settings,
) -> StorageEstimate:
    if isinstance(images.sizing, FitSizing):
        width = images.sizing.max_width or metadata.width or 1280
        height = images.sizing.max_height or metadata.height or 720
    elif isinstance(images.sizing, ExactSizing):
        width = images.sizing.width
        height = images.sizing.height
    else:
        width = metadata.width or 1280
        height = metadata.height or 720
    return estimate_storage(
        source_bytes=metadata.source_size_bytes or metadata.estimated_download_bytes or 0,
        duration_seconds=(metadata.duration_ms or 0) / 1000,
        frame_count=min(
            estimate.request_max_frames,
            estimate.soft_final_target or estimate.estimated_base_frames,
        ),
        width=width,
        height=height,
        images=images,
        required_reserve=settings.min_free_bytes,
        retain_source=False,
        contact_sheets=False,
    )


async def inspect_local(request: InspectLocalRequest, settings: Settings) -> InspectionResult:
    source = validate_local_source(
        request.path,
        allowed_directories=settings.allowed_directories,
        max_source_bytes=settings.max_source_bytes,
        reject_hardlinks=settings.reject_hardlinks,
    )
    store = JobStore(settings)
    store.initialize()
    warnings = [
        WarningMessage(
            code="SNAPSHOT_MAY_BECOME_STALE",
            message="Preparation will revalidate and privately copy the local source.",
        )
    ]
    transient = None
    reservation: str | None = None
    try:
        if request.local_inspection_mode is LocalInspectionMode.HARDENED_COPY:
            transient = store.create_staging()
            reservation = f"{transient.job_id}:inspection"
            await storage_ledger(settings.cache_dir).reserve(
                store, reservation, source.identity.size
            )
            copied = await finish_thread_before_cancel(
                secure_copy_source,
                source,
                transient.source / f"input{source.resolved_path.suffix.lower()}",
                max_source_bytes=settings.max_source_bytes,
                reject_hardlinks=settings.reject_hardlinks,
            )
            probe = await probe_media(
                copied.path,
                source_type=SourceType.LOCAL,
                display_name=source.display_name,
                settings=settings,
            )
        else:
            before = source.resolved_path.stat(follow_symlinks=False)
            probe = await probe_media(
                source.resolved_path,
                source_type=SourceType.LOCAL,
                display_name=source.display_name,
                settings=settings,
            )
            after = source.resolved_path.stat(follow_symlinks=False)
            if (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
            ) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                raise VideoMCPError(
                    ErrorCode.SOURCE_CHANGED, "The local source changed during inspection."
                )
    finally:
        if reservation is not None:
            await storage_ledger(settings.cache_dir).release(reservation)
        if transient is not None:
            shutil.rmtree(transient.root, ignore_errors=True)

    return _finish_inspection(
        probe,
        request.range,
        request.optimization_profile,
        request.content_profile,
        SourceType.LOCAL,
        settings,
        warnings,
    )


async def inspect_youtube(request: InspectYoutubeRequest, settings: Settings) -> InspectionResult:
    validated = validate_youtube_url(request.url)
    store = JobStore(settings)
    store.initialize()
    temporary = store.create_staging()
    try:
        data = await preflight_youtube(
            validated, working_directory=temporary.source, settings=settings
        )
    finally:
        shutil.rmtree(temporary.root, ignore_errors=True)
    duration = _positive_float(data.get("duration"), "YouTube duration")
    if duration > settings.max_duration_seconds:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Video exceeds duration limit.")
    size = data.get("estimated_download_bytes")
    if isinstance(size, int) and size > settings.max_source_bytes:
        raise VideoMCPError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Video exceeds source byte limit.")
    width = _optional_positive_int(data.get("width"))
    height = _optional_positive_int(data.get("height"))
    metadata = SafeSourceMetadata(
        source_type=SourceType.YOUTUBE,
        display_title_or_filename=str(data.get("title") or "YouTube video")[:160],
        duration_ms=round(duration * 1000),
        container=str(data.get("ext"))[:30] if data.get("ext") else None,
        width=width,
        height=height,
        display_aspect_ratio=(f"{width}:{height}" if width and height else None),
        source_fps=_optional_positive_float(data.get("fps")),
        video_codec=str(data.get("vcodec"))[:40] if data.get("vcodec") else None,
        audio_codec=str(data.get("acodec"))[:40] if data.get("acodec") else None,
        estimated_download_bytes=size if isinstance(size, int) and size >= 0 else None,
        captions_available=bool(
            data.get("creator_caption_languages") or data.get("automatic_caption_languages")
        ),
        creator_captions_available=bool(data.get("creator_caption_languages")),
        automatic_captions_available=bool(data.get("automatic_caption_languages")),
        chapters_available=bool(data.get("chapters")),
    )
    probe = ProbeResult(
        metadata=metadata,
        duration_seconds=duration,
        has_video=True,
        has_audio=data.get("acodec") not in (None, "none"),
        chapters=(),
    )
    return _finish_inspection(
        probe,
        request.range,
        request.optimization_profile,
        request.content_profile,
        SourceType.YOUTUBE,
        settings,
        [
            WarningMessage(
                code="YOUTUBE_PREFLIGHT_ESTIMATE",
                message="Download size and selected format may differ after acquisition.",
            )
        ],
    )


def _finish_inspection(
    probe: ProbeResult,
    requested_range: ProcessingRange | None,
    requested_profile: OptimizationProfile,
    requested_content: ContentProfile,
    source_type: SourceType,
    settings: Settings,
    warnings: list[WarningMessage],
) -> InspectionResult:
    resolved_range = resolve_processing_range(
        requested_range,
        media_duration_seconds=probe.duration_seconds,
        settings=settings,
    )
    profile = resolve_optimization_profile(requested_profile, source_type)
    content, content_resolution = resolve_content_profile(
        requested_content, heuristic_text_heavy=None
    )
    estimate = _frame_estimate(
        profile=profile,
        start_ms=resolved_range.start_ms,
        end_ms=resolved_range.end_ms,
        settings=settings,
    )
    images = default_images(profile, content)
    storage = _storage_for_inspection(
        metadata=probe.metadata,
        estimate=estimate,
        images=images,
        settings=settings,
    )
    return InspectionResult(
        source=probe.metadata,
        resolved_range=resolved_range,
        requested_optimization_profile=requested_profile,
        resolved_optimization_profile=profile,
        requested_content_profile=requested_content,
        resolved_content_profile=(None if requested_content is ContentProfile.AUTO else content),
        content_profile_resolution=content_resolution,
        storage_estimate=storage,
        frame_estimate=estimate,
        recommendations=recommendation_presets(requested_content),
        warnings=warnings,
    )


def _positive_float(value: object, label: str) -> float:
    if not isinstance(value, (str, int, float)):
        raise VideoMCPError(ErrorCode.DOWNLOAD_FAILED, f"{label} is unavailable.")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise VideoMCPError(ErrorCode.DOWNLOAD_FAILED, f"{label} is unavailable.") from exc
    if not math.isfinite(result) or result <= 0:
        raise VideoMCPError(ErrorCode.DOWNLOAD_FAILED, f"{label} is invalid.")
    return result


def _optional_positive_float(value: object) -> float | None:
    if not isinstance(value, (str, int, float)):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and result > 0 else None


def _optional_positive_int(value: object) -> int | None:
    if not isinstance(value, (str, int, float)):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if result > 0 else None
