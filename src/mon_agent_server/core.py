from __future__ import annotations

import json
import math
import random
import string
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from .ids import now_ms


class CoreAuthenticationExpiredError(Exception):
    def __init__(self, path: str, status: int, detail: str) -> None:
        super().__init__(f"Core 认证已失效: {path} - {detail}")
        self.path = path
        self.status = status
        self.detail = detail


def read_auth_token(headers: Any) -> str | None:
    value = headers.get("authorization") or headers.get("Authorization")
    if not value:
        return None
    text = str(value).strip()
    lowered = text.lower()
    if lowered.startswith("token "):
        return text[6:].strip()
    if lowered.startswith("bearer "):
        return text[7:].strip()
    return text or None


def require_core_token(headers: Any) -> str:
    token = read_auth_token(headers)
    if not token:
        raise CoreAuthenticationExpiredError("/api/agent/sessions/", 401, "not_authenticated")
    return token


def to_storage_iso(value: int | float | None = None) -> str:
    millis = now_ms() if value is None else value
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_json(text: str) -> Any:
    if not text.strip():
        return None
    return json.loads(text)


def _error_message(status: int, reason: str, text: str) -> str:
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return str(data.get("error") or data.get("detail") or data.get("message") or f"{status} {reason}")
    except Exception:
        pass
    return f"{status} {reason}"


def _is_auth_expired(status: int, message: str) -> bool:
    haystack = message.lower()
    return status == 401 or any(
        token in haystack
        for token in ["authentication_expired", "not_authenticated", "invalid token", "token invalid", "token无效", "认证凭据"]
    )


def _unwrap_results(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("results"), list):
        return value["results"]
    return []


def _to_millis(value: Any, fallback: int | None = None) -> int:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            normalized = value.replace("Z", "+00:00")
            return int(datetime.fromisoformat(normalized).timestamp() * 1000)
        except ValueError:
            return fallback if fallback is not None else now_ms()
    return fallback if fallback is not None else now_ms()


def _is_api_session_payload(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("id"), str)
        and isinstance(value.get("title"), str)
        and isinstance(value.get("time"), dict)
        and isinstance(value["time"].get("created"), (int, float))
        and isinstance(value["time"].get("updated"), (int, float))
    )


def _is_api_message_payload(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("info"), dict)
        and isinstance(value.get("parts"), list)
        and isinstance(value["info"].get("id"), str)
        and value["info"].get("role") in {"user", "assistant"}
    )


def session_from_map(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("session_payload") if _is_api_session_payload(item.get("session_payload")) else None
    created = payload["time"]["created"] if payload else _to_millis(item.get("created_at"))
    updated = max(
        payload["time"]["updated"] if payload else 0,
        _to_millis(item.get("last_message_at"), 0),
        _to_millis(item.get("updated_at"), created),
        created,
    )
    return {
        "id": item.get("external_session_id"),
        "title": item.get("title") or (payload or {}).get("title") or "新会话",
        "time": {"created": created, "updated": updated},
    }


def message_from_map(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("message_payload")
    if _is_api_message_payload(payload):
        return payload
    created = _to_millis(item.get("created_at"))
    return {
        "info": {
            "id": item.get("external_message_id") or f"core_msg_{item.get('id')}",
            "role": "user" if item.get("kind") == "user" else "assistant",
            "time": {"created": created, "completed": _to_millis(item.get("updated_at"), created)},
        },
        "parts": [],
    }


def _random_suffix(length: int = 6) -> str:
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(length))


def _run_id_from_millis(prefix: str, millis: int) -> str:
    stamp = to_storage_iso(millis).replace("-", "").replace(":", "").replace(".", "").replace("Z", "")
    return f"{prefix}-{stamp}-{_random_suffix()}"


class CoreClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def login_for_token(self, username: str, password: str, client_id: str, client_type: str) -> str:
        data = self._request(
            "/api/api-token-auth/",
            None,
            method="POST",
            payload={"username": username, "password": password, "client_id": client_id, "client_type": client_type},
        )
        token = data.get("token") if isinstance(data, dict) else None
        if not token:
            raise RuntimeError("Core 登录成功但未返回 token")
        return token

    def resolve_runtime_config(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        assistant = self._request("/api/assistants/default/", token)
        character = assistant.get("character") if isinstance(assistant, dict) else None
        if not character:
            raise RuntimeError("默认助手没有绑定角色，请先在 Core 助手管理中绑定角色。")
        ai_entity_id = character.get("ai_talk_entity_id")
        if not ai_entity_id:
            raise RuntimeError(f"角色「{character.get('name')}」没有绑定对话 AI，请先在角色配置中设置 AI 实体。")
        ai_entity = self._request(f"/api/ai/entities/{urllib.parse.quote(str(ai_entity_id))}/", token)
        if not ai_entity.get("api_key"):
            raise RuntimeError(f"AI 实体「{ai_entity.get('ai_name')}」没有配置 API Key。")
        vision_configs = []
        try:
            vision_configs = self.list_vision_configs(token)
        except Exception:
            vision_configs = []
        vision_config = next((item for item in vision_configs if item.get("status") == "active"), None)
        if vision_config is None and vision_configs:
            vision_config = vision_configs[0]
        return {"assistant": assistant, "character": character, "aiEntity": ai_entity, "visionConfig": vision_config}

    def sync_agent_session(self, token: str | None, session: dict[str, Any], core: dict[str, Any] | None = None) -> Any:
        if not token:
            return None
        payload = {
            "source": "monagent",
            "external_session_id": session["id"],
            "assistant": ((core or {}).get("assistant") or {}).get("id"),
            "character": ((core or {}).get("character") or {}).get("id"),
            "title": session.get("title"),
            "session_payload": session,
            "status": "active",
            "last_message_at": to_storage_iso(session.get("time", {}).get("updated", now_ms())),
        }
        return self._request("/api/agent/sessions/", token, method="POST", payload=payload)

    def list_agent_session_maps(self, token: str, limit: int = 50) -> list[dict[str, Any]]:
        raw = self._request(f"/api/agent/sessions/?limit={urllib.parse.quote(str(limit))}", token)
        return _unwrap_results(raw)

    def list_agent_sessions(self, token: str, limit: int = 50) -> list[dict[str, Any]]:
        return [session_from_map(item) for item in self.list_agent_session_maps(token, limit)]

    def get_agent_session(self, token: str, external_session_id: str) -> dict[str, Any]:
        path = f"/api/agent/sessions/?external_session_id={urllib.parse.quote(external_session_id)}&limit=1"
        session_map = (_unwrap_results(self._request(path, token)) or [None])[0]
        if not session_map:
            raise RuntimeError(f"Core 会话不存在: {external_session_id}")
        info = session_from_map(session_map)
        message_maps = session_map.get("messages")
        if message_maps is None:
            message_maps = _unwrap_results(
                self._request(f"/api/agent/sessions/{urllib.parse.quote(str(session_map['id']))}/messages/", token)
            )
        messages = sorted([message_from_map(item) for item in message_maps], key=lambda item: item["info"]["time"]["created"])
        return {"info": info, "messages": messages}

    def sync_agent_message(
        self,
        token: str | None,
        session: dict[str, Any],
        message: dict[str, Any],
        core: dict[str, Any] | None = None,
    ) -> Any:
        session_map = self.sync_agent_session(token, session, core)
        if not token or not session_map:
            return None
        first_tool_part = next((part for part in message.get("parts", []) if part.get("type") == "tool"), None)
        payload = {
            "external_message_id": message["info"]["id"],
            "external_parent_message_id": "",
            "kind": "user" if message["info"].get("role") == "user" else "assistant",
            "message_payload": message,
            "tool_call_id": (first_tool_part or {}).get("id") or "",
            "sync_status": "synced",
        }
        return self._request(
            f"/api/agent/sessions/{urllib.parse.quote(str(session_map['id']))}/messages/",
            token,
            method="POST",
            payload=payload,
        )

    def persist_self_awake_run(self, token: str | None, decision: dict[str, Any], context: dict[str, Any] | None = None) -> Any:
        if not token:
            return None
        current = now_ms()
        next_wake = decision.get("next_wake") or {}
        after_minutes = int(next_wake.get("after_minutes") or 720)
        failed = decision.get("source") == "fallback"
        payload = {
            "source_service": "monagent",
            "external_run_id": _run_id_from_millis("monagent", current),
            "status": "failed" if failed else "succeeded",
            "started_at": to_storage_iso(current),
            "finished_at": to_storage_iso(current),
            "context": context or None,
            "decision": decision,
            "mood": decision.get("mood") or "",
            "current_desire": decision.get("current_desire") or "",
            "should_interrupt_user": bool(decision.get("should_interrupt_user")),
            "next_wake_at": to_storage_iso(current + after_minutes * 60 * 1000),
            "next_wake_after_minutes": after_minutes,
            "next_wake_reason": next_wake.get("reason") or "",
            "error": decision.get("error") or "",
            "diary": {"title": (decision.get("diary") or {}).get("title") or "", "content": (decision.get("diary") or {}).get("content") or "", "visible_to_user": True},
            "action": {
                "action_type": (decision.get("action") or {}).get("type") or "write_diary",
                "message": (decision.get("action") or {}).get("message") or "",
                "payload": (decision.get("action") or {}).get("payload") or {},
                "status": "failed" if failed else "succeeded",
                "error": decision.get("error") or "",
            },
        }
        return self._request("/api/agent/self-awake/runs/", token, method="POST", payload=payload)

    def list_self_awake_runs(self, token: str, limit: int = 30) -> list[dict[str, Any]]:
        return self.list_self_awake_runs_page(token, page=1, page_size=limit)["results"]

    def list_self_awake_runs_page(self, token: str, page: int = 1, page_size: int = 30, q: str | None = None) -> dict[str, Any]:
        page = max(1, int(page))
        page_size = min(max(int(page_size), 1), 100)
        params = {"page": str(page), "page_size": str(page_size)}
        if q:
            params["q"] = q
        raw = self._request(f"/api/agent/self-awake/runs/?{urllib.parse.urlencode(params)}", token)
        if isinstance(raw, list):
            return {"count": len(raw), "next": None, "previous": None, "page_size": page_size, "current_page": page, "total_pages": 1, "results": raw}
        results = raw.get("results") if isinstance(raw, dict) and isinstance(raw.get("results"), list) else []
        count = int(raw.get("count", len(results))) if isinstance(raw, dict) else len(results)
        return {
            "count": count,
            "next": raw.get("next") if isinstance(raw, dict) else None,
            "previous": raw.get("previous") if isinstance(raw, dict) else None,
            "page_size": int(raw.get("page_size", page_size)) if isinstance(raw, dict) else page_size,
            "current_page": int(raw.get("current_page", page)) if isinstance(raw, dict) else page,
            "total_pages": int(raw.get("total_pages", max(1, math.ceil(count / max(1, page_size))))) if isinstance(raw, dict) else 1,
            "results": results,
        }

    def create_memo(self, token: str, payload: dict[str, Any]) -> Any:
        return self._request("/api/memos/", token, method="POST", payload=payload)

    def update_memo(self, token: str, memo_id: int, payload: dict[str, Any]) -> Any:
        return self._request(f"/api/memos/{urllib.parse.quote(str(memo_id))}/", token, method="PATCH", payload=payload)

    def list_memos(self, token: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        query = {key: str(value).strip() for key, value in params.items() if key != "limit" and value not in (None, "")}
        raw = self._request(f"/api/memos/{'?' + urllib.parse.urlencode(query) if query else ''}", token)
        memos = _unwrap_results(raw)
        limit = int(params.get("limit") or 0)
        return memos[:limit] if limit > 0 else memos

    def dispatch_due_memos(self, token: str, payload: dict[str, Any]) -> Any:
        return self._request("/api/memos/dispatch-due/", token, method="POST", payload=payload)

    def get_next_memo_wake(self, token: str, after: str | None = None) -> Any:
        query = f"?{urllib.parse.urlencode({'after': after})}" if after else ""
        return self._request(f"/api/memos/next-wake/{query}", token)

    def complete_memo(self, token: str, memo_id: int) -> Any:
        return self._request(f"/api/memos/{urllib.parse.quote(str(memo_id))}/complete/", token, method="POST", payload={})

    def snooze_memo(self, token: str, memo_id: int, payload: dict[str, Any]) -> Any:
        return self._request(f"/api/memos/{urllib.parse.quote(str(memo_id))}/snooze/", token, method="POST", payload=payload)

    def mark_memo_triggered(self, token: str, memo_id: int) -> Any:
        return self._request(f"/api/memos/{urllib.parse.quote(str(memo_id))}/mark-triggered/", token, method="POST", payload={})

    def list_vision_configs(self, token: str) -> list[dict[str, Any]]:
        return _unwrap_results(self._request("/api/vision/configs/", token))

    def analyze_vision(self, token: str, payload: dict[str, Any]) -> Any:
        return self._request("/api/vision/analyze/", token, method="POST", payload=payload)

    def _request(self, path: str, token: str | None, method: str = "GET", payload: Any | None = None) -> Any:
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"accept": "application/json"}
        if body is not None:
            headers["content-type"] = "application/json"
        if token:
            headers["authorization"] = f"Token {token}"
        request = urllib.request.Request(f"{self.base_url}{path}", data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                text = response.read().decode("utf-8", errors="replace")
                data = _parse_json(text)
                if data is None:
                    raise RuntimeError(f"Core 响应不是有效 JSON: {path}")
                return data
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", errors="replace")
            message = _error_message(error.code, error.reason, text)
            if _is_auth_expired(error.code, message):
                raise CoreAuthenticationExpiredError(path, error.code, message) from error
            raise RuntimeError(f"Core 请求失败: {path} - {message}") from error
