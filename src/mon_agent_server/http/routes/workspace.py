from __future__ import annotations

from typing import Any

from ...core import require_core_token


def handle_workspace(handler: Any, path: str, query: dict[str, list[str]], method: str) -> bool:
    if path != "/workspace" or method not in {"GET", "PATCH"}:
        return False
    token = require_core_token(handler.headers)
    handler.app.core_client.get_user_profile(token)
    if method == "PATCH":
        requested = str(handler.read_json_body().get("path") or "").strip()
        if not requested:
            raise ValueError("缺少项目文件夹路径")
        root = handler.app.switch_workspace(requested)
    else:
        root = handler.app.config.workspace_root.resolve()
    handler.json_response({"path": str(root), "name": root.name})
    return True
