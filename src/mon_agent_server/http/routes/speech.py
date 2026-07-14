from __future__ import annotations

from typing import Any

from ...core import require_core_token


def handle_speech(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if path != "/speech/synthesize" or method != "POST":
        return False

    token = require_core_token(handler.headers)
    body = handler.read_json_body()
    session_id = str(body.get("session_id") or "").strip()
    message_id = str(body.get("message_id") or "").strip()
    segment_id = str(body.get("segment_id") or "").strip()
    text = str(body.get("text") or "").strip()
    mode = str(body.get("mode") or "").strip().lower()
    try:
        config_id = int(body.get("config_id"))
    except (TypeError, ValueError):
        config_id = 0

    missing = [
        name
        for name, value in (
            ("session_id", session_id),
            ("message_id", message_id),
            ("segment_id", segment_id),
            ("text", text),
            ("config_id", config_id),
        )
        if not value
    ]
    if missing or mode not in {"text_only", "all"}:
        handler.json_response({"error": f"invalid speech request: {', '.join(missing) or 'mode'}"}, 400)
        return True

    handler.app.ensure_hydrated(token, session_id)
    session = handler.app.store.require_session(session_id)
    if not any(message.get("info", {}).get("id") == message_id for message in session.get("messages", [])):
        handler.json_response({"error": "message not found in session"}, 404)
        return True

    result = handler.app.speech_cache.synthesize(
        session_id=session_id,
        message_id=message_id,
        segment_id=segment_id,
        config_id=config_id,
        mode=mode,
        text=text,
        producer=lambda: handler.app.core_client.synthesize_speech(token, text, config_id),
    )
    handler.json_response(result, 200 if result.get("success") else 502)
    return True
