from __future__ import annotations

import re
from http import HTTPStatus
from typing import Any

from ...connectors.catalog import ConnectorContractError
from ...core import require_core_token


def _with_runtime(handler: Any, connector: dict[str, Any]) -> dict[str, Any]:
    result = dict(connector)
    connector_id = result.get("id")
    if connector_id not in (None, ""):
        snapshot = handler.app.connector_manager.runtime_snapshot(int(connector_id))
        if snapshot:
            result["runtime"] = snapshot
    return result


def handle_connectors(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if path == "/connectors/catalog" and method == "GET":
        require_core_token(handler.headers)
        entries, errors = handler.app.connector_manager.catalog.public_catalog()
        handler.json_response({"connectors": entries, "errors": errors})
        return True

    if path == "/connectors" and method == "GET":
        token = require_core_token(handler.headers)
        handler.app.connector_manager.reconcile_user(token)
        rows = handler.app.core_client.list_connectors(token)
        handler.json_response({"connectors": [_with_runtime(handler, row) for row in rows]})
        return True

    if path == "/connectors" and method == "POST":
        token = require_core_token(handler.headers)
        body = handler.read_json_body()
        if not str(body.get("connector_key") or "").strip() or not str(body.get("identity_key") or "").strip():
            handler.json_response({"error": "connector_key 和 identity_key 不能为空"}, HTTPStatus.BAD_REQUEST)
            return True
        connector_key = str(body.get("connector_key") or "").strip()
        try:
            handler.app.connector_manager.catalog.load(connector_key)
        except ConnectorContractError as error:
            handler.json_response({"error": str(error), "code": "connector_not_installed"}, HTTPStatus.BAD_REQUEST)
            return True
        row = handler.app.core_client.register_connector(token, body)
        handler.app.connector_manager.reconcile_user(token)
        handler.json_response(_with_runtime(handler, row), HTTPStatus.CREATED)
        return True

    match = re.fullmatch(r"/connectors/(\d+)", path)
    if match and method == "PATCH":
        token = require_core_token(handler.headers)
        connector_id = int(match.group(1))
        body = handler.read_json_body()
        allowed = {key: body[key] for key in ("desired_state", "settings", "display_name") if key in body}
        if not allowed:
            handler.json_response({"error": "没有可更新的连接器字段"}, HTTPStatus.BAD_REQUEST)
            return True
        row = handler.app.core_client.update_connector(token, connector_id, allowed)
        handler.app.connector_manager.reconcile_user(token)
        handler.json_response(_with_runtime(handler, row))
        return True

    return False
