from __future__ import annotations

from typing import Any

from ...core import require_core_token


def handle_speech(handler: Any, path: str, query: dict[str, list[str]], method: str) -> bool:
    if path == "/speech/segments" and method == "GET":
        token = require_core_token(handler.headers)
        session_id = str((query.get("session_id") or [""])[0]).strip()
        message_id = str((query.get("message_id") or [""])[0]).strip()
        if not session_id:
            handler.json_response({"error": "session_id is required"}, 400)
            return True
        handler.app.ensure_hydrated(token, session_id)
        handler.json_response(handler.app.core_client.get_message_speech_segments(token, session_id, message_id))
        return True

    if path != "/speech/synthesize" or method != "POST":
        return False

    token = require_core_token(handler.headers)
    body = handler.read_json_body()
    session_id = str(body.get("session_id") or "").strip()
    message_id = str(body.get("message_id") or "").strip()
    segment_group_id = str(body.get("segment_group_id") or "").strip()
    text = str(body.get("text") or "").strip()
    mode = str(body.get("mode") or "").strip().lower()
    try:
        config_id = int(body.get("config_id"))
        group_index = int(body.get("group_index"))
        sequence = int(body.get("sequence"))
    except (TypeError, ValueError):
        config_id = 0
        group_index = -1
        sequence = -1

    missing = [
        name
        for name, value in (
            ("session_id", session_id),
            ("message_id", message_id),
            ("segment_group_id", segment_group_id),
            ("text", text),
            ("config_id", config_id),
        )
        if not value
    ]
    if missing or group_index < 0 or sequence < 0 or mode not in {"text_only", "all"}:
        handler.json_response({"error": f"invalid speech request: {', '.join(missing) or 'mode'}"}, 400)
        return True

    handler.app.ensure_hydrated(token, session_id)
    session = handler.app.store.require_session(session_id)
    message = next(
        (message for message in session.get("messages", []) if message.get("info", {}).get("id") == message_id),
        None,
    )
    if message is None:
        handler.json_response({"error": "message not found in session"}, 404)
        return True

    handler.app.core_client.sync_agent_message(token, session["info"], message)
    result = handler.app.core_client.synthesize_speech(
        token,
        text,
        config_id,
        session_id,
        message_id,
        segment_group_id,
        group_index,
        sequence,
    )
    handler.json_response(result, 200 if result.get("success") else 502)
    return True
