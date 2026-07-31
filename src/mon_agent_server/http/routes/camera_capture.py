from __future__ import annotations

import re
import urllib.parse
from typing import Any

from ...core import require_core_token


def handle_camera_capture(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if method == "GET" and path == "/camera-capture":
        token = require_core_token(handler.headers)
        handler.app.core_client.get_user_profile(token)
        handler.json_response(handler.app.camera_captures.list())
        return True

    reply_match = re.match(r"^/camera-capture/([^/]+)/reply$", path)
    if reply_match and method == "POST":
        token = require_core_token(handler.headers)
        handler.app.core_client.get_user_profile(token)
        body = handler.read_json_body()
        result = handler.app.camera_captures.reply(
            urllib.parse.unquote(reply_match.group(1)),
            body.get("result") if isinstance(body.get("result"), dict) else None,
            body.get("error"),
        )
        handler.json_response(result)
        return True

    return False
