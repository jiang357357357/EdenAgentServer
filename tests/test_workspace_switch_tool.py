from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from mon_agent_server.tools.context import MonToolContext
from mon_agent_server.tools.workspace_switch import create_workspace_switch_tools
from mon_agent_server.skills.runtime import MonAgentSkillRuntime


class WorkspaceSwitchToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_is_active_in_user_chat_profile(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = MonAgentSkillRuntime(
                directory,
                MonToolContext(agent_path="/root", request_workspace_switch=lambda path: {"path": path}),
                profile="user_chat",
            )
            tool = next(item for item in runtime.active_tools() if item.name == "switch_workspace")
        self.assertEqual(tool.exposure, "direct")

    async def test_requests_switch_to_resolved_directory(self) -> None:
        requested: list[str] = []

        def request(path: str) -> dict[str, object]:
            requested.append(path)
            return {"path": path, "status": "pending"}

        with tempfile.TemporaryDirectory() as directory:
            tool = create_workspace_switch_tools(
                MonToolContext(agent_path="/root", request_workspace_switch=request)
            )[0]
            result = await tool.execute("call-1", {"path": directory})

        self.assertEqual(requested, [str(Path(directory).resolve())])
        self.assertEqual(result["structuredContent"]["status"], "pending")

    async def test_rejects_missing_directory(self) -> None:
        tool = create_workspace_switch_tools(
            MonToolContext(agent_path="/root", request_workspace_switch=lambda path: {"path": path})
        )[0]
        with self.assertRaisesRegex(ValueError, "不存在"):
            await tool.execute("call-2", {"path": "/definitely/missing/monagent-workspace"})

    async def test_subagent_cannot_switch_workspace(self) -> None:
        tool = create_workspace_switch_tools(
            MonToolContext(agent_path="/root/child", request_workspace_switch=lambda path: {"path": path})
        )[0]
        with self.assertRaisesRegex(RuntimeError, "父智能体"):
            await tool.execute("call-3", {"path": "."})


if __name__ == "__main__":
    unittest.main()
