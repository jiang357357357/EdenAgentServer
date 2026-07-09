from __future__ import annotations

import importlib
import os
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


class DisplayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.env_backup = {
            key: os.environ.get(key)
            for key in [
                "MON_AGENT_RENDER_LOG_DIR",
                "MON_AGENT_RENDER_LOG_FILE",
                "MON_AGENT_RENDER_PLAIN_LOG_FILE",
                "MON_AGENT_RENDER_PANELS_FILE",
                "MON_AGENT_SILENT_BOOT",
            ]
        }

    def tearDown(self) -> None:
        for key, value in self.env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def reload_table_renderer(self):
        import mon_agent_server.display.core.printer as printer
        import mon_agent_server.display.renderers.table as table

        importlib.reload(printer)
        return importlib.reload(table)

    def test_render_table_writes_panel_index_svg_and_plain_log(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            render_dir = root / "Render"
            os.environ["MON_AGENT_RENDER_LOG_DIR"] = str(render_dir)
            os.environ["MON_AGENT_RENDER_LOG_FILE"] = str(render_dir / "render.log")
            os.environ["MON_AGENT_RENDER_PLAIN_LOG_FILE"] = str(render_dir / "render_plain.log")
            os.environ["MON_AGENT_RENDER_PANELS_FILE"] = str(render_dir / "panels.json")
            os.environ["MON_AGENT_SILENT_BOOT"] = "true"
            table = self.reload_table_renderer()

            stdout = StringIO()
            stderr = StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                table.render_table(
                    ["项目", "值"],
                    [["服务", "MonAgent"], ["状态", "[bold green]运行中[/bold green]"]],
                    title="[AGENT-TEST] 表格测试",
                    width=80,
                )

            plain_log = render_dir / "render_plain.log"
            panels = render_dir / "panels.json"
            svg_files = list((render_dir / "svg").glob("*.svg"))

            self.assertTrue(plain_log.exists())
            self.assertTrue(panels.exists())
            self.assertTrue(svg_files)
            self.assertIn("表格测试", plain_log.read_text(encoding="utf-8"))
            self.assertIn("MonAgent", plain_log.read_text(encoding="utf-8"))
            self.assertIn("MonAgent", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
