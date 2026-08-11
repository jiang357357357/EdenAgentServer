from __future__ import annotations

import asyncio
import json
import os
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from mon_agent_server.connectors.catalog import ConnectorCatalog, ConnectorContractError
from mon_agent_server.connectors.manager import ExternalConnectionManager
from mon_agent_server.connectors.worker_adapter import ConnectorReloadRequested, ConnectorWorkerAdapter


FIXTURE_MODULE = """
import asyncio
import os
from pathlib import Path

print("fixture connector diagnostic")

VERSION = Path(os.environ["MON_AGENT_TEST_CONNECTOR_VERSION"]).read_text(encoding="utf-8").strip()

class FixtureConnector:
    def __init__(self, connector, publish, report_state):
        self.connector = connector
        self.publish = publish
        self.report_state = report_state
        self.closed = asyncio.Event()

    async def run(self):
        await self.report_state("connecting", "")
        await self.report_state("online", "")
        await self.closed.wait()

    async def execute(self, action, payload):
        if action != "echo":
            raise RuntimeError("unsupported")
        if payload.get("publish"):
            await self.publish({"external_event_id": "fixture:1", "event_type": "fixture.echo", "payload": payload})
        return {"ok": True, "version": VERSION, "payload": payload}

    def runtime_snapshot(self):
        return {"version": VERSION, "capabilities": {"echo": True}}

    async def close(self):
        self.closed.set()
"""


class ConnectorWorkerTest(unittest.IsolatedAsyncioTestCase):
    def _catalog(self, directory: str, version_file: Path) -> ConnectorCatalog:
        root = Path(directory)
        manifests = root / "manifests"
        manifests.mkdir()
        (root / "fixture_connector.py").write_text(textwrap.dedent(FIXTURE_MODULE), encoding="utf-8")
        (manifests / "fixture.json").write_text(json.dumps({
            "schemaVersion": 1,
            "key": "fixture",
            "version": "1",
            "adapter": "fixture_connector:FixtureConnector",
            "executeRequiresStream": True,
            "watch": [version_file.name],
            "queries": [],
            "actions": {
                "echo": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}, "publish": {"type": "boolean"}},
                    "additionalProperties": False,
                }
            },
        }), encoding="utf-8")
        return ConnectorCatalog(manifests, root)

    async def test_worker_is_process_isolated_and_preserves_rpc_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "version.txt"
            version_file.write_text("one", encoding="utf-8")
            catalog = self._catalog(directory, version_file)
            events: list[dict] = []
            states: list[str] = []

            async def publish(event):
                events.append(event)

            async def report(state, _error=""):
                states.append(state)

            python_path = directory + os.pathsep + os.environ.get("PYTHONPATH", "")
            with patch.dict(os.environ, {
                "PYTHONPATH": python_path,
                "MON_AGENT_TEST_CONNECTOR_VERSION": str(version_file),
            }):
                adapter = ConnectorWorkerAdapter(
                    {"id": 7, "connector_key": "fixture", "identity_key": "local"},
                    publish,
                    report,
                    catalog,
                    stream=True,
                    watch_interval=0.05,
                )
                runner = asyncio.create_task(adapter.run())
                try:
                    result = await adapter.execute("echo", {"text": "hello", "publish": True})
                    snapshot = await adapter.runtime_snapshot()
                    self.assertEqual(result["version"], "one")
                    self.assertNotEqual(snapshot["worker"]["pid"], os.getpid())
                    self.assertTrue(snapshot["worker"]["isolated"])
                    self.assertEqual(events[0]["event_type"], "fixture.echo")
                    self.assertIn("online", states)
                finally:
                    await adapter.close()
                    await asyncio.gather(runner, return_exceptions=True)

    async def test_source_revision_restarts_only_the_connector_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "version.txt"
            version_file.write_text("one", encoding="utf-8")
            catalog = self._catalog(directory, version_file)

            async def noop(*_args):
                return None

            python_path = directory + os.pathsep + os.environ.get("PYTHONPATH", "")
            with patch.dict(os.environ, {
                "PYTHONPATH": python_path,
                "MON_AGENT_TEST_CONNECTOR_VERSION": str(version_file),
            }):
                first = ConnectorWorkerAdapter(
                    {"id": 8, "connector_key": "fixture", "identity_key": "local"},
                    noop,
                    noop,
                    catalog,
                    stream=True,
                    watch_interval=0.05,
                )
                first_runner = asyncio.create_task(first.run())
                self.assertEqual((await first.execute("echo", {}))["version"], "one")
                first_pid = (await first.runtime_snapshot())["worker"]["pid"]
                version_file.write_text("two-updated", encoding="utf-8")
                with self.assertRaises(ConnectorReloadRequested):
                    await asyncio.wait_for(first_runner, timeout=3)
                await first.close()

                second = ConnectorWorkerAdapter(
                    {"id": 8, "connector_key": "fixture", "identity_key": "local"},
                    noop,
                    noop,
                    catalog,
                    stream=True,
                    watch_interval=0.05,
                )
                second_runner = asyncio.create_task(second.run())
                try:
                    self.assertEqual((await second.execute("echo", {}))["version"], "two-updated")
                    second_pid = (await second.runtime_snapshot())["worker"]["pid"]
                    self.assertNotEqual(first_pid, second_pid)
                finally:
                    await second.close()
                    await asyncio.gather(second_runner, return_exceptions=True)

    async def test_persistently_invalid_manifest_retires_stale_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "version.txt"
            version_file.write_text("one", encoding="utf-8")
            catalog = self._catalog(directory, version_file)
            states: list[tuple[str, str]] = []

            async def noop(*_args):
                return None

            async def report(state, error=""):
                states.append((state, error))

            python_path = directory + os.pathsep + os.environ.get("PYTHONPATH", "")
            with patch.dict(os.environ, {
                "PYTHONPATH": python_path,
                "MON_AGENT_TEST_CONNECTOR_VERSION": str(version_file),
            }):
                adapter = ConnectorWorkerAdapter(
                    {"id": 10, "connector_key": "fixture", "identity_key": "local"},
                    noop,
                    report,
                    catalog,
                    stream=True,
                    watch_interval=0.05,
                )
                runner = asyncio.create_task(adapter.run())
                try:
                    await adapter.execute("echo", {})
                    (catalog.manifest_root / "fixture.json").write_text("{", encoding="utf-8")
                    with self.assertRaises(ConnectorReloadRequested):
                        await asyncio.wait_for(runner, timeout=3)
                    self.assertTrue(any(state == "reloading" and error for state, error in states))
                finally:
                    await adapter.close()

    def test_manifest_contract_validates_actions_without_server_code_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "version.txt"
            version_file.write_text("one", encoding="utf-8")
            catalog = self._catalog(directory, version_file)
            catalog.validate_action("fixture", "echo", {"text": "ok"})
            with self.assertRaises(ConnectorContractError):
                catalog.validate_action("fixture", "echo", {"unknown": True})
            with self.assertRaises(ConnectorContractError):
                catalog.validate_action("fixture", "missing", {})

    def test_public_catalog_is_generated_from_connector_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "version.txt"
            version_file.write_text("one", encoding="utf-8")
            catalog = self._catalog(directory, version_file)

            entries, errors = catalog.public_catalog()

            self.assertEqual(errors, [])
            self.assertEqual(entries[0]["key"], "fixture")
            self.assertTrue(entries[0]["hot_reload"])
            self.assertTrue(entries[0]["worker_isolated"])
            self.assertEqual(entries[0]["capabilities"][0]["id"], "echo")
            self.assertEqual(entries[0]["capabilities"][0]["direction"], "output")


class _FakeConnectorCore:
    def __init__(self, connector: dict) -> None:
        self.connector = connector
        self.states: list[tuple[str, str]] = []

    def list_connectors(self, _token):
        return [dict(self.connector)]

    def report_connector_state(self, _token, _connector_id, payload):
        self.states.append((str(payload.get("runtime_state") or ""), str(payload.get("error") or "")))
        return payload

    def publish_connector_event(self, _token, _connector_id, _event):
        return {"newly_created": True, "status": "pending"}


class ConnectorManagerHotReloadTest(unittest.TestCase):
    @staticmethod
    def _wait_snapshot(manager: ExternalConnectionManager, connector_id: int, predicate, timeout: float = 5.0):
        deadline = time.monotonic() + timeout
        last: dict = {}
        while time.monotonic() < deadline:
            try:
                last = manager.runtime_snapshot(connector_id)
            except Exception:
                last = {}
            if predicate(last):
                return last
            time.sleep(0.05)
        raise AssertionError(f"连接器状态未在 {timeout} 秒内满足条件：{last}")

    def test_manager_replaces_changed_worker_without_restarting_host(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "version.txt"
            version_file.write_text("one", encoding="utf-8")
            fixture = ConnectorWorkerTest()
            catalog = fixture._catalog(directory, version_file)
            connector = {
                "id": 9,
                "connector_key": "fixture",
                "identity_key": "local",
                "desired_state": "connected",
                "settings": {},
            }
            core = _FakeConnectorCore(connector)
            python_path = directory + os.pathsep + os.environ.get("PYTHONPATH", "")
            with patch.dict(os.environ, {
                "PYTHONPATH": python_path,
                "MON_AGENT_TEST_CONNECTOR_VERSION": str(version_file),
            }):
                manager = ExternalConnectionManager(core, catalog=catalog)
                try:
                    host_pid = os.getpid()
                    manager.reconcile_user("token")
                    first = self._wait_snapshot(manager, 9, lambda value: bool(value.get("worker")))
                    first_pid = first["worker"]["pid"]
                    self.assertNotEqual(first_pid, host_pid)
                    self.assertEqual(manager.execute("token", connector, "echo", {})["version"], "one")

                    version_file.write_text("two-hot", encoding="utf-8")
                    second = self._wait_snapshot(
                        manager,
                        9,
                        lambda value: bool(value.get("worker")) and value["worker"]["pid"] != first_pid,
                    )
                    self.assertNotEqual(second["worker"]["pid"], host_pid)
                    self.assertEqual(manager.execute("token", connector, "echo", {})["version"], "two-hot")
                    self.assertEqual(os.getpid(), host_pid)
                    self.assertIn("reloading", [state for state, _error in core.states])
                finally:
                    manager.close()

    def test_concurrent_reconciliation_starts_only_one_replacement_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "version.txt"
            version_file.write_text("one", encoding="utf-8")
            fixture = ConnectorWorkerTest()
            catalog = fixture._catalog(directory, version_file)
            connector = {
                "id": 11,
                "connector_key": "fixture",
                "identity_key": "local",
                "desired_state": "connected",
                "settings": {"generation": 1},
            }
            core = _FakeConnectorCore(connector)
            python_path = directory + os.pathsep + os.environ.get("PYTHONPATH", "")
            with patch.dict(os.environ, {
                "PYTHONPATH": python_path,
                "MON_AGENT_TEST_CONNECTOR_VERSION": str(version_file),
            }):
                manager = ExternalConnectionManager(core, catalog=catalog)
                try:
                    manager.reconcile_user("token")
                    first = self._wait_snapshot(manager, 11, lambda value: bool(value.get("worker")))
                    first_pid = first["worker"]["pid"]
                    core.states.clear()
                    core.connector = {**connector, "settings": {"generation": 2}}

                    barrier = threading.Barrier(3)
                    failures: list[BaseException] = []

                    def reconcile():
                        try:
                            barrier.wait()
                            manager.reconcile_user("token")
                        except BaseException as error:  # surfaced on the test thread below
                            failures.append(error)

                    threads = [threading.Thread(target=reconcile) for _ in range(2)]
                    for thread in threads:
                        thread.start()
                    barrier.wait()
                    for thread in threads:
                        thread.join(timeout=5)

                    self.assertEqual(failures, [])
                    self.assertTrue(all(not thread.is_alive() for thread in threads))
                    self._wait_snapshot(
                        manager,
                        11,
                        lambda value: bool(value.get("worker")) and value["worker"]["pid"] != first_pid,
                    )
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline and not any(state == "online" for state, _ in core.states):
                        time.sleep(0.05)
                    self.assertEqual(sum(state == "online" for state, _ in core.states), 1)
                finally:
                    manager.close()


if __name__ == "__main__":
    unittest.main()
