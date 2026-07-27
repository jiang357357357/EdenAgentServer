from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

from ..ids import now_ms


ACTIVE_SUBAGENT_STATUSES = frozenset({"created", "queued", "running", "waiting"})


def _storage_key(value: str) -> str:
    readable = "".join(character for character in value if character.isalnum() or character in "-_")[:32]
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
    return f"{readable or 'item'}-{digest}"


def _json_default(value: Any) -> str:
    return str(value)


class SubagentThreadRepository:
    """Durable append-only storage for background agent threads."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self._lock = threading.RLock()

    @classmethod
    def for_workspace(cls, workspace_root: str | Path) -> "SubagentThreadRepository":
        configured = os.environ.get("MON_AGENT_THREAD_STORE_DIR", "").strip()
        if configured:
            root = Path(configured).expanduser()
            if not root.is_absolute():
                root = Path(workspace_root) / root
        else:
            root = Path(workspace_root) / "Data" / "AgentThreads"
        return cls(root)

    def upsert_thread(self, session_id: str, thread: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(thread.get("id") or "").strip()
        if not agent_id:
            raise ValueError("持久化子智能体线程时缺少 id。")
        with self._lock:
            directory = self._thread_dir(session_id, agent_id)
            current = self._read_json(directory / "thread.json") or {}
            saved = {**current, **deepcopy(thread), "id": agent_id, "rootSessionID": session_id}
            self._write_json_atomic(directory / "thread.json", saved)
            self._write_session_manifest(session_id)
            return deepcopy(saved)

    def append_event(self, session_id: str, agent_id: str, event: dict[str, Any]) -> dict[str, Any]:
        saved = {"sequenceID": f"evt_{uuid.uuid4().hex}", "time": now_ms(), **deepcopy(event)}
        with self._lock:
            path = self._thread_dir(session_id, agent_id) / "events.jsonl"
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(saved, ensure_ascii=False, default=_json_default, separators=(",", ":")))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
        return deepcopy(saved)

    def save_checkpoint(
        self,
        session_id: str,
        agent_id: str,
        checkpoint: dict[str, Any],
    ) -> dict[str, Any]:
        saved = {
            "version": 1,
            "rootSessionID": session_id,
            "agentID": agent_id,
            "updatedAt": now_ms(),
            **deepcopy(checkpoint),
        }
        with self._lock:
            self._write_json_atomic(self._thread_dir(session_id, agent_id) / "checkpoint.json", saved)
        return deepcopy(saved)

    def load_checkpoint(self, session_id: str, agent_id: str) -> dict[str, Any] | None:
        with self._lock:
            checkpoint = self._read_json(self._thread_dir(session_id, agent_id, create=False) / "checkpoint.json")
            return deepcopy(checkpoint) if checkpoint else None

    def enqueue_message(self, session_id: str, message: dict[str, Any]) -> dict[str, Any]:
        message_id = str(message.get("id") or "").strip()
        target = str(message.get("target") or "").strip()
        if not message_id or not target:
            raise ValueError("持久化子智能体消息时缺少 id 或 target。")
        with self._lock:
            payload = self._read_mailboxes(session_id)
            messages = payload["messages"]
            if not any(str(item.get("id") or "") == message_id for item in messages):
                messages.append(deepcopy(message))
            payload["updatedAt"] = now_ms()
            self._write_json_atomic(self._session_dir(session_id) / "mailboxes.json", payload)
        return deepcopy(message)

    def consume_messages(self, session_id: str, receiver: str, message_ids: list[str]) -> int:
        consumed_ids = {str(item) for item in message_ids if str(item)}
        if not consumed_ids:
            return 0
        with self._lock:
            payload = self._read_mailboxes(session_id)
            before = len(payload["messages"])
            payload["messages"] = [
                item
                for item in payload["messages"]
                if not (
                    str(item.get("target") or "") == str(receiver)
                    and str(item.get("id") or "") in consumed_ids
                )
            ]
            consumed = before - len(payload["messages"])
            if consumed:
                payload["updatedAt"] = now_ms()
                self._write_json_atomic(self._session_dir(session_id) / "mailboxes.json", payload)
            return consumed

    def upsert_coordination_batch(self, session_id: str, batch: dict[str, Any]) -> dict[str, Any]:
        batch_id = str(batch.get("batchID") or "").strip()
        if not batch_id:
            raise ValueError("持久化协调批次时缺少 batchID。")
        with self._lock:
            path = self._coordination_dir(session_id) / f"{_storage_key(batch_id)}.json"
            current = self._read_json(path) or {}
            saved = {
                **current,
                **deepcopy(batch),
                "batchID": batch_id,
                "sessionID": session_id,
                "updatedAt": now_ms(),
            }
            self._write_json_atomic(path, saved)
            self._write_session_manifest(session_id)
            return deepcopy(saved)

    def get_coordination_batch(self, session_id: str, batch_id: str) -> dict[str, Any] | None:
        with self._lock:
            path = self._coordination_dir(session_id, create=False) / f"{_storage_key(batch_id)}.json"
            batch = self._read_json(path)
            return deepcopy(batch) if batch else None

    def list_coordination_batches(self, session_id: str) -> list[dict[str, Any]]:
        directory = self._coordination_dir(session_id, create=False)
        if not directory.is_dir():
            return []
        with self._lock:
            batches = [
                value
                for path in directory.glob("*.json")
                if isinstance((value := self._read_json(path)), dict)
            ]
        return sorted(
            (deepcopy(item) for item in batches),
            key=lambda item: (int(item.get("createdAt") or 0), str(item.get("batchID") or "")),
        )

    def coordination_metrics(self, session_id: str) -> dict[str, Any]:
        """Return deterministic operational metrics; semantic quality belongs to offline evals."""
        batches = self.list_coordination_batches(session_id)
        threads = self.list_threads(session_id)
        terminal = [item for item in threads if str(item.get("status") or "") not in ACTIVE_SUBAGENT_STATUSES]
        completed = [item for item in terminal if str(item.get("status") or "") == "completed"]
        required_total = sum(len(item.get("requiredTaskIDs") or []) for item in batches)
        required_consumed = sum(
            len(item.get("requiredTaskIDs") or [])
            for item in batches
            if str(item.get("status") or "") == "completed"
        )
        role_counts: dict[str, int] = {}
        category_counts: dict[str, int] = {}
        durations: list[int] = []
        for thread in threads:
            role = str(thread.get("role") or "general")
            role_counts[role] = role_counts.get(role, 0) + 1
            metadata = thread.get("metadata") if isinstance(thread.get("metadata"), dict) else {}
            category = str(metadata.get("taskCategory") or "other")
            category_counts[category] = category_counts.get(category, 0) + 1
            if thread.get("completedAt") and thread.get("createdAt"):
                durations.append(max(0, int(thread["completedAt"]) - int(thread["createdAt"])))
        return {
            "batchCount": len(batches),
            "taskCount": len(threads),
            "terminalCount": len(terminal),
            "completedCount": len(completed),
            "completionRate": (len(completed) / len(terminal)) if terminal else None,
            "requiredResultUtilization": (required_consumed / required_total) if required_total else None,
            "averageTaskDurationMs": (sum(durations) / len(durations)) if durations else None,
            "roleCounts": role_counts,
            "categoryCounts": category_counts,
            "batchStatusCounts": {
                status: sum(1 for item in batches if str(item.get("status") or "") == status)
                for status in sorted({str(item.get("status") or "unknown") for item in batches})
            },
        }

    def record_coordination_result(
        self,
        session_id: str,
        batch_id: str,
        *,
        task_id: str,
        attempt_id: str,
        result: dict[str, Any],
    ) -> tuple[dict[str, Any], bool]:
        """Persist one terminal task result and advance the batch atomically.

        Returns ``(batch, inserted)``. Replayed terminal events keep the stored
        batch unchanged and return ``inserted=False``.
        """

        with self._lock:
            path = self._coordination_dir(session_id, create=False) / f"{_storage_key(batch_id)}.json"
            batch = self._read_json(path)
            if batch is None:
                raise KeyError(f"找不到协调批次：{batch_id}")
            if str(batch.get("status") or "") == "cancelled":
                return deepcopy(batch), False
            result_key = f"{task_id}:{attempt_id}"
            delivered = [str(item) for item in batch.get("deliveredResultKeys") or []]
            if result_key in delivered:
                return deepcopy(batch), False
            terminal = [str(item) for item in batch.get("terminalTaskIDs") or []]
            pending = dict(batch.get("pendingResults") or {})
            delivered.append(result_key)
            if task_id not in terminal:
                terminal.append(task_id)
            pending[task_id] = deepcopy(result)
            required = {str(item) for item in batch.get("requiredTaskIDs") or []}
            optional = {str(item) for item in batch.get("optionalTaskIDs") or []}
            terminal_set = set(terminal)
            if required and required <= terminal_set:
                status = "ready"
            elif not required and optional and optional <= terminal_set:
                status = "completed"
            else:
                status = "collecting"
            saved = {
                **batch,
                "terminalTaskIDs": terminal,
                "pendingResults": pending,
                "deliveredResultKeys": delivered,
                "status": status,
                "readyAt": (batch.get("readyAt") or now_ms()) if status == "ready" else batch.get("readyAt"),
                "updatedAt": now_ms(),
            }
            self._write_json_atomic(path, saved)
            return deepcopy(saved), True

    def list_mailbox(self, session_id: str, receiver: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            messages = self._read_mailboxes(session_id)["messages"]
            if receiver is not None:
                messages = [item for item in messages if str(item.get("target") or "") == str(receiver)]
            return deepcopy(messages)

    def list_threads(self, session_id: str) -> list[dict[str, Any]]:
        directory = self._session_dir(session_id, create=False)
        if not directory.is_dir():
            return []
        threads: list[dict[str, Any]] = []
        with self._lock:
            for child in directory.iterdir():
                if not child.is_dir():
                    continue
                thread = self._read_json(child / "thread.json")
                if isinstance(thread, dict) and str(thread.get("rootSessionID") or "") == session_id:
                    threads.append(thread)
        return sorted(threads, key=lambda item: (int(item.get("createdAt") or 0), str(item.get("agentPath") or "")))

    def get_thread(self, session_id: str, target: str) -> dict[str, Any] | None:
        value = str(target or "")
        return next(
            (
                thread
                for thread in self.list_threads(session_id)
                if value in {str(thread.get("id") or ""), str(thread.get("agentPath") or "")}
            ),
            None,
        )

    def list_events(self, session_id: str, agent_id: str, limit: int = 500) -> list[dict[str, Any]]:
        path = self._thread_dir(session_id, agent_id, create=False) / "events.jsonl"
        if not path.is_file():
            return []
        events: list[dict[str, Any]] = []
        with self._lock:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    events.append(event)
        return events[-max(1, min(int(limit), 5_000)) :]

    def reconcile_inflight(self, session_id: str) -> list[dict[str, Any]]:
        reconciled: list[dict[str, Any]] = []
        for thread in self.list_threads(session_id):
            if str(thread.get("status") or "") not in ACTIVE_SUBAGENT_STATUSES:
                continue
            current = now_ms()
            updated = {
                **thread,
                "status": "interrupted",
                "updatedAt": current,
                "completedAt": current,
                "error": "MonAgent 服务重启，原运行请求已断开；可基于保存的检查点继续任务。",
                "metadata": {
                    **(thread.get("metadata") if isinstance(thread.get("metadata"), dict) else {}),
                    "recoveredAfterRestart": True,
                },
            }
            self.upsert_thread(session_id, updated)
            self.append_event(
                session_id,
                str(updated["id"]),
                {"type": "recovery.interrupted", "status": "interrupted", "reason": updated["error"]},
            )
            reconciled.append(updated)
        return reconciled

    def reconcile_coordination_batches(
        self,
        session_id: str,
        *,
        aggregation_max_retries: int = 2,
    ) -> list[dict[str, Any]]:
        """Repair batches after process restart and consume recovered terminal threads."""
        threads = {str(item.get("id") or ""): item for item in self.list_threads(session_id)}
        changed: list[dict[str, Any]] = []
        for original in self.list_coordination_batches(session_id):
            batch_id = str(original.get("batchID") or "")
            batch = original
            registered = [
                str(item)
                for item in [*(batch.get("requiredTaskIDs") or []), *(batch.get("optionalTaskIDs") or [])]
            ]
            terminal = set(str(item) for item in batch.get("terminalTaskIDs") or [])
            for task_id in registered:
                thread = threads.get(task_id)
                if task_id in terminal or not thread or str(thread.get("status") or "") in ACTIVE_SUBAGENT_STATUSES:
                    continue
                metadata = thread.get("metadata") if isinstance(thread.get("metadata"), dict) else {}
                batch, inserted = self.record_coordination_result(
                    session_id,
                    batch_id,
                    task_id=task_id,
                    attempt_id=str(metadata.get("attemptID") or "recovered"),
                    result={
                        "taskID": task_id,
                        "attemptID": str(metadata.get("attemptID") or "recovered"),
                        "taskName": str(thread.get("taskName") or ""),
                        "agentPath": str(thread.get("agentPath") or ""),
                        "role": str(thread.get("role") or "general"),
                        "status": str(thread.get("status") or "interrupted"),
                        "result": thread.get("result") if isinstance(thread.get("result"), dict) else None,
                        "error": str(thread.get("error") or "") or None,
                        "completedAt": thread.get("completedAt") or now_ms(),
                    },
                )
                if inserted:
                    terminal.add(task_id)
            status = str(batch.get("status") or "")
            retry_count = int(batch.get("aggregationRetryCount") or 0)
            if status == "aggregating":
                batch = self.upsert_coordination_batch(
                    session_id,
                    {**batch, "status": "ready", "aggregationScheduled": False, "recoveredAt": now_ms()},
                )
            elif status == "aggregation_failed" and retry_count <= aggregation_max_retries:
                batch = self.upsert_coordination_batch(
                    session_id,
                    {**batch, "status": "ready", "aggregationScheduled": False, "recoveredAt": now_ms()},
                )
            if batch != original:
                changed.append(batch)
        return changed

    def thread_details(
        self,
        session_id: str,
        target: str,
        *,
        event_limit: int = 500,
        include_messages: bool = False,
    ) -> dict[str, Any]:
        thread = self.get_thread(session_id, target)
        if thread is None:
            raise KeyError(f"找不到子智能体线程：{target}")
        agent_id = str(thread["id"])
        checkpoint = self.load_checkpoint(session_id, agent_id)
        if checkpoint and not include_messages:
            messages = checkpoint.get("messages") if isinstance(checkpoint.get("messages"), list) else []
            checkpoint = {
                key: value
                for key, value in checkpoint.items()
                if key != "messages"
            }
            checkpoint["messageCount"] = len(messages)
        return {
            "thread": thread,
            "events": self.list_events(session_id, agent_id, event_limit),
            "checkpoint": checkpoint,
        }

    def _session_dir(self, session_id: str, *, create: bool = True) -> Path:
        directory = self.root / _storage_key(session_id)
        if create:
            directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _thread_dir(self, session_id: str, agent_id: str, *, create: bool = True) -> Path:
        directory = self._session_dir(session_id, create=create) / _storage_key(agent_id)
        if create:
            directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _coordination_dir(self, session_id: str, *, create: bool = True) -> Path:
        directory = self._session_dir(session_id, create=create) / "coordination"
        if create:
            directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _write_session_manifest(self, session_id: str) -> None:
        self._write_json_atomic(
            self._session_dir(session_id) / "session.json",
            {"rootSessionID": session_id, "updatedAt": now_ms()},
        )

    def _read_mailboxes(self, session_id: str) -> dict[str, Any]:
        payload = self._read_json(self._session_dir(session_id, create=False) / "mailboxes.json") or {}
        messages = payload.get("messages") if isinstance(payload.get("messages"), list) else []
        return {
            "version": 1,
            "rootSessionID": session_id,
            "updatedAt": int(payload.get("updatedAt") or 0),
            "messages": [item for item in messages if isinstance(item, dict)],
        }

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    @staticmethod
    def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, default=_json_default, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
