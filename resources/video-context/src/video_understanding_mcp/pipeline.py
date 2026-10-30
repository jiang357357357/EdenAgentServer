"""Shared secure preparation pipeline for local and YouTube sources."""

from __future__ import annotations

import asyncio
import hashlib
import math
import shutil
import time
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .artifacts import write_output_bundle
from .config import Settings
from .constants import CACHE_POLICY_VERSION, ENGLISH_ONLY_WHISPER_MODELS
from .errors import ErrorCode, VideoMCPError
from .inspection import inspect_local, inspect_youtube
from .jobs.cache_key import cache_key
from .jobs.coordinator import JobCoordinator
from .jobs.storage_ledger import storage_ledger
from .jobs.store import JobPaths, JobStore
from .media.audio import extract_transcription_audio
from .media.content import infer_text_heavy
from .media.frames import FrameExtractionResult, extract_frames
from .media.probe import ProbeResult, probe_media
from .media.youtube import download_youtube, preflight_youtube
from .planning.balanced import build_balanced_plan
from .planning.explicit import build_explicit_plan
from .planning.local_token_saver import build_local_token_saver_plan
from .planning.models import FramePlan
from .planning.storage import estimate_storage
from .planning.youtube_content_first import build_youtube_content_first_plan
from .profiles import (
    default_images,
    merge_image_settings,
    resolve_content_profile,
    resolve_optimization_profile,
)
from .schemas import (
    AutoSampling,
    CacheStatus,
    ContentProfile,
    ExactSizing,
    FitSizing,
    ImageSettings,
    InspectionResult,
    InspectLocalRequest,
    InspectYoutubeRequest,
    OptimizationProfile,
    OriginalSizing,
    OutputSettings,
    PrepareLocalRequest,
    PrepareVideoResult,
    PrepareYoutubeRequest,
    ProcessingSummary,
    ResourceLinks,
    SafeSourceMetadata,
    SourceRetention,
    SourceType,
    StorageEstimate,
    TranscriptSettings,
    TranscriptTask,
    WarningMessage,
    YoutubeTranscriptPolicy,
    YoutubeTranscriptSettings,
)
from .security.limits import resolve_processing_range
from .security.paths import secure_copy_source, validate_local_source
from .security.threads import finish_thread_before_cancel
from .security.urls import validate_youtube_url
from .transcription.captions import parse_webvtt
from .transcription.models import TranscriptResult, TranscriptSegment, TranscriptSource
from .transcription.whisper import transcribe_local_audio


def _iso_time(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _resources(job_id: str) -> ResourceLinks:
    root = f"videoctx://jobs/{job_id}"
    return ResourceLinks(
        metadata=f"{root}/metadata",
        timeline=f"{root}/timeline",
        transcript=f"{root}/transcript",
        frame_template=f"{root}/frames/{{frame_id}}",
    )


def _processing_cache_key(
    source_identity: dict[str, Any],
    request: PrepareLocalRequest | PrepareYoutubeRequest,
    settings: Settings,
) -> str:
    """Bind reusable artifacts to content, the full request, and administrator policy."""
    return cache_key(
        source_identity,
        {
            "cache_policy_version": CACHE_POLICY_VERSION,
            "request": request.model_dump(mode="json", exclude_none=False),
            "administrator_policy": settings.model_dump(mode="json", exclude_none=False),
        },
    )


def _plan_for(
    *,
    resolved_profile: OptimizationProfile,
    sampling: Any,
    start_ms: int,
    end_ms: int,
    settings: Settings,
) -> FramePlan:
    if sampling is not None and not isinstance(sampling, AutoSampling):
        return build_explicit_plan(
            sampling,
            start_ms=start_ms,
            end_ms=end_ms,
            administrator_max_frames=settings.max_output_frames,
        )
    request_max = sampling.request_max_frames if isinstance(sampling, AutoSampling) else None
    soft_target = sampling.soft_target_frames if isinstance(sampling, AutoSampling) else None
    scene_threshold = sampling.scene_threshold if isinstance(sampling, AutoSampling) else None
    near_duplicate = (
        sampling.near_duplicates.similarity_threshold
        if isinstance(sampling, AutoSampling) and sampling.near_duplicates is not None
        else None
    )
    if resolved_profile is OptimizationProfile.TOKEN_SAVER:
        plan = build_local_token_saver_plan(
            start_ms=start_ms,
            end_ms=end_ms,
            administrator_max_frames=settings.max_output_frames,
            request_max_frames=request_max,
            soft_target_frames=soft_target,
            scene_threshold=scene_threshold,
            near_duplicate_threshold=near_duplicate,
        )
    elif resolved_profile is OptimizationProfile.CONTENT_FIRST:
        plan = build_youtube_content_first_plan(
            start_ms=start_ms,
            end_ms=end_ms,
            administrator_max_frames=settings.max_output_frames,
            request_max_frames=request_max,
            soft_target_frames=soft_target,
            scene_threshold=scene_threshold,
            near_duplicate_threshold=near_duplicate,
        )
    else:
        plan = build_balanced_plan(
            start_ms=start_ms,
            end_ms=end_ms,
            administrator_max_frames=settings.max_output_frames,
            request_max_frames=request_max,
            soft_target_frames=soft_target,
            scene_threshold=scene_threshold,
            near_duplicate_threshold=near_duplicate,
        )
    if isinstance(sampling, AutoSampling) and sampling.near_duplicates is not None:
        plan = replace(plan, near_duplicate_enabled=sampling.near_duplicates.enabled)
    return plan


def _image_dimensions(images: ImageSettings, source: SafeSourceMetadata) -> tuple[int, int]:
    source_width, source_height = source.width or 1280, source.height or 720
    sizing = images.sizing
    if isinstance(sizing, FitSizing):
        return sizing.max_width or source_width, sizing.max_height or source_height
    if isinstance(sizing, ExactSizing):
        return sizing.width, sizing.height
    if isinstance(sizing, OriginalSizing):
        return source_width, source_height
    raise VideoMCPError(ErrorCode.INVALID_INPUT, "Image sizing was not resolved.")


def _validate_transcript_settings(transcript: TranscriptSettings, settings: Settings) -> None:
    if transcript.model not in settings.approved_whisper_models:
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT, "The selected Whisper model is not administrator-approved."
        )
    if (
        transcript.task is TranscriptTask.TRANSLATE
        and transcript.model in ENGLISH_ONLY_WHISPER_MODELS
    ):
        raise VideoMCPError(
            ErrorCode.INVALID_INPUT, "English-only Whisper models do not support translation."
        )


def _peak_frame_candidates(plan: FramePlan) -> int:
    base_count = plan.base_candidate_count
    if plan.mode in {"scene", "hybrid"}:
        return plan.request_max_frames
    if plan.mode != "auto":
        return base_count
    chapter_candidates = min(32, max(1, base_count // 5))
    if plan.profile == "content_first":
        raw_scene_candidates = min(
            max(0, plan.request_max_frames - base_count), math.ceil(base_count * 0.50)
        )
    else:
        raw_scene_candidates = min(
            max(0, plan.request_max_frames - base_count),
            max(0, (plan.soft_final_target or plan.request_max_frames) - base_count) * 2,
        )
    return min(
        plan.request_max_frames,
        base_count + chapter_candidates + raw_scene_candidates,
    )


def _check_disk(
    *,
    source: SafeSourceMetadata,
    duration_seconds: float,
    plan: FramePlan,
    images: ImageSettings,
    output: OutputSettings,
    settings: Settings,
) -> StorageEstimate:
    width, height = _image_dimensions(images, source)
    if (
        width > settings.max_source_width
        or height > settings.max_source_height
        or width * height > settings.max_output_image_pixels
    ):
        raise VideoMCPError(
            ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Requested output dimensions exceed limits."
        )
    return estimate_storage(
        source_bytes=source.source_size_bytes or source.estimated_download_bytes or 0,
        duration_seconds=duration_seconds,
        frame_count=_peak_frame_candidates(plan),
        width=width,
        height=height,
        images=images,
        required_reserve=settings.min_free_bytes,
        retain_source=output.source_retention is SourceRetention.RETAIN_UNTIL_JOB_EXPIRY,
        contact_sheets=images.contact_sheets is not None,
    )


def _shift_and_clip_whisper(
    result: TranscriptResult, start_ms: int, end_ms: int
) -> TranscriptResult:
    segments = tuple(
        TranscriptSegment(
            max(start_ms, segment.start_ms + start_ms),
            min(end_ms, segment.end_ms + start_ms),
            segment.text,
        )
        for segment in result.segments
        if segment.end_ms + start_ms > start_ms and segment.start_ms + start_ms < end_ms
    )
    return TranscriptResult(
        "complete" if segments else "no_speech",
        result.source,
        result.language,
        segments,
        result.warnings,
        result.model,
    )


def _clip_caption_result(result: TranscriptResult, start_ms: int, end_ms: int) -> TranscriptResult:
    return TranscriptResult(
        result.status,
        result.source,
        result.language,
        tuple(
            TranscriptSegment(
                max(start_ms, segment.start_ms),
                min(end_ms, segment.end_ms),
                segment.text,
            )
            for segment in result.segments
            if segment.end_ms > start_ms and segment.start_ms < end_ms
        ),
        result.warnings,
        result.model,
    )


async def _whisper_or_partial(
    source: Path,
    *,
    probe: ProbeResult,
    selected_range: Any,
    transcript_settings: TranscriptSettings,
    paths: JobPaths,
    settings: Settings,
    warnings: list[WarningMessage],
) -> TranscriptResult:
    if not probe.has_audio:
        warnings.append(WarningMessage(code="NO_AUDIO", message="The video has no audio stream."))
        return TranscriptResult("no_audio", TranscriptSource.NONE, None, ())
    audio_path = paths.audio / "transcription.wav"
    try:
        await extract_transcription_audio(
            source,
            audio_path,
            selected_range=selected_range,
            settings=settings,
        )
        result = await transcribe_local_audio(
            audio_path,
            transcript=transcript_settings,
            working_directory=paths.audio,
            settings=settings,
        )
        return _shift_and_clip_whisper(result, selected_range.start_ms, selected_range.end_ms)
    except VideoMCPError as exc:
        warnings.append(WarningMessage(code=exc.code.value, message=exc.message))
        return TranscriptResult("unavailable", TranscriptSource.NONE, None, ())
    finally:
        await asyncio.to_thread(audio_path.unlink, missing_ok=True)


async def _youtube_transcript(
    source: Path,
    captions: list[Path],
    download_data: dict[str, Any],
    *,
    probe: ProbeResult,
    selected_range: Any,
    transcript_settings: YoutubeTranscriptSettings,
    paths: JobPaths,
    settings: Settings,
    warnings: list[WarningMessage],
) -> TranscriptResult:
    policy = transcript_settings.policy
    may_use_caption = policy is not YoutubeTranscriptPolicy.WHISPER_ONLY
    if may_use_caption and transcript_settings.task.value == "transcribe" and captions:
        automatic = download_data.get("selected_caption_is_automatic") is True
        if automatic and policy is YoutubeTranscriptPolicy.CREATOR_CAPTIONS_THEN_WHISPER:
            warnings.append(
                WarningMessage(
                    code="AUTOMATIC_CAPTION_REJECTED",
                    message="Automatic captions are forbidden by the selected policy.",
                )
            )
        else:
            source_kind = (
                TranscriptSource.AUTOMATIC_CAPTIONS
                if automatic
                else TranscriptSource.CREATOR_CAPTIONS
            )
            language = download_data.get("selected_caption_language")
            try:
                caption_result = await finish_thread_before_cancel(
                    parse_webvtt,
                    captions[0],
                    max_chars=settings.max_transcript_chars,
                    source=source_kind,
                    language=language if isinstance(language, str) else None,
                )
                clipped = _clip_caption_result(
                    caption_result, selected_range.start_ms, selected_range.end_ms
                )
                if clipped.segments:
                    return clipped
                warnings.append(
                    WarningMessage(
                        code="CAPTIONS_EMPTY_IN_RANGE",
                        message="No usable caption cues overlap the selected range.",
                    )
                )
            except VideoMCPError as exc:
                warnings.append(WarningMessage(code=exc.code.value, message=exc.message))
    if policy is YoutubeTranscriptPolicy.CAPTIONS_ONLY:
        warnings.append(
            WarningMessage(
                code="CAPTIONS_UNAVAILABLE",
                message="No usable captions were available under the selected policy.",
            )
        )
        return TranscriptResult("unavailable", TranscriptSource.NONE, None, ())
    return await _whisper_or_partial(
        source,
        probe=probe,
        selected_range=selected_range,
        transcript_settings=transcript_settings,
        paths=paths,
        settings=settings,
        warnings=warnings,
    )


class VideoPipeline:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = JobStore(settings)
        self.store.initialize()
        self.store.cleanup_staging()
        self.store.cleanup_expired()
        self.coordinator = JobCoordinator(settings)
        self.storage = storage_ledger(settings.cache_dir)

    async def shutdown(self) -> None:
        await self.coordinator.shutdown()
        await asyncio.to_thread(self.store.cleanup_staging)

    def _cached(self, key: str) -> PrepareVideoResult | None:
        paths = self.store.find_cached(key)
        if paths is None:
            return None
        try:
            payload = self.store.read_json(paths.root / "result.json")
            result = PrepareVideoResult.model_validate(payload)
            metadata = self.store.read_json(paths.root / "metadata.json")
            expires = float(metadata["expires_epoch"])
        except (VideoMCPError, KeyError, TypeError, ValueError):
            return None
        return result.model_copy(
            update={"cache": CacheStatus(hit=True, coalesced=False, expires_at=_iso_time(expires))}
        )

    async def inspect_local(self, request: InspectLocalRequest) -> InspectionResult:
        key = cache_key(
            {"operation": "inspect-local"}, request.model_dump(mode="json", exclude_none=False)
        )

        async def work() -> InspectionResult:
            return await inspect_local(request, self.settings)

        result, _ = await self.coordinator.run(key, work)
        return result

    async def inspect_youtube(self, request: InspectYoutubeRequest) -> InspectionResult:
        key = cache_key(
            {"operation": "inspect-youtube"}, request.model_dump(mode="json", exclude_none=False)
        )

        async def work() -> InspectionResult:
            return await inspect_youtube(request, self.settings)

        result, _ = await self.coordinator.run(key, work)
        return result

    async def prepare_local(self, request: PrepareLocalRequest) -> PrepareVideoResult:
        validated = validate_local_source(
            request.path,
            allowed_directories=self.settings.allowed_directories,
            max_source_bytes=self.settings.max_source_bytes,
            reject_hardlinks=self.settings.reject_hardlinks,
        )
        provisional_key = _processing_cache_key(
            {
                "type": "local-provisional",
                "device": validated.identity.device,
                "inode": validated.identity.inode,
                "size": validated.identity.size,
                "mtime_ns": validated.identity.mtime_ns,
            },
            request,
            self.settings,
        )

        async def work() -> PrepareVideoResult:
            return await self._prepare_local_validated(request, validated)

        result, coalesced = await self.coordinator.run(provisional_key, work)
        if coalesced:
            result = result.model_copy(
                update={"cache": result.cache.model_copy(update={"coalesced": True})}
            )
        return result

    async def _prepare_local_validated(
        self, request: PrepareLocalRequest, validated: Any
    ) -> PrepareVideoResult:
        paths = self.store.create_staging()
        source_reservation = f"{paths.job_id}:source"
        try:
            await self.storage.reserve(self.store, source_reservation, validated.identity.size)
            try:
                copied = await finish_thread_before_cancel(
                    secure_copy_source,
                    validated,
                    paths.source / f"input{validated.resolved_path.suffix.lower()}",
                    max_source_bytes=self.settings.max_source_bytes,
                    reject_hardlinks=self.settings.reject_hardlinks,
                )
            finally:
                await self.storage.release(source_reservation)
            key = _processing_cache_key(
                {"type": "local", "sha256": copied.sha256, "size": copied.size},
                request,
                self.settings,
            )
            cached = self._cached(key)
            if cached is not None:
                return cached
            return await self._prepare_local_copied(
                request, validated.display_name, copied, paths, key
            )
        finally:
            await self.storage.release(f"{paths.job_id}:output")
            if paths.root.exists():
                await asyncio.to_thread(shutil.rmtree, paths.root, True)

    async def prepare_youtube(self, request: PrepareYoutubeRequest) -> PrepareVideoResult:
        validated = validate_youtube_url(request.url)
        key = _processing_cache_key(
            {"type": "youtube", "video_id": validated.video_id}, request, self.settings
        )
        cached = self._cached(key)
        if cached is not None:
            return cached

        async def work() -> PrepareVideoResult:
            return await self._prepare_youtube_uncached(request, validated, key)

        result, coalesced = await self.coordinator.run(key, work)
        if coalesced:
            result = result.model_copy(
                update={"cache": result.cache.model_copy(update={"coalesced": True})}
            )
        return result

    async def _prepare_local_copied(
        self,
        request: PrepareLocalRequest,
        display_name: str,
        copied: Any,
        paths: JobPaths,
        key: str,
    ) -> PrepareVideoResult:
        try:
            probe = await probe_media(
                copied.path,
                source_type=SourceType.LOCAL,
                display_name=display_name,
                settings=self.settings,
            )
            return await self._process_and_publish(
                request=request,
                source_type=SourceType.LOCAL,
                media=copied.path,
                probe=probe,
                paths=paths,
                key=key,
                captions=[],
                download_data={},
                source_sha256=copied.sha256,
            )
        except BaseException:
            await asyncio.to_thread(shutil.rmtree, paths.root, True)
            raise

    async def _prepare_youtube_uncached(
        self, request: PrepareYoutubeRequest, validated: Any, key: str
    ) -> PrepareVideoResult:
        paths = self.store.create_staging()
        try:
            preflight = await preflight_youtube(
                validated, working_directory=paths.source, settings=self.settings
            )
            duration = preflight.get("duration")
            if not isinstance(duration, (int, float)) or duration <= 0:
                raise VideoMCPError(ErrorCode.DOWNLOAD_FAILED, "YouTube duration is unavailable.")
            if duration > self.settings.max_duration_seconds:
                raise VideoMCPError(
                    ErrorCode.RESOURCE_LIMIT_EXCEEDED, "Video exceeds the duration limit."
                )
            estimated = preflight.get("estimated_download_bytes")
            if isinstance(estimated, int) and estimated > self.settings.max_source_bytes:
                raise VideoMCPError(
                    ErrorCode.RESOURCE_LIMIT_EXCEEDED,
                    "Estimated download exceeds the source byte limit.",
                )
            expected_bytes = (
                estimated
                if isinstance(estimated, int) and estimated > 0
                else self.settings.max_source_bytes
            )
            source_reservation = f"{paths.job_id}:source"
            await self.storage.reserve(self.store, source_reservation, expected_bytes)
            transcript_settings = request.transcript or YoutubeTranscriptSettings(
                model=self.settings.default_whisper_model
            )
            try:
                media, download_data, captions = await download_youtube(
                    validated,
                    working_directory=paths.source,
                    settings=self.settings,
                    caption_policy=transcript_settings.policy,
                    language=transcript_settings.language,
                )
            finally:
                await self.storage.release(source_reservation)
            title = download_data.get("title")
            probe = await probe_media(
                media,
                source_type=SourceType.YOUTUBE,
                display_name=str(title)[:160] if isinstance(title, str) else "YouTube video",
                settings=self.settings,
            )
            selected_caption = bool(download_data.get("selected_caption_language"))
            selected_automatic = download_data.get("selected_caption_is_automatic") is True
            creator_available = bool(download_data.get("creator_caption_languages")) or (
                selected_caption and not selected_automatic
            )
            automatic_available = bool(download_data.get("automatic_caption_languages")) or (
                selected_caption and selected_automatic
            )
            probe = replace(
                probe,
                metadata=probe.metadata.model_copy(
                    update={
                        "captions_available": creator_available or automatic_available,
                        "creator_captions_available": creator_available,
                        "automatic_captions_available": automatic_available,
                    }
                ),
            )
            return await self._process_and_publish(
                request=request,
                source_type=SourceType.YOUTUBE,
                media=media,
                probe=probe,
                paths=paths,
                key=key,
                captions=captions,
                download_data=download_data,
                source_sha256=await finish_thread_before_cancel(_sha256, media),
            )
        except BaseException:
            await asyncio.to_thread(shutil.rmtree, paths.root, True)
            raise
        finally:
            await self.storage.release(f"{paths.job_id}:output")

    async def _process_and_publish(
        self,
        *,
        request: PrepareLocalRequest | PrepareYoutubeRequest,
        source_type: SourceType,
        media: Path,
        probe: ProbeResult,
        paths: JobPaths,
        key: str,
        captions: list[Path],
        download_data: dict[str, Any],
        source_sha256: str,
    ) -> PrepareVideoResult:
        selected_range = resolve_processing_range(
            request.range,
            media_duration_seconds=probe.duration_seconds,
            settings=self.settings,
        )
        resolved_profile = resolve_optimization_profile(request.optimization_profile, source_type)
        heuristic = None
        if request.content_profile is ContentProfile.AUTO:
            heuristic = await infer_text_heavy(
                media,
                duration_seconds=selected_range.duration_ms / 1000,
                working_directory=paths.root,
                settings=self.settings,
            )
        resolved_content, content_resolution = resolve_content_profile(
            request.content_profile, heuristic_text_heavy=heuristic
        )
        images = merge_image_settings(
            default_images(resolved_profile, resolved_content), request.images
        )
        plan = _plan_for(
            resolved_profile=resolved_profile,
            sampling=request.sampling,
            start_ms=selected_range.start_ms,
            end_ms=selected_range.end_ms,
            settings=self.settings,
        )
        output = request.output or OutputSettings()
        if source_type is SourceType.YOUTUBE:
            selected_transcript = request.transcript or YoutubeTranscriptSettings(
                model=self.settings.default_whisper_model
            )
        else:
            selected_transcript = request.transcript or TranscriptSettings(
                model=self.settings.default_whisper_model
            )
        _validate_transcript_settings(selected_transcript, self.settings)
        estimate = await finish_thread_before_cancel(
            _check_disk,
            source=probe.metadata,
            duration_seconds=selected_range.duration_ms / 1000,
            plan=plan,
            images=images,
            output=output,
            settings=self.settings,
        )
        staged_bytes = await asyncio.to_thread(self.store.path_bytes, paths.root)
        output_reservation = f"{paths.job_id}:output"
        await self.storage.reserve(
            self.store,
            output_reservation,
            max(1, estimate.peak_bytes - staged_bytes),
        )
        warnings = [WarningMessage(code="UNTRUSTED_MEDIA", message="Media content is untrusted.")]
        if source_type is SourceType.YOUTUBE:
            transcript_settings = request.transcript or YoutubeTranscriptSettings(
                model=self.settings.default_whisper_model
            )
            if not isinstance(transcript_settings, YoutubeTranscriptSettings):
                raise VideoMCPError(
                    ErrorCode.INTERNAL_ERROR, "The YouTube transcript policy is invalid."
                )
            transcript = await _youtube_transcript(
                media,
                captions,
                download_data,
                probe=probe,
                selected_range=selected_range,
                transcript_settings=transcript_settings,
                paths=paths,
                settings=self.settings,
                warnings=warnings,
            )
        else:
            transcript_settings = request.transcript or TranscriptSettings(
                model=self.settings.default_whisper_model
            )
            transcript = await _whisper_or_partial(
                media,
                probe=probe,
                selected_range=selected_range,
                transcript_settings=transcript_settings,
                paths=paths,
                settings=self.settings,
                warnings=warnings,
            )
        frame_result: FrameExtractionResult = await extract_frames(
            media,
            paths.frames,
            plan=plan,
            images=images,
            source_width=probe.metadata.width or 1,
            source_height=probe.metadata.height or 1,
            chapters=probe.chapters,
            settings=self.settings,
        )
        created = time.time()
        ttl = (
            self.settings.ephemeral_ttl_seconds
            if output.ephemeral
            else self.settings.normal_ttl_seconds
        )
        expires = created + ttl
        artifact = await finish_thread_before_cancel(
            write_output_bundle,
            paths.root,
            job_id=paths.job_id,
            source_type=source_type,
            source=probe.metadata,
            selected_range=selected_range,
            requested_optimization_profile=request.optimization_profile,
            resolved_optimization_profile=resolved_profile,
            requested_content_profile=request.content_profile,
            resolved_content_profile=resolved_content,
            content_profile_resolution=content_resolution,
            plan=plan,
            requested_sampling=(
                request.sampling.model_dump(mode="json", exclude_none=False)
                if request.sampling is not None
                else None
            ),
            source_sha256=source_sha256,
            images=images,
            transcript=transcript,
            frames=frame_result,
            output=output,
            warnings=[item.model_dump(mode="json") for item in warnings],
            created_epoch=created,
            expires_epoch=expires,
            max_output_bytes=self.settings.max_completed_output_bytes,
            max_image_width=self.settings.max_source_width,
            max_image_height=self.settings.max_source_height,
            max_image_pixels=self.settings.max_output_image_pixels,
        )
        status = "partial_success" if transcript.status == "unavailable" else "complete"
        result = PrepareVideoResult(
            job_id=paths.job_id,
            status=status,
            source=probe.metadata,
            processing=ProcessingSummary(
                resolved_optimization_profile=resolved_profile,
                resolved_content_profile=resolved_content,
                transcript_status=transcript.status,
                calculated_interval_seconds=plan.calculated_interval_seconds,
                base_candidates=frame_result.base_candidates,
                scene_candidates=frame_result.scene_candidates,
                retained_scene_candidates=frame_result.retained_scene_candidates,
                duplicate_frames_removed=frame_result.duplicate_frames_removed,
                final_frames=len(frame_result.records),
                output_bytes=artifact.output_bytes,
            ),
            warnings=warnings,
            resources=_resources(paths.job_id),
            cache=CacheStatus(hit=False, coalesced=False, expires_at=_iso_time(expires)),
        )
        self.store.atomic_write_json(paths.root / "cache.json", {"cache_key": key})
        self.store.atomic_write_json(
            paths.root / "result.json", result.model_dump(mode="json", exclude_none=True)
        )
        published = await self.storage.publish(self.store, paths, output_reservation)
        if output.source_retention is SourceRetention.DELETE_AFTER_PROCESSING:
            try:
                await asyncio.to_thread(shutil.rmtree, published.source)
                await asyncio.to_thread(shutil.rmtree, published.audio)
            except OSError as exc:
                await asyncio.to_thread(self.store.delete, published.job_id)
                raise VideoMCPError(
                    ErrorCode.INTERNAL_ERROR, "Private source cleanup failed; the job was removed."
                ) from exc
        return result
