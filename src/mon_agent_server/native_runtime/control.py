from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any

from .adapter import native_runtime_service

TERMINAL_AGENT_STATUSES = frozenset({"completed", "failed", "interrupted", "cancelled"})


@dataclass(slots=True)
class InterAgentMessage:
    id: str
    sender: str
    target: str
    content: str
    kind: str = "message"
    trigger_turn: bool = False
    created_at: int = 0
    details: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "sender": self.sender,
            "target": self.target,
            "content": self.content,
            "kind": self.kind,
            "triggerTurn": self.trigger_turn,
            "createdAt": self.created_at,
            "details": dict(self.details),
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> InterAgentMessage:
        return cls(
            id=str(payload.get("id") or ""),
            sender=str(payload.get("sender") or "/root"),
            target=str(payload.get("target") or "/root"),
            content=str(payload.get("content") or ""),
            kind=str(payload.get("kind") or "message"),
            trigger_turn=bool(payload.get("triggerTurn", False)),
            created_at=int(payload.get("createdAt") or 0),
            details=dict(payload.get("details") or {}),
        )


@dataclass(slots=True)
class AgentResult:
    content: str
    summary: str = ""
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    changed_files: list[str] = field(default_factory=list)
    tests: list[dict[str, Any]] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "content": self.content,
            "summary": self.summary or self.content[:240],
            "artifacts": list(self.artifacts),
            "changedFiles": list(self.changed_files),
            "tests": list(self.tests),
            "details": dict(self.details),
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> AgentResult:
        return cls(
            content=str(payload.get("content") or ""),
            summary=str(payload.get("summary") or ""),
            artifacts=list(payload.get("artifacts") or []),
            changed_files=[str(item) for item in payload.get("changedFiles") or []],
            tests=list(payload.get("tests") or []),
            details=dict(payload.get("details") or {}),
        )


@dataclass(slots=True)
class AgentSnapshot:
    id: str
    root_session_id: str
    parent_id: str | None
    path: str
    task_name: str
    role: str
    status: str
    depth: int
    created_at: int
    updated_at: int
    started_at: int | None = None
    completed_at: int | None = None
    error: str | None = None
    result: AgentResult | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "rootSessionID": self.root_session_id,
            "parentID": self.parent_id,
            "agentPath": self.path,
            "taskName": self.task_name,
            "role": self.role,
            "status": self.status,
            "depth": self.depth,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "startedAt": self.started_at,
            "completedAt": self.completed_at,
            "error": self.error,
            "result": self.result.to_payload() if self.result else None,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> AgentSnapshot:
        result = payload.get("result") if isinstance(payload.get("result"), dict) else None
        return cls(
            id=str(payload.get("id") or ""),
            root_session_id=str(payload.get("rootSessionID") or ""),
            parent_id=str(payload["parentID"]) if payload.get("parentID") not in (None, "") else None,
            path=str(payload.get("agentPath") or ""),
            task_name=str(payload.get("taskName") or ""),
            role=str(payload.get("role") or "general"),
            status=str(payload.get("status") or "interrupted"),
            depth=max(1, int(payload.get("depth") or 1)),
            created_at=int(payload.get("createdAt") or 0),
            updated_at=int(payload.get("updatedAt") or 0),
            started_at=int(payload["startedAt"]) if payload.get("startedAt") is not None else None,
            completed_at=int(payload["completedAt"]) if payload.get("completedAt") is not None else None,
            error=str(payload["error"]) if payload.get("error") not in (None, "") else None,
            result=AgentResult.from_payload(result) if result else None,
            metadata=dict(payload.get("metadata") or {}),
        )


AgentRunner = Callable[["AgentThread", str], Awaitable[AgentResult | str | dict[str, Any]]]
AgentEventHandler = Callable[[dict[str, Any]], Awaitable[None] | None]


class AgentThread:
    def __init__(self, snapshot: AgentSnapshot, runner: AgentRunner) -> None:
        self.snapshot = snapshot
        self.runner = runner
        self.task: asyncio.Task[None] | None = None
        self.resume_pending = True


def _normalize_result(value: AgentResult | str | dict[str, Any]) -> AgentResult:
    if isinstance(value, AgentResult):
        return value
    if isinstance(value, str):
        return AgentResult(content=value, summary=value[:240])
    content = str(value.get("content") or value.get("summary") or "")
    return AgentResult(
        content=content,
        summary=str(value.get("summary") or content[:240]),
        artifacts=list(value.get("artifacts") or []),
        changed_files=[str(item) for item in value.get("changedFiles", value.get("changed_files", []))],
        tests=list(value.get("tests") or []),
        details=dict(value.get("details") or {}),
    )


class AgentControl:
    """Server runner adapter backed by the Rust multi-agent control plane."""

    ROOT_PATH = "/root"

    def __init__(
        self,
        root_session_id: str,
        *,
        max_threads: int = 64,
        max_concurrent: int = 4,
        max_depth: int = 2,
        on_event: AgentEventHandler | None = None,
    ) -> None:
        self.root_session_id = str(root_session_id)
        self.max_threads = max_threads
        self.max_concurrent = max_concurrent
        self.max_depth = max_depth
        self.on_event = on_event
        self._threads: dict[str, AgentThread] = {}
        self._ids_by_path: dict[str, str] = {}
        self._pending_restores: list[AgentSnapshot] = []
        self._pending_mailbox: list[InterAgentMessage] = []
        self._initialized = False
        self._init_lock = asyncio.Lock()
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._condition = asyncio.Condition()

    async def _native(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        service = native_runtime_service()
        await service.ensure_started()
        return await service.client.agent_control(self.root_session_id, action, payload)

    async def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        async with self._init_lock:
            if self._initialized:
                return
            await self._native("create", {"maxThreads": self.max_threads, "maxDepth": self.max_depth})
            for snapshot in self._pending_restores:
                await self._native("restore", {"snapshot": snapshot.to_payload()})
            if self._pending_mailbox:
                await self._native(
                    "restoreMailbox",
                    {"messages": [message.to_payload() for message in self._pending_mailbox]},
                )
            self._pending_restores.clear()
            self._pending_mailbox.clear()
            self._initialized = True

    async def spawn(
        self,
        *,
        message: str,
        task_name: str,
        runner: AgentRunner,
        parent: str = ROOT_PATH,
        role: str = "general",
        metadata: dict[str, Any] | None = None,
        start: bool = True,
    ) -> AgentSnapshot:
        await self._ensure_initialized()
        payload = await self._native(
            "spawn",
            {"taskName": task_name, "parent": parent, "role": role, "metadata": metadata or {}},
        )
        snapshot = AgentSnapshot.from_payload(payload)
        thread = AgentThread(snapshot, runner)
        self._threads[snapshot.id] = thread
        self._ids_by_path[snapshot.path] = snapshot.id
        await self._emit("agent.spawned", thread)
        if start:
            self._schedule(thread, str(message or ""))
        return self._copy_snapshot(snapshot)

    async def start(self, target: str, message: str) -> AgentSnapshot:
        thread = self._require_thread(target)
        if thread.task is not None or thread.snapshot.status != "queued":
            raise RuntimeError(f"sub-agent cannot be started from status {thread.snapshot.status}: {thread.snapshot.path}")
        self._schedule(thread, str(message or ""))
        return self._copy_snapshot(thread.snapshot)

    async def send_message(
        self,
        target: str,
        message: str,
        *,
        sender: str = ROOT_PATH,
        trigger_turn: bool = False,
        kind: str = "message",
        details: dict[str, Any] | None = None,
    ) -> InterAgentMessage:
        await self._ensure_initialized()
        payload = await self._native(
            "sendMessage",
            {
                "target": target,
                "sender": sender,
                "content": str(message or ""),
                "triggerTurn": trigger_turn,
                "kind": kind,
                "details": details or {},
            },
        )
        communication = InterAgentMessage.from_payload(payload)
        thread = self._require_thread(target)
        await self._emit("agent.message", thread, message=communication.to_payload())
        if trigger_turn:
            thread.resume_pending = True
            await self._resume_pending_turn(thread)
        return communication

    async def followup_task(self, target: str, message: str, *, sender: str = ROOT_PATH) -> InterAgentMessage:
        return await self.send_message(target, message, sender=sender, trigger_turn=True, kind="followup")

    async def interrupt(self, target: str) -> AgentSnapshot:
        await self._ensure_initialized()
        thread = self._require_thread(target)
        thread.resume_pending = False
        if thread.snapshot.status not in TERMINAL_AGENT_STATUSES:
            thread.snapshot.status = "interrupted"
        if thread.task and not thread.task.done():
            thread.task.cancel()
            await asyncio.gather(thread.task, return_exceptions=True)
        snapshot = AgentSnapshot.from_payload(await self._native("interrupt", {"target": target}))
        thread.snapshot = snapshot
        await self._emit("agent.interrupted", thread)
        return self._copy_snapshot(snapshot)

    async def wait(
        self,
        targets: list[str] | None = None,
        *,
        timeout: float | None = None,
        receiver: str = ROOT_PATH,
    ) -> dict[str, Any]:
        await self._ensure_initialized()
        resolved = [self._require_thread(target) for target in targets] if targets else list(self._threads.values())

        def finished() -> bool:
            return bool(resolved) and all(thread.snapshot.status in TERMINAL_AGENT_STATUSES for thread in resolved)

        if not finished():
            async with self._condition:
                try:
                    waiter = self._condition.wait_for(finished)
                    if timeout is None:
                        await waiter
                    else:
                        await asyncio.wait_for(waiter, timeout=max(0.0, timeout))
                except TimeoutError:
                    pass
        messages = await self.take_messages(receiver)
        return {
            "agents": [self._copy_snapshot(thread.snapshot).to_payload() for thread in resolved],
            "messages": [message.to_payload() for message in messages],
        }

    def list_agents(self, path_prefix: str | None = None) -> list[AgentSnapshot]:
        prefix = str(path_prefix or "").rstrip("/")
        values = [
            self._copy_snapshot(thread.snapshot)
            for thread in self._threads.values()
            if not prefix or thread.snapshot.path == prefix or thread.snapshot.path.startswith(f"{prefix}/")
        ]
        return sorted(values, key=lambda item: (item.path.count("/"), item.created_at, item.path))

    def get(self, target: str) -> AgentSnapshot:
        return self._copy_snapshot(self._require_thread(target).snapshot)

    def restore(self, snapshot: AgentSnapshot, runner: AgentRunner) -> AgentSnapshot:
        existing = self._threads.get(snapshot.id)
        if existing:
            existing.runner = runner
            return self._copy_snapshot(existing.snapshot)
        thread = AgentThread(self._copy_snapshot(snapshot), runner)
        self._threads[snapshot.id] = thread
        self._ids_by_path[snapshot.path] = snapshot.id
        self._pending_restores.append(snapshot)
        return self._copy_snapshot(snapshot)

    def restore_mailbox(self, messages: list[InterAgentMessage | dict[str, Any]]) -> None:
        self._pending_mailbox.extend(
            message if isinstance(message, InterAgentMessage) else InterAgentMessage.from_payload(message)
            for message in messages
        )

    async def take_messages(self, receiver: str = ROOT_PATH) -> list[InterAgentMessage]:
        await self._ensure_initialized()
        payload = await self._native("drainMailbox", {"receiver": receiver})
        messages = [InterAgentMessage.from_payload(item) for item in payload.get("messages") or []]
        if messages:
            await self._emit_mailbox_consumed(receiver, messages)
        return messages

    async def close(self) -> None:
        tasks = [thread.task for thread in self._threads.values() if thread.task and not thread.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._initialized:
            await self._native("close")

    def _schedule(self, thread: AgentThread, message: str) -> None:
        if thread.task and not thread.task.done():
            raise RuntimeError(f"sub-agent is already running: {thread.snapshot.path}")
        task = asyncio.create_task(self._drive(thread, message), name=f"mon-agent:{thread.snapshot.path}")
        thread.task = task
        task.add_done_callback(
            lambda completed, item=thread: asyncio.create_task(self._after_task_done(item, completed))
        )

    async def _drive(self, thread: AgentThread, message: str) -> None:
        try:
            async with self._semaphore:
                thread.snapshot = AgentSnapshot.from_payload(
                    await self._native("start", {"target": thread.snapshot.id})
                )
                await self._emit("agent.running", thread)
                result = _normalize_result(await thread.runner(thread, message))
                completed = await self._native(
                    "complete",
                    {"target": thread.snapshot.id, "result": result.to_payload()},
                )
                await self._emit("agent.message", thread, message=completed["message"])
                thread.snapshot = AgentSnapshot.from_payload(completed["agent"])
                await self._emit("agent.completed", thread)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            try:
                failed = await self._native("fail", {"target": thread.snapshot.id, "error": str(error)})
                await self._emit("agent.message", thread, message=failed["message"])
                thread.snapshot = AgentSnapshot.from_payload(failed["agent"])
                await self._emit("agent.failed", thread)
            except Exception:
                thread.snapshot.status = "failed"
                thread.snapshot.error = str(error)
                await self._notify_changed()

    async def _after_task_done(self, thread: AgentThread, completed: asyncio.Task[None]) -> None:
        if thread.task is completed and thread.resume_pending:
            await self._resume_pending_turn(thread)

    async def _resume_pending_turn(self, thread: AgentThread) -> None:
        if thread.task and not thread.task.done():
            return
        pending = await self.take_messages(thread.snapshot.path)
        triggered = [message for message in pending if message.trigger_turn]
        if not triggered:
            return
        prompt = "\n\n".join(message.content for message in pending if message.content.strip())
        if prompt:
            thread.snapshot = AgentSnapshot.from_payload(
                await self._native("requeue", {"target": thread.snapshot.id})
            )
            self._schedule(thread, prompt)

    def _require_thread(self, target: str) -> AgentThread:
        thread_id = target if target in self._threads else self._ids_by_path.get(str(target))
        thread = self._threads.get(str(thread_id or ""))
        if thread is None:
            raise KeyError(f"unknown sub-agent: {target}")
        return thread

    async def _emit(self, event_type: str, thread: AgentThread, **properties: Any) -> None:
        if self.on_event:
            result = self.on_event(
                {
                    "type": event_type,
                    "properties": {
                        "rootSessionID": self.root_session_id,
                        "agent": thread.snapshot.to_payload(),
                        **properties,
                    },
                }
            )
            if asyncio.iscoroutine(result):
                await result
        await self._notify_changed()

    async def _emit_mailbox_consumed(self, receiver: str, messages: list[InterAgentMessage]) -> None:
        if self.on_event:
            result = self.on_event(
                {
                    "type": "agent.messages_consumed",
                    "properties": {
                        "rootSessionID": self.root_session_id,
                        "receiver": receiver,
                        "messageIDs": [message.id for message in messages],
                    },
                }
            )
            if asyncio.iscoroutine(result):
                await result
        await self._notify_changed()

    async def _notify_changed(self) -> None:
        async with self._condition:
            self._condition.notify_all()

    @staticmethod
    def _copy_snapshot(snapshot: AgentSnapshot) -> AgentSnapshot:
        return replace(
            snapshot,
            result=replace(snapshot.result) if snapshot.result else None,
            metadata=dict(snapshot.metadata),
        )
