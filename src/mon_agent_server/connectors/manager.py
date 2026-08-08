from __future__ import annotations

import asyncio
import threading
from concurrent.futures import Future
from typing import Any, Callable

from ..core import CoreClient
from ..logging import get_logger
from .lichess import LichessConnector
from .openttd import OpenTTDConnector

logger = get_logger("MonAgent", "Connectors")


class ExternalConnectionManager:
    def __init__(
        self,
        core_client: CoreClient,
        on_event: Callable[[Any, dict[str, Any], dict[str, Any], dict[str, Any]], None] | None = None,
    ) -> None:
        self.core_client = core_client
        self._on_event = on_event
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, name="mon-agent-connectors", daemon=True)
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._adapters: dict[int, Any] = {}
        self._tokens: dict[int, Any] = {}
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

    async def _reconcile(self, token: str, connectors: list[dict[str, Any]]) -> None:
        for connector in connectors:
            connector_id = int(connector["id"])
            self._tokens[connector_id] = token
            if connector.get("desired_state") == "connected":
                if connector_id not in self._tasks or self._tasks[connector_id].done():
                    self._tasks[connector_id] = asyncio.create_task(self._run_connector(connector_id, connector))
            else:
                await self._stop_connector(connector_id)

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

    def _create_adapter(self, connector_id: int, connector: dict[str, Any]) -> Any:
        callbacks = (
            lambda event: self._publish(connector_id, event),
            lambda state, error="": self._report(connector_id, state, error),
        )
        connector_key = connector.get("connector_key")
        if connector_key == "lichess":
            return LichessConnector(connector, *callbacks)
        if connector_key == "openttd":
            return OpenTTDConnector(connector, *callbacks)
        raise RuntimeError(f"未安装连接器类型：{connector_key}")

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
            self._tasks.pop(connector_id, None)

    async def _stop_connector(self, connector_id: int) -> None:
        task = self._tasks.get(connector_id)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
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
        return result if isinstance(result, dict) else {}

    async def _execute(self, connector_id: int, connector: dict[str, Any], action: str, payload: dict[str, Any]) -> dict[str, Any]:
        adapter = self._adapters.get(connector_id)
        temporary = False
        temporary_runner: asyncio.Task[None] | None = None
        if adapter is None:
            adapter = self._create_adapter(connector_id, connector)
            temporary = True
            if connector.get("connector_key") == "openttd":
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
