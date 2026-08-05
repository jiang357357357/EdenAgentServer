from __future__ import annotations

import re
from http import HTTPStatus
from typing import Any

from ...core import require_core_token


def _identity(handler: Any) -> tuple[str, object, str]:
    token = require_core_token(handler.headers)
    profile = handler.app.core_client.get_user_profile(token)
    owner_id = profile.get("id")
    if owner_id in (None, ""):
        raise RuntimeError("Core 用户资料缺少 id")
    device_id = str(handler.headers.get("X-MON-CLIENT-ID") or "local").strip() or "local"
    return token, owner_id, device_id


def handle_skills(handler: Any, path: str, _query: dict[str, list[str]], method: str) -> bool:
    if path == "/skills" and method == "GET":
        token, owner_id, device_id = _identity(handler)
        handler.json_response({"skills": handler.app.skill_installer.list(owner_id, token, device_id)})
        return True

    if path == "/skills/inspect" and method == "POST":
        _token, owner_id, _device_id = _identity(handler)
        handler.json_response(handler.app.skill_installer.inspect(owner_id, handler.read_json_body()))
        return True

    if path == "/skills/install" and method == "POST":
        token, owner_id, device_id = _identity(handler)
        preview_id = str(handler.read_json_body().get("previewID") or "").strip()
        if not preview_id:
            handler.json_response({"error": "缺少 previewID"}, HTTPStatus.BAD_REQUEST)
            return True
        installed = handler.app.skill_installer.install(owner_id, token, device_id, preview_id)
        handler.json_response(installed, HTTPStatus.CREATED)
        return True

    match = re.fullmatch(r"/skills/([^/]+)", path)
    update_match = re.fullmatch(r"/skills/([^/]+)/inspect-update", path)
    if update_match and method == "POST":
        token, owner_id, device_id = _identity(handler)
        handler.json_response(
            handler.app.skill_installer.inspect_update(
                owner_id, token, device_id, update_match.group(1)
            )
        )
        return True

    if match and method == "GET":
        token, owner_id, device_id = _identity(handler)
        handler.json_response(handler.app.skill_installer.details(owner_id, token, device_id, match.group(1)))
        return True

    if match and method == "PATCH":
        token, owner_id, device_id = _identity(handler)
        body = handler.read_json_body()
        if "enabled" not in body:
            handler.json_response({"error": "当前只支持修改 enabled"}, HTTPStatus.BAD_REQUEST)
            return True
        handler.json_response(
            handler.app.skill_installer.set_enabled(
                owner_id, token, device_id, match.group(1), bool(body["enabled"])
            )
        )
        return True

    if match and method == "DELETE":
        token, owner_id, device_id = _identity(handler)
        handler.json_response(
            handler.app.skill_installer.uninstall(owner_id, token, device_id, match.group(1))
        )
        return True

    return False
