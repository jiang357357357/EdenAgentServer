from __future__ import annotations

import re
import urllib.parse
from typing import Any

from ...core import require_core_token


def handle_sessions(handler: Any, path: str, query: dict[str, list[str]], method: str) -> bool:
    if method == "GET" and path == "/session":
        token = require_core_token(handler.headers)
        limit = handler.query_int(query, "limit", 50)
        sessions = handler.app.core_client.list_agent_sessions(token, limit)
        for session in sessions:
            handler.app.store.upsert_session_info(session)
        handler.json_response(sessions)
        return True

    if method == "POST" and path == "/session":
        token = require_core_token(handler.headers)
        body = handler.read_json_body()
        session = handler.app.store.create_session(str(body.get("title") or ""))
        handler.app.mark_hydrated(session["id"])
        handler.app.core_client.sync_agent_session(token, session)
        handler.app.events.emit({"type": "session.created", "properties": {"sessionID": session["id"], "info": session}})
        handler.json_response(session)
        return True

    message_match = re.match(r"^/session/([^/]+)/message$", path)
    if message_match and method == "GET":
        session_id = urllib.parse.unquote(message_match.group(1))
        token = require_core_token(handler.headers)
        if not handler.app.runtime.is_running(session_id):
            handler.app.hydrate(token, session_id)
        else:
            handler.app.ensure_hydrated(token, session_id)
        include_compactions = (query.get("includeCompactions") or [""])[0].strip().lower() in {"1", "true", "yes"}
        handler.json_response(
            handler.app.store.list_messages(
                session_id,
                handler.query_int(query, "limit", 100),
                include_compactions=include_compactions,
            )
        )
        return True

    if message_match and method == "POST":
        session_id = urllib.parse.unquote(message_match.group(1))
        token = require_core_token(handler.headers)
        body = handler.read_json_body()
        handler.app.ensure_hydrated(token, session_id)
        message = handler.app.runtime.append_user_only(session_id, body.get("parts") or [])
        handler.app.core_client.sync_agent_message(token, handler.app.store.require_session(session_id)["info"], message)
        handler.json_response(True)
        return True

    prompt_match = re.match(r"^/session/([^/]+)/prompt$", path)
    if prompt_match and method == "POST":
        session_id = urllib.parse.unquote(prompt_match.group(1))
        token = require_core_token(handler.headers)
        body = handler.read_json_body()
        handler.app.ensure_hydrated(token, session_id)
        handler.app.runtime.prompt_async(session_id, body.get("parts") or [], token)
        handler.json_response(True)
        return True

    compact_match = re.match(r"^/session/([^/]+)/compact$", path)
    if compact_match and method == "POST":
        session_id = urllib.parse.unquote(compact_match.group(1))
        token = require_core_token(handler.headers)
        body = handler.read_json_body()
        handler.app.ensure_hydrated(token, session_id)
        handler.app.runtime.compact_async(session_id, body.get("instructions"), token)
        handler.json_response({"accepted": True, "sessionID": session_id}, status=202)
        return True

    return False
