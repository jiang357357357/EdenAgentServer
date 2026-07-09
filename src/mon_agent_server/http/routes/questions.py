from __future__ import annotations

import re
import urllib.parse
from typing import Any


def handle_questions(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if method == "GET" and path == "/question":
        handler.json_response(handler.app.questions.list())
        return True

    question_reply_match = re.match(r"^/question/([^/]+)/reply$", path)
    if question_reply_match and method == "POST":
        body = handler.read_json_body()
        result = handler.app.questions.reply(urllib.parse.unquote(question_reply_match.group(1)), body.get("answers") or [])
        handler.json_response(result)
        return True

    question_reject_match = re.match(r"^/question/([^/]+)/reject$", path)
    if question_reject_match and method == "POST":
        result = handler.app.questions.reject(urllib.parse.unquote(question_reject_match.group(1)))
        handler.json_response(result)
        return True

    return False
