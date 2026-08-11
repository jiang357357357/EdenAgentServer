from __future__ import annotations

import json
from http import HTTPStatus
from typing import Any

from ...core import require_core_token
from ...self_awake import start_self_awake_run_async
from ...self_awake.contract import SelfAwakeContractError, normalize_self_awake_request
from ...service_auth import ServiceAuthenticationError, verify_service_request


def _author_from_assistant(assistant: dict[str, Any]) -> dict[str, Any]:
    character = assistant.get("character") if isinstance(assistant.get("character"), dict) else {}
    return {
        "assistant_id": assistant.get("id"),
        "assistant_name": assistant.get("name") or character.get("name") or "助手",
        "character_id": character.get("id"),
        "character_name": character.get("name") or assistant.get("name") or "助手",
        "avatar_url": character.get("avatar_url") or "",
    }


def _enrich_run_authors(
    payload: Any,
    assistants: list[dict[str, Any]],
    characters: dict[str, dict[str, Any]] | None = None,
) -> Any:
    rows = payload if isinstance(payload, list) else payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return payload
    authors = {str(item.get("id")): _author_from_assistant(item) for item in assistants if item.get("id") not in (None, "")}
    character_authors = characters or {}
    for run in rows:
        if not isinstance(run, dict):
            continue
        decision = run.get("decision_payload") if isinstance(run.get("decision_payload"), dict) else {}
        snapshot = decision.get("author") if isinstance(decision.get("author"), dict) else None
        character = character_authors.get(str(run.get("character")))
        character_author = None
        if isinstance(character, dict) and character:
            assistant = authors.get(str(run.get("assistant")), {})
            character_author = {
                "assistant_id": run.get("assistant"),
                "assistant_name": assistant.get("assistant_name") or character.get("name") or "助手",
                "character_id": character.get("id") or run.get("character"),
                "character_name": character.get("name") or "未知角色",
                "avatar_url": character.get("avatar_url") or "",
            }
        assistant_author = authors.get(str(run.get("assistant"))) if run.get("character") in (None, "") else None
        run["author"] = snapshot or character_author or assistant_author or {
            "assistant_id": run.get("assistant"),
            "assistant_name": "未知助手",
            "character_id": run.get("character"),
            "character_name": "未知角色",
            "avatar_url": "",
        }
    return payload


def handle_self_awake(handler: Any, path: str, query: dict[str, list[str]], method: str) -> bool:
    if method == "GET" and path == "/self-awake/runs":
        token = require_core_token(handler.headers)
        try:
            assistants = handler.app.core_client.list_assistants(token)
        except Exception:
            assistants = []
        if "page" in query or "page_size" in query:
            runs = handler.app.core_client.list_self_awake_runs_page(
                token,
                page=handler.query_int(query, "page", 1),
                page_size=handler.query_int(query, "page_size", handler.query_int(query, "limit", 30)),
                q=handler.query_value(query, "q"),
            )
        else:
            runs = handler.app.core_client.list_self_awake_runs(token, handler.query_int(query, "limit", 30))
        rows = runs if isinstance(runs, list) else runs.get("results") if isinstance(runs, dict) else []
        character_ids = {
            str(run.get("character"))
            for run in rows
            if isinstance(run, dict) and run.get("character") not in (None, "")
        }
        characters: dict[str, dict[str, Any]] = {}
        for character_id in character_ids:
            try:
                characters[character_id] = handler.app.core_client.get_character(token, character_id)
            except Exception:
                continue
        handler.json_response(_enrich_run_authors(runs, assistants, characters))
        return True

    if method == "POST" and path == "/internal/self-awake/run":
        raw_body = handler.read_json_body()
        try:
            body = normalize_self_awake_request(raw_body)
        except SelfAwakeContractError as error:
            handler.json_response({"error": str(error), "code": "invalid_self_awake_contract"}, HTTPStatus.BAD_REQUEST)
            return True
        context = body.get("context") if isinstance(body.get("context"), dict) else {}
        event = context.get("event") if isinstance(context.get("event"), dict) else {}
        if str(event.get("source") or "").strip().lower() != "monos":
            handler.json_response(
                {"error": "自醒事件只能由 MonOs 派发。"},
                HTTPStatus.FORBIDDEN,
            )
            return True
        try:
            verify_service_request(
                handler.headers,
                method,
                path,
                json.dumps(raw_body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"),
                "self_awake:submit",
            )
        except ServiceAuthenticationError as error:
            handler.json_response({"error": str(error), "code": "invalid_service_identity"}, HTTPStatus.UNAUTHORIZED)
            return True
        user_id = body.get("user_id")
        if user_id in (None, ""):
            handler.json_response(
                {"error": "自醒请求缺少用户作用域", "code": "missing_user_scope"},
                HTTPStatus.BAD_REQUEST,
            )
            return True
        identity = handler.app.core_client.self_awake_service_identity(user_id)
        accepted = start_self_awake_run_async(body, handler.app, identity)
        handler.json_response(accepted, HTTPStatus.ACCEPTED)
        return True

    return False
