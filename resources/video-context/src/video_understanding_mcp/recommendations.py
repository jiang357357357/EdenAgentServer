"""Deterministic inspection recommendations."""

from __future__ import annotations

from .profiles import default_images
from .schemas import (
    AutoSampling,
    ContentProfile,
    NearDuplicateSettings,
    OptimizationProfile,
    RecommendedPlan,
)


def recommendation_presets(content_profile: ContentProfile) -> dict[str, RecommendedPlan]:
    content = ContentProfile.GENERAL if content_profile is ContentProfile.AUTO else content_profile
    return {
        "token_saver": RecommendedPlan(
            optimization_profile=OptimizationProfile.TOKEN_SAVER,
            sampling=AutoSampling(
                soft_target_frames=120,
                request_max_frames=180,
                scene_threshold=0.45,
                near_duplicates=NearDuplicateSettings(similarity_threshold=0.94),
            ),
            images=default_images(OptimizationProfile.TOKEN_SAVER, content),
            notes=["Approximately 90 regular base frames for videos longer than 4.5 minutes."],
        ),
        "balanced": RecommendedPlan(
            optimization_profile=OptimizationProfile.BALANCED,
            sampling=AutoSampling(
                scene_threshold=0.35,
                near_duplicates=NearDuplicateSettings(similarity_threshold=0.96),
            ),
            images=default_images(OptimizationProfile.BALANCED, content),
        ),
        "content_first": RecommendedPlan(
            optimization_profile=OptimizationProfile.CONTENT_FIRST,
            sampling=AutoSampling(
                scene_threshold=0.30,
                near_duplicates=NearDuplicateSettings(similarity_threshold=0.98),
            ),
            images=default_images(OptimizationProfile.CONTENT_FIRST, content),
            notes=["Scene additions are bounded by qualified 35-50% budgets."],
        ),
    }
