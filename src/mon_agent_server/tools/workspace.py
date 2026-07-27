from __future__ import annotations

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
    # Read-only access is permission-free. Mutation-capable tools remain
    # governed by the runtime permission hook.
    return resolved
