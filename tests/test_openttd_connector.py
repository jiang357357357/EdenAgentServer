import asyncio
import json
import os
import struct
import tempfile
import unittest
from unittest.mock import patch

from mon_agent_server.connectors.openttd import (
    ADMIN_CHAT,
    ADMIN_GAMESCRIPT,
    ADMIN_JOIN,
    ADMIN_POLL,
    SERVER_COMPANY_ECONOMY,
    SERVER_COMPANY_INFO,
    SERVER_PROTOCOL,
    SERVER_GAMESCRIPT,
    SERVER_WELCOME,
    OpenTTDConnector,
    _packet,
    openttd_password_environment,
)
from mon_agent_server.connectors.openttd_instance import load_active_instance


async def _noop(*_args):
    return None


def _string(value: str) -> bytes:
    return value.encode() + b"\0"


def _instance_registry(directory: str, admin_port: int) -> str:
    path = os.path.join(directory, "active-instance.json")
    with open(path, "w", encoding="utf-8") as output:
        json.dump({
            "instance_id": "test-instance",
            "host": "127.0.0.1",
            "game_port": admin_port + 1,
            "admin_port": admin_port,
            "pid": os.getpid(),
            "mode": "test",
            "started_at": "2026-08-08T00:00:00+00:00",
        }, output)
    return path


class OpenTTDConnectorTest(unittest.IsolatedAsyncioTestCase):
    def test_instance_registry_is_the_connection_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = _instance_registry(directory, 43123)
            instance = load_active_instance(path)
            self.assertEqual(instance.instance_id, "test-instance")
            self.assertEqual(instance.admin_port, 43123)
            self.assertEqual(instance.pid, os.getpid())

    def test_missing_instance_registry_is_not_replaced_by_a_fixed_port(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "没有活动"):
                load_active_instance(os.path.join(directory, "missing.json"))

    def test_password_environment_is_scoped_by_identity(self):
        self.assertEqual(openttd_password_environment("Local Main"), "MON_CONNECTOR_OPENTTD_LOCAL_MAIN")

    def test_decode_welcome_and_company_state(self):
        connector = OpenTTDConnector({"identity_key": "local"}, _noop, _noop)
        welcome = (
            _string("MonAgent OpenTTD") + _string("15.3") + b"\x01" + _string("")
            + struct.pack("<IBIHH", 42, 0, 0, 256, 256)
        )
        event_type, payload = connector._decode(SERVER_WELCOME, welcome)
        self.assertEqual(event_type, "openttd.server_state")
        self.assertEqual(payload["server"]["map_width"], 256)
        self.assertFalse(payload["capabilities"]["company_gameplay"])

        company = bytes([1]) + _string("凯伊运输") + _string("凯伊") + bytes([3, 1]) + struct.pack("<I", 1950) + bytes([0, 0])
        event_type, payload = connector._decode(SERVER_COMPANY_INFO, company)
        self.assertEqual(event_type, "openttd.company")
        self.assertEqual(payload["companies"][0]["name"], "凯伊运输")

        economy = bytes([1]) + struct.pack("<QQQH", 100000, 20000, 5000, 8)
        economy += struct.pack("<QHHQHH", 120000, 400, 7, 110000, 350, 6)
        event_type, payload = connector._decode(SERVER_COMPANY_ECONOMY, economy)
        self.assertEqual(event_type, "openttd.economy")
        self.assertEqual(payload["companies"][0]["economy"]["money"], 100000)

    async def test_real_packet_framing_and_admin_actions(self):
        received = []

        async def handle(reader, writer):
            try:
                while True:
                    header = await reader.readexactly(2)
                    size = struct.unpack("<H", header)[0]
                    body = await reader.readexactly(size - 2)
                    received.append((body[0], body[1:]))
                    if body[0] == ADMIN_JOIN:
                        protocol = bytes([3])
                        for update_type, frequencies in ((0, 2), (2, 64), (3, 16), (4, 16), (5, 64), (6, 64), (9, 64)):
                            protocol += bytes([1]) + struct.pack("<HH", update_type, frequencies)
                        protocol += bytes([0])
                        writer.write(_packet(SERVER_PROTOCOL, protocol))
                        await writer.drain()
            except asyncio.IncompleteReadError:
                pass
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        with tempfile.TemporaryDirectory() as directory:
            connector = OpenTTDConnector(
                {"identity_key": "local", "settings": {"instance_registry": _instance_registry(directory, port)}},
                _noop,
                _noop,
            )
            with patch.dict(os.environ, {"MON_CONNECTOR_OPENTTD_LOCAL": "secret"}):
                runner = asyncio.create_task(connector.run())
                await connector.execute("refresh_state", {})
                await connector.execute("send_chat", {"text": "你好"})
                runner.cancel()
                await asyncio.gather(runner, return_exceptions=True)
                await connector.close()
        await asyncio.sleep(0)
        server.close()
        await server.wait_closed()

        self.assertEqual(received[0][0], ADMIN_JOIN)
        self.assertEqual(received[0][1], b"secret\0MonAgent\0" + b"1\0")
        self.assertEqual([item[0] for item in received].count(ADMIN_POLL), 8)
        subscriptions = [struct.unpack("<HH", payload) for packet_type, payload in received if packet_type == 2]
        self.assertIn((9, 64), subscriptions)
        probe = next(payload for packet_type, payload in received if packet_type == ADMIN_GAMESCRIPT)
        probe_command = __import__("json").loads(probe.rstrip(b"\0"))
        self.assertEqual(probe_command["action"], "ping")
        self.assertTrue(probe_command["request_id"].startswith("bridge-probe-"))
        chat = next(payload for packet_type, payload in received if packet_type == ADMIN_CHAT)
        self.assertTrue(chat.endswith("你好".encode() + b"\0"))

    def test_packet_length_includes_header_and_type(self):
        value = _packet(ADMIN_POLL, b"abc")
        self.assertEqual(struct.unpack("<H", value[:2])[0], 6)
        self.assertEqual(value[2:], bytes([ADMIN_POLL]) + b"abc")

    def test_periodic_state_is_not_actionable(self):
        connector = OpenTTDConnector({"identity_key": "local"}, _noop, _noop)
        self.assertFalse(connector._is_actionable_event("openttd.date", {"date": 1}))
        self.assertFalse(connector._is_actionable_event("openttd.economy", {}))
        self.assertFalse(connector._is_actionable_event(
            "openttd.gamescript", {"message": {"type": "heartbeat"}},
        ))
        self.assertTrue(connector._is_actionable_event("openttd.chat", {"message": "你好"}))
        self.assertTrue(connector._is_actionable_event(
            "openttd.gamescript", {"message": {"type": "vehicle_stuck"}},
        ))

    async def test_gameplay_command_waits_for_matching_gamescript_response(self):
        async def handle(reader, writer):
            try:
                while True:
                    header = await reader.readexactly(2)
                    size = struct.unpack("<H", header)[0]
                    body = await reader.readexactly(size - 2)
                    if body[0] == ADMIN_JOIN:
                        writer.write(_packet(SERVER_PROTOCOL, bytes([3, 0])))
                    elif body[0] == ADMIN_GAMESCRIPT:
                        command = __import__("json").loads(body[1:].rstrip(b"\0"))
                        response = {"type": "command_result", "request_id": command["request_id"], "ok": True}
                        writer.write(_packet(SERVER_GAMESCRIPT, __import__("json").dumps(response).encode() + b"\0"))
                    await writer.drain()
            except asyncio.IncompleteReadError:
                pass
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        with tempfile.TemporaryDirectory() as directory:
            connector = OpenTTDConnector(
                {"identity_key": "local", "settings": {"instance_registry": _instance_registry(directory, port)}}, _noop, _noop,
            )
            with patch.dict(os.environ, {"MON_CONNECTOR_OPENTTD_LOCAL": "secret"}):
                runner = asyncio.create_task(connector.run())
                result = await connector.execute("gameplay_command", {"command": {"action": "ping"}})
                self.assertTrue(result["ok"])
                self.assertTrue(connector._state_payload("test")["capabilities"]["company_gameplay"])
                self.assertTrue(connector.runtime_snapshot()["capabilities"]["gameplay_bridge_ready"])
                runner.cancel()
                await asyncio.gather(runner, return_exceptions=True)
                await connector.close()
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    unittest.main()
