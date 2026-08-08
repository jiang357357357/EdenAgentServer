from __future__ import annotations

from copy import deepcopy
import threading
from typing import Any

from ..context import ContextManager
from ..ids import create_id, now_ms
from .serializers import is_hidden_message, message_compaction, message_text, title_from_messages


class SessionStore:
    _CHARACTER_ACTION_HISTORY_LIMIT = 5

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
            "orchestratorRuns": [],
            "agentThreads": [],
            "agentMessages": [],
            "characterPerformances": {},
            "time": {"created": current, "updated": current},
        }
        with self._lock:
            self._sessions[info["id"]] = {
                "info": info,
                "messages": [],
                "modelEvents": [],
                "characterRuntime": None,
            }
        return info

    def upsert_session_info(self, info: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            existing = self._sessions.get(info["id"], {})
            existing_info = existing.get("info", {})
            incoming_runtime = info.get("characterRuntime") if isinstance(info.get("characterRuntime"), dict) else None
            incoming_threads = list(info.get("agentThreads") or [])
            local_threads = list(existing_info.get("agentThreads") or [])
            threads_by_id = {
                str(item.get("id")): dict(item)
                for item in incoming_threads
                if isinstance(item, dict) and item.get("id")
            }
            terminal = {"completed", "failed", "interrupted", "cancelled"}
            for item in local_threads:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                key = str(item["id"])
                incoming = threads_by_id.get(key)
                if (
                    incoming is None
                    or str(item.get("status")) in terminal
                    or int(item.get("updatedAt") or 0) >= int(incoming.get("updatedAt") or 0)
                ):
                    threads_by_id[key] = dict(item)
            merged_messages = {
                str(item.get("id")): dict(item)
                for item in [*(info.get("agentMessages") or []), *(existing_info.get("agentMessages") or [])]
                if isinstance(item, dict) and item.get("id")
            }
            merged = {
                **existing_info,
                **info,
                "time": {**existing_info.get("time", {}), **info.get("time", {})},
                "agentThreads": list(threads_by_id.values()),
                "agentMessages": list(merged_messages.values()),
            }
            self._sessions[info["id"]] = {
                "info": merged,
                "messages": existing.get("messages", []),
                "modelEvents": existing.get("modelEvents", []),
                "characterRuntime": incoming_runtime or existing.get("characterRuntime"),
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

    def upsert_orchestrator_run(self, session_id: str, orchestrator_run: dict[str, Any]) -> dict[str, Any]:
        orchestration_id = str(orchestrator_run.get("orchestrationID") or "").strip()
        if not orchestration_id:
            raise ValueError("编排运行缺少 orchestrationID")
        with self._lock:
            session = self.require_session(session_id)
            runs = list(session["info"].get("orchestratorRuns") or [])
            existing_index = next(
                (
                    index
                    for index, item in enumerate(runs)
                    if str(item.get("orchestrationID") or "") == orchestration_id
                ),
                None,
            )
            if existing_index is None:
                saved = deepcopy(orchestrator_run)
                runs.append(saved)
            else:
                saved = {**runs[existing_index], **deepcopy(orchestrator_run)}
                runs[existing_index] = saved
            session["info"]["orchestratorRuns"] = runs[-500:]
            return deepcopy(saved)

    def upsert_agent_thread(
        self,
        session_id: str,
        agent: dict[str, Any],
        *,
        touch: bool = True,
    ) -> dict[str, Any]:
        agent_id = str(agent.get("id") or "").strip()
        if not agent_id:
            raise ValueError("子智能体状态缺少 id")
        with self._lock:
            session = self.require_session(session_id)
            threads = list(session["info"].get("agentThreads") or [])
            index = next(
                (position for position, item in enumerate(threads) if str(item.get("id") or "") == agent_id),
                None,
            )
            if index is None:
                saved = deepcopy(agent)
                threads.append(saved)
            else:
                saved = {**threads[index], **deepcopy(agent)}
                threads[index] = saved
            session["info"]["agentThreads"] = threads
            if touch:
                self._touch(session)
            return deepcopy(saved)

    def append_agent_message(self, session_id: str, message: dict[str, Any]) -> dict[str, Any]:
        message_id = str(message.get("id") or "").strip()
        if not message_id:
            raise ValueError("智能体消息缺少 id")
        with self._lock:
            session = self.require_session(session_id)
            messages = list(session["info"].get("agentMessages") or [])
            index = next(
                (position for position, item in enumerate(messages) if str(item.get("id") or "") == message_id),
                None,
            )
            saved = deepcopy(message)
            if index is None:
                messages.append(saved)
            else:
                messages[index] = {**messages[index], **saved}
                saved = messages[index]
            session["info"]["agentMessages"] = messages[-500:]
            self._touch(session)
            return deepcopy(saved)

    def require_session(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                raise KeyError(f"Session not found: {session_id}")
            return session

    def delete_session(self, session_id: str) -> bool:
        with self._lock:
            return self._sessions.pop(session_id, None) is not None

    def list_messages(self, session_id: str, limit: int = 100, include_compactions: bool = False) -> list[dict[str, Any]]:
        session = self.require_session(session_id)
        with self._lock:
            visible = [
                message
                for message in session["messages"]
                if not is_hidden_message(message) or (include_compactions and message_compaction(message) is not None)
            ]
            return list(visible[-limit:])

    def list_message_page(
        self,
        session_id: str,
        *,
        limit: int = 50,
        before: str | None = None,
        include_compactions: bool = False,
    ) -> dict[str, Any]:
        session = self.require_session(session_id)
        page_size = min(max(int(limit), 1), 100)
        with self._lock:
            visible = [
                message
                for message in session["messages"]
                if not is_hidden_message(message) or (include_compactions and message_compaction(message) is not None)
            ]
            end = len(visible)
            if before:
                cursor_index = next(
                    (index for index, message in enumerate(visible) if str(message.get("info", {}).get("id")) == before),
                    None,
                )
                if cursor_index is None:
                    raise KeyError(f"Message cursor not found: {before}")
                end = cursor_index
            start = max(0, end - page_size)
            items = visible[start:end]
            return {
                "items": deepcopy(items),
                "hasMore": start > 0,
                "nextCursor": str(items[0].get("info", {}).get("id")) if start > 0 and items else None,
            }

    def message_page(
        self,
        session_id: str,
        limit: int = 100,
        before: str | None = None,
        include_compactions: bool = False,
    ) -> dict[str, Any]:
        return self.list_message_page(
            session_id,
            limit=limit,
            before=before,
            include_compactions=include_compactions,
        )

    def hydrate_messages(
        self,
        session_id: str,
        messages: list[dict[str, Any]],
        model_events: list[dict[str, Any]] | None = None,
    ) -> None:
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
            canonical_events = deepcopy(model_events or [])
            # Sessions created before the canonical event stream was added may
            # still have a complete Core message projection but no modelEvents.
            # Recover only conversational text. Runtime/reasoning/tool/hidden
            # projections remain UI-only and are deliberately excluded.
            if not canonical_events:
                canonical_events = self._recover_conversation_events(session["messages"])
            session["modelEvents"] = canonical_events
            latest = max((item.get("info", {}).get("time", {}).get("created", 0) for item in session["messages"]), default=0)
            if latest:
                session["info"]["time"]["updated"] = max(session["info"]["time"]["updated"], latest)
            if not session["info"].get("title") or session["info"].get("title") == "新会话":
                title = title_from_messages(session["messages"])
                if title:
                    session["info"]["title"] = title

    @staticmethod
    def _recover_conversation_events(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        recovered: list[dict[str, Any]] = []
        for message in messages:
            info = message.get("info") or {}
            if info.get("hidden") or info.get("internal") or info.get("kind") == "runtime":
                continue
            role = str(info.get("role") or "")
            if role not in {"user", "assistant"}:
                continue
            # Tool-call assistant projections are intermediate model messages,
            # not character replies. Only final/legacy assistant text is safe
            # to recover without the original canonical tool-result pairing.
            if role == "assistant" and info.get("phase") in {"tool", "streaming"}:
                continue
            text = message_text(message)
            if not text:
                continue
            model_message: dict[str, Any] = {
                "role": role,
                "timestamp": int((info.get("time") or {}).get("created") or 0),
                "content": [{"type": "text", "text": text}],
            }
            speaker = info.get("speaker")
            if role == "assistant" and isinstance(speaker, dict):
                model_message["contextSpeaker"] = deepcopy(speaker)
            recovered.append(
                ContextManager.event_for_message(
                    model_message,
                    sequence=len(recovered) + 1,
                    turn_id=str(info.get("runID") or "") or None,
                ).dump()
            )
        return recovered

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

    def append_command_message(self, session_id: str, command: str) -> dict[str, Any]:
        """Persist a UI-only slash command marker in the chronological message stream."""
        current = now_ms()
        message_id = create_id("msg")
        part = {
            "id": f"{message_id}_text_0",
            "messageID": message_id,
            "sessionID": session_id,
            "type": "text",
            "text": command,
            "time": {"start": current, "end": current},
        }
        message = {
            "info": {
                "id": message_id,
                "role": "assistant",
                "kind": "slash-command",
                "time": {"created": current, "completed": current},
            },
            "parts": [part],
        }
        with self._lock:
            session = self.require_session(session_id)
            session["messages"].append(message)
            self._touch(session)
        return message

    def append_internal_user_message(
        self,
        session_id: str,
        text: str,
        *,
        persist_context: bool = True,
    ) -> dict[str, Any]:
        """Append a model-visible user message that is hidden from chat history."""

        current = now_ms()
        message_id = create_id("msg")
        model_message = {
            "role": "user",
            "timestamp": current,
            "content": [{"type": "text", "text": str(text or "")}],
        }
        message = {
            "info": {
                "id": message_id,
                "role": "user",
                "hidden": True,
                "internal": True,
                "time": {"created": current, "completed": current},
            },
            "parts": [
                {
                    "id": f"{message_id}_text_0",
                    "messageID": message_id,
                    "sessionID": session_id,
                    "type": "text",
                    "text": str(text or ""),
                    "time": {"start": current, "end": current},
                }
            ],
        }
        if persist_context:
            with self._lock:
                session = self.require_session(session_id)
                session["messages"].append(message)
                sequence = len(session["modelEvents"]) + 1
                session["modelEvents"].append(
                    ContextManager.event_for_message(model_message, sequence=sequence).dump()
                )
                self._touch(session)
        return deepcopy(message)

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

    def context_messages(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return ContextManager.compile(self.require_session(session_id).get("modelEvents") or [])

    def replace_context_messages(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        with self._lock:
            session = self.require_session(session_id)
            session["modelEvents"] = [
                ContextManager.event_for_message(message, sequence=index + 1).dump()
                for index, message in enumerate(messages)
            ]
            self._touch(session)

    def append_context_message(
        self,
        session_id: str,
        message: dict[str, Any],
        *,
        turn_id: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            session = self.require_session(session_id)
            sequence = len(session["modelEvents"]) + 1
            event = ContextManager.event_for_message(message, sequence=sequence, turn_id=turn_id).dump()
            session["modelEvents"].append(event)
            self._touch(session)
            return deepcopy(event)

    def append_session_event(
        self,
        session_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        *,
        turn_id: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            session = self.require_session(session_id)
            event = {
                "id": create_id("evt"),
                "sequence": len(session["modelEvents"]) + 1,
                "type": event_type,
                "turnID": turn_id,
                "payload": deepcopy(payload or {}),
                "createdAt": now_ms(),
            }
            session["modelEvents"].append(event)
            self._touch(session)
            return deepcopy(event)

    def model_events(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return deepcopy(self.require_session(session_id).get("modelEvents") or [])

    def get_character_action(
        self,
        session_id: str,
        character_id: int | str | None = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            session = self.require_session(session_id)
            if character_id is not None:
                performances = session["info"].get("characterPerformances")
                record = performances.get(str(character_id)) if isinstance(performances, dict) else None
                state = record.get("current") if isinstance(record, dict) else None
                if isinstance(state, dict):
                    return deepcopy(state)
                runtime = session.get("characterRuntime")
                if isinstance(runtime, dict) and str(runtime.get("characterID")) == str(character_id):
                    return deepcopy(runtime)
                return None
            state = session.get("characterRuntime")
            return deepcopy(state) if isinstance(state, dict) else None

    def get_character_action_history(
        self,
        session_id: str,
        character_id: int | str,
        limit: int = _CHARACTER_ACTION_HISTORY_LIMIT,
    ) -> list[dict[str, Any]]:
        with self._lock:
            session = self.require_session(session_id)
            performances = session["info"].get("characterPerformances")
            record = performances.get(str(character_id)) if isinstance(performances, dict) else None
            recent = record.get("recent") if isinstance(record, dict) else None
            if not isinstance(recent, list):
                return []
            return deepcopy(recent[: max(0, limit)])

    def set_character_action(
        self,
        session_id: str,
        state: dict[str, Any] | None,
        *,
        record_history: bool = True,
    ) -> dict[str, Any] | None:
        with self._lock:
            session = self.require_session(session_id)
            saved = deepcopy(state) if isinstance(state, dict) else None
            previous = session.get("characterRuntime") if isinstance(session.get("characterRuntime"), dict) else {}
            if saved is not None:
                saved["revision"] = int(previous.get("revision") or 0) + 1
                saved["updatedAt"] = now_ms()
            session["characterRuntime"] = saved
            session["info"]["characterRuntime"] = deepcopy(saved)
            character_id = saved.get("characterID") if saved else None
            if character_id is not None:
                performances = session["info"].setdefault("characterPerformances", {})
                if not isinstance(performances, dict):
                    performances = {}
                    session["info"]["characterPerformances"] = performances
                key = str(character_id)
                existing = performances.get(key) if isinstance(performances.get(key), dict) else {}
                recent = list(existing.get("recent") or [])
                if record_history:
                    action = saved.get("action") if isinstance(saved.get("action"), dict) else {}
                    recent.insert(
                        0,
                        {
                            "actionID": action.get("id"),
                            "actionName": action.get("name") or action.get("action_label") or "",
                            "intent": action.get("intent") or action.get("action_key") or "",
                            "motion": saved.get("motion") or "none",
                            "effect": saved.get("effect") or "none",
                            "performanceID": saved.get("performanceID") or "",
                            "time": saved.get("time") or now_ms(),
                        },
                    )
                    recent = recent[: self._CHARACTER_ACTION_HISTORY_LIMIT]
                performances[key] = {"current": deepcopy(saved), "recent": recent}
            self._touch(session)
            return deepcopy(saved)

    def _touch(self, session: dict[str, Any]) -> None:
        session["info"]["time"]["updated"] = now_ms()
        if not session["info"].get("title") or session["info"].get("title") == "新会话":
            title = title_from_messages(session["messages"])
            if title:
                session["info"]["title"] = title
