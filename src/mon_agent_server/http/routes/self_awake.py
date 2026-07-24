from __future__ import annotations

import json
from http import HTTPStatus
from typing import Any

from ...core import require_core_token
from ...self_awake import start_self_awake_run_async
from ...self_awake.contract import SelfAwakeContractError, normalize_self_awake_request
from ...service_auth import SIGNATURE_HEADER, ServiceAuthenticationError, verify_service_request


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
        if handler.headers.get(SIGNATURE_HEADER):
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
            try:
                token = handler.app.core_client.login_for_service()
            except Exception as error:
                handler.json_response(
                    {"error": f"Core 服务身份交换失败: {error}", "code": "service_token_exchange_failed"},
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return True
        else:
            token = require_core_token(handler.headers)
        accepted = start_self_awake_run_async(body, handler.app, token)
        handler.json_response(accepted, HTTPStatus.ACCEPTED)
        return True

    return False
