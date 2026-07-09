from __future__ import annotations

from http import HTTPStatus
from typing import Any

from ...core import read_auth_token, require_core_token
from ...self_awake import start_self_awake_run_async


def handle_self_awake(handler: Any, path: str, query: dict[str, list[str]], method: str) -> bool:
    if method == "GET" and path == "/self-awake/runs":
        token = require_core_token(handler.headers)
        if "page" in query or "page_size" in query:
            handler.json_response(
                handler.app.core_client.list_self_awake_runs_page(
                    token,
                    page=handler.query_int(query, "page", 1),
                    page_size=handler.query_int(query, "page_size", handler.query_int(query, "limit", 30)),
                    q=handler.query_value(query, "q"),
                )
            )
        else:
            handler.json_response(handler.app.core_client.list_self_awake_runs(token, handler.query_int(query, "limit", 30)))
        return True

    if method == "POST" and path == "/internal/self-awake/run":
        body = handler.read_json_body()
        token = read_auth_token(handler.headers)
        accepted = start_self_awake_run_async(body, handler.app, token)
        handler.json_response(accepted, HTTPStatus.ACCEPTED)
        return True

    return False
