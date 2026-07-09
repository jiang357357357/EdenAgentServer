from __future__ import annotations

import asyncio
from pathlib import Path

from .context import MonToolContext


async def maybe_ask_outside_workspace(
    workspace_root: Path,
    target: str,
    context: MonToolContext,
    tool_name: str,
    tool_call_id: str,
    action: str,
) -> Path:
    resolved = Path(target).expanduser().resolve()
    try:
        resolved.relative_to(workspace_root.resolve())
        return resolved
    except ValueError:
        pass
    permission = "访问工作区外路径"
    pattern = str(resolved)
    if context.permissions and context.permissions.is_always_allowed(permission, pattern):
        return resolved
    if not context.permissions or not context.session_id:
        raise RuntimeError(f"读取工作区外路径需要授权: {target}")
    reply = await asyncio.to_thread(
        context.permissions.ask,
        {
            "sessionID": context.session_id,
            "permission": permission,
            "patterns": [pattern],
            "metadata": {
                "action": action,
                "toolName": tool_name,
                "path": str(resolved),
                "workspaceRoot": str(workspace_root),
                "reason": "模型请求访问当前 MonAgent 工作区之外的路径，需要你确认。",
            },
            "tool": {"messageID": context.get_message_id(), "callID": tool_call_id}
            if context.get_message_id and context.get_message_id()
            else None,
        },
    )
    if reply == "reject":
        raise RuntimeError(f"用户拒绝访问工作区外路径: {target}")
    return resolved
