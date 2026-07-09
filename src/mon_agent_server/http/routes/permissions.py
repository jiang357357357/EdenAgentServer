from __future__ import annotations

import re
import urllib.parse
from typing import Any


def handle_permissions(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if method == "GET" and path == "/permission":
        handler.json_response(handler.app.permissions.list())
        return True

    if path == "/permission/mode":
        if method == "GET":
            handler.json_response(handler.app.permissions.mode())
            return True
        if method == "POST":
            body = handler.read_json_body()
            handler.json_response(handler.app.permissions.set_mode(str(body.get("mode") or "")))
            return True

    permission_match = re.match(r"^/permission/([^/]+)/reply$", path)
    if permission_match and method == "POST":
        body = handler.read_json_body()
        result = handler.app.permissions.reply(
            urllib.parse.unquote(permission_match.group(1)),
            body.get("reply") or "reject",
            body.get("message"),
        )
        handler.json_response(result)
        return True

    return False
