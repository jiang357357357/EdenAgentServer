from __future__ import annotations

import re
import urllib.parse
from typing import Any

from ...core import require_core_token
from ...core.serializers import session_from_map


def _participant_from_assistant(assistant: dict[str, Any], position: int = 0) -> dict[str, Any]:
    character = assistant.get("character") if isinstance(assistant.get("character"), dict) else {}
    return {
        "assistantID": assistant.get("id"),
        "assistantName": assistant.get("name") or character.get("name") or "助手",
        "characterID": character.get("id"),
        "characterName": character.get("name") or assistant.get("name") or "助手",
        "signature": character.get("signature") or "",
        "avatarUrl": character.get("avatar_url") or "",
        "standingImageUrl": character.get("default_standing_image_url") or "",
        "ttsConfigID": character.get("tts_config_id"),
        "position": position,
    }


def handle_sessions(handler: Any, path: str, query: dict[str, list[str]], method: str) -> bool:
    if method == "GET" and path == "/session":
        token = require_core_token(handler.headers)
        limit = handler.query_int(query, "limit", 50)
        sessions = handler.app.core_client.list_agent_sessions(token, limit)
        merged_sessions = [handler.app.store.upsert_session_info(session) for session in sessions]
        handler.json_response(merged_sessions)
        return True

    if method == "POST" and path == "/session":
        token = require_core_token(handler.headers)
        body = handler.read_json_body()
        assistant_ids = body.get("assistantIDs") if isinstance(body.get("assistantIDs"), list) else []
        if assistant_ids:
            assistants = [handler.app.core_client.get_assistant(token, assistant_id) for assistant_id in assistant_ids]
        else:
            assistants = [handler.app.core_client.get_current_assistant(token)]
        participants = [
            _participant_from_assistant(assistant, position)
            for position, assistant in enumerate(assistants)
            if assistant.get("id") is not None
        ]
        session = handler.app.store.create_session(str(body.get("title") or ""), participants)
        handler.app.mark_hydrated(session["id"])
        handler.app.core_client.sync_agent_session(token, session)
        if participants:
            handler.app.core_client.update_agent_session_participants(
                token,
                session,
                [participant["assistantID"] for participant in participants],
            )
        handler.app.events.emit({"type": "session.created", "properties": {"sessionID": session["id"], "info": session}})
        handler.json_response(session)
        return True

    participants_match = re.match(r"^/session/([^/]+)/participants$", path)
    if participants_match and method == "PUT":
        session_id = urllib.parse.unquote(participants_match.group(1))
        token = require_core_token(handler.headers)
        body = handler.read_json_body()
        assistant_ids = body.get("assistantIDs")
        if not isinstance(assistant_ids, list) or not assistant_ids:
            handler.json_response({"error": "至少选择一个参与助手。"}, status=400)
            return True
        if len(assistant_ids) > 8 or len({str(item) for item in assistant_ids}) != len(assistant_ids):
            handler.json_response({"error": "参与助手不能重复，且最多选择 8 个。"}, status=400)
            return True
        handler.app.ensure_hydrated(token, session_id)
        assistants = [handler.app.core_client.get_assistant(token, assistant_id) for assistant_id in assistant_ids]
        participants = [_participant_from_assistant(assistant, index) for index, assistant in enumerate(assistants)]
        session = handler.app.store.update_participants(session_id, participants)
        mapped = handler.app.core_client.update_agent_session_participants(token, session, assistant_ids)
        info = handler.app.store.upsert_session_info(session_from_map(mapped))
        handler.app.events.emit({"type": "session.updated", "properties": {"sessionID": session_id, "info": info}})
        handler.json_response(info)
        return True

    message_match = re.match(r"^/session/([^/]+)/message$", path)
    if message_match and method == "GET":
        session_id = urllib.parse.unquote(message_match.group(1))
        token = require_core_token(handler.headers)
        if not handler.app.runtime.is_running(session_id):
            handler.app.hydrate(token, session_id)
        else:
            handler.app.ensure_hydrated(token, session_id)
        # Hydration rebuilds the actual model context. Publish its token count so
        # the composer and compaction logic use the same source of truth.
        handler.app.runtime.emit_session(session_id)
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
        instructions = str(body.get("instructions") or "").strip()
        command = f"/compact {instructions}" if instructions else "/compact"
        command_message = handler.app.store.append_command_message(session_id, command)
        handler.app.runtime.emit_message(session_id, command_message["info"])
        for part in command_message["parts"]:
            handler.app.runtime.emit_part(session_id, part)
        handler.app.core_client.sync_agent_message(
            token,
            handler.app.store.require_session(session_id)["info"],
            command_message,
        )
        handler.app.runtime.compact_async(session_id, instructions, token)
        handler.json_response({"accepted": True, "sessionID": session_id}, status=202)
        return True

    abort_match = re.match(r"^/session/([^/]+)/abort$", path)
    if abort_match and method == "POST":
        session_id = urllib.parse.unquote(abort_match.group(1))
        require_core_token(handler.headers)
        handler.json_response({"aborted": handler.app.runtime.abort(session_id), "sessionID": session_id})
        return True

    interrupt_agent_match = re.match(r"^/session/([^/]+)/agents/([^/]+)/interrupt$", path)
    if interrupt_agent_match and method == "POST":
        session_id = urllib.parse.unquote(interrupt_agent_match.group(1))
        target = urllib.parse.unquote(interrupt_agent_match.group(2))
        token = require_core_token(handler.headers)
        handler.app.ensure_hydrated(token, session_id)
        handler.json_response(handler.app.runtime.interrupt_subagent(session_id, target))
        return True

    followup_agent_match = re.match(r"^/session/([^/]+)/agents/([^/]+)/followup$", path)
    if followup_agent_match and method == "POST":
        session_id = urllib.parse.unquote(followup_agent_match.group(1))
        target = urllib.parse.unquote(followup_agent_match.group(2))
        token = require_core_token(handler.headers)
        body = handler.read_json_body()
        handler.app.ensure_hydrated(token, session_id)
        handler.json_response(
            handler.app.runtime.followup_subagent(
                session_id,
                target,
                str(body.get("message") or ""),
                token,
            ),
            status=202,
        )
        return True

    agent_details_match = re.match(r"^/session/([^/]+)/agents/([^/]+)$", path)
    if agent_details_match and method == "GET":
        session_id = urllib.parse.unquote(agent_details_match.group(1))
        target = urllib.parse.unquote(agent_details_match.group(2))
        token = require_core_token(handler.headers)
        handler.app.ensure_hydrated(token, session_id)
        handler.json_response(
            handler.app.runtime.get_subagent_thread_details(
                session_id,
                target,
                event_limit=handler.query_int(query, "eventLimit", 500),
                include_messages=(query.get("includeMessages") or [""])[0].strip().lower()
                in {"1", "true", "yes"},
            )
        )
        return True

    return False
