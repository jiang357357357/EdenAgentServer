"""Source-specific optimization and adaptive image profile resolution."""

from __future__ import annotations

from dataclasses import dataclass

from .schemas import (
    ContentProfile,
    FitSizing,
    ImageSettings,
    JpegEncoding,
    OptimizationProfile,
    SourceType,
)


@dataclass(frozen=True)
class ResolvedProfile:
    requested: OptimizationProfile
    resolved: OptimizationProfile
    content_requested: ContentProfile
    content_resolved: ContentProfile
    content_resolution: str
    images: ImageSettings


def resolve_optimization_profile(
    requested: OptimizationProfile, source_type: SourceType
) -> OptimizationProfile:
    if requested is not OptimizationProfile.AUTO:
        return requested
    return (
        OptimizationProfile.TOKEN_SAVER
        if source_type is SourceType.LOCAL
        else OptimizationProfile.CONTENT_FIRST
    )


def default_images(profile: OptimizationProfile, content: ContentProfile) -> ImageSettings:
    text_heavy = content is ContentProfile.TEXT_HEAVY
    if profile is OptimizationProfile.TOKEN_SAVER:
        width, height, quality = (1280, 720, 85) if text_heavy else (960, 540, 80)
    else:
        width, height, quality = (1920, 1080, 90) if text_heavy else (1280, 720, 85)
    return ImageSettings(
        encoding=JpegEncoding(format="jpeg", quality=quality),
        sizing=FitSizing(mode="fit", max_width=width, max_height=height),
    )


def resolve_content_profile(
    requested: ContentProfile, *, heuristic_text_heavy: bool | None
) -> tuple[ContentProfile, str]:
    if requested is not ContentProfile.AUTO:
        return requested, "user_selected"
    if heuristic_text_heavy is None:
        return ContentProfile.GENERAL, "deferred"
    return (
        ContentProfile.TEXT_HEAVY if heuristic_text_heavy else ContentProfile.GENERAL,
        "heuristically_inferred",
    )


def merge_image_settings(defaults: ImageSettings, explicit: ImageSettings | None) -> ImageSettings:
    if explicit is None:
        return defaults
    return ImageSettings(
        encoding=explicit.encoding or defaults.encoding,
        sizing=explicit.sizing or defaults.sizing,
        timestamp_overlay=explicit.timestamp_overlay,
        contact_sheets=explicit.contact_sheets,
    )
