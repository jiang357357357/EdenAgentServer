"""Secure local video-understanding MCP server."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("video-understanding-mcp")
except PackageNotFoundError:  # pragma: no cover - source checkout before install
    __version__ = "0.1.0"

__all__ = ["__version__"]
