from __future__ import annotations

from typing import Any

from mon_agent_core import AgentTool

from .context import MonToolContext
from .result import text_result


def create_subagent_tools(context: MonToolContext) -> list[AgentTool]:
    async def dispatch(action: str, params: dict[str, Any]) -> dict[str, Any]:
        if context.subagent_dispatch is None:
            raise RuntimeError("当前运行时没有启用子智能体控制器。")
        return await context.subagent_dispatch(action, params)

    async def spawn_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        result = await dispatch("spawn", params)
        return text_result(
            f"已创建子智能体 {result.get('agentPath')}，状态：{result.get('status')}。",
            result,
        )

    async def send_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        result = await dispatch("send_message", params)
        return text_result(f"消息已投递给 {result.get('target')}。", result)

    async def followup_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        result = await dispatch("followup_task", params)
        return text_result(f"已追加任务并唤醒 {result.get('target')}。", result)

    async def list_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        result = await dispatch("list_agents", params)
        agents = result.get("agents") or []
        lines = [
            f"- {item.get('agentPath')}｜{item.get('role')}｜{item.get('status')}｜{item.get('taskName')}"
            for item in agents
        ]
        return text_result("\n".join(lines) if lines else "当前没有子智能体。", result)

    async def wait_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        result = await dispatch("wait_agent", params)
        messages = result.get("messages") or []
        lines = [
            f"{item.get('sender')}：{item.get('content')}"
            for item in messages
            if str(item.get("content") or "").strip()
        ]
        if not lines:
            agents = result.get("agents") or []
            lines = [f"{item.get('agentPath')}：{item.get('status')}" for item in agents]
        return text_result("\n\n".join(lines) if lines else "等待结束，暂无新结果。", result)

    async def interrupt_execute(_call_id: str, params: dict[str, Any], _signal: Any = None, _update: Any = None):
        result = await dispatch("interrupt_agent", params)
        return text_result(f"已中断 {result.get('agentPath')}。", result)

    target_schema = {"type": "string", "description": "子智能体的 agentPath 或 agentID。"}
    return [
        AgentTool(
            name="spawn_agent",
            label="创建子智能体",
            description=(
                "把一个边界清晰、可独立完成的任务交给后台子智能体。简单问题、闲聊或必须由当前角色直接完成的任务不要创建子智能体。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "完整任务说明、约束和期望交付物。"},
                    "task_name": {"type": "string", "description": "稳定的英文任务短名，例如 research_api。"},
                    "role": {
                        "type": "string",
                        **({"enum": list(context.subagent_role_names)} if context.subagent_role_names else {}),
                        "description": "后台任务角色；省略时使用 general。",
                    },
                    "fork_turns": {
                        "description": "继承上下文：none、all 或最近 N 个用户轮次。",
                        "anyOf": [
                            {"type": "string", "enum": ["none", "all"]},
                            {"type": "integer", "minimum": 0, "maximum": 20},
                        ],
                    },
                },
                "required": ["message", "task_name"],
            },
            execute=spawn_execute,
            execution_mode="sequential",
        ),
        AgentTool(
            name="send_message",
            label="发送智能体消息",
            description="向已有子智能体邮箱投递补充信息，不主动开始新一轮。",
            parameters={
                "type": "object",
                "properties": {"target": target_schema, "message": {"type": "string"}},
                "required": ["target", "message"],
            },
            execute=send_execute,
            execution_mode="sequential",
        ),
        AgentTool(
            name="followup_task",
            label="追加子任务",
            description="给已有子智能体追加任务，并在它空闲时唤醒新一轮。",
            parameters={
                "type": "object",
                "properties": {"target": target_schema, "message": {"type": "string"}},
                "required": ["target", "message"],
            },
            execute=followup_execute,
            execution_mode="sequential",
        ),
        AgentTool(
            name="list_agents",
            label="查看子智能体",
            description="列出当前会话的子智能体树和运行状态。",
            parameters={
                "type": "object",
                "properties": {"path_prefix": {"type": "string", "description": "可选的路径前缀。"}},
            },
            execute=list_execute,
            execution_mode="sequential",
        ),
        AgentTool(
            name="wait_agent",
            label="等待子智能体",
            description="等待指定子智能体完成或返回结果；可同时等待多个目标。",
            parameters={
                "type": "object",
                "properties": {
                    "targets": {"type": "array", "items": target_schema, "maxItems": 8},
                    "timeout_ms": {"type": "integer", "minimum": 0, "maximum": 60000},
                },
            },
            execute=wait_execute,
            execution_mode="sequential",
        ),
        AgentTool(
            name="interrupt_agent",
            label="中断子智能体",
            description="停止一个正在运行的子智能体，保留已有状态和结果。",
            parameters={
                "type": "object",
                "properties": {"target": target_schema},
                "required": ["target"],
            },
            execute=interrupt_execute,
            execution_mode="sequential",
        ),
    ]
