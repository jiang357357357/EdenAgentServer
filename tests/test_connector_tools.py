import json
import unittest

from mon_agent_server.tools.connectors import create_connector_tools
from mon_agent_server.tools.context import MonToolContext


class FakeCore:
    def __init__(self):
        self.connectors = []
        self.completed_payload = None

    def list_connectors(self, _token):
        return list(self.connectors)

    def register_connector(self, _token, payload):
        row = {"id": len(self.connectors) + 1, "runtime_state": "offline", **payload}
        self.connectors.append(row)
        return row

    def update_connector(self, _token, connector_id, payload):
        row = next(item for item in self.connectors if str(item["id"]) == str(connector_id))
        row.update(payload)
        return row

    def claim_connector_events(self, _token, payload):
        return {"lease_id": "lease-1", "events": [{"id": 7, "connector_key": "lichess", "event_type": "turn", "payload": {"fen": "test"}}]}

    def complete_connector_events(self, _token, payload):
        self.completed_payload = payload
        return {"completed": len(payload["event_ids"])}

    def release_connector_events(self, _token, payload):
        return {"released": len(payload["event_ids"])}


class FakeConnectorManager:
    def __init__(self):
        self.calls = []

    def execute(self, token, connector, action, payload):
        self.calls.append((token, connector, action, payload))
        return {"ok": True}


def by_name(tools, name):
    return next(tool for tool in tools if tool.name == name)


class ConnectorToolTest(unittest.IsolatedAsyncioTestCase):
    async def test_current_assistant_can_register_claim_and_finish(self):
        core = FakeCore()
        tools = create_connector_tools(MonToolContext(core_client=core, core_token="token", assistant={"id": 3}))
        registered = await by_name(tools, "register_connector").run("call-1", {
            "connector_key": "lichess", "identity_key": "kayoko", "connect": True,
        })
        self.assertNotIn("assistant", registered["details"]["connector"])
        claimed = await by_name(tools, "claim_connector_events").run("call-2", {})
        self.assertEqual(claimed["details"]["lease_id"], "lease-1")
        self.assertIn("租约 ID：lease-1", claimed["content"][0]["text"])
        finished = await by_name(tools, "finish_connector_events").run("call-3", {
            "event_ids": [7],
        })
        self.assertEqual(finished["details"]["completed"], 1)
        self.assertEqual(core.completed_payload["lease_id"], "lease-1")

    async def test_connectors_are_shared_across_assistants(self):
        core = FakeCore()
        core.connectors.append({"id": 2, "connector_key": "lichess", "identity_key": "shared"})
        first = create_connector_tools(MonToolContext(core_client=core, core_token="token", assistant={"id": 3}))
        second = create_connector_tools(MonToolContext(core_client=core, core_token="token", assistant={"id": 4}))
        self.assertEqual((await by_name(first, "list_connectors").run("call-1", {}))["details"]["connectors"][0]["id"], 2)
        self.assertEqual((await by_name(second, "list_connectors").run("call-2", {}))["details"]["connectors"][0]["id"], 2)

    async def test_list_connectors_returns_bounded_model_summary(self):
        core = FakeCore()
        core.connectors.append({
            "id": 8,
            "connector_key": "openttd",
            "identity_key": "local",
            "desired_state": "connected",
            "runtime_state": "reconnecting",
            "last_error": "Admin Port connection refused",
            "settings": {"credential": "must-not-reach-model"},
            "thread_sessions": [{"id": index, "dump": "x" * 100} for index in range(50)],
        })
        tool = by_name(
            create_connector_tools(MonToolContext(core_client=core, core_token="token", assistant={"id": 3})),
            "list_connectors",
        )

        result = await tool.run("call-list", {})
        serialized = json.dumps(result, ensure_ascii=False)

        self.assertIn("reconnecting", result["content"][0]["text"])
        self.assertIn("Admin Port connection refused", result["content"][0]["text"])
        self.assertNotIn("thread_sessions", serialized)
        self.assertNotIn("must-not-reach-model", serialized)
        self.assertEqual(result["structuredContent"]["count"], 1)
        contract = result["structuredContent"]["connectors"][0]["contract"]
        self.assertTrue(contract["hot_reload"])
        self.assertTrue(contract["worker_isolated"])
        self.assertIn("gameplay_plan", contract["action_schemas"])

    async def test_connector_action_schema_is_generated_from_installed_manifests(self):
        tool = by_name(create_connector_tools(MonToolContext()), "execute_connector_action")
        payload = tool.parameters["properties"]["payload"]
        actions = tool.parameters["properties"]["action"]["enum"]
        self.assertIn("accept_challenge", actions)
        self.assertIn("gameplay_plan", actions)
        self.assertIn("challenge_id", payload["properties"])
        self.assertNotIn("challengeId", payload["properties"])
        self.assertIn("generic", payload["properties"]["reason"]["enum"])
        # The generic outer tool can carry fields from newly installed
        # manifests; the selected connector's exact schema is enforced before
        # RPC dispatch.
        self.assertTrue(payload["additionalProperties"])

    async def test_connector_action_reports_missing_snake_case_field(self):
        core = FakeCore()
        core.connectors.append({"id": 2, "connector_key": "lichess"})
        manager = FakeConnectorManager()
        tools = create_connector_tools(MonToolContext(
            core_client=core, core_token="token", assistant={"id": 3}, connector_manager=manager,
        ))
        with self.assertRaisesRegex(RuntimeError, "challenge_id.*snake_case"):
            await by_name(tools, "execute_connector_action").run("call-1", {
                "connector_id": 2,
                "action": "decline_challenge",
                "payload": {"challengeId": "c1", "reason": "generic"},
            })

    async def test_connector_action_rejects_free_form_decline_reason(self):
        core = FakeCore()
        core.connectors.append({"id": 2, "connector_key": "lichess"})
        manager = FakeConnectorManager()
        tools = create_connector_tools(MonToolContext(
            core_client=core, core_token="token", assistant={"id": 3}, connector_manager=manager,
        ))
        with self.assertRaisesRegex(RuntimeError, "payload.reason.*generic"):
            await by_name(tools, "execute_connector_action").run("call-1", {
                "connector_id": 2,
                "action": "decline_challenge",
                "payload": {"challenge_id": "c1", "reason": "not now"},
            })

    async def test_register_rejects_connector_without_an_installed_manifest(self):
        core = FakeCore()
        tool = by_name(
            create_connector_tools(MonToolContext(core_client=core, core_token="token", assistant={"id": 3})),
            "register_connector",
        )
        with self.assertRaisesRegex(RuntimeError, "未安装连接器类型"):
            await tool.run("call-register", {
                "connector_key": "missing-connector",
                "identity_key": "local",
            })

    async def test_openttd_query_is_structured_and_read_only(self):
        core = FakeCore()
        core.connectors.append({"id": 8, "connector_key": "openttd"})
        manager = FakeConnectorManager()
        tools = create_connector_tools(MonToolContext(
            core_client=core, core_token="token", assistant={"id": 3}, connector_manager=manager,
        ))
        result = await by_name(tools, "query_openttd").run("call-1", {
            "connector_id": 8, "query": "find_towns", "x": 12, "y": 34, "limit": 5,
        })
        self.assertTrue(result["details"]["ok"])
        self.assertEqual(result["structuredContent"], {"ok": True})
        self.assertEqual(by_name(tools, "query_openttd").output_schema, {"type": "object"})
        self.assertEqual(manager.calls[0][2], "gameplay_command")
        self.assertEqual(manager.calls[0][3]["command"], {
            "action": "find_towns", "x": 12, "y": 34, "limit": 5,
        })
        self.assertIn('"ok": true', result["content"][0]["text"])

    async def test_send_chat_is_shared_by_openttd_without_game_id(self):
        core = FakeCore()
        core.connectors.append({"id": 8, "connector_key": "openttd"})
        manager = FakeConnectorManager()
        tools = create_connector_tools(MonToolContext(
            core_client=core, core_token="token", assistant={"id": 3}, connector_manager=manager,
        ))

        result = await by_name(tools, "execute_connector_action").run("call-1", {
            "connector_id": 8,
            "action": "send_chat",
            "payload": {"text": "你好"},
        })

        self.assertTrue(result["details"]["ok"])
        self.assertEqual(manager.calls[0][2:], ("send_chat", {"text": "你好"}))
