from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any

from ..ids import now_ms
from .auth import CoreAuthenticationExpiredError, read_auth_token, require_core_token
from .http import error_message, is_auth_expired, parse_json
from .serializers import message_from_map, run_id_from_millis, session_from_map, to_storage_iso, unwrap_results
from ..service_auth import sign_service_request


@dataclass(frozen=True)
class CoreServiceIdentity:
    service_id: str
    scope: str
    user_id: str


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

    @staticmethod
    def self_awake_service_identity(user_id: int | str) -> CoreServiceIdentity:
        return CoreServiceIdentity("monagent", "self_awake:user_context", str(user_id))

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
        listed_entities = None
        if ai_entity_id:
            ai_entity = self.get_ai_entity(token, ai_entity_id)
        else:
            settings = self.get_agent_settings(token)
            selected = str(settings.get("default_model") or "").strip()
            listed_entities = self.list_ai_entities(token)
            active_entities = [entity for entity in listed_entities if entity.get("status") == "active"]
            ai_entity = next(
                (
                    entity
                    for entity in active_entities
                    if selected
                    and (
                        str(entity.get("id")) == selected
                        or str(entity.get("ai_model") or "") == selected
                        or str(entity.get("ai_name") or "") == selected
                    )
                ),
                None,
            )
            if ai_entity is None:
                ai_entity = next(
                    (
                        entity
                        for entity in active_entities
                        if not entity.get("is_vision_default") and not entity.get("is_choice_default")
                    ),
                    active_entities[0] if active_entities else None,
                )
            if ai_entity is not None and ai_entity.get("id") not in (None, ""):
                ai_entity = self.get_ai_entity(token, ai_entity["id"])
            if ai_entity is None:
                raise RuntimeError(
                    f"角色「{character.get('name')}」没有绑定对话 AI，且输入框当前没有可用模型。"
                )
        if not ai_entity.get("api_key"):
            raise RuntimeError(f"AI 实体「{ai_entity.get('ai_name')}」没有配置 API Key。")
        vision_ai_entity = None
        vision_reference = character.get("vision_ai_entity_id")
        if vision_reference is None:
            vision_reference = character.get("vision_ai_entity")
        if isinstance(vision_reference, dict):
            vision_reference = vision_reference.get("id")
        if vision_reference not in (None, ""):
            try:
                vision_ai_entity = self.get_ai_entity(token, vision_reference)
            except Exception as error:
                vision_ai_entity = {
                    "id": vision_reference,
                    "ai_name": character.get("vision_ai_entity_name") or "角色绑定视觉 AI",
                    "status": "unavailable",
                    "error": str(error),
                }
        else:
            vision_ai_entity = next(
                (
                    entity
                    for entity in (listed_entities if listed_entities is not None else self.list_ai_entities(token))
                    if entity.get("status") == "active"
                    and entity.get("is_multimodal") is True
                    and entity.get("is_vision_default") is True
                ),
                None,
            )
        return {
            "assistant": assistant,
            "character": character,
            "aiEntity": ai_entity,
            "visionAIEntity": vision_ai_entity,
        }

    def get_assistant(self, token: str, assistant_id: int | str) -> dict[str, Any]:
        raw = self._request(f"/api/assistants/{urllib.parse.quote(str(assistant_id))}/", token)
        return raw if isinstance(raw, dict) else {}

    def list_assistants(self, token: str) -> list[dict[str, Any]]:
        return unwrap_results(self._request("/api/assistants/", token))

    def get_default_assistant(self, token: str) -> dict[str, Any]:
        raw = self._request("/api/assistants/default/", token)
        return raw if isinstance(raw, dict) else {}

    def get_current_assistant(self, token: str) -> dict[str, Any]:
        raw = self._request("/api/assistants/current/", token)
        return raw if isinstance(raw, dict) else {}

    def get_agent_settings(self, token: str) -> dict[str, Any]:
        raw = self._request("/api/agent/settings/my/", token)
        return raw if isinstance(raw, dict) else {}

    def update_agent_settings(self, token: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw = self._request("/api/agent/settings/my/", token, method="PATCH", payload=payload)
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

    def list_character_stickers(self, token: str, character_id: int | str, query: str = "") -> list[dict[str, Any]]:
        suffix = "?" + urllib.parse.urlencode({"enabled": "true", "q": query}) if query else "?enabled=true"
        return unwrap_results(self._request(f"/api/characters/{urllib.parse.quote(str(character_id))}/stickers/{suffix}", token))

    def create_character_sticker(self, token: str, character_id: int | str, fields: dict[str, Any],
                                 filename: str, mime: str, image: bytes) -> dict[str, Any]:
        boundary = "----MonAgent" + uuid.uuid4().hex
        chunks: list[bytes] = []
        for key, value in fields.items():
            encoded = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
            chunks.extend([f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{encoded}\r\n".encode()])
        chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n".encode())
        chunks.extend([image, f"\r\n--{boundary}--\r\n".encode()])
        request = urllib.request.Request(
            f"{self.base_url}/api/characters/{urllib.parse.quote(str(character_id))}/stickers/",
            data=b"".join(chunks),
            headers={"accept":"application/json", "authorization":f"Token {token}",
                     "content-type":f"multipart/form-data; boundary={boundary}"}, method="POST")
        with urllib.request.urlopen(request, timeout=60) as response:
            return parse_json(response.read().decode()) or {}

    def delete_character_sticker(
        self,
        token: str,
        character_id: int | str,
        sticker_id: int | str,
    ) -> dict[str, Any]:
        path = (
            f"/api/characters/{urllib.parse.quote(str(character_id))}/stickers/"
            f"{urllib.parse.quote(str(sticker_id))}/"
        )
        self._request(path, token, method="DELETE")
        return {"deleted": True, "sticker_id": sticker_id}

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
            message_maps = []
            before: str | None = None
            while True:
                params = {"limit": "100"}
                if before:
                    params["before"] = before
                raw_messages = self._request(
                    f"/api/agent/sessions/{urllib.parse.quote(str(session_map['id']))}/messages/"
                    f"?{urllib.parse.urlencode(params)}",
                    token,
                )
                if isinstance(raw_messages, dict) and isinstance(raw_messages.get("items"), list):
                    message_maps = [*raw_messages["items"], *message_maps]
                    if not raw_messages.get("has_more"):
                        break
                    before = str(raw_messages.get("next_cursor") or "") or None
                    if not before:
                        break
                    continue
                message_maps = unwrap_results(raw_messages)
                break
        messages = sorted([message_from_map(item) for item in message_maps], key=lambda item: item["info"]["time"]["created"])
        model_events = session_map.get("session_events_payload")
        return {
            "info": info,
            "messages": messages,
            "modelEvents": model_events if isinstance(model_events, list) else [],
        }

    def delete_agent_session(self, token: str, external_session_id: str) -> bool:
        path = f"/api/agent/sessions/?external_session_id={urllib.parse.quote(external_session_id)}&limit=1"
        session_map = (unwrap_results(self._request(path, token)) or [None])[0]
        if not isinstance(session_map, dict) or session_map.get("id") is None:
            return False
        self._request(
            f"/api/agent/sessions/{urllib.parse.quote(str(session_map['id']))}/",
            token,
            method="DELETE",
        )
        return True

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
                "event_reason": event.get("wake_reason") or event.get("reason") or "",
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
            "assistant": decision.get("assistant_id"),
            "character": decision.get("character_id"),
            "source_service": "monagent",
            "external_run_id": external_run_id or run_id_from_millis("monagent", current),
            "event_type": event.get("type") or "scheduled",
            "event_source": event.get("source") or "monagent",
            "event_reason": event.get("wake_reason") or event.get("reason") or "",
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

    def get_self_awake_run_by_external_id(self, token: str, external_run_id: str) -> dict[str, Any] | None:
        params = urllib.parse.urlencode(
            {"source_service": "monagent", "external_run_id": external_run_id, "page_size": "1"}
        )
        raw = self._request(f"/api/agent/self-awake/runs/?{params}", token)
        if isinstance(raw, list):
            return raw[0] if raw else None
        results = raw.get("results") if isinstance(raw, dict) else None
        return results[0] if isinstance(results, list) and results else None

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

    def get_self_awake_diary_context(
        self, token: str, limit: int = 5, *, character_id: int | str | None = None, assistant_id: int | str | None = None
    ) -> dict[str, Any]:
        limit = min(max(int(limit), 1), 12)
        params = {"limit": str(limit)}
        if character_id not in (None, ""):
            params["character"] = str(character_id)
        if assistant_id not in (None, ""):
            params["assistant"] = str(assistant_id)
        raw = self._request(f"/api/agent/self-awake/diaries/context/?{urllib.parse.urlencode(params)}", token)
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

    def remember_memory(self, token: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw = self._request("/api/agent/memories/remember/", token, method="POST", payload=payload)
        return raw if isinstance(raw, dict) else {}

    def list_memories(self, token: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        params = params or {}
        limit = min(max(int(params.get("limit") or 20), 1), 100)
        query = {
            key: str(value).strip()
            for key, value in params.items()
            if key != "limit" and value not in (None, "")
        }
        raw = self._request(
            f"/api/agent/memories/{'?' + urllib.parse.urlencode(query) if query else ''}",
            token,
        )
        return unwrap_results(raw)[:limit]

    def update_memory(self, token: str, memory_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        raw = self._request(
            f"/api/agent/memories/{urllib.parse.quote(str(memory_id))}/",
            token,
            method="PATCH",
            payload=payload,
        )
        return raw if isinstance(raw, dict) else {}

    def forget_memory(self, token: str, memory_id: int) -> dict[str, Any]:
        raw = self._request(
            f"/api/agent/memories/{urllib.parse.quote(str(memory_id))}/forget/",
            token,
            method="POST",
            payload={},
        )
        return raw if isinstance(raw, dict) else {}

    def mark_memories_used(self, token: str, memory_ids: list[int]) -> dict[str, Any]:
        raw = self._request(
            "/api/agent/memories/mark-used/",
            token,
            method="POST",
            payload={"ids": memory_ids},
        )
        return raw if isinstance(raw, dict) else {}

    def get_user_profile(self, token: str) -> dict[str, Any]:
        raw = self._request("/api/users/me/profile/", token)
        return raw if isinstance(raw, dict) else {}

    def list_skill_installations(self, token: str, device_id: str) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"device_id": device_id})
        path = f"/api/agent/skills/?{query}"
        installations: list[dict[str, Any]] = []
        for _page in range(100):
            raw = self._request(path, token)
            installations.extend(unwrap_results(raw))
            next_url = raw.get("next") if isinstance(raw, dict) else None
            if not next_url:
                break
            parsed = urllib.parse.urlparse(str(next_url))
            path = f"{parsed.path}{'?' + parsed.query if parsed.query else ''}"
        return installations

    def upsert_skill_installation(self, token: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw = self._request("/api/agent/skills/", token, method="POST", payload=payload)
        return raw if isinstance(raw, dict) else {}

    def update_skill_installation(
        self, token: str, installation_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        encoded = urllib.parse.quote(installation_id)
        raw = self._request(f"/api/agent/skills/{encoded}/", token, method="PATCH", payload=payload)
        return raw if isinstance(raw, dict) else {}

    def delete_skill_installation(self, token: str, installation_id: str) -> dict[str, Any]:
        encoded = urllib.parse.quote(installation_id)
        raw = self._request(f"/api/agent/skills/{encoded}/", token, method="DELETE", payload={})
        if isinstance(raw, dict) and raw.get("deleted") is True:
            return raw
        return {"deleted": True, "external_installation_id": installation_id}

    def update_user_profile(self, token: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw = self._request("/api/users/me/profile/", token, method="PATCH", payload=payload)
        return raw if isinstance(raw, dict) else {}

    def analyze_image(self, token: str, payload: dict[str, Any]) -> Any:
        return self._request("/api/ai/entities/analyze-image/", token, method="POST", payload=payload)

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

    def _request(self, path: str, token: str | CoreServiceIdentity | None, method: str = "GET", payload: Any | None = None) -> Any:
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"accept": "application/json"}
        if body is not None:
            headers["content-type"] = "application/json"
        if isinstance(token, CoreServiceIdentity):
            canonical_path = urllib.parse.urlparse(path).path
            headers.update(
                sign_service_request(
                    token.service_id,
                    token.scope,
                    method,
                    canonical_path,
                    body or b"",
                    subject_user_id=token.user_id,
                )
            )
        elif token:
            headers["authorization"] = f"Token {token}"
        request = urllib.request.Request(f"{self.base_url}{path}", data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                text = response.read().decode("utf-8", errors="replace")
                if response.status == 204:
                    return {}
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
