from __future__ import annotations

import asyncio
import base64
import mimetypes
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from mon_agent_core import AgentTool

from .context import MonToolContext
from .core_access import core_call, require_core_access
from .result import text_result


def _character_id(context: MonToolContext) -> int:
    value = (context.character or {}).get("id")
    if not value:
        raise RuntimeError("当前助手没有绑定可用角色。")
    return int(value)


def _read_image(url: str) -> tuple[bytes, str, str]:
    if url.startswith("data:"):
        header, encoded = url.split(",", 1)
        mime = header[5:].split(";", 1)[0] or "image/png"
        data = base64.b64decode(encoded)
    elif url.startswith("file://") or Path(url).expanduser().is_absolute():
        if url.startswith("file://"):
            parsed = urlparse(url)
            if parsed.netloc not in ("", "localhost"):
                raise ValueError("不支持远程 file URL。")
            path = Path(unquote(parsed.path)).expanduser().resolve()
        else:
            path = Path(url).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"表情包图片不存在: {path}")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = path.read_bytes()
    else:
        with urllib.request.urlopen(url, timeout=30) as response:
            mime = response.headers.get_content_type()
            data = response.read(10 * 1024 * 1024 + 1)
    if not mime.startswith("image/") or len(data) > 10 * 1024 * 1024:
        raise ValueError("表情包必须是小于 10MB 的图片。")
    extension = mimetypes.guess_extension(mime) or ".png"
    return data, mime, "sticker" + extension


def create_sticker_tools(context: MonToolContext) -> list[AgentTool]:
    # 表情包属于主角色的公开表达，不向任何后台子智能体暴露。
    if context.agent_path != "/root":
        return []

    async def list_execute(_id: str, params: dict[str, Any], *_args):
        core, token = require_core_access(context)
        stickers = await asyncio.to_thread(core_call, core.list_character_stickers, token,
                                           _character_id(context), str(params.get("query") or ""))
        lines = [f"#{s['id']} {s['name']}（{s.get('emotion') or '-'} / {s.get('intent') or '-'}）" for s in stickers]
        return text_result("可用表情包：\n" + ("\n".join(lines) if lines else "暂无。"), {"stickers":stickers})

    async def remember_execute(_id: str, params: dict[str, Any], *_args):
        if context.agent_path != "/root":
            raise RuntimeError("只有主智能体可以记录表情包。")
        missing = [
            key for key in ("name", "description", "emotion", "intent")
            if not str(params.get(key) or "").strip()
        ]
        aliases = [str(item).strip() for item in (params.get("aliases") or []) if str(item).strip()]
        if missing or not aliases:
            labels = {"name": "名称", "description": "描述", "emotion": "情绪", "intent": "使用意图"}
            missing_labels = [labels[key] for key in missing]
            if not aliases:
                missing_labels.append("至少一个检索别名")
            raise ValueError("保存表情包前必须补全：" + "、".join(missing_labels) + "。")
        core, token = require_core_access(context)
        image_url = str(params["image_url"])
        if image_url.startswith("attachment://"):
            attachment_name = unquote(image_url.removeprefix("attachment://"))
            files = context.get_current_files() if context.get_current_files else []
            attachment = next(
                (item for item in files if str(item.get("filename") or "") == attachment_name),
                None,
            )
            if not attachment:
                raise ValueError(f"当前消息中不存在附件：{attachment_name}")
            image_url = str(attachment.get("url") or "")
        data, mime, filename = await asyncio.to_thread(_read_image, image_url)
        sticker = await asyncio.to_thread(
            core.create_character_sticker, token, _character_id(context),
            {"name":params["name"], "description":params["description"],
             "emotion":params["emotion"], "intent":params["intent"],
             "aliases":aliases}, filename, mime, data)
        return text_result(f"已记录表情包 #{sticker.get('id')}「{sticker.get('name')}」。", {"sticker":sticker})

    async def send_execute(_id: str, params: dict[str, Any], *_args):
        if context.agent_path != "/root":
            raise RuntimeError("只有主智能体可以向用户发送表情包。")
        core, token = require_core_access(context)
        stickers = await asyncio.to_thread(core_call, core.list_character_stickers, token, _character_id(context), "")
        target = str(params.get("sticker") or "").strip()
        sticker = next((s for s in stickers if str(s.get("id")) == target or s.get("name") == target or
                        target in (s.get("aliases") or [])), None)
        if not sticker:
            raise ValueError(f"当前角色不存在表情包「{target}」，请先查看列表。")
        if not context.append_assistant_part:
            raise RuntimeError("当前消息通道不支持发送表情包。")
        part = context.append_assistant_part({"type":"sticker", "stickerID":sticker["id"],
            "characterID":_character_id(context), "name":sticker["name"], "url":sticker["image_url"],
            "mime":sticker.get("mime") or mimetypes.guess_type(sticker["image_url"])[0] or "image/webp",
            "alt":sticker.get("description") or sticker["name"]})
        return text_result(f"已发送表情包「{sticker['name']}」。", {"sticker":sticker, "part":part})

    async def delete_execute(_id: str, params: dict[str, Any], *_args):
        core, token = require_core_access(context)
        stickers = await asyncio.to_thread(
            core_call,
            core.list_character_stickers,
            token,
            _character_id(context),
            "",
        )
        target = str(params.get("sticker") or "").strip()
        sticker = next(
            (
                item for item in stickers
                if str(item.get("id")) == target
                or item.get("name") == target
                or target in (item.get("aliases") or [])
            ),
            None,
        )
        if not sticker:
            raise ValueError(f"当前角色不存在表情包「{target}」，请先查看列表。")
        await asyncio.to_thread(
            core_call,
            core.delete_character_sticker,
            token,
            _character_id(context),
            sticker["id"],
        )
        return text_result(
            f"已删除表情包 #{sticker['id']}「{sticker['name']}」。",
            {"deleted": True, "sticker": sticker},
        )

    return [
        AgentTool("list_character_stickers", "查看表情包列表", "检索当前角色已有表情包，可根据名称、别名、情绪和使用意图筛选。",
                  {"type":"object","properties":{"query":{"type":"string"}}}, list_execute),
        AgentTool("remember_character_sticker", "记录表情包", "仅在用户明确要求收藏或记录某张图片时保存。image_url 可使用附件引用 attachment://文件名、本地绝对路径、file://、data URL 或 http(s) URL。必须先理解图片语义，并填写名称、描述、情绪、使用意图和至少一个检索别名。",
                  {"type":"object","properties":{"image_url":{"type":"string"},"name":{"type":"string"},"description":{"type":"string","minLength":1},"emotion":{"type":"string","minLength":1},"intent":{"type":"string","minLength":1},"aliases":{"type":"array","items":{"type":"string","minLength":1},"minItems":1}},"required":["image_url","name","description","emotion","intent","aliases"]}, remember_execute, execution_mode="sequential"),
        AgentTool("send_character_sticker", "发送表情包", "向用户发送当前角色已有表情包。用户明确要求时直接发送；自然聊天中，如果能贴合当前情绪并增强表达，也可以主动使用。",
                  {"type":"object","properties":{"sticker":{"type":"string"}},"required":["sticker"]}, send_execute, execution_mode="sequential"),
        AgentTool("delete_character_sticker", "删除表情包", "仅当用户明确要求删除时，按 ID、名称或别名删除当前角色的表情包及其图片文件。这不是长期记忆操作。",
                  {"type":"object","properties":{"sticker":{"type":"string"}},"required":["sticker"]}, delete_execute, execution_mode="sequential"),
    ]
