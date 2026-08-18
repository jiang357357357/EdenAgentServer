from __future__ import annotations

import unittest

from mon_agent_server.agent_api import AgentTool
from mon_agent_server.llm.cache import advance_cache_prefix, cache_prefix_state


def _tool(name: str, properties: dict) -> AgentTool:
    return AgentTool(
        name=name,
        label=name,
        description=f"Tool {name}",
        parameters={"type": "object", "properties": properties},
        execute=lambda *_args: None,
    )


class PromptCacheFingerprintTest(unittest.TestCase):
    def test_fingerprint_ignores_object_key_order_but_preserves_tool_order(self) -> None:
        model = {"provider": "openai", "id": "gpt-test", "api": "responses"}
        alpha = _tool("alpha", {"z": {"type": "string"}, "a": {"type": "number"}})
        beta = _tool("beta", {"value": {"type": "boolean"}})
        reordered_alpha = _tool("alpha", {"a": {"type": "number"}, "z": {"type": "string"}})

        first = cache_prefix_state(model, "medium", "system", [alpha, beta])
        second = cache_prefix_state(model, "medium", "system", [reordered_alpha, beta])
        reordered_tools = cache_prefix_state(model, "medium", "system", [beta, reordered_alpha])

        self.assertEqual(first["fingerprint"], second["fingerprint"])
        self.assertNotEqual(first["fingerprint"], reordered_tools["fingerprint"])

    def test_epoch_advances_with_specific_invalidation_reason(self) -> None:
        model = {"provider": "openai", "id": "gpt-test", "api": "responses"}
        first = advance_cache_prefix(
            None,
            cache_prefix_state(model, "off", "system", [_tool("alpha", {})]),
        )
        stable = advance_cache_prefix(
            first,
            cache_prefix_state(model, "off", "system", [_tool("alpha", {})]),
        )
        changed = advance_cache_prefix(
            stable,
            cache_prefix_state(model, "off", "system", [_tool("alpha", {}), _tool("beta", {})]),
        )

        self.assertEqual((first["epoch"], first["invalidationReason"]), (0, "initial"))
        self.assertEqual((stable["epoch"], stable["invalidationReason"]), (0, "stable"))
        self.assertEqual(changed["epoch"], 1)
        self.assertEqual(changed["invalidationReason"], "tools")
        self.assertEqual(changed["changedComponents"], ["tools"])
