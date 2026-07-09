from __future__ import annotations

import logging
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from mon_agent_server.logging import configure, get_logger, install_standard_logging_bridge, shutdown
from mon_agent_server.logging.handlers import MonAgentLogBridgeHandler


class LoggingTest(unittest.TestCase):
    def tearDown(self) -> None:
        shutdown()
        std_logger = logging.getLogger("mon_agent_server.test")
        std_logger.handlers = [
            handler for handler in std_logger.handlers if not isinstance(handler, MonAgentLogBridgeHandler)
        ]
        std_logger.propagate = True

    def configure_temp_logs(self, text_root: Path, *, max_bytes: int = 10 * 1024 * 1024) -> tuple[Path, Path]:
        log_file = text_root / "MonAgent" / "MonAgent.log"
        plain_log_file = text_root / "MonAgent" / "MonAgent_plain.log"
        configure(
            console_enabled=False,
            file_enabled=True,
            color_enabled=False,
            dual_file_enabled=True,
            level="DEBUG",
            text_log_root=text_root,
            log_file=log_file,
            plain_log_file=plain_log_file,
            max_bytes=max_bytes,
            backup_count=2,
        )
        return log_file, plain_log_file

    def test_monagent_logs_write_colored_and_plain_files(self) -> None:
        with TemporaryDirectory() as temp_dir:
            _, plain_log_file = self.configure_temp_logs(Path(temp_dir) / "Text")

            get_logger("MonAgent", "Server").info("server ready")

            self.assertIn("[MonAgent][Server][INFO]", plain_log_file.read_text(encoding="utf-8"))
            self.assertIn("server ready", plain_log_file.read_text(encoding="utf-8"))

    def test_non_default_main_uses_own_log_directory(self) -> None:
        with TemporaryDirectory() as temp_dir:
            text_root = Path(temp_dir) / "Text"
            self.configure_temp_logs(text_root)

            get_logger("AgentCore", "Harness").warning("core ready")

            plain_log_file = text_root / "AgentCore" / "AgentCore_plain.log"
            self.assertTrue(plain_log_file.exists())
            text = plain_log_file.read_text(encoding="utf-8")
            self.assertIn("[AgentCore][Harness][WARNING]", text)
            self.assertIn("core ready", text)

    def test_file_rotation_keeps_backups(self) -> None:
        with TemporaryDirectory() as temp_dir:
            _, plain_log_file = self.configure_temp_logs(Path(temp_dir) / "Text", max_bytes=160)

            logger = get_logger("MonAgent", "Rotate")
            logger.info("first " + "x" * 120)
            logger.info("second " + "y" * 120)

            self.assertTrue(plain_log_file.exists())
            self.assertTrue(plain_log_file.with_name(f"{plain_log_file.name}.1").exists())

    def test_standard_logging_bridge_uses_monagent_handlers(self) -> None:
        with TemporaryDirectory() as temp_dir:
            _, plain_log_file = self.configure_temp_logs(Path(temp_dir) / "Text")
            install_standard_logging_bridge(("mon_agent_server.test",), level="INFO")

            logging.getLogger("mon_agent_server.test").warning("bridged warning")

            text = plain_log_file.read_text(encoding="utf-8")
            self.assertIn("[MonAgent][test][WARNING]", text)
            self.assertIn("bridged warning", text)


if __name__ == "__main__":
    unittest.main()
