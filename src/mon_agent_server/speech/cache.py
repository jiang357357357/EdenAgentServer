from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
from pathlib import Path
from typing import Any, Callable


class SpeechCache:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._lock = threading.RLock()

    @staticmethod
    def cache_key(
        *,
        session_id: str,
        message_id: str,
        segment_id: str,
        config_id: int,
        mode: str,
        text: str,
    ) -> str:
        payload = json.dumps(
            {
                "session_id": session_id,
                "message_id": message_id,
                "segment_id": segment_id,
                "config_id": config_id,
                "mode": mode,
                "text": text,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def synthesize(
        self,
        *,
        session_id: str,
        message_id: str,
        segment_id: str,
        config_id: int,
        mode: str,
        text: str,
        producer: Callable[[], dict[str, Any]],
    ) -> dict[str, Any]:
        key = self.cache_key(
            session_id=session_id,
            message_id=message_id,
            segment_id=segment_id,
            config_id=config_id,
            mode=mode,
            text=text,
        )
        audio_path = self.root / key[:2] / f"{key}.wav"
        with self._lock:
            if audio_path.is_file():
                return {
                    "success": True,
                    "audio_data": base64.b64encode(audio_path.read_bytes()).decode("ascii"),
                    "audio_url": None,
                    "text": text,
                    "cached": True,
                    "cache_key": key,
                }

            result = producer()
            if not result.get("success"):
                return {**result, "cached": False, "cache_key": key}

            audio_data = result.get("audio_data")
            if isinstance(audio_data, str) and audio_data:
                audio = base64.b64decode(audio_data, validate=True)
                audio_path.parent.mkdir(parents=True, exist_ok=True)
                temporary_path = audio_path.with_suffix(f".{os.getpid()}.tmp")
                temporary_path.write_bytes(audio)
                os.replace(temporary_path, audio_path)

            return {**result, "cached": False, "cache_key": key}
