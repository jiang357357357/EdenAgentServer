from __future__ import annotations

import asyncio
import inspect
import json
import threading
from concurrent.futures import Future
from typing import Any, Callable

from ..core import CoreClient
from ..logging import get_logger
from .catalog import ConnectorCatalog, DEFAULT_CONNECTOR_CATALOG
from .worker_adapter import ConnectorReloadRequested, ConnectorWorkerAdapter

logger = get_logger("MonAgent", "Connectors")


class ExternalConnectionManager:
    def __init__(
        self,
        core_client: CoreClient,
        on_event: Callable[[Any, dict[str, Any], dict[str, Any], dict[str, Any]], None] | None = None,
        *,
        catalog: ConnectorCatalog | None = None,
    ) -> None:
        self.core_client = core_client
        self._on_event = on_event
        self.catalog = catalog or DEFAULT_CONNECTOR_CATALOG
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, name="mon-agent-connectors", daemon=True)
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._adapters: dict[int, Any] = {}
        self._tokens: dict[int, Any] = {}
        self._definitions: dict[int, str] = {}
        self._reconcile_lock = asyncio.Lock()
        self._closed = False
        self._thread.start()

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _submit(self, coroutine: Any) -> Future[Any]:
        if self._closed:
            raise RuntimeError("连接管理器已关闭。")
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop)

    def reconcile_user(self, token: Any) -> None:
        connectors = self.core_client.list_connectors(token)
        self._submit(self._reconcile(token, connectors)).result(timeout=15)

    @staticmethod
    def _definition_fingerprint(connector: dict[str, Any]) -> str:
        # Runtime fields are written by Core while a worker is running and must
        # not cause a restart loop. Every other field is part of the adapter's
        # immutable startup definition, including future connector-specific
        # settings that the generic host does not know about yet.
        transient = {
            "runtime_state",
            "runtime",
            "last_error",
            "error",
            "runtime_error",
            "last_connected_at",
            "created_at",
            "updated_at",
            "thread_sessions",
        }
        definition = {
            key: value
            for key, value in connector.items()
            if key not in transient and key != "desired_state"
        }
        return json.dumps(definition, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)

    async def _reconcile(self, token: Any, connectors: list[dict[str, Any]]) -> None:
        # Startup recovery, SSE presence, UI refresh, and model tools can all
        # request reconciliation at once. Serialize the read/stop/replace
        # transaction so two callers cannot leave an untracked duplicate
        # worker connected to the same remote identity.
        async with self._reconcile_lock:
            await self._reconcile_locked(token, connectors)

    async def _reconcile_locked(self, token: Any, connectors: list[dict[str, Any]]) -> None:
        visible_ids: set[int] = set()
        for connector in connectors:
            connector_id = int(connector["id"])
            visible_ids.add(connector_id)
            self._tokens[connector_id] = token
            if connector.get("desired_state") == "connected":
                fingerprint = self._definition_fingerprint(connector)
                task = self._tasks.get(connector_id)
                if (
                    task is not None
                    and not task.done()
                    and self._definitions.get(connector_id) != fingerprint
                ):
                    # Settings/identity changes replace only this connector's
                    # worker. The Agent Server and all other workers stay up.
                    await self._stop_connector(connector_id)
                    task = None
                self._definitions[connector_id] = fingerprint
                if task is None or task.done():
                    self._tasks[connector_id] = asyncio.create_task(self._run_connector(connector_id, connector))
            else:
                await self._stop_connector(connector_id)
                self._definitions.pop(connector_id, None)

        # A connector removed from Core must not leave an orphan worker behind.
        stale_ids = [
            connector_id
            for connector_id, owner_token in self._tokens.items()
            if owner_token == token and connector_id not in visible_ids
        ]
        for connector_id in stale_ids:
            await self._stop_connector(connector_id)
            self._definitions.pop(connector_id, None)
            self._tokens.pop(connector_id, None)

    async def _report(self, connector_id: int, state: str, error: str = "") -> None:
        token = self._tokens.get(connector_id)
        if not token:
            return
        await asyncio.to_thread(self.core_client.report_connector_state, token, connector_id, {"runtime_state": state, "error": error})

    async def _publish(self, connector_id: int, event: dict[str, Any]) -> None:
        token = self._tokens[connector_id]
        persisted = await asyncio.to_thread(self.core_client.publish_connector_event, token, connector_id, event)
        if not persisted.get("newly_created") and persisted.get("status") != "pending":
            return
        if self._on_event is not None and self._should_wake(event):
            connector = self._adapters.get(connector_id)
            connector_data = connector.connector if connector is not None else {"id": connector_id}
            await asyncio.to_thread(self._on_event, token, connector_data, event, persisted)

    @staticmethod
    def _should_wake(event: dict[str, Any]) -> bool:
        event_type = str(event.get("event_type") or "")
        if event_type.startswith("openttd."):
            return event_type in {
                "openttd.chat", "openttd.new_game", "openttd.shutdown",
                "openttd.company_removed", "openttd.gamescript",
            }
        if event_type != "lichess.game_state":
            return True
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        position = payload.get("position") if isinstance(payload.get("position"), dict) else {}
        return bool(position.get("is_bot_turn")) or str(position.get("status") or "started") != "started"

    def _create_adapter(self, connector_id: int, connector: dict[str, Any], *, stream: bool = True) -> ConnectorWorkerAdapter:
        callbacks = (
            lambda event: self._publish(connector_id, event),
            lambda state, error="": self._report(connector_id, state, error),
        )
        return ConnectorWorkerAdapter(connector, *callbacks, self.catalog, stream=stream)

    async def _run_connector(self, connector_id: int, connector: dict[str, Any]) -> None:
        delay = 1.0
        try:
            while connector.get("desired_state") == "connected" and connector_id in self._tokens:
                adapter = None
                try:
                    adapter = self._create_adapter(connector_id, connector)
                    self._adapters[connector_id] = adapter
                    await adapter.run()
                    raise RuntimeError("远端事件流已结束。")
                except asyncio.CancelledError:
                    raise
                except ConnectorReloadRequested:
                    delay = 1.0
                    continue
                except Exception as error:
                    logger.warning(f"连接器 #{connector_id} 中断: {error}")
                    await self._report(connector_id, "reconnecting", str(error))
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 60.0)
                finally:
                    self._adapters.pop(connector_id, None)
                    if adapter is not None:
                        await adapter.close()
        finally:
            await self._report(connector_id, "offline", "")
            if self._tasks.get(connector_id) is asyncio.current_task():
                self._tasks.pop(connector_id, None)

    async def _stop_connector(self, connector_id: int) -> None:
        task = self._tasks.get(connector_id)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if self._tasks.get(connector_id) is task:
                self._tasks.pop(connector_id, None)
        else:
            await self._report(connector_id, "offline", "")

    def execute(self, token: str, connector: dict[str, Any], action: str, payload: dict[str, Any]) -> dict[str, Any]:
        connector_id = int(connector["id"])
        self._tokens[connector_id] = token
        return self._submit(self._execute(connector_id, connector, action, payload)).result(timeout=45)

    def runtime_snapshot(self, connector_id: int) -> dict[str, Any]:
        return self._submit(self._runtime_snapshot(connector_id)).result(timeout=5)

    async def _runtime_snapshot(self, connector_id: int) -> dict[str, Any]:
        adapter = self._adapters.get(connector_id)
        if adapter is None:
            return {}
        snapshot = getattr(adapter, "runtime_snapshot", None)
        if not callable(snapshot):
            return {}
        result = snapshot()
        if inspect.isawaitable(result):
            result = await result
        return result if isinstance(result, dict) else {}

    async def _execute(self, connector_id: int, connector: dict[str, Any], action: str, payload: dict[str, Any]) -> dict[str, Any]:
        adapter = self._adapters.get(connector_id)
        temporary = False
        temporary_runner: asyncio.Task[None] | None = None
        if adapter is None:
            connector_key = str(connector.get("connector_key") or "")
            manifest = self.catalog.load(connector_key)
            adapter = self._create_adapter(connector_id, connector, stream=manifest.execute_requires_stream)
            temporary = True
            if manifest.execute_requires_stream:
                temporary_runner = asyncio.create_task(adapter.run())
        try:
            return await adapter.execute(action, payload)
        finally:
            if temporary:
                if temporary_runner is not None:
                    temporary_runner.cancel()
                    await asyncio.gather(temporary_runner, return_exceptions=True)
                await adapter.close()

    def close(self) -> None:
        if self._closed:
            return
        async def shutdown() -> None:
            tasks = list(self._tasks.values())
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
        self._submit(shutdown()).result(timeout=15)
        self._closed = True
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)
        if not self._thread.is_alive() and not self._loop.is_closed():
            self._loop.close()
