from __future__ import annotations

import base64
from typing import Any


def content_text(parts: list[dict[str, Any]]) -> str:
    return "\n".join(str(part.get("text") or "") for part in parts if part.get("type") == "text").strip()


def prompt_files(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "url": part.get("url") or "",
            "filename": part.get("filename"),
            "mime": part.get("mime") or "application/octet-stream",
            "size": part.get("size"),
        }
        for part in parts
        if part.get("type") == "file"
    ]


def images_from_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    for part in parts:
        if part.get("type") != "file":
            continue
        mime = part.get("mime") or "image/png"
        url = part.get("url") or ""
        if not str(mime).startswith("image/") or not url.startswith("data:"):
            continue
        try:
            payload = url.split(",", 1)[1]
            base64.b64decode(payload, validate=False)
        except Exception:
            continue
        images.append({"type": "image", "mimeType": mime, "data": payload})
    return images


def text_from_tool_result(result: dict[str, Any]) -> str:
    return "\n".join(
        str(item.get("text") or "") for item in result.get("content", []) if isinstance(item, dict) and item.get("type") == "text"
    )
