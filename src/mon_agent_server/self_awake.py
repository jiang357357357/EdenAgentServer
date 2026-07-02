from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from mon_agent_core import Agent, AgentOptions

from .ids import create_id, now_ms
from .logging import get_logger
from .model_stream import core_model, env_model, stream_openai_compatible
from .mon_tools import MonToolContext, create_mon_agent_tools
from .prompts import (
    build_agent_system_prompt,
    build_self_awake_task_prompt,
    fallback_self_awake_decision,
    parse_self_awake_decision,
)

if TYPE_CHECKING:
    from .app import AppState

logger = get_logger("MonAgent", "SelfAwake")


class SelfAwakeModelError(RuntimeError):
    pass


@dataclass(slots=True)
class SelfAwakeRuntimeConfig:
    model: dict[str, Any]
    api_key: str | None
    label: str
    source: str
    core: dict[str, Any] | None
    supports_images: bool
    thinking_level: str


def _runtime_config_from_model(
    model: dict[str, Any],
    api_key: str | None,
    label: str,
    source: str,
    core: dict[str, Any] | None = None,
) -> SelfAwakeRuntimeConfig:
    return SelfAwakeRuntimeConfig(
        model=model,
        api_key=api_key,
        label=label,
        source=source,
        core=core,
        supports_images="image" in (model.get("input") or []),
        thinking_level="medium" if model.get("reasoning") else "off",
    )


async def resolve_self_awake_runtime_config(app: AppState, token: str | None) -> SelfAwakeRuntimeConfig:
    if token:
        try:
            core = await asyncio.to_thread(app.core_client.resolve_runtime_config, token)
            if core:
                return _runtime_config_from_model(*core_model(core), core)
        except Exception as error:
            logger.warning(f"解析 Core 默认助手配置失败，将使用环境模型: {error}")
    return _runtime_config_from_model(*env_model(), None)


def final_assistant_text(messages: list[dict[str, Any]]) -> str:
    blocks: list[str] = []
    for message in messages:
        if message.get("role") != "assistant":
            continue
        for part in message.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip():
                blocks.append(str(part.get("text") or "").strip())
    return blocks[-1] if blocks else ""


def request_character(request: dict[str, Any], core: dict[str, Any] | None) -> dict[str, Any]:
    character = (core or {}).get("character")
    if isinstance(character, dict):
        return character
    character = request.get("character")
    return character if isinstance(character, dict) else {}


def has_meaningful_array(value: Any) -> bool:
    return isinstance(value, list) and any(str(item or "").strip() for item in value)


def self_awake_can_use_file_tool(context: dict[str, Any] | None, tool_name: str, args: Any) -> bool:
    if tool_name not in {"read", "ls", "grep", "find"}:
        return False
    data = context or {}
    if data.get("debug_target") or data.get("debugTarget"):
        return True
    if has_meaningful_array(data.get("recent_incidents")) or has_meaningful_array(data.get("recent_logs")):
        return True
    policy = data.get("policy") if isinstance(data.get("policy"), dict) else {}
    if policy.get("allow_workspace_file_tools") is True:
        return True
    if isinstance(args, dict):
        path_value = args.get("path")
        pattern_value = args.get("pattern")
        if isinstance(path_value, str) and path_value not in {"", ".", "./"} and isinstance(pattern_value, str) and pattern_value:
            return True
    return False


def tool_pattern(tool_name: str, args: Any) -> str:
    if isinstance(args, dict):
        for key in ["path", "url", "query", "command"]:
            value = args.get(key)
            if isinstance(value, str) and value:
                return value
    return tool_name


def self_awake_before_tool_call(context_data: dict[str, Any] | None):
    allowed_tools = {
        "loaded_tools",
        "web_search",
        "web_fetch",
        "analyze_image",
        "create_memo",
        "create_reminder",
        "list_memos",
        "list_due_memos",
        "dispatch_due_memos",
        "get_next_memo_wake",
        "complete_memo",
        "snooze_memo",
        "mark_memo_triggered",
        "set_self_awake_timer",
    }
    file_tools = {"read", "ls", "grep", "find"}

    async def before_tool_call(context: dict[str, Any], _signal: Any = None) -> dict[str, Any] | None:
        tool_call = context.get("toolCall") or {}
        tool_name = str(tool_call.get("name") or "")
        args = context.get("args")
        pattern = tool_pattern(tool_name, args)
        if self_awake_can_use_file_tool(context_data, tool_name, args):
            logger.info(f"文件工具已按上下文放行: {tool_name} {pattern}")
            return None
        if tool_name in file_tools:
            logger.warning(f"文件工具已拦截: {tool_name} {pattern}")
            return {
                "block": True,
                "reason": "当前自醒上下文已提供工作区与工作日记摘要，后台自醒不能无目的浏览文件。只有存在 debug_target、recent_incidents 或明确错误日志时才可读取具体文件。",
            }
        if tool_name in allowed_tools:
            logger.info(f"工具已允许: {tool_name} {pattern}")
            return None
        logger.warning(f"后台工具已拦截: {tool_name} {pattern}")
        return {
            "block": True,
            "reason": "当前轮次是后台非交互观察，不能直接执行需要用户确认或可能产生副作用的工具。请在最终 JSON 的 action 字段中说明需要的动作。",
        }

    return before_tool_call


async def run_self_awake_agent(
    request: dict[str, Any],
    app: AppState,
    token: str | None,
    runtime_config: SelfAwakeRuntimeConfig,
) -> dict[str, Any]:
    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    session_id = create_id("selfawake")
    tools = create_mon_agent_tools(
        app.config.workspace_root,
        MonToolContext(
            session_id=session_id,
            core_client=app.core_client,
            core_token=token,
            current_model_supports_images=runtime_config.supports_images,
            vision_config=(runtime_config.core or {}).get("visionConfig") if runtime_config.core else None,
            get_current_files=lambda: [],
        ),
        "self_awake",
    )
    character = request_character(request, runtime_config.core)
    system_prompt = build_agent_system_prompt({"character": character}, source="self_awake")
    user_prompt = build_self_awake_task_prompt(context)
    logger.info(f"调用开始 session={session_id} model={runtime_config.label} tools={len(tools)} context_keys={list(context.keys())}")
    agent = Agent(
        AgentOptions(
            session_id=session_id,
            tool_execution="sequential",
            stream_fn=stream_openai_compatible,
            initial_state={
                "model": runtime_config.model,
                "thinkingLevel": runtime_config.thinking_level,
                "systemPrompt": system_prompt,
                "tools": tools,
                "messages": [],
            },
            get_api_key=lambda _provider: runtime_config.api_key,
            before_tool_call=self_awake_before_tool_call(context),
        )
    )

    def handle_event(event: dict[str, Any], _signal: Any = None) -> None:
        event_type = event.get("type")
        if event_type == "tool_execution_start":
            logger.info(f"工具开始: {event.get('toolName')} {event.get('toolCallId')}")
        elif event_type == "tool_execution_end":
            logger.info(f"工具{'失败' if event.get('isError') else '完成'}: {event.get('toolName')} {event.get('toolCallId')}")
        elif event_type == "message_end":
            message = event.get("message") or {}
            if message.get("errorMessage"):
                logger.error(f"助手消息失败: {message.get('errorMessage')}")

    agent.subscribe(handle_event)
    await agent.prompt({"role": "user", "timestamp": now_ms(), "content": [{"type": "text", "text": user_prompt}]})
    error_messages = [
        str(message.get("errorMessage"))
        for message in agent.state.messages
        if isinstance(message, dict) and message.get("errorMessage")
    ]
    if error_messages:
        raise SelfAwakeModelError(error_messages[-1])
    return {"session_id": session_id, "messages": list(agent.state.messages), "text": final_assistant_text(list(agent.state.messages))}


async def run_self_awake(request: dict[str, Any], app: AppState, token: str | None) -> dict[str, Any]:
    started = now_ms()
    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    runtime_config = await resolve_self_awake_runtime_config(app, token)
    character = request_character(request, runtime_config.core)
    try:
        result = await run_self_awake_agent(request, app, token, runtime_config)
        decision = parse_self_awake_decision(str(result.get("text") or ""))
        logger.info(
            f"决策完成 model={runtime_config.label} action={decision['action']['type']} "
            f"next={decision['next_wake']['after_minutes']}m duration={now_ms() - started}ms"
        )
        return decision
    except Exception as error:
        reason = str(error)
        if isinstance(error, SelfAwakeModelError):
            logger.error(f"调用失败，使用 fallback: {reason}")
        else:
            logger.error(f"调用失败，使用 fallback: {reason}", exc_info=True)
        return fallback_self_awake_decision(context, reason, character)


def run_self_awake_sync(request: dict[str, Any], app: AppState, token: str | None) -> dict[str, Any]:
    return asyncio.run(run_self_awake(request, app, token))
