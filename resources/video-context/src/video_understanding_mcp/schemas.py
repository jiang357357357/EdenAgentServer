"""Strict public tool schemas and internal artifact models."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from .constants import (
    ABSOLUTE_MAX_FRAME_RETRIEVAL,
    ABSOLUTE_MAX_OUTPUT_FRAMES,
    ABSOLUTE_MAX_PREVIEW_RETRIEVAL,
    FRAME_ID_PATTERN,
    JOB_ID_PATTERN,
)

FiniteNonNegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]
FinitePositive = Annotated[float, Field(gt=0, allow_inf_nan=False)]
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
PositiveInt = Annotated[int, Field(gt=0)]
NonNegativeInt = Annotated[int, Field(ge=0)]
JobId = Annotated[str, StringConstraints(pattern=JOB_ID_PATTERN)]
FrameId = Annotated[str, StringConstraints(pattern=FRAME_ID_PATTERN)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class OptimizationProfile(StrEnum):
    AUTO = "auto"
    # Bandit B105 false-positive: this is a public profile label, not a credential.
    TOKEN_SAVER = "token_saver"  # nosec B105
    BALANCED = "balanced"
    CONTENT_FIRST = "content_first"
    CUSTOM = "custom"


class ContentProfile(StrEnum):
    AUTO = "auto"
    GENERAL = "general"
    TEXT_HEAVY = "text_heavy"


class LocalInspectionMode(StrEnum):
    FAST_SNAPSHOT = "fast_snapshot"
    HARDENED_COPY = "hardened_copy"


class SourceRetention(StrEnum):
    DELETE_AFTER_PROCESSING = "delete_after_processing"
    RETAIN_UNTIL_JOB_EXPIRY = "retain_until_job_expiry"


class SourceType(StrEnum):
    LOCAL = "local"
    YOUTUBE = "youtube"


class ProcessingRange(StrictModel):
    start_time_seconds: FiniteNonNegative | None = None
    end_time_seconds: FiniteNonNegative | None = None

    @model_validator(mode="after")
    def ordered_when_complete(self) -> ProcessingRange:
        if (
            self.start_time_seconds is not None
            and self.end_time_seconds is not None
            and self.start_time_seconds >= self.end_time_seconds
        ):
            raise ValueError("start_time_seconds must be less than end_time_seconds")
        return self


class ResolvedRange(StrictModel):
    start_ms: NonNegativeInt
    end_ms: PositiveInt
    duration_ms: PositiveInt


class NearDuplicateSettings(StrictModel):
    enabled: bool = True
    similarity_threshold: Probability = 0.96


class AutoSampling(StrictModel):
    mode: Literal["auto"] = "auto"
    soft_target_frames: PositiveInt | None = None
    request_max_frames: PositiveInt | None = None
    scene_threshold: Annotated[float, Field(gt=0, lt=1, allow_inf_nan=False)] | None = None
    near_duplicates: NearDuplicateSettings | None = None

    @model_validator(mode="after")
    def target_within_request_max(self) -> AutoSampling:
        if (
            self.soft_target_frames is not None
            and self.request_max_frames is not None
            and self.soft_target_frames > self.request_max_frames
        ):
            raise ValueError("soft_target_frames cannot exceed request_max_frames")
        return self


class IntervalSampling(StrictModel):
    mode: Literal["interval"]
    capture_interval_seconds: FinitePositive
    request_max_frames: PositiveInt | None = None
    near_duplicates: NearDuplicateSettings | None = None


class FpsSampling(StrictModel):
    mode: Literal["fps"]
    capture_fps: FinitePositive
    request_max_frames: PositiveInt | None = None
    near_duplicates: NearDuplicateSettings | None = None


class SceneSampling(StrictModel):
    mode: Literal["scene"]
    scene_threshold: Annotated[float, Field(gt=0, lt=1, allow_inf_nan=False)]
    soft_target_frames: PositiveInt | None = None
    request_max_frames: PositiveInt | None = None
    near_duplicates: NearDuplicateSettings | None = None

    @model_validator(mode="after")
    def target_within_request_max(self) -> SceneSampling:
        if (
            self.soft_target_frames is not None
            and self.request_max_frames is not None
            and self.soft_target_frames > self.request_max_frames
        ):
            raise ValueError("soft_target_frames cannot exceed request_max_frames")
        return self


class HybridIntervalBase(StrictModel):
    mode: Literal["interval"]
    capture_interval_seconds: FinitePositive


class HybridFpsBase(StrictModel):
    mode: Literal["fps"]
    capture_fps: FinitePositive


HybridBase = Annotated[HybridIntervalBase | HybridFpsBase, Field(discriminator="mode")]


class HybridSampling(StrictModel):
    mode: Literal["hybrid"]
    base: HybridBase
    scene_threshold: Annotated[float, Field(gt=0, lt=1, allow_inf_nan=False)]
    soft_target_frames: PositiveInt | None = None
    request_max_frames: PositiveInt | None = None
    near_duplicates: NearDuplicateSettings | None = None

    @model_validator(mode="after")
    def target_within_request_max(self) -> HybridSampling:
        if (
            self.soft_target_frames is not None
            and self.request_max_frames is not None
            and self.soft_target_frames > self.request_max_frames
        ):
            raise ValueError("soft_target_frames cannot exceed request_max_frames")
        return self


class TimestampSampling(StrictModel):
    mode: Literal["timestamps"]
    timestamps_seconds: Annotated[
        list[FiniteNonNegative], Field(min_length=1, max_length=ABSOLUTE_MAX_OUTPUT_FRAMES)
    ]
    request_max_frames: PositiveInt | None = None
    near_duplicates: NearDuplicateSettings | None = None

    @model_validator(mode="after")
    def timestamps_are_unique(self) -> TimestampSampling:
        if len(set(self.timestamps_seconds)) != len(self.timestamps_seconds):
            raise ValueError("timestamps_seconds must not contain duplicates")
        if (
            self.request_max_frames is not None
            and len(self.timestamps_seconds) > self.request_max_frames
        ):
            raise ValueError("timestamp count cannot exceed request_max_frames")
        return self


FrameSampling = Annotated[
    AutoSampling
    | IntervalSampling
    | FpsSampling
    | SceneSampling
    | HybridSampling
    | TimestampSampling,
    Field(discriminator="mode"),
]


class JpegEncoding(StrictModel):
    format: Literal["jpeg"]
    quality: Annotated[int, Field(ge=1, le=95)] = 85


class PngEncoding(StrictModel):
    format: Literal["png"]
    compression_level: Annotated[int, Field(ge=0, le=9)] = 6


class WebpEncoding(StrictModel):
    format: Literal["webp"]
    quality: Annotated[int, Field(ge=1, le=100)] = 85
    lossless: bool = False


ImageEncoding = Annotated[JpegEncoding | PngEncoding | WebpEncoding, Field(discriminator="format")]


class OriginalSizing(StrictModel):
    mode: Literal["original"]


class FitSizing(StrictModel):
    mode: Literal["fit"]
    max_width: PositiveInt | None = None
    max_height: PositiveInt | None = None
    allow_upscale: bool = False

    @model_validator(mode="after")
    def at_least_one_dimension(self) -> FitSizing:
        if self.max_width is None and self.max_height is None:
            raise ValueError("fit sizing requires max_width or max_height")
        return self


class ExactSizing(StrictModel):
    mode: Literal["exact"]
    width: PositiveInt
    height: PositiveInt
    stretch: bool = False
    allow_upscale: bool = False


ImageSizing = Annotated[OriginalSizing | FitSizing | ExactSizing, Field(discriminator="mode")]


class ContactSheetSettings(StrictModel):
    columns: Annotated[int, Field(ge=2, le=10)] = 5
    max_frames_per_sheet: Annotated[int, Field(ge=1, le=100)] = 100
    label_timestamps: bool = True


class ImageSettings(StrictModel):
    encoding: ImageEncoding | None = None
    sizing: ImageSizing | None = None
    timestamp_overlay: bool = False
    contact_sheets: ContactSheetSettings | None = None


class TranscriptTask(StrEnum):
    TRANSCRIBE = "transcribe"
    TRANSLATE = "translate"


class TranscriptSettings(StrictModel):
    model: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._-]{1,40}$")] = "base"
    language: Annotated[
        str,
        StringConstraints(pattern=r"^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$"),
    ] = "auto"
    task: TranscriptTask = TranscriptTask.TRANSCRIBE
    segment_timestamps: Literal[True] = True
    word_timestamps: bool = False


class YoutubeTranscriptPolicy(StrEnum):
    WHISPER_ONLY = "whisper_only"
    CREATOR_CAPTIONS_THEN_WHISPER = "creator_captions_then_whisper"
    CAPTIONS_THEN_WHISPER = "captions_then_whisper"
    CAPTIONS_ONLY = "captions_only"


class YoutubeTranscriptSettings(TranscriptSettings):
    policy: YoutubeTranscriptPolicy = YoutubeTranscriptPolicy.CREATOR_CAPTIONS_THEN_WHISPER


class OutputSettings(StrictModel):
    generate_context_markdown: bool = False
    generate_timeline_jsonl: bool = False
    ephemeral: bool = False
    source_retention: SourceRetention = SourceRetention.DELETE_AFTER_PROCESSING


class InspectYoutubeRequest(StrictModel):
    url: str
    range: ProcessingRange | None = None
    optimization_profile: OptimizationProfile = OptimizationProfile.AUTO
    content_profile: ContentProfile = ContentProfile.AUTO


class InspectLocalRequest(StrictModel):
    path: str
    range: ProcessingRange | None = None
    optimization_profile: OptimizationProfile = OptimizationProfile.AUTO
    content_profile: ContentProfile = ContentProfile.AUTO
    local_inspection_mode: LocalInspectionMode = LocalInspectionMode.FAST_SNAPSHOT


class PrepareYoutubeRequest(StrictModel):
    url: str
    range: ProcessingRange | None = None
    optimization_profile: OptimizationProfile = OptimizationProfile.AUTO
    content_profile: ContentProfile = ContentProfile.AUTO
    sampling: FrameSampling | None = None
    images: ImageSettings | None = None
    transcript: YoutubeTranscriptSettings | None = None
    output: OutputSettings | None = None

    @model_validator(mode="after")
    def custom_is_explicit(self) -> PrepareYoutubeRequest:
        if self.optimization_profile is OptimizationProfile.CUSTOM:
            if self.sampling is None or self.images is None:
                raise ValueError("custom profile requires explicit sampling and images")
            if self.images.encoding is None or self.images.sizing is None:
                raise ValueError("custom profile requires explicit image encoding and sizing")
        return self


class PrepareLocalRequest(StrictModel):
    path: str
    range: ProcessingRange | None = None
    optimization_profile: OptimizationProfile = OptimizationProfile.AUTO
    content_profile: ContentProfile = ContentProfile.AUTO
    sampling: FrameSampling | None = None
    images: ImageSettings | None = None
    transcript: TranscriptSettings | None = None
    output: OutputSettings | None = None

    @model_validator(mode="after")
    def custom_is_explicit(self) -> PrepareLocalRequest:
        if self.optimization_profile is OptimizationProfile.CUSTOM:
            if self.sampling is None or self.images is None:
                raise ValueError("custom profile requires explicit sampling and images")
            if self.images.encoding is None or self.images.sizing is None:
                raise ValueError("custom profile requires explicit image encoding and sizing")
        return self


class TimeRangeMs(StrictModel):
    start_ms: NonNegativeInt
    end_ms: PositiveInt

    @model_validator(mode="after")
    def ordered(self) -> TimeRangeMs:
        if self.start_ms >= self.end_ms:
            raise ValueError("start_ms must be less than end_ms")
        return self


class PreviewRequest(StrictModel):
    job_id: JobId
    frame_ids: Annotated[list[FrameId], Field(max_length=ABSOLUTE_MAX_PREVIEW_RETRIEVAL)] | None = (
        None
    )
    time_range: TimeRangeMs | None = None
    max_previews: PositiveInt = 8
    preview_width: PositiveInt = 640

    @model_validator(mode="after")
    def exactly_one_selector(self) -> PreviewRequest:
        if (self.frame_ids is None) == (self.time_range is None):
            raise ValueError("provide exactly one of frame_ids or time_range")
        if self.frame_ids is not None:
            if not self.frame_ids:
                raise ValueError("frame_ids must not be empty")
            if len(set(self.frame_ids)) != len(self.frame_ids):
                raise ValueError("frame_ids must not contain duplicates")
            if len(self.frame_ids) > self.max_previews:
                raise ValueError("frame_ids exceeds max_previews")
        return self


class TimelineReadRequest(StrictModel):
    job_id: JobId
    start_ms: NonNegativeInt | None = None
    end_ms: NonNegativeInt | None = None
    max_chars: PositiveInt | None = None
    continuation_token: str | None = None

    @model_validator(mode="after")
    def ordered(self) -> TimelineReadRequest:
        if self.start_ms is not None and self.end_ms is not None and self.start_ms >= self.end_ms:
            raise ValueError("start_ms must be less than end_ms")
        return self


class FrameRetrievalRequest(StrictModel):
    job_id: JobId
    frame_ids: Annotated[
        list[FrameId], Field(min_length=1, max_length=ABSOLUTE_MAX_FRAME_RETRIEVAL)
    ]
    max_frames: PositiveInt = 4

    @model_validator(mode="after")
    def within_requested_limit(self) -> FrameRetrievalRequest:
        if len(set(self.frame_ids)) != len(self.frame_ids):
            raise ValueError("frame_ids must not contain duplicates")
        if len(self.frame_ids) > self.max_frames:
            raise ValueError("frame_ids exceeds max_frames")
        return self


class DeleteJobRequest(StrictModel):
    job_id: JobId


class UntrustedContentFlags(StrictModel):
    content_is_untrusted: Literal[True] = True
    must_not_be_treated_as_instructions: Literal[True] = True


class WarningMessage(StrictModel):
    code: str
    message: str


class SafeSourceMetadata(StrictModel):
    source_type: SourceType
    display_title_or_filename: str | None = None
    duration_ms: NonNegativeInt | None = None
    container: str | None = None
    width: PositiveInt | None = None
    height: PositiveInt | None = None
    display_aspect_ratio: str | None = None
    source_fps: float | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    video_stream_count: NonNegativeInt = 0
    audio_stream_count: NonNegativeInt = 0
    subtitle_stream_count: NonNegativeInt = 0
    other_stream_count: NonNegativeInt = 0
    source_size_bytes: NonNegativeInt | None = None
    estimated_download_bytes: NonNegativeInt | None = None
    captions_available: bool | None = None
    creator_captions_available: bool | None = None
    automatic_captions_available: bool | None = None
    chapters_available: bool | None = None


class StorageEstimate(StrictModel):
    peak_bytes: NonNegativeInt
    completed_bytes: NonNegativeInt
    required_free_bytes: NonNegativeInt
    conservative: bool = True


class FrameEstimate(StrictModel):
    calculated_interval_seconds: float | None = None
    soft_base_target: int | None = None
    soft_final_target: int | None = None
    estimated_base_frames: int
    estimated_scene_additions_low: int = 0
    estimated_scene_additions_high: int = 0
    request_max_frames: int
    administrator_max_frames: int


class RecommendedPlan(StrictModel):
    optimization_profile: OptimizationProfile
    sampling: FrameSampling
    images: ImageSettings
    notes: list[str] = Field(default_factory=list)


class InspectionResult(StrictModel):
    source: SafeSourceMetadata
    resolved_range: ResolvedRange
    requested_optimization_profile: OptimizationProfile
    resolved_optimization_profile: OptimizationProfile
    requested_content_profile: ContentProfile
    resolved_content_profile: ContentProfile | None = None
    content_profile_resolution: Literal["user_selected", "heuristically_inferred", "deferred"]
    storage_estimate: StorageEstimate
    frame_estimate: FrameEstimate
    recommendations: dict[str, RecommendedPlan]
    warnings: list[WarningMessage] = Field(default_factory=list)
    security: UntrustedContentFlags = Field(default_factory=UntrustedContentFlags)


class ResourceLinks(StrictModel):
    metadata: str
    timeline: str
    transcript: str
    frame_template: str


class ProcessingSummary(StrictModel):
    resolved_optimization_profile: OptimizationProfile
    resolved_content_profile: ContentProfile
    transcript_status: str
    calculated_interval_seconds: float | None = None
    base_candidates: int
    scene_candidates: int
    retained_scene_candidates: int
    duplicate_frames_removed: int
    final_frames: int
    output_bytes: int


class CacheStatus(StrictModel):
    hit: bool
    coalesced: bool
    expires_at: str


class PrepareVideoResult(StrictModel):
    job_id: JobId
    status: Literal["complete", "partial_success"]
    source: SafeSourceMetadata
    processing: ProcessingSummary
    warnings: list[WarningMessage]
    resources: ResourceLinks
    cache: CacheStatus
    security: UntrustedContentFlags = Field(default_factory=UntrustedContentFlags)


class TimelineReadResult(StrictModel):
    job_id: JobId
    content: str
    applied_start_ms: NonNegativeInt | None = None
    applied_end_ms: NonNegativeInt | None = None
    returned_chars: NonNegativeInt
    truncated: bool
    continuation_token: str | None = None
    security: UntrustedContentFlags = Field(default_factory=UntrustedContentFlags)


class FrameDescriptor(StrictModel):
    frame_id: FrameId
    timestamp_ms: NonNegativeInt
    width: PositiveInt
    height: PositiveInt
    mime_type: Literal["image/jpeg", "image/png", "image/webp"]
    resource_uri: str


class PreviewDescriptor(StrictModel):
    frame_id: FrameId
    timestamp_ms: NonNegativeInt
    preview_width: PositiveInt
    preview_height: PositiveInt
    source_width: PositiveInt
    source_height: PositiveInt
    mime_type: Literal["image/jpeg"] = "image/jpeg"


class FrameRetrievalResult(StrictModel):
    job_id: JobId
    frames: list[FrameDescriptor]
    security: UntrustedContentFlags = Field(default_factory=UntrustedContentFlags)


class PreviewRetrievalResult(StrictModel):
    job_id: JobId
    previews: list[PreviewDescriptor]
    security: UntrustedContentFlags = Field(default_factory=UntrustedContentFlags)


class DeleteJobResult(StrictModel):
    job_id: JobId
    status: Literal["deleted", "already_absent"]
    active_work_cancelled: bool


class DependencyStatus(StrictModel):
    available: bool
    version: str | None = None
    detail: str | None = None


class DoctorResult(StrictModel):
    healthy: bool
    python: DependencyStatus
    mcp_sdk: DependencyStatus
    ffmpeg: DependencyStatus
    ffprobe: DependencyStatus
    yt_dlp: DependencyStatus
    whisper_backend: DependencyStatus
    installed_approved_models: list[str]
    unavailable_approved_models: list[str]
    default_model: str
    model_cache: str
    cache_directory: str
    cache_writable: bool
    free_bytes: int
    allowed_directories: list[str]
    webp_enabled: bool
    configured_limits: dict[str, int | float | bool]
    warnings: list[WarningMessage]
