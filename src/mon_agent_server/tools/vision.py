from __future__ import annotations

import asyncio
import base64
import mimetypes
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from mon_agent_core import AgentTool

from .context import MonToolContext
from .core_access import core_call, require_core_access
from .result import text_result
from .workspace import maybe_ask_outside_workspace

MAX_CAPTURE_BYTES = 10 * 1024 * 1024


def _local_file_path(value: str) -> Path | None:
    raw = str(value or "").strip()
    if raw.startswith("file://"):
        parsed = urlparse(raw)
        if parsed.netloc not in ("", "localhost"):
            return None
        return Path(unquote(parsed.path)).expanduser().resolve()
    path = Path(raw).expanduser()
    return path.resolve() if path.is_absolute() else None


def _decode_capture_image(capture: dict[str, Any], capture_name: str) -> tuple[str, str]:
    data_url = str(capture.get("dataUrl") or capture.get("data_url") or "")
    match = re.match(r"^data:([^;,]+);base64,(.*)$", data_url)
    if not match:
        raise RuntimeError(f"{capture_name}格式无效。")
    mime_type = match.group(1) or "image/jpeg"
    if not mime_type.startswith("image/"):
        raise RuntimeError(f"{capture_name}格式无效。")
    data = match.group(2)
    try:
        decoded = base64.b64decode(data, validate=True)
    except Exception as error:
        raise RuntimeError(f"{capture_name}数据损坏。") from error
    if not decoded or len(decoded) > MAX_CAPTURE_BYTES:
        raise RuntimeError(f"{capture_name}大小无效。")
    return mime_type, data


def create_vision_tools(root: Path, context: MonToolContext) -> list[AgentTool]:
    async def vision_result(
        *,
        tool_call_id: str,
        question: str,
        mime_type: str,
        data: str,
        source: str,
        metadata: dict[str, Any] | None = None,
        capture_status_text: str | None = None,
    ) -> dict[str, Any]:
        if context.current_model_supports_images is not False:
            return {
                "content": [
                    {"type": "text", "text": capture_status_text or f"请根据图片回答：{question}"},
                    {"type": "image", "mimeType": mime_type, "data": data},
                ],
                "details": {"source": source, "mimeType": mime_type, "question": question, **(metadata or {})},
            }

        core, token = require_core_access(context)
        if not context.vision_ai_entity or not context.vision_ai_entity.get("id"):
            raise RuntimeError("当前对话模型不支持图片，且没有可用的默认多模态 AI。")
        if context.vision_ai_entity.get("status") not in (None, "", "active"):
            raise RuntimeError("当前对话模型不支持图片，且选定的多模态 AI 不可用。")
        result = await asyncio.to_thread(
            core_call,
            core.analyze_image,
            token,
            {
                "ai_entity_id": context.vision_ai_entity.get("id"),
                "images": [{"type": "base64", "source": data, "media_type": mime_type, "ref": source}],
                "prompt": question,
                "source": "monagent",
                "related_session_id": context.session_id,
                "related_message_id": context.get_message_id() if context.get_message_id else None,
                "tool_call_id": tool_call_id,
                "metadata": {
                    "image_source": source,
                    "fallback_reason": "current_model_does_not_support_images",
                    **(metadata or {}),
                },
                "temperature": 0.2,
                "max_tokens": 1200,
            },
        )
        if not result.get("success"):
            raise RuntimeError(result.get("error") or result.get("error_message") or "Core Vision 分析失败。")
        return text_result(result.get("content") or result.get("summary") or "", {"source": source, "vision": result})

    async def analyze_image_execute(tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        question = str(params.get("question") or "请分析这张图片。").strip()
        mime_type = "image/png"
        data = ""
        source = ""
        if params.get("path"):
            raw_path = str(params["path"])
            normalized_path = _local_file_path(raw_path)
            file_path = await maybe_ask_outside_workspace(
                root,
                str(normalized_path or raw_path),
                context,
                "analyze_image",
                tool_call_id,
                "读取图片",
            )
            if not file_path.is_file():
                raise RuntimeError(f"图片文件不存在: {file_path}")
            mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
            if not mime_type.startswith("image/"):
                raise RuntimeError(f"不是支持的图片类型: {file_path}")
            data = base64.b64encode(file_path.read_bytes()).decode("ascii")
            source = str(file_path)
        else:
            files = context.get_current_files() if context.get_current_files else []
            image_files = [file for file in files if str(file.get("mime") or "").startswith("image/")]
            index = max(int(params.get("attachment_index") or 1) - 1, 0)
            file = image_files[index] if index < len(image_files) else None
            if not file:
                raise RuntimeError("本轮消息中没有可分析的图片附件。请先上传图片，或传入 path。")
            match = re.match(r"^data:([^;,]+);base64,(.*)$", file.get("url") or "")
            if not match:
                raise RuntimeError(f"图片附件不是 data URL，暂时无法直接交给模型分析: {file.get('filename') or '未命名图片'}")
            mime_type = match.group(1) or file.get("mime") or "image/png"
            data = match.group(2)
            source = file.get("filename") or f"附件图片 {index + 1}"
        return await vision_result(
            tool_call_id=tool_call_id,
            question=question,
            mime_type=mime_type,
            data=data,
            source=source,
        )

    async def analyze_screen_execute(tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        if not context.session_id:
            raise RuntimeError("当前会话无法读取屏幕。")
        requested_source = str(params.get("source") or "auto").strip().lower()
        if requested_source not in {"auto", "desktop", "game"}:
            raise RuntimeError("屏幕来源无效，只支持 auto、desktop 或 game。")
        if not context.screen_captures:
            raise RuntimeError("当前没有可用的桌面截图客户端。")

        capture = await asyncio.to_thread(
            context.screen_captures.capture,
            {
                "sessionID": context.session_id,
                "toolCallID": tool_call_id,
                "source": requested_source,
                # Retain the legacy display hint for existing Electron clients.
                "display": "cursor",
            },
        )
        mime_type, data = _decode_capture_image(capture, "桌面客户端返回的截图")

        question = str(params.get("question") or "请分析当前屏幕。").strip()
        width = capture.get("width")
        height = capture.get("height")
        source_name = str(capture.get("sourceName") or "").strip()
        captured_source = str(capture.get("source") or requested_source).strip().lower()
        capture_details = []
        if width and height:
            capture_details.append(f"{width}×{height}")
        if source_name:
            capture_details.append(source_name)
        status_suffix = f"（{'，'.join(capture_details)}）" if capture_details else ""
        return await vision_result(
            tool_call_id=tool_call_id,
            question=question,
            mime_type=mime_type,
            data=data,
            source="当前屏幕截图",
            capture_status_text=f"屏幕截图已捕获并提供给当前模型{status_suffix}。",
            metadata={
                "displayId": capture.get("displayId"),
                "sourceName": source_name or None,
                "source": captured_source,
                "requestedSource": requested_source,
                "width": width,
                "height": height,
            },
        )

    async def capture_camera_execute(
        tool_call_id: str,
        params: dict[str, Any],
        _signal: Any = None,
        _on_update: Any = None,
    ) -> dict[str, Any]:
        if not context.session_id:
            raise RuntimeError("当前会话无法读取摄像头。")
        if not context.camera_captures:
            raise RuntimeError("当前没有可用的摄像头采集客户端。")
        facing_mode = str(params.get("facing_mode") or "user").strip().lower()
        if facing_mode not in {"user", "environment"}:
            raise RuntimeError("摄像头方向无效，只支持 user 或 environment。")

        capture = await asyncio.to_thread(
            context.camera_captures.capture,
            {
                "sessionID": context.session_id,
                "toolCallID": tool_call_id,
                "facingMode": facing_mode,
            },
        )
        mime_type, data = _decode_capture_image(capture, "客户端返回的摄像头图片")
        question = str(params.get("question") or "请观察当前摄像头画面。").strip()
        width = capture.get("width")
        height = capture.get("height")
        device_label = str(capture.get("deviceLabel") or "").strip()
        actual_facing_mode = str(capture.get("facingMode") or facing_mode).strip().lower()
        capture_details = []
        if width and height:
            capture_details.append(f"{width}×{height}")
        if device_label:
            capture_details.append(device_label)
        status_suffix = f"（{'，'.join(capture_details)}）" if capture_details else ""
        return await vision_result(
            tool_call_id=tool_call_id,
            question=question,
            mime_type=mime_type,
            data=data,
            source="当前摄像头画面",
            capture_status_text=f"摄像头单帧已捕获并提供给当前模型{status_suffix}。",
            metadata={
                "deviceLabel": device_label or None,
                "facingMode": actual_facing_mode,
                "requestedFacingMode": facing_mode,
                "width": width,
                "height": height,
            },
        )

    tools = [
        AgentTool(
            "analyze_screen",
            "屏幕分析",
            "只读截取整个桌面或当前游戏画面；多模态模型直接查看截图，文本模型交给角色绑定的 Vision 分析。",
            {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "source": {
                        "type": "string",
                        "enum": ["auto", "desktop", "game"],
                        "default": "auto",
                        "description": "截图来源：auto 在游戏运行时优先游戏，否则截取桌面；desktop 截取整个当前显示器；game 仅截取 VTU 嵌入的游戏画面。",
                    },
                },
            },
            analyze_screen_execute,
        ),
        AgentTool(
            "capture_camera",
            "摄像头观察",
            "经用户授权后从当前设备摄像头拍摄一张单帧图片，随即停止摄像头；多模态模型直接观察，文本模型交给角色绑定的 Vision 分析。",
            {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "facing_mode": {
                        "type": "string",
                        "enum": ["user", "environment"],
                        "default": "user",
                        "description": "优先使用前置（user）或后置（environment）摄像头。",
                    },
                },
            },
            capture_camera_execute,
            execution_mode="sequential",
        ),
    ]
    tools.insert(
        0,
        AgentTool(
            "analyze_image",
            "图片分析",
            "分析本轮附件或本机图片。path 支持绝对路径和 file:// URL；读取本机图片不受工作区限制。",
            {"type": "object", "properties": {"path": {"type": "string"}, "attachment_index": {"type": "number"}, "question": {"type": "string"}}},
            analyze_image_execute,
        ),
    )
    return tools
