from pathlib import Path
import unittest

from mon_agent_server.config import create_core_base_url, load_server_config


class ConfigTest(unittest.TestCase):
    def test_load_server_config_from_agent_workspace(self):
        config = load_server_config(Path(__file__).resolve().parents[2])

        self.assertEqual(config.port, 40092)
        self.assertEqual(config.vite_port, 40091)
        self.assertEqual(config.workspace_root.name, "Agent")
        self.assertEqual(config.core_base_url, "http://127.0.0.1:40011")
        self.assertTrue(config.startup_self_awake_enabled)
        self.assertEqual(config.startup_self_awake_delay_seconds, 0)

    def test_core_base_url_normalizes_public_bind_host(self):
        self.assertEqual(create_core_base_url(None, "0.0.0.0", 40011), "http://127.0.0.1:40011")
        self.assertEqual(create_core_base_url("http://0.0.0.0:40011", None, 1), "http://127.0.0.1:40011")


if __name__ == "__main__":
    unittest.main()
