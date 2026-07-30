from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024


def local_file_path(value: str) -> Path | None:
    raw = str(value or "").strip()
    if raw.startswith("file://"):
        parsed = urlparse(raw)
        if parsed.netloc not in ("", "localhost"):
            return None
        return Path(unquote(parsed.path)).expanduser().resolve()
    path = Path(raw).expanduser()
    return path.resolve() if path.is_absolute() else None


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
        if not str(mime).startswith("image/"):
            continue
        if url.startswith("data:"):
            try:
                payload = url.split(",", 1)[1]
                base64.b64decode(payload, validate=False)
            except Exception:
                continue
        else:
            file_path = local_file_path(url)
            if not file_path or not file_path.is_file():
                continue
            try:
                data = file_path.read_bytes()
            except OSError:
                continue
            if len(data) > MAX_LOCAL_IMAGE_BYTES:
                continue
            detected_mime = mimetypes.guess_type(file_path.name)[0]
            if detected_mime and detected_mime.startswith("image/"):
                mime = detected_mime
            payload = base64.b64encode(data).decode("ascii")
        images.append({"type": "image", "mimeType": mime, "data": payload})
    return images


def text_from_tool_result(result: dict[str, Any]) -> str:
    return "\n".join(
        str(item.get("text") or "") for item in result.get("content", []) if isinstance(item, dict) and item.get("type") == "text"
    )
