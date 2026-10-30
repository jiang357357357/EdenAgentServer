"""Process-local storage reservations shared by preparation, inspection, and retrieval."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from ..errors import ErrorCode, VideoMCPError
from .store import JobPaths, JobStore


class StorageLedger:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._reservations: dict[str, int] = {}

    async def reserve(self, store: JobStore, identifier: str, future_bytes: int) -> None:
        amount = max(1, future_bytes)
        async with self._lock:
            if identifier in self._reservations:
                raise VideoMCPError(
                    ErrorCode.INTERNAL_ERROR, "A storage reservation collision occurred."
                )
            reserved = sum(self._reservations.values()) + amount
            store.evict_oldest(reserved)
            if store.cache_bytes() + reserved > store.settings.max_cache_bytes:
                raise VideoMCPError(
                    ErrorCode.INSUFFICIENT_DISK, "The private cache limit is exhausted."
                )
            free = shutil.disk_usage(store.settings.cache_dir).free
            if free < reserved + store.settings.min_free_bytes:
                raise VideoMCPError(ErrorCode.INSUFFICIENT_DISK, "Insufficient free disk space.")
            self._reservations[identifier] = amount

    async def release(self, identifier: str) -> None:
        async with self._lock:
            self._reservations.pop(identifier, None)

    async def publish(
        self, store: JobStore, paths: JobPaths, reservation_identifier: str
    ) -> JobPaths:
        """Recheck actual staging plus other reservations and publish under the same lock."""
        async with self._lock:
            self._reservations.pop(reservation_identifier, None)
            reserved = sum(self._reservations.values())
            store.evict_oldest(reserved)
            if store.cache_bytes() + reserved > store.settings.max_cache_bytes:
                raise VideoMCPError(
                    ErrorCode.INSUFFICIENT_DISK,
                    "The completed job would exceed the private cache limit.",
                )
            free = shutil.disk_usage(store.settings.cache_dir).free
            if free < reserved + store.settings.min_free_bytes:
                raise VideoMCPError(
                    ErrorCode.INSUFFICIENT_DISK,
                    "Insufficient free disk space to publish the completed job.",
                )
            return store.publish(paths)


_LEDGERS: dict[Path, StorageLedger] = {}


def storage_ledger(cache_dir: Path) -> StorageLedger:
    key = cache_dir.resolve(strict=False)
    ledger = _LEDGERS.get(key)
    if ledger is None:
        ledger = StorageLedger()
        _LEDGERS[key] = ledger
    return ledger
