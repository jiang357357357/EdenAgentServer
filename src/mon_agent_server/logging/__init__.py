from .config import LoggerConfig, configure, configure_from_server_config, get_config
from .handlers import shutdown
from .logger import ColoredLogger, get_logger

getLogger = get_logger

__all__ = [
    "LoggerConfig",
    "configure",
    "configure_from_server_config",
    "get_config",
    "ColoredLogger",
    "get_logger",
    "getLogger",
    "shutdown",
]
