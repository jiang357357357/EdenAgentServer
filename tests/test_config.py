import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from mon_agent_server.config import create_core_base_url, load_server_config


class ConfigTest(unittest.TestCase):
    def test_load_server_config_from_agent_workspace(self):
        env_backup = {
            key: os.environ.get(key)
            for key in [
                "MON_LOG_START_DIR",
                "MON_AGENT_SERVER_LOG_FILE",
                "MON_AGENT_SERVER_PLAIN_LOG_FILE",
                "MON_AGENT_RENDER_LOG_DIR",
                "MON_AGENT_RENDER_LOG_FILE",
                "MON_AGENT_RENDER_PLAIN_LOG_FILE",
                "MON_AGENT_RENDER_PANELS_FILE",
            ]
        }
        try:
            with TemporaryDirectory() as temp_dir:
                start_dir = Path(temp_dir) / "start_000123"
                os.environ["MON_LOG_START_DIR"] = str(start_dir)
                for key in env_backup:
                    if key != "MON_LOG_START_DIR":
                        os.environ.pop(key, None)
                config = load_server_config(Path(__file__).resolve().parents[2])
        finally:
            for key, value in env_backup.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        self.assertEqual(config.port, 40092)
        self.assertEqual(config.vite_port, 40091)
        self.assertEqual(config.workspace_root.name, "Agent")
        self.assertEqual(config.core_base_url, "http://127.0.0.1:40011")
        self.assertTrue(config.display_enabled)
        self.assertEqual(config.log_file, start_dir / "Text" / "MonAgent" / "MonAgent.log")
        self.assertEqual(config.plain_log_file, start_dir / "Text" / "MonAgent" / "MonAgent_plain.log")
        self.assertEqual(config.render_log_dir.name, "Render")
        self.assertEqual(config.render_log_dir, start_dir / "Render")
        self.assertEqual(config.render_panels_file.name, "panels.json")
        self.assertTrue(config.startup_self_awake_enabled)
        self.assertEqual(config.startup_self_awake_delay_seconds, 0)
        self.assertEqual(config.environment.timezone, "Asia/Shanghai")
        self.assertEqual(config.environment.locale, "zh-CN")
        self.assertEqual(config.environment.city, "上海")
        self.assertAlmostEqual(config.environment.latitude or 0, 31.2304, places=4)
        self.assertAlmostEqual(config.environment.longitude or 0, 121.4737, places=4)

    def test_core_base_url_normalizes_public_bind_host(self):
        self.assertEqual(create_core_base_url(None, "0.0.0.0", 40011), "http://127.0.0.1:40011")
        self.assertEqual(create_core_base_url("http://0.0.0.0:40011", None, 1), "http://127.0.0.1:40011")


if __name__ == "__main__":
    unittest.main()
