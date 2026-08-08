from __future__ import annotations

import asyncio
import base64
import json
import subprocess
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

    def list_skill_installations(self, _token: str, device_id: str | None = None) -> list[dict[str, Any]]:
        if device_id is None:
            return list(self.records.values())
        return [item for item in self.records.values() if item["device_id"] == device_id]

    def update_skill_installation(
        self, _token: str, installation_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.records[installation_id].update(payload)
        return self.records[installation_id]

    def delete_skill_installation(self, _token: str, installation_id: str) -> dict[str, Any]:
        self.records.pop(installation_id)
        return {"deleted": True, "external_installation_id": installation_id}


def write_skill(root: Path, *, version: str = "1.0.0", tools: str = "web") -> None:
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
        self.assertEqual(preview["tools"], ["web"])

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
        self.assertIn("web", {tool.name for tool in runtime.active_tools()})

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

    def test_generated_skill_is_created_immediately_and_can_be_updated(self) -> None:
        installed = self.service.create_generated(
            self.owner_id,
            "token",
            "local",
            {
                "name": "daily-brief",
                "display_name": "每日简报",
                "description": "Use when the user asks for a reusable daily web briefing.",
                "instructions": "搜索最新来源，提炼三条重要信息并标明来源。",
                "tools": ["web"],
                "profiles": ["user_chat"],
                "scope": "project",
            },
        )

        self.assertEqual(installed["skillName"], "daily-brief")
        self.assertEqual(installed["sourceType"], "generated")
        target = skill_roots(self.workspace, self.owner_key)["project"] / "daily-brief"
        self.assertTrue((target / "SKILL.md").is_file())

        updated = self.service.create_generated(
            self.owner_id,
            "token",
            "local",
            {
                "name": "daily-brief",
                "display_name": "每日简报",
                "description": "Use when the user asks for a reusable daily web briefing.",
                "instructions": "搜索最新来源，提炼五条重要信息并标明来源。",
                "tools": ["web"],
                "scope": "project",
                "version": "1.1.0",
            },
        )
        self.assertEqual(updated["id"], installed["id"])
        self.assertIn("提炼五条", (target / "SKILL.md").read_text(encoding="utf-8"))

    def test_generated_skill_can_be_created_inside_agent_event_loop(self) -> None:
        async def inspect() -> dict[str, Any]:
            return self.service.create_generated(
                self.owner_id,
                "token",
                "local",
                {
                    "name": "async-skill",
                    "display_name": "异步技能",
                    "description": "Use to verify candidate validation from an agent tool.",
                    "instructions": "读取相关内容并给出简洁结论。",
                    "tools": ["read"],
                    "scope": "project",
                },
            )

        preview = asyncio.run(inspect())
        self.assertEqual(preview["skillName"], "async-skill")

    def test_existing_runtime_refreshes_after_skill_creation(self) -> None:
        runtime = create_skill_runtime(
            self.workspace,
            profile="user_chat",
            owner_key=self.owner_key,
        )
        self.assertNotIn("late-skill", runtime.available_skill_ids)
        self.service.create_generated(
            self.owner_id,
            "token",
            "local",
            {
                "name": "late-skill",
                "description": "Use to verify same-run skill discovery after creation.",
                "instructions": "报告技能已经在当前运行中可见。",
                "tools": ["read"],
                "scope": "project",
            },
        )
        loaded = runtime.load(["late-skill"])
        self.assertTrue(loaded["success"])
        self.assertIn("late-skill", runtime.available_skill_ids)

    def test_generated_skill_registers_and_executes_code_tool(self) -> None:
        runtime = create_skill_runtime(
            self.workspace,
            profile="user_chat",
            owner_key=self.owner_key,
        )
        installed = self.service.create_generated(
            self.owner_id,
            "token",
            "local",
            {
                "name": "echo-tool-skill",
                "description": "Use to verify a skill-defined runtime code tool.",
                "instructions": "调用 echo_skill_value 返回输入内容。",
                "tools": ["echo_skill_value"],
                "scope": "project",
                "files": [
                    {
                        "path": "scripts/echo.py",
                        "content": (
                            "#!/usr/bin/env python3\n"
                            "import json, sys\n"
                            "data = json.load(sys.stdin)\n"
                            "print(json.dumps({'text': 'echo:' + str(data.get('value', ''))}))\n"
                        ),
                        "executable": True,
                    },
                    {
                        "path": "tools/echo.json",
                        "content": json.dumps(
                            {
                                "schemaVersion": 1,
                                "name": "echo_skill_value",
                                "label": "回显技能值",
                                "description": "Return the supplied value through the skill process.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {"value": {"type": "string"}},
                                    "required": ["value"],
                                },
                                "outputSchema": {
                                    "type": "object",
                                    "properties": {"text": {"type": "string"}},
                                    "required": ["text"],
                                },
                                "command": ["python3", "scripts/echo.py"],
                                "testCommand": ["python3", "scripts/echo.py"],
                            },
                            ensure_ascii=False,
                        ),
                    },
                ],
            },
        )
        self.assertEqual(installed["skillName"], "echo-tool-skill")
        loaded = runtime.load(["echo-tool-skill"])
        self.assertTrue(loaded["success"])
        tool = next(tool for tool in runtime.active_tools() if tool.name == "echo_skill_value")
        self.assertEqual(tool.exposure, "deferred")
        self.assertEqual(tool.output_schema["required"], ["text"])
        result = asyncio.run(tool.execute("call-1", {"value": "hello"}))
        self.assertEqual(result["details"]["result"]["text"], "echo:hello")

    def test_generated_skill_supports_scripts_references_assets_and_agent_metadata(self) -> None:
        installed = self.service.create_generated(
            self.owner_id,
            "token",
            "local",
            {
                "name": "code-bundle",
                "display_name": "代码技能包",
                "description": "Use when a deterministic greeting and its reference are needed.",
                "instructions": (
                    "运行 `scripts/greet.py` 生成结果。需要了解格式时读取 "
                    "`references/format.md`；复制模板时使用 `assets/template.txt`。"
                ),
                "default_prompt": "使用代码技能包生成一次问候。",
                "tools": ["bash", "read"],
                "scope": "project",
                "files": [
                    {
                        "path": "scripts/greet.py",
                        "content": "#!/usr/bin/env python3\nprint('hello from skill')\n",
                        "executable": True,
                    },
                    {"path": "references/format.md", "content": "# Format\n\nReturn one line.\n"},
                    {"path": "assets/template.txt", "content": "hello, {{name}}\n"},
                    {
                        "path": "assets/pixel.bin",
                        "content": base64.b64encode(b"\x00\x01\x02").decode("ascii"),
                        "encoding": "base64",
                    },
                ],
            },
        )

        target = skill_roots(self.workspace, self.owner_key)["project"] / "code-bundle"
        self.assertTrue((target / "scripts" / "greet.py").stat().st_mode & 0o111)
        self.assertEqual((target / "assets" / "pixel.bin").read_bytes(), b"\x00\x01\x02")
        metadata = (target / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertIn("使用代码技能包生成一次问候", metadata)
        self.assertEqual(installed["fileCount"], 6)

        result = subprocess.run(
            [str(target / "scripts" / "greet.py")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "hello from skill")

        runtime = create_skill_runtime(self.workspace, profile="user_chat", owner_key=self.owner_key)
        loaded = runtime.load(["code-bundle"])
        self.assertTrue(loaded["success"])
        self.assertIn(str(target / "SKILL.md"), loaded["instructions"])
        self.assertIn("references/format.md", loaded["instructions"])

    def test_generated_skill_rejects_unsafe_or_unrelated_files(self) -> None:
        base = {
            "name": "unsafe-bundle",
            "display_name": "不安全技能包",
            "description": "Use to verify generated package path validation.",
            "instructions": "执行已验证的流程。",
            "tools": ["read"],
            "scope": "project",
        }
        for path in ("../escape.py", "README.md", "scripts/../../escape.py", ".hidden/file"):
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, "路径|文档"):
                    self.service.inspect_generated(
                        self.owner_id,
                        {**base, "files": [{"path": path, "content": "bad"}]},
                    )

    def test_list_repairs_missing_core_record_and_details_expose_content(self) -> None:
        installed = self.service.create_generated(
            self.owner_id,
            "token",
            "local",
            {
                "name": "repairable-skill",
                "display_name": "可修复技能",
                "description": "Use to verify local skill reconciliation.",
                "instructions": "读取状态并报告。",
                "tools": ["read"],
                "scope": "project",
            },
        )
        installation_id = installed["id"]
        self.core.records.clear()

        listed = self.service.list(self.owner_id, "token", "desktop-2")
        repaired = next(item for item in listed if item.get("skillName") == "repairable-skill")
        self.assertEqual(repaired["id"], installation_id)
        self.assertIn(installation_id, self.core.records)

        details = self.service.details(self.owner_id, "token", "desktop-2", installation_id)
        self.assertIn("读取状态并报告", details["content"])
        self.assertIn("SKILL.md", details["files"])

    def test_project_skill_marks_same_named_user_skill_as_shadowed(self) -> None:
        payload = {
            "name": "layered-skill",
            "display_name": "分层技能",
            "description": "Use to verify skill scope precedence.",
            "instructions": "报告当前范围。",
            "tools": ["read"],
        }
        project = self.service.create_generated(self.owner_id, "token", "local", {**payload, "scope": "project"})
        project_record = dict(self.core.records[project["id"]])
        user_id = "skill_layered_user"
        self.core.records[user_id] = {
            **project_record,
            "external_installation_id": user_id,
            "scope": "user",
        }

        listed = [item for item in self.service.list(self.owner_id, "token", "desktop-2") if item.get("skillName") == "layered-skill"]
        self.assertEqual(len(listed), 2)
        self.assertTrue(next(item for item in listed if item["scope"] == "user")["shadowed"])
        self.assertFalse(next(item for item in listed if item["scope"] == "project")["shadowed"])

    def test_model_skill_inventory_distinguishes_builtin_generated_and_scope(self) -> None:
        generated = self.service.create_generated(
            self.owner_id,
            "token",
            "local",
            {
                "name": "inventory-skill",
                "display_name": "清单技能",
                "description": "Use when testing the model-facing skill inventory.",
                "instructions": "读取真实技能清单。",
                "tools": ["list_skills"],
                "scope": "project",
            },
        )

        builtins = self.service.list_for_model(
            self.owner_id, "token", "local", {"kind": "builtin"}
        )
        generated_items = self.service.list_for_model(
            self.owner_id,
            "token",
            "local",
            {"kind": "generated", "scope": "project", "enabled": "enabled"},
        )

        self.assertTrue(builtins)
        self.assertTrue(all(item["builtin"] for item in builtins))
        self.assertEqual([item["skillName"] for item in generated_items], ["inventory-skill"])
        self.assertEqual(generated_items[0]["id"], generated["id"])
        self.assertEqual(generated_items[0]["sourceType"], "generated")
        self.assertNotIn("sourceUri", generated_items[0])

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
        try:
            (self.source / "outside-link").symlink_to(self.workspace / "outside")
        except OSError as error:
            self.skipTest(f"当前平台无法创建符号链接: {error}")
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
