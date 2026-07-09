from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool

from .context import MonToolContext
from .core_access import core_call, require_core_access
from .result import text_result
from .workspace import maybe_ask_outside_workspace


def create_vision_tools(root: Path, context: MonToolContext) -> list[AgentTool]:
    async def analyze_image_execute(tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        question = str(params.get("question") or "请分析这张图片。").strip()
        mime_type = "image/png"
        data = ""
        source = ""
        if params.get("path"):
            file_path = await maybe_ask_outside_workspace(root, str(params["path"]), context, "analyze_image", tool_call_id, "读取图片")
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
        if context.current_model_supports_images is False:
            core, token = require_core_access(context)
            if not context.vision_config or context.vision_config.get("status") != "active":
                raise RuntimeError("当前对话模型不支持图片输入，且 Core 没有可用的 active Vision 配置。")
            result = await asyncio.to_thread(
                core_call,
                core.analyze_vision,
                token,
                {
                    "config_id": context.vision_config.get("id"),
                    "images": [{"type": "base64", "source": data, "media_type": mime_type, "ref": source}],
                    "prompt": question,
                    "source": "monagent",
                    "related_session_id": context.session_id,
                    "related_message_id": context.get_message_id() if context.get_message_id else None,
                    "tool_call_id": tool_call_id,
                    "metadata": {"image_source": source, "fallback_reason": "current_model_does_not_support_images"},
                    "temperature": 0.2,
                    "max_tokens": 1200,
                },
            )
            if not result.get("success"):
                raise RuntimeError(result.get("error") or "Core Vision 分析失败。")
            return text_result(result.get("content") or result.get("summary") or "", {"source": source, "vision": result})
        return {"content": [{"type": "text", "text": f"请根据图片回答：{question}"}, {"type": "image", "mimeType": mime_type, "data": data}], "details": {"source": source, "mimeType": mime_type, "question": question}}

    async def analyze_screen_execute(tool_call_id: str, params: dict[str, Any], _signal: Any = None, _on_update: Any = None) -> dict[str, Any]:
        if os.name != "nt":
            raise RuntimeError(f"当前屏幕截图暂只支持 Windows，当前平台: {os.name}")
        if context.permissions and context.session_id:
            reply = await asyncio.to_thread(
                context.permissions.ask,
                {
                    "sessionID": context.session_id,
                    "permission": "读取当前屏幕",
                    "patterns": ["desktop-screenshot"],
                    "metadata": {"action": "截取当前屏幕", "toolName": "analyze_screen", "reason": "模型请求查看当前桌面画面，需要你确认。"},
                    "tool": {"messageID": context.get_message_id(), "callID": tool_call_id}
                    if context.get_message_id and context.get_message_id()
                    else None,
                },
            )
            if reply == "reject":
                raise RuntimeError("用户拒绝读取当前屏幕。")
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if not powershell:
            raise RuntimeError("未找到 PowerShell，无法截屏。")
        with tempfile.TemporaryDirectory(prefix="monagent-screen-") as tmp:
            output_path = Path(tmp) / "screen.png"
            script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
if (-not $screens -or $screens.Length -eq 0) {{ throw "No screen found" }}
$left = ($screens | ForEach-Object {{ $_.Bounds.Left }} | Measure-Object -Minimum).Minimum
$top = ($screens | ForEach-Object {{ $_.Bounds.Top }} | Measure-Object -Minimum).Minimum
$right = ($screens | ForEach-Object {{ $_.Bounds.Right }} | Measure-Object -Maximum).Maximum
$bottom = ($screens | ForEach-Object {{ $_.Bounds.Bottom }} | Measure-Object -Maximum).Maximum
$bitmap = New-Object System.Drawing.Bitmap ([int]($right - $left)), ([int]($bottom - $top))
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {{
  $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
  $bitmap.Save('{str(output_path).replace("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
}} finally {{
  $graphics.Dispose()
  $bitmap.Dispose()
}}
"""
            await asyncio.to_thread(subprocess.run, [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], check=True, timeout=15)
            data = base64.b64encode(output_path.read_bytes()).decode("ascii")
        return {"content": [{"type": "text", "text": f"请根据当前屏幕截图回答：{params.get('question') or '请分析当前屏幕。'}"}, {"type": "image", "mimeType": "image/png", "data": data}], "details": {"source": "当前屏幕截图"}}

    return [
        AgentTool("analyze_image", "图片分析", "把本轮附件图片或指定路径图片交给当前视觉模型分析。", {"type": "object", "properties": {"path": {"type": "string"}, "attachment_index": {"type": "number"}, "question": {"type": "string"}}}, analyze_image_execute),
        AgentTool("analyze_screen", "屏幕分析", "经用户授权后截取当前桌面屏幕，并交给当前视觉模型分析。", {"type": "object", "properties": {"question": {"type": "string"}}}, analyze_screen_execute),
    ]
