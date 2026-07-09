from __future__ import annotations

import json
from typing import Any


def attachment_context(files: list[dict[str, Any]], images_provided_to_model: bool = True) -> str:
    if not files:
        return ""
    sections: list[str] = []
    for index, file in enumerate(files, start=1):
        filename = file.get("filename") or f"附件-{index}"
        mime = file.get("mime") or "application/octet-stream"
        size_text = f"，大小 {file['size']} bytes" if isinstance(file.get("size"), int) else ""
        if str(mime).startswith("image/"):
            sections.append(
                f"### 附件 {index}: {filename}\n类型: {mime}{size_text}\n说明: 这是图片附件，"
                + ("已通过视觉通道提供给模型。" if images_provided_to_model else "当前对话模型不支持直接看图。")
            )
        elif str(file.get("url") or "").startswith("data:"):
            sections.append(f"### 附件 {index}: {filename}\n类型: {mime}{size_text}\n内容以 data URL 提供，长度 {len(file.get('url') or '')}。")
        else:
            sections.append(f"### 附件 {index}: {filename}\n类型: {mime}{size_text}\n位置: {file.get('url') or ''}")
    return "用户本轮上传了以下附件：\n\n" + "\n\n".join(sections)


def dump_context(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
