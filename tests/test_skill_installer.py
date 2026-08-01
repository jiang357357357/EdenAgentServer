from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from mon_agent_server.skills import create_skill_runtime, owner_storage_key
from mon_agent_server.skills.installer import INSTALLATION_MANIFEST, SkillInstallationService, skill_roots


class FakeCoreClient:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}

    def upsert_skill_installation(self, _token: str, payload: dict[str, Any]) -> dict[str, Any]:
        record = {
            **payload,
            "installed_at": "2026-07-21T00:00:00Z",
            "updated_at": "2026-07-21T00:00:00Z",
        }
        self.records[payload["external_installation_id"]] = record
        return record

    def list_skill_installations(self, _token: str, device_id: str) -> list[dict[str, Any]]:
        return [item for item in self.records.values() if item["device_id"] == device_id]

    def update_skill_installation(
        self, _token: str, installation_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.records[installation_id].update(payload)
        return self.records[installation_id]

    def delete_skill_installation(self, _token: str, installation_id: str) -> dict[str, Any]:
        self.records.pop(installation_id)
        return {"deleted": True, "external_installation_id": installation_id}


def write_skill(root: Path, *, version: str = "1.0.0", tools: str = "web_search") -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: sample-skill",
                "description: Search the web using the project's approved search tool.",
                "metadata:",
                "  monagent:",
                "    display_name: 示例技能",
                f"    version: {version}",
                f"    tools: [{tools}]",
                "    profiles: [user_chat]",
                "---",
                "先搜索可信来源，然后给出结论。",
            ]
        ),
        encoding="utf-8",
    )


def write_plain_pi_skill(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        "---\nname: plain-skill\ndescription: A native Pi skill without MonAgent metadata.\n---\n"
        "Read the relevant files before answering.\n",
        encoding="utf-8",
    )


class SkillInstallationServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temporary.name)
        self.source = self.workspace / "source"
        write_skill(self.source)
        self.core = FakeCoreClient()
        self.service = SkillInstallationService(self.workspace, self.core)  # type: ignore[arg-type]
        self.owner_id = 42
        self.owner_key = owner_storage_key(self.owner_id)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_inspect_install_activate_disable_update_and_uninstall(self) -> None:
        preview = self.service.inspect(
            self.owner_id,
            {
                "sourceType": "local",
                "sourceUri": str(self.source),
                "scope": "project",
            },
        )
        self.assertEqual(preview["skillName"], "sample-skill")
        self.assertEqual(preview["tools"], ["web_search"])

        installed = self.service.install(self.owner_id, "token", "desktop-1", preview["previewID"])
        installation_id = installed["id"]
        target = skill_roots(self.workspace, self.owner_key)["project"] / "sample-skill"
        self.assertTrue((target / "SKILL.md").is_file())
        manifest = json.loads((target / INSTALLATION_MANIFEST).read_text(encoding="utf-8"))
        self.assertEqual(manifest["installationID"], installation_id)

        runtime = create_skill_runtime(self.workspace, profile="user_chat", owner_key=self.owner_key)
        self.assertIn("sample-skill", runtime.available_skill_ids)
        loaded = runtime.load(["sample-skill"])
        self.assertIn("<skill name=\"sample-skill\"", loaded["instructions"])
        self.assertIn("web_search", {tool.name for tool in runtime.active_tools()})

        disabled = self.service.set_enabled(self.owner_id, "token", "desktop-1", installation_id, False)
        self.assertFalse(disabled["enabled"])
        disabled_runtime = create_skill_runtime(self.workspace, profile="user_chat", owner_key=self.owner_key)
        self.assertNotIn("sample-skill", disabled_runtime.available_skill_ids)

        write_skill(self.source, version="1.1.0")
        update_preview = self.service.inspect_update(
            self.owner_id, "token", "desktop-1", installation_id
        )
        self.assertEqual(update_preview["replaceInstallationID"], installation_id)
        updated = self.service.install(self.owner_id, "token", "desktop-1", update_preview["previewID"])
        self.assertEqual(updated["id"], installation_id)
        self.assertEqual(updated["version"], "1.1.0")
        self.assertFalse(updated["enabled"])

        result = self.service.uninstall(self.owner_id, "token", "desktop-1", installation_id)
        self.assertTrue(result["deleted"])
        self.assertFalse(target.exists())
        self.assertEqual(self.core.records, {})

    def test_unknown_tools_are_rejected(self) -> None:
        write_skill(self.source, tools="made_up_tool")
        with self.assertRaisesRegex(ValueError, "未知工具"):
            self.service.inspect(
                self.owner_id,
                {"sourceType": "local", "sourceUri": str(self.source), "scope": "project"},
            )

    def test_plain_pi_skill_loads_without_declaring_tools_or_permissions(self) -> None:
        write_plain_pi_skill(self.source)
        preview = self.service.inspect(
            self.owner_id,
            {"sourceType": "local", "sourceUri": str(self.source), "scope": "project"},
        )
        self.assertEqual(preview["skillName"], "plain-skill")
        self.assertEqual(preview["tools"], [])
        self.service.install(self.owner_id, "token", "desktop-1", preview["previewID"])

        runtime = create_skill_runtime(self.workspace, profile="user_chat", owner_key=self.owner_key)
        before = {tool.name for tool in runtime.active_tools()}
        loaded = runtime.load(["plain-skill"])
        after = {tool.name for tool in runtime.active_tools()}

        self.assertTrue(loaded["success"])
        self.assertIn("Read the relevant files", loaded["instructions"])
        self.assertNotIn("capabilitiesEnabled", loaded)
        self.assertEqual(before, after)

    def test_symbolic_links_are_rejected(self) -> None:
        (self.source / "outside-link").symlink_to(self.workspace / "outside")
        with self.assertRaisesRegex(ValueError, "符号链接"):
            self.service.inspect(
                self.owner_id,
                {"sourceType": "local", "sourceUri": str(self.source), "scope": "project"},
            )

    def test_preview_is_owned_and_single_use(self) -> None:
        preview = self.service.inspect(
            self.owner_id,
            {"sourceType": "local", "sourceUri": str(self.source), "scope": "project"},
        )
        with self.assertRaisesRegex(ValueError, "预检已失效"):
            self.service.install(99, "token", "desktop-1", preview["previewID"])
        with self.assertRaisesRegex(ValueError, "预检已失效"):
            self.service.install(self.owner_id, "token", "desktop-1", preview["previewID"])


if __name__ == "__main__":
    unittest.main()
