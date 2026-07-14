from __future__ import annotations

import re
import urllib.parse
from typing import Any


def handle_screen_capture(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if method == "GET" and path == "/screen-capture":
        handler.json_response(handler.app.screen_captures.list())
        return True

    reply_match = re.match(r"^/screen-capture/([^/]+)/reply$", path)
    if reply_match and method == "POST":
        body = handler.read_json_body()
        result = handler.app.screen_captures.reply(
            urllib.parse.unquote(reply_match.group(1)),
            body.get("result") if isinstance(body.get("result"), dict) else None,
            body.get("error"),
        )
        handler.json_response(result)
        return True

    return False
