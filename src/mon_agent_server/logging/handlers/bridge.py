from __future__ import annotations

import logging
from typing import Iterable


class MonAgentLogBridgeHandler(logging.Handler):
    """
    Bridge standard library logging records into the MonAgent logging system.

    This mirrors the Backend DjangoLogs bridge so framework or dependency logs
    can share MonAgent's console/file handlers without adopting a separate
    formatter stack.
    """

    def __init__(self, main: str = "MonAgent") -> None:
        super().__init__()
        self.main = main

    def emit(self, record: logging.LogRecord) -> None:
        try:
            from ..logger import get_logger

            sub = record.name.rsplit(".", 1)[-1] if record.name else "Stdlib"
            logger = get_logger(self.main, sub)
            message = self.format(record)
            level = record.levelname.upper()
            if level == "DEBUG":
                logger.debug(message)
            elif level == "INFO":
                logger.info(message)
            elif level == "WARNING":
                logger.warning(message)
            elif level == "ERROR":
                logger.error(message)
            elif level == "CRITICAL":
                logger.critical(message)
            else:
                logger.info(message)
        except Exception:
            self.handleError(record)


def install_standard_logging_bridge(
    logger_names: Iterable[str] | None = None,
    *,
    main: str = "MonAgent",
    level: str | int = "INFO",
) -> None:
    names = tuple(logger_names or ("mon_agent_server",))
    level_no = logging.getLevelName(level.upper()) if isinstance(level, str) else level
    if not isinstance(level_no, int):
        level_no = logging.INFO

    for name in names:
        logger = logging.getLogger(name)
        logger.handlers = [handler for handler in logger.handlers if not isinstance(handler, MonAgentLogBridgeHandler)]
        handler = MonAgentLogBridgeHandler(main=main)
        handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
        handler.setLevel(level_no)
        logger.addHandler(handler)
        logger.setLevel(level_no)
        logger.propagate = False
