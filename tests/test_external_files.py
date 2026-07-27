from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from mon_agent_server.tools import MonToolContext
from mon_agent_server.tools.external_files import create_external_file_tools


class AllowBroker:
    def __init__(self) -> None:
        self.requests: list[dict] = []

    def is_always_allowed(self, _permission: str, _pattern: str) -> bool:
        return False

    def ask(self, request: dict) -> str:
        self.requests.append(request)
        return "once"


def by_name(tools, name):
    return next(tool for tool in tools if tool.name == name)


class ExternalFileToolsTest(unittest.IsolatedAsyncioTestCase):
    async def test_reads_only_inside_explicit_authorized_root(self):
        with TemporaryDirectory() as workspace, TemporaryDirectory() as external:
            root = Path(external)
            (root / "saves").mkdir()
            (root / "saves" / "slot1.json").write_text('{"level": 4}', encoding="utf-8")
            broker = AllowBroker()
            tools = create_external_file_tools(
                Path(workspace),
                MonToolContext(session_id="ses_test", permissions=broker),
            )

            result = await by_name(tools, "external_read").run(
                "call_read", {"root": str(root), "path": "saves/slot1.json"}
            )

            self.assertIn('"level": 4', result["content"][0]["text"])
            self.assertEqual(broker.requests, [])

    async def test_find_is_bounded_and_skips_symlinks(self):
        with TemporaryDirectory() as workspace, TemporaryDirectory() as external, TemporaryDirectory() as secret:
            root = Path(external)
            (root / "Steam" / "game").mkdir(parents=True)
            (root / "Steam" / "game" / "save-slot.dat").write_text("ok", encoding="utf-8")
            (Path(secret) / "secret-save.dat").write_text("secret", encoding="utf-8")
            (root / "escaped").symlink_to(secret, target_is_directory=True)
            tools = create_external_file_tools(
                Path(workspace), MonToolContext(session_id="ses_test", permissions=AllowBroker())
            )

            result = await by_name(tools, "external_find").run(
                "call_find", {"root": str(root), "name": "save", "max_depth": 8}
            )

            self.assertEqual(
                result["details"]["matches"],
                [{"path": "Steam/game/save-slot.dat", "type": "file"}],
            )

    async def test_rejects_path_traversal_and_symlink_escape(self):
        with TemporaryDirectory() as workspace, TemporaryDirectory() as external, TemporaryDirectory() as secret:
            root = Path(external)
            (Path(secret) / "token.txt").write_text("hidden", encoding="utf-8")
            (root / "link.txt").symlink_to(Path(secret) / "token.txt")
            tools = create_external_file_tools(
                Path(workspace), MonToolContext(session_id="ses_test", permissions=AllowBroker())
            )

            with self.assertRaisesRegex(RuntimeError, "越过已授权目录"):
                await by_name(tools, "external_read").run(
                    "call_link", {"root": str(root), "path": "link.txt"}
                )
            with self.assertRaisesRegex(RuntimeError, "越过已授权目录"):
                await by_name(tools, "external_read").run(
                    "call_parent", {"root": str(root), "path": f"../{Path(secret).name}/token.txt"}
                )

    async def test_rejects_broad_roots_before_permission(self):
        with TemporaryDirectory() as workspace:
            broker = AllowBroker()
            tools = create_external_file_tools(
                Path(workspace), MonToolContext(session_id="ses_test", permissions=broker)
            )
            with self.assertRaisesRegex(RuntimeError, "过宽"):
                await by_name(tools, "external_ls").run("call_root", {"root": "/"})
            if Path("/home").is_dir():
                with self.assertRaisesRegex(RuntimeError, "过宽"):
                    await by_name(tools, "external_ls").run("call_home", {"root": "/home"})
            with self.assertRaisesRegex(RuntimeError, "过宽"):
                await by_name(tools, "external_ls").run(
                    "call_user_home", {"root": str(Path.home())}
                )
            self.assertEqual(broker.requests, [])

    async def test_reads_outside_workspace_without_permission_context(self):
        with TemporaryDirectory() as workspace, TemporaryDirectory() as external:
            tools = create_external_file_tools(Path(workspace), MonToolContext())
            result = await by_name(tools, "external_ls").run(
                "call_no_permission", {"root": external}
            )
            self.assertEqual(result["details"]["entries"], [])


if __name__ == "__main__":
    unittest.main()
