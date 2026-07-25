import os
import platform
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from mon_agent_server.config import MonConfig, create_core_base_url, environment_context, load_server_config, publish_web_env_defaults


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
                "MON_AGENT_SEARCH_PROVIDER",
                "MON_AGENT_SEARCH_TIMEOUT_MS",
                "MON_AGENT_SEARCH_CACHE_TTL_SECONDS",
                "MON_AGENT_FETCH_TIMEOUT_MS",
                "MON_AGENT_FETCH_MAX_BYTES",
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
        self.assertEqual(config.environment.timezone, "Asia/Shanghai")
        self.assertEqual(config.environment.locale, "zh-CN")
        self.assertEqual(config.environment.city, "上海")
        self.assertAlmostEqual(config.environment.latitude or 0, 31.2304, places=4)
        self.assertAlmostEqual(config.environment.longitude or 0, 121.4737, places=4)
        runtime = environment_context(config.environment)["runtime"]
        self.assertEqual(runtime["operating_system"], platform.system())
        self.assertTrue(runtime["architecture"])

    def test_core_base_url_normalizes_public_bind_host(self):
        self.assertEqual(create_core_base_url(None, "0.0.0.0", 40011), "http://127.0.0.1:40011")
        self.assertEqual(create_core_base_url("http://0.0.0.0:40011", None, 1), "http://127.0.0.1:40011")

    def test_search_config_publishes_defaults_without_overriding_environment(self):
        config = MonConfig(
            data={"search": {"PROVIDER": "exa,brave", "EXA_API_KEY": "config-key", "FETCH_MAX_BYTES": "1000000"}},
            workspace_root=Path("/tmp"),
            files=[],
        )
        with patch.dict(os.environ, {"EXA_API_KEY": "environment-key"}, clear=True):
            publish_web_env_defaults(config)
            self.assertEqual(os.environ["MON_AGENT_SEARCH_PROVIDER"], "exa,brave")
            self.assertEqual(os.environ["EXA_API_KEY"], "environment-key")
            self.assertEqual(os.environ["MON_AGENT_FETCH_MAX_BYTES"], "1000000")


if __name__ == "__main__":
    unittest.main()
