from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from ..ids import now_ms
from .auth import CoreAuthenticationExpiredError, read_auth_token, require_core_token
from .http import error_message, is_auth_expired, parse_json
from .serializers import message_from_map, run_id_from_millis, session_from_map, to_storage_iso, unwrap_results
from ..service_auth import sign_service_request


class CoreClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._service_token = ""
        self._service_token_cached_at = 0.0
        self._service_token_lock = threading.Lock()

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

    def login_for_service(self) -> str:
        with self._service_token_lock:
            if self._service_token and time.monotonic() - self._service_token_cached_at < 15 * 60:
                return self._service_token
            path = "/api/internal/service-token/"
            payload = {"audience": "monagent", "requested_scope": "self_awake:user_context"}
            body = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            headers = {"accept": "application/json", "content-type": "application/json"}
            headers.update(sign_service_request("monagent", "core:service_token", "POST", path, body))
            request = urllib.request.Request(f"{self.base_url}{path}", data=body, headers=headers, method="POST")
            with urllib.request.urlopen(request, timeout=15) as response:
                data = parse_json(response.read().decode("utf-8", errors="replace"))
            token = data.get("token") if isinstance(data, dict) else None
            if not token:
                raise RuntimeError("Core 服务身份交换成功但未返回 token")
            self._service_token = str(token)
            self._service_token_cached_at = time.monotonic()
            return self._service_token

    def resolve_runtime_config(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        assistant = self.get_current_assistant(token)
        return self._runtime_config_from_assistant(token, assistant)

    def resolve_runtime_config_for_assistant(
        self,
        token: str | None,
        assistant_id: int | str,
    ) -> dict[str, Any] | None:
        if not token:
            return None
        return self._runtime_config_from_assistant(token, self.get_assistant(token, assistant_id))

    def _runtime_config_from_assistant(self, token: str, assistant: dict[str, Any]) -> dict[str, Any]:
        character = assistant.get("character") if isinstance(assistant, dict) else None
        if not character:
            raise RuntimeError("当前助手没有绑定角色，请先在 Core 助手管理中绑定角色。")
        ai_entity_id = character.get("ai_talk_entity_id")
        if not ai_entity_id:
            raise RuntimeError(f"角色「{character.get('name')}」没有绑定对话 AI，请先在角色配置中设置 AI 实体。")
        ai_entity = self.get_ai_entity(token, ai_entity_id)
        if not ai_entity.get("api_key"):
            raise RuntimeError(f"AI 实体「{ai_entity.get('ai_name')}」没有配置 API Key。")
        vision_config = None
        vision_reference = character.get("vision_config_id")
        if vision_reference is None:
            vision_reference = character.get("vision_config")
        if isinstance(vision_reference, dict):
            vision_reference = vision_reference.get("id")
        if vision_reference not in (None, ""):
            try:
                vision_config = self.get_vision_config(token, vision_reference)
            except Exception as error:
                vision_config = {
                    "id": vision_reference,
                    "vision_name": character.get("vision_config_name") or "角色绑定 Vision",
                    "status": "unavailable",
                    "error": str(error),
                }
        return {"assistant": assistant, "character": character, "aiEntity": ai_entity, "visionConfig": vision_config}

    def get_assistant(self, token: str, assistant_id: int | str) -> dict[str, Any]:
        raw = self._request(f"/api/assistants/{urllib.parse.quote(str(assistant_id))}/", token)
        return raw if isinstance(raw, dict) else {}

    def get_default_assistant(self, token: str) -> dict[str, Any]:
        raw = self._request("/api/assistants/default/", token)
        return raw if isinstance(raw, dict) else {}

    def get_current_assistant(self, token: str) -> dict[str, Any]:
        raw = self._request("/api/assistants/current/", token)
        return raw if isinstance(raw, dict) else {}

    def list_ai_entities(self, token: str) -> list[dict[str, Any]]:
        return unwrap_results(self._request("/api/ai/entities/", token))

    def list_service_vendors(self, token: str, service_type: str) -> dict[str, Any]:
        raw = self._request(f"/api/core/vendors/{urllib.parse.quote(service_type)}/", token)
        vendors = raw.get("vendors") if isinstance(raw, dict) else None
        return vendors if isinstance(vendors, dict) else {}

    def get_ai_entity(self, token: str, ai_entity_id: int | str) -> dict[str, Any]:
        raw = self._request(f"/api/ai/entities/{urllib.parse.quote(str(ai_entity_id))}/", token)
        return raw if isinstance(raw, dict) else {}

    def update_character(self, token: str, character_id: int | str, payload: dict[str, Any]) -> dict[str, Any]:
        raw = self._request(
            f"/api/characters/{urllib.parse.quote(str(character_id))}/",
            token,
            method="PATCH",
            payload=payload,
        )
        return raw if isinstance(raw, dict) else {}

    def list_character_visual_actions(self, token: str, character_id: int | str) -> list[dict[str, Any]]:
        return unwrap_results(self._request(f"/api/characters/{urllib.parse.quote(str(character_id))}/visual-actions/", token))

    def list_character_visual_action_groups(self, token: str, character_id: int | str) -> list[dict[str, Any]]:
        return unwrap_results(self._request(f"/api/characters/{urllib.parse.quote(str(character_id))}/visual-action-groups/", token))

    def sync_agent_session(self, token: str | None, session: dict[str, Any], core: dict[str, Any] | None = None) -> Any:
        if not token:
            return None
        participant_ids = [
            item for item in session.get("participantAssistantIDs", [])
            if isinstance(item, (int, str)) and str(item).strip()
        ]
        primary_assistant_id = participant_ids[0] if participant_ids else ((core or {}).get("assistant") or {}).get("id")
        primary_character_id = None
        for participant in session.get("participants", []):
            if participant.get("assistantID") == primary_assistant_id:
                primary_character_id = participant.get("characterID")
                break
        if primary_character_id is None:
            primary_character_id = ((core or {}).get("character") or {}).get("id")
        session_payload = {key: value for key, value in session.items() if key != "modelEvents"}
        payload = {
            "source": "monagent",
            "external_session_id": session["id"],
            "assistant": primary_assistant_id,
            "character": primary_character_id,
            "title": session.get("title"),
            "mode": session.get("mode") or "companion",
            "director_policy": session.get("directorPolicy") or {},
            "session_payload": session_payload,
            "session_events_payload": session.get("modelEvents") or [],
            "status": "active",
            "last_message_at": to_storage_iso(session.get("time", {}).get("updated", now_ms())),
        }
        return self._request("/api/agent/sessions/", token, method="POST", payload=payload)

    def update_agent_session_participants(
        self,
        token: str,
        session: dict[str, Any],
        assistant_ids: list[int | str],
    ) -> dict[str, Any]:
        session_map = self.sync_agent_session(token, session)
        raw = self._request(
            f"/api/agent/sessions/{urllib.parse.quote(str(session_map['id']))}/participants/",
            token,
            method="PUT",
            payload={"assistant_ids": assistant_ids, "mode": "companion"},
        )
        return raw if isinstance(raw, dict) else {}

    def list_agent_session_maps(self, token: str, limit: int = 50) -> list[dict[str, Any]]:
        raw = self._request(f"/api/agent/sessions/?limit={urllib.parse.quote(str(limit))}", token)
        return unwrap_results(raw)

    def list_agent_sessions(self, token: str, limit: int = 50) -> list[dict[str, Any]]:
        return [session_from_map(item) for item in self.list_agent_session_maps(token, limit)]

    def get_agent_session(self, token: str, external_session_id: str) -> dict[str, Any]:
        path = f"/api/agent/sessions/?external_session_id={urllib.parse.quote(external_session_id)}&limit=1"
        session_map = (unwrap_results(self._request(path, token)) or [None])[0]
        if not session_map:
            raise RuntimeError(f"Core 会话不存在: {external_session_id}")
        info = session_from_map(session_map)
        message_maps = session_map.get("messages")
        if message_maps is None:
            message_maps = unwrap_results(
                self._request(f"/api/agent/sessions/{urllib.parse.quote(str(session_map['id']))}/messages/", token)
            )
        messages = sorted([message_from_map(item) for item in message_maps], key=lambda item: item["info"]["time"]["created"])
        model_events = session_map.get("session_events_payload")
        return {
            "info": info,
            "messages": messages,
            "modelEvents": model_events if isinstance(model_events, list) else [],
        }

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
            "speaker_assistant": ((message.get("info") or {}).get("speaker") or {}).get("assistantID"),
            "speaker_character": ((message.get("info") or {}).get("speaker") or {}).get("characterID"),
            "turn_index": ((message.get("info") or {}).get("speaker") or {}).get("turnIndex"),
            "orchestration_payload": ((message.get("info") or {}).get("orchestration") or {}),
            "tool_call_id": (first_tool_part or {}).get("id") or "",
            "sync_status": "synced",
        }
        return self._request(
            f"/api/agent/sessions/{urllib.parse.quote(str(session_map['id']))}/messages/",
            token,
            method="POST",
            payload=payload,
        )

    def sync_agent_director_run(
        self,
        token: str | None,
        session: dict[str, Any],
        director_run: dict[str, Any],
        core: dict[str, Any] | None = None,
    ) -> Any:
        session_map = self.sync_agent_session(token, session, core)
        if not token or not session_map:
            return None
        payload = {
            "external_plan_id": director_run["planID"],
            "external_user_message_id": director_run["userMessageID"],
            "source": director_run.get("source") or "",
            "diagnostic": director_run.get("diagnostic") or "",
            "scene_payload": director_run.get("scene") or {},
            "execution_payload": director_run.get("execution") or {},
            "beats_payload": director_run.get("beats") or [],
            "status": director_run.get("status") or "planned",
            "active_beat_index": director_run.get("activeBeatIndex"),
            "completed_beat_indexes": director_run.get("completedBeatIndexes") or [],
            "participant_count": director_run.get("participantCount") or 0,
            "error": director_run.get("error") or "",
        }
        return self._request(
            f"/api/agent/sessions/{urllib.parse.quote(str(session_map['id']))}/director-runs/",
            token,
            method="POST",
            payload=payload,
        )

    def synthesize_speech(self, token: str, text: str, config_id: int) -> dict[str, Any]:
        raw = self._request(
            "/api/tts/configs/synthesize/",
            token,
            method="POST",
            payload={"text": text, "config_id": config_id},
        )
        return raw if isinstance(raw, dict) else {"success": False, "error_message": "Core TTS response is invalid"}

    def persist_self_awake_pending(
        self,
        token: str | None,
        context: dict[str, Any] | None,
        external_run_id: str,
    ) -> Any:
        if not token:
            return None
        current = now_ms()
        event = context.get("event") if isinstance(context, dict) and isinstance(context.get("event"), dict) else {}
        return self._request(
            "/api/agent/self-awake/runs/",
            token,
            method="POST",
            payload={
                "source_service": "monagent",
                "external_run_id": external_run_id,
                "event_type": event.get("type") or "scheduled",
                "event_source": event.get("source") or "monagent",
                "event_reason": event.get("reason") or "",
                "event_id": event.get("event_id") or "",
                "event_occurred_at": event.get("occurred_at") or to_storage_iso(current),
                "status": "pending",
                "started_at": to_storage_iso(current),
                "context": context or None,
            },
        )

    def persist_self_awake_run(
        self,
        token: str | None,
        decision: dict[str, Any],
        context: dict[str, Any] | None = None,
        *,
        external_run_id: str | None = None,
    ) -> Any:
        if not token:
            return None
        current = now_ms()
        event = context.get("event") if isinstance(context, dict) and isinstance(context.get("event"), dict) else {}
        next_wake = decision.get("next_wake") or {}
        after_minutes = int(next_wake.get("after_minutes") or 720)
        failed = decision.get("source") == "fallback"
        payload = {
            "source_service": "monagent",
            "external_run_id": external_run_id or run_id_from_millis("monagent", current),
            "event_type": event.get("type") or "scheduled",
            "event_source": event.get("source") or "monagent",
            "event_reason": event.get("reason") or "",
            "event_id": event.get("event_id") or "",
            "event_occurred_at": event.get("occurred_at") or to_storage_iso(current),
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
            "total_pages": int(raw.get("total_pages", max(1, (count + page_size - 1) // page_size))) if isinstance(raw, dict) else 1,
            "results": results,
        }

    def get_self_awake_diary_context(self, token: str, limit: int = 5) -> dict[str, Any]:
        limit = min(max(int(limit), 1), 12)
        raw = self._request(f"/api/agent/self-awake/diaries/context/?{urllib.parse.urlencode({'limit': str(limit)})}", token)
        return raw if isinstance(raw, dict) else {"source": "core", "last": None, "recent": [], "memory": {}}

    def get_self_awake_diary(self, token: str, diary_id: int) -> dict[str, Any]:
        raw = self._request(f"/api/agent/self-awake/diaries/{urllib.parse.quote(str(int(diary_id)))}/", token)
        return raw if isinstance(raw, dict) else {}

    def create_memo(self, token: str, payload: dict[str, Any]) -> Any:
        return self._request("/api/memos/", token, method="POST", payload=payload)

    def update_memo(self, token: str, memo_id: int, payload: dict[str, Any]) -> Any:
        return self._request(f"/api/memos/{urllib.parse.quote(str(memo_id))}/", token, method="PATCH", payload=payload)

    def list_memos(self, token: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        query = {key: str(value).strip() for key, value in params.items() if key != "limit" and value not in (None, "")}
        raw = self._request(f"/api/memos/{'?' + urllib.parse.urlencode(query) if query else ''}", token)
        memos = unwrap_results(raw)
        limit = int(params.get("limit") or 0)
        return memos[:limit] if limit > 0 else memos

    def list_due_memos(self, token: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        params = params or {}
        query = {key: str(value).strip() for key, value in params.items() if key != "limit" and value not in (None, "")}
        raw = self._request(f"/api/memos/due/{'?' + urllib.parse.urlencode(query) if query else ''}", token)
        memos = unwrap_results(raw)
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
        return unwrap_results(self._request("/api/vision/configs/", token))

    def get_vision_config(self, token: str, config_id: int | str) -> dict[str, Any]:
        raw = self._request(f"/api/vision/configs/{urllib.parse.quote(str(config_id))}/", token)
        return raw if isinstance(raw, dict) else {}

    def get_user_profile(self, token: str) -> dict[str, Any]:
        raw = self._request("/api/users/me/profile/", token)
        return raw if isinstance(raw, dict) else {}

    def update_user_profile(self, token: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw = self._request("/api/users/me/profile/", token, method="PATCH", payload=payload)
        return raw if isinstance(raw, dict) else {}

    def analyze_vision(self, token: str, payload: dict[str, Any]) -> Any:
        return self._request("/api/vision/analyze/", token, method="POST", payload=payload)

    def external_email_status(self, token: str) -> Any:
        return self._request("/api/agent/external-email/status/", token)

    def send_external_email(self, token: str, payload: dict[str, Any]) -> Any:
        return self._request("/api/agent/external-email/send/", token, method="POST", payload=payload)

    def list_qq_bots(self, token: str, owner_only: bool = True, status: str | None = None) -> list[dict[str, Any]]:
        params: dict[str, str] = {}
        if owner_only:
            params["owner_only"] = "true"
        if status:
            params["status"] = status
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        raw = self._request(f"/api/devices/qq_bot/{query}", token)
        if isinstance(raw, dict) and isinstance(raw.get("data"), list):
            return raw["data"]
        return unwrap_results(raw)

    def get_qq_bot_management(self, token: str, bot_id: int | str | None = None) -> Any:
        query = f"?{urllib.parse.urlencode({'bot_id': str(bot_id)})}" if bot_id not in (None, "") else ""
        return self._request(f"/api/devices/qq_bot/management/{query}", token)

    def send_qq_message(self, token: str, bot_id: int | str, payload: dict[str, Any]) -> Any:
        return self._request(
            f"/api/devices/qq_bot/{urllib.parse.quote(str(bot_id))}/send-message/",
            token,
            method="POST",
            payload=payload,
        )

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
                data = parse_json(text)
                if data is None:
                    raise RuntimeError(f"Core 响应不是有效 JSON: {path}")
                return data
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", errors="replace")
            message = error_message(error.code, error.reason, text)
            if is_auth_expired(error.code, message):
                raise CoreAuthenticationExpiredError(path, error.code, message) from error
            raise RuntimeError(f"Core 请求失败: {path} - {message}") from error
