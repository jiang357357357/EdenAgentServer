from __future__ import annotations

import threading
from typing import Any

from ..ids import create_id, now_ms
from .serializers import is_hidden_message, message_compaction, message_text, title_from_messages, to_agent_messages


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()

    def list_sessions(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            sessions = [session["info"] for session in self._sessions.values()]
        return sorted(sessions, key=lambda item: item["time"]["updated"], reverse=True)[:limit]

    def create_session(self, title: str = "", participants: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        current = now_ms()
        selected = list(participants or [])
        info = {
            "id": create_id("ses"),
            "title": title or "新会话",
            "mode": "companion",
            "directorPolicy": {
                "maxBeatsPerTurn": 3,
                "maxReturnsPerAssistant": 1,
                "allowInterAssistantReplies": True,
                "directorMaxTokens": 2000,
            },
            "participants": selected,
            "participantAssistantIDs": [item.get("assistantID") for item in selected if item.get("assistantID") is not None],
            "directorRuns": [],
            "time": {"created": current, "updated": current},
        }
        with self._lock:
            self._sessions[info["id"]] = {"info": info, "messages": [], "agentMessages": [], "characterAction": None}
        return info

    def upsert_session_info(self, info: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            existing = self._sessions.get(info["id"], {})
            existing_info = existing.get("info", {})
            merged = {
                **existing_info,
                **info,
                "time": {**existing_info.get("time", {}), **info.get("time", {})},
            }
            self._sessions[info["id"]] = {
                "info": merged,
                "messages": existing.get("messages", []),
                "agentMessages": existing.get("agentMessages", []),
                "characterAction": existing.get("characterAction"),
            }
            return merged

    def update_participants(self, session_id: str, participants: list[dict[str, Any]]) -> dict[str, Any]:
        with self._lock:
            session = self.require_session(session_id)
            session["info"]["mode"] = "companion"
            session["info"]["participants"] = list(participants)
            session["info"]["participantAssistantIDs"] = [
                item.get("assistantID") for item in participants if item.get("assistantID") is not None
            ]
            self._touch(session)
            return dict(session["info"])

    def upsert_director_run(self, session_id: str, director_run: dict[str, Any]) -> dict[str, Any]:
        plan_id = str(director_run.get("planID") or "").strip()
        if not plan_id:
            raise ValueError("导演运行缺少 planID")
        with self._lock:
            session = self.require_session(session_id)
            runs = list(session["info"].get("directorRuns") or [])
            existing_index = next(
                (index for index, item in enumerate(runs) if str(item.get("planID") or "") == plan_id),
                None,
            )
            if existing_index is None:
                saved = dict(director_run)
                runs.append(saved)
            else:
                saved = {**runs[existing_index], **director_run}
                runs[existing_index] = saved
            session["info"]["directorRuns"] = runs
            return dict(saved)

    def require_session(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                raise KeyError(f"Session not found: {session_id}")
            return session

    def list_messages(self, session_id: str, limit: int = 100, include_compactions: bool = False) -> list[dict[str, Any]]:
        session = self.require_session(session_id)
        with self._lock:
            visible = [
                message
                for message in session["messages"]
                if not is_hidden_message(message) or (include_compactions and message_compaction(message) is not None)
            ]
            return list(visible[-limit:])

    def hydrate_messages(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        with self._lock:
            session = self.require_session(session_id)
            merged_by_id = {
                str(message.get("info", {}).get("id")): message
                for message in messages
                if message.get("info", {}).get("id")
            }
            for local_message in session["messages"]:
                message_id = str(local_message.get("info", {}).get("id") or "")
                if not message_id:
                    continue
                remote_message = merged_by_id.get(message_id)
                if not remote_message:
                    merged_by_id[message_id] = local_message
                    continue
                remote_parts = {
                    str(part.get("id")): part
                    for part in remote_message.get("parts", [])
                    if part.get("id")
                }
                for part in local_message.get("parts", []):
                    if part.get("id"):
                        remote_parts[str(part["id"])] = part
                merged_by_id[message_id] = {
                    "info": {
                        **remote_message.get("info", {}),
                        **local_message.get("info", {}),
                        "time": {
                            **remote_message.get("info", {}).get("time", {}),
                            **local_message.get("info", {}).get("time", {}),
                        },
                    },
                    "parts": list(remote_parts.values()),
                }
            session["messages"] = sorted(
                merged_by_id.values(),
                key=lambda item: item.get("info", {}).get("time", {}).get("created", 0),
            )
            session["agentMessages"] = to_agent_messages(session["messages"])
            latest = max((item.get("info", {}).get("time", {}).get("created", 0) for item in session["messages"]), default=0)
            if latest:
                session["info"]["time"]["updated"] = max(session["info"]["time"]["updated"], latest)
            if not session["info"].get("title") or session["info"].get("title") == "新会话":
                title = title_from_messages(session["messages"])
                if title:
                    session["info"]["title"] = title

    def upsert_message(self, session_id: str, info: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            session = self.require_session(session_id)
            for message in session["messages"]:
                if message["info"]["id"] == info["id"]:
                    message["info"] = {**message["info"], **info, "time": {**message["info"].get("time", {}), **info.get("time", {})}}
                    self._touch(session)
                    return message
            message = {"info": info, "parts": []}
            session["messages"].append(message)
            self._touch(session)
            return message

    def upsert_part(self, session_id: str, part: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            session = self.require_session(session_id)
            message = next((item for item in session["messages"] if item["info"]["id"] == part["messageID"]), None)
            if not message:
                message = self.upsert_message(
                    session_id,
                    {"id": part["messageID"], "role": "assistant", "time": {"created": now_ms()}},
                )
            for index, existing in enumerate(message["parts"]):
                if existing["id"] == part["id"]:
                    message["parts"][index] = part
                    return part
            message["parts"].append(part)
            self._touch(session)
            return part

    def append_user_message(self, session_id: str, text: str, files: list[dict[str, Any]]) -> dict[str, Any]:
        current = now_ms()
        message_id = create_id("msg")
        parts: list[dict[str, Any]] = []
        if text.strip():
            parts.append(
                {
                    "id": f"{message_id}_text_0",
                    "messageID": message_id,
                    "sessionID": session_id,
                    "type": "text",
                    "text": text,
                    "time": {"start": current, "end": current},
                }
            )
        for index, file in enumerate(files):
            parts.append(
                {
                    "id": f"{message_id}_file_{index}",
                    "messageID": message_id,
                    "sessionID": session_id,
                    "type": "file",
                    "mime": file.get("mime") or "application/octet-stream",
                    "url": file.get("url") or "",
                    "filename": file.get("filename"),
                }
            )
        message = {"info": {"id": message_id, "role": "user", "time": {"created": current, "completed": current}}, "parts": parts}
        with self._lock:
            session = self.require_session(session_id)
            session["messages"].append(message)
            self._touch(session)
        return message

    def append_compaction_message(
        self,
        session_id: str,
        *,
        summary: str,
        tokens_before: int,
        tokens_after: int,
        first_kept_entry_id: str | None,
        details: Any | None = None,
        created_at: int | None = None,
        automatic: bool = True,
        overflow: bool = True,
    ) -> dict[str, Any]:
        current = created_at or now_ms()
        message_id = create_id("msg")
        part = {
            "id": f"{message_id}_compaction",
            "messageID": message_id,
            "sessionID": session_id,
            "type": "compaction",
            "auto": automatic,
            "overflow": overflow,
            "tail_start_id": first_kept_entry_id,
            "firstKeptEntryId": first_kept_entry_id,
            "summary": summary,
            "tokensBefore": tokens_before,
            "tokensAfter": tokens_after,
            "details": details,
            "time": {"start": current, "end": current},
        }
        message = {
            "info": {
                "id": message_id,
                "role": "assistant",
                "agent": "python-agent-core",
                "hidden": True,
                "time": {"created": current, "completed": current},
            },
            "parts": [part],
        }
        with self._lock:
            session = self.require_session(session_id)
            session["messages"].append(message)
            session["messages"].sort(key=lambda item: item.get("info", {}).get("time", {}).get("created", 0))
            self._touch(session)
        return message

    def set_agent_messages(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        with self._lock:
            session = self.require_session(session_id)
            session["agentMessages"] = messages
            self._touch(session)

    def rebuild_agent_messages(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            session = self.require_session(session_id)
            messages = to_agent_messages(session["messages"])
            session["agentMessages"] = messages
            self._touch(session)
            return list(messages)

    def get_character_action(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            state = self.require_session(session_id).get("characterAction")
            return dict(state) if isinstance(state, dict) else None

    def set_character_action(self, session_id: str, state: dict[str, Any] | None) -> dict[str, Any] | None:
        with self._lock:
            session = self.require_session(session_id)
            session["characterAction"] = dict(state) if isinstance(state, dict) else None
            self._touch(session)
            return self.get_character_action(session_id)

    def _touch(self, session: dict[str, Any]) -> None:
        session["info"]["time"]["updated"] = now_ms()
        if not session["info"].get("title") or session["info"].get("title") == "新会话":
            title = title_from_messages(session["messages"])
            if title:
                session["info"]["title"] = title
