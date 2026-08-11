from __future__ import annotations

from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool

from .context import MonToolContext
from .result import text_result


def create_workspace_switch_tools(context: MonToolContext) -> list[AgentTool]:
    async def execute(
        _call_id: str,
        params: dict[str, Any],
        _signal: Any = None,
        _update: Any = None,
    ) -> dict[str, Any]:
        if context.agent_path != "/root":
            raise RuntimeError("只有当前会话的父智能体可以切换项目文件夹。")
        if context.request_workspace_switch is None:
            raise RuntimeError("当前运行环境不支持切换项目文件夹。")
        raw_path = str(params.get("path") or "").strip()
        if not raw_path:
            raise ValueError("path 不能为空；目标不明确时应先询问用户。")
        target = Path(raw_path).expanduser().resolve()
        if not target.is_dir():
            raise ValueError(f"目标项目文件夹不存在：{target}")
        result = context.request_workspace_switch(str(target))
        return text_result(
            f"项目文件夹切换请求已接受：{target}\n"
            "请简短结束当前回复。回复完成后系统会安全重建智能体运行时，并同步刷新左侧资源管理器。",
            result,
        )

    return [
        AgentTool(
            "switch_workspace",
            "切换项目文件夹",
            "切换 MonAgent 当前项目工作区，使左侧资源管理器和后续智能体文件工具共同使用目标目录。"
            "仅在用户明确要求切换且目标路径明确时调用；切换会在当前回复结束后生效。",
            {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "目标项目文件夹的绝对路径，也支持以 ~ 开头的用户目录路径。",
                    }
                },
                "required": ["path"],
            },
            execute,
            execution_mode="sequential",
        )
    ]
