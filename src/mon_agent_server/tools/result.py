from __future__ import annotations

from typing import Any

from ..agent_api import ToolExecutionError


def tool_failure(
    code: str,
    message: str,
    *,
    retryable: bool = False,
    details: Any = None,
) -> ToolExecutionError:
    """Create a typed tool failure without changing successful business results."""
    return ToolExecutionError(code, message, retryable=retryable, details=details)


def text_result(content: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": content}], "success": True}
    if details is not None:
        result["details"] = details
        result["structuredContent"] = details
    return result


def truncate(content: str, max_chars: int = 24_000) -> str:
    if len(content) <= max_chars:
        return content
    return f"{content[:max_chars]}\n\n[输出已截断，原始长度 {len(content)}]"


def compact_text(value: Any, limit: int = 600) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f"... [已截断，总长度: {len(text)}]"
