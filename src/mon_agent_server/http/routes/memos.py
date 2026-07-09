from __future__ import annotations

import re
from typing import Any

from ...core import require_core_token


def handle_memos(handler: Any, path: str, query: dict[str, list[str]], method: str) -> bool:
    if method == "GET" and path == "/memos":
        token = require_core_token(handler.headers)
        handler.json_response(
            handler.app.core_client.list_memos(
                token,
                {
                    "kind": handler.query_value(query, "kind"),
                    "status": handler.query_value(query, "status"),
                    "priority": handler.query_value(query, "priority"),
                    "q": handler.query_value(query, "q"),
                    "limit": handler.query_int(query, "limit", 80),
                },
            )
        )
        return True

    if method == "POST" and path == "/memos":
        token = require_core_token(handler.headers)
        body = handler.read_json_body()
        handler.json_response(handler.app.core_client.create_memo(token, {**body, "source": "monagent_ui"}), 201)
        return True

    memo_match = re.match(r"^/memos/(\d+)$", path)
    if memo_match and method == "PATCH":
        token = require_core_token(handler.headers)
        handler.json_response(handler.app.core_client.update_memo(token, int(memo_match.group(1)), handler.read_json_body()))
        return True

    if method == "GET" and path == "/memos/next-wake":
        token = require_core_token(handler.headers)
        handler.json_response(handler.app.core_client.get_next_memo_wake(token, handler.query_value(query, "after")))
        return True

    if method == "POST" and path == "/memos/dispatch-due":
        token = require_core_token(handler.headers)
        handler.json_response(handler.app.core_client.dispatch_due_memos(token, handler.read_json_body()))
        return True

    memo_action_match = re.match(r"^/memos/(\d+)/(complete|snooze|triggered)$", path)
    if memo_action_match and method == "POST":
        token = require_core_token(handler.headers)
        memo_id = int(memo_action_match.group(1))
        action = memo_action_match.group(2)
        if action == "complete":
            handler.json_response(handler.app.core_client.complete_memo(token, memo_id))
        elif action == "snooze":
            handler.json_response(handler.app.core_client.snooze_memo(token, memo_id, handler.read_json_body()))
        else:
            handler.json_response(handler.app.core_client.mark_memo_triggered(token, memo_id))
        return True

    return False
