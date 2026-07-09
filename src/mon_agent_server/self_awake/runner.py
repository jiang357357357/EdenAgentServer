from __future__ import annotations

import asyncio
import json
import threading
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from mon_agent_core import Agent, AgentOptions

from ..ids import create_id, now_ms
from ..core import to_storage_iso
from ..logging import get_logger
from ..model_stream import stream_openai_compatible
from ..prompts import (
    build_agent_system_prompt,
    build_self_awake_task_prompt,
    fallback_self_awake_decision,
    parse_self_awake_decision,
)
from ..tools import MonToolContext, create_mon_agent_tools, resolve_self_awake_state_path
from .config import SelfAwakeRuntimeConfig, resolve_self_awake_runtime_config
from .environment import enrich_self_awake_context, enrich_self_awake_request
from .permissions import self_awake_before_tool_call
from .render import render_self_awake_decision, render_self_awake_request
from .result import final_assistant_text, final_assistant_usage, request_character

if TYPE_CHECKING:
    from ..app import AppState

logger = get_logger("MonAgent", "SelfAwake")


class SelfAwakeModelError(RuntimeError):
    pass


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
            environment=context.get("environment") if isinstance(context.get("environment"), dict) else None,
            get_current_files=lambda: [],
        ),
        "self_awake",
    )
    character = request_character(request, runtime_config.core)
    prompt_core = runtime_config.core if runtime_config.core else {"character": character}
    system_prompt = build_agent_system_prompt(prompt_core, source="self_awake")
    user_prompt = build_self_awake_task_prompt(context)
    logger.info(f"调用开始 session={session_id} model={runtime_config.label} tools={len(tools)} context_keys={list(context.keys())}")
    render_self_awake_request(
        app,
        session_id,
        context,
        runtime_config,
        character,
        system_prompt,
        user_prompt,
        [tool.name for tool in tools],
    )
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
    messages = list(agent.state.messages)
    return {"session_id": session_id, "messages": messages, "text": final_assistant_text(messages), "usage": final_assistant_usage(messages)}


async def run_self_awake(request: dict[str, Any], app: AppState, token: str | None) -> dict[str, Any]:
    request = enrich_self_awake_request(request, app, token=token)
    started = now_ms()
    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    runtime_config = await resolve_self_awake_runtime_config(app, token)
    character = request_character(request, runtime_config.core)
    try:
        result = await run_self_awake_agent(request, app, token, runtime_config)
        decision = parse_self_awake_decision(str(result.get("text") or ""))
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else final_assistant_usage(result.get("messages") or [])
        decision["usage"] = usage
        duration_ms = now_ms() - started
        logger.info(
            f"决策完成 model={runtime_config.label} action={decision['action']['type']} "
            f"next={decision['next_wake']['after_minutes']}m duration={duration_ms}ms "
            f"cache_hit_tokens={usage.get('cacheRead') or 0} cache_miss_tokens={usage.get('cacheMiss') or 0} "
            f"output_tokens={usage.get('output') or 0} total_tokens={usage.get('totalTokens') or 0}"
        )
        render_self_awake_decision(app, decision, runtime_config, duration_ms, character, usage)
        return decision
    except Exception as error:
        reason = str(error)
        if isinstance(error, SelfAwakeModelError):
            logger.error(f"调用失败，使用 fallback: {reason}")
        else:
            logger.error(f"调用失败，使用 fallback: {reason}", exc_info=True)
        decision = fallback_self_awake_decision(context, reason, character)
        decision["usage"] = final_assistant_usage([])
        render_self_awake_decision(app, decision, runtime_config, now_ms() - started, character, decision["usage"])
        return decision


def run_self_awake_sync(request: dict[str, Any], app: AppState, token: str | None) -> dict[str, Any]:
    return asyncio.run(run_self_awake(request, app, token))


def run_self_awake_and_persist_sync(
    request: dict[str, Any],
    app: AppState,
    token: str | None,
    async_run_id: str | None = None,
) -> dict[str, Any]:
    request = enrich_self_awake_request(request, app, token=token)
    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    decision = run_self_awake_sync(request, app, token)
    update_self_awake_timer_from_decision(app, decision, async_run_id)
    server_run_id = None
    server_error = ""
    if token:
        try:
            persisted = app.core_client.persist_self_awake_run(token, decision, context)
            server_run_id = persisted.get("id") if isinstance(persisted, dict) else None
        except Exception as error:
            server_error = str(error)
            logger.error(f"异步自醒写入 Core 失败 run={async_run_id or '-'}: {error}", exc_info=True)
    return {
        **decision,
        "accepted": False,
        "async_run_id": async_run_id,
        "server_run_id": server_run_id,
        "server_error": server_error,
    }


def update_self_awake_timer_from_decision(app: AppState, decision: dict[str, Any], async_run_id: str | None = None) -> None:
    try:
        next_wake = decision.get("next_wake") if isinstance(decision.get("next_wake"), dict) else {}
        after_minutes = int(float(next_wake.get("after_minutes") or 720))
        timer = resolve_self_awake_state_path(app.config.workspace_root)
        after_minutes = max(int(timer["min_minutes"]), min(int(timer["max_minutes"]), after_minutes))
        wake_at = datetime.now().astimezone() + timedelta(minutes=after_minutes)
        state_path = timer["state_path"]
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
        state.update(
            {
                "enabled": True,
                "next_wake_at": to_storage_iso(wake_at.timestamp() * 1000),
                "next_wake_after_minutes": after_minutes,
                "next_wake_reason": str(next_wake.get("reason") or "MonAgent 异步自醒决策完成，安排下一次自醒。"),
                "last_timer_tool_at": to_storage_iso(now_ms()),
                "last_timer_tool_source": "monagent_async_self_awake",
                "last_agent_async_run_id": async_run_id or "",
            }
        )
        tmp_path = state_path.with_suffix(f"{state_path.suffix}.tmp")
        tmp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(state_path)
        logger.info(f"异步自醒定时器已写回 run={async_run_id or '-'} next={state['next_wake_at']}")
    except Exception as error:
        logger.error(f"异步自醒定时器写回失败 run={async_run_id or '-'}: {error}", exc_info=True)


def start_self_awake_run_async(request: dict[str, Any], app: AppState, token: str | None) -> dict[str, Any]:
    async_run_id = create_id("selfawakejob")
    request = enrich_self_awake_request(request, app, token=token)
    context = request.get("context") if isinstance(request.get("context"), dict) else {}

    def worker() -> None:
        try:
            logger.info(f"异步自醒开始 run={async_run_id} context_keys={list(context.keys())}")
            result = run_self_awake_and_persist_sync(request, app, token, async_run_id)
            action_type = ((result.get("action") or {}) if isinstance(result.get("action"), dict) else {}).get("type") or ""
            after_minutes = (
                ((result.get("next_wake") or {}) if isinstance(result.get("next_wake"), dict) else {}).get("after_minutes")
                or ""
            )
            logger.info(
                f"异步自醒完成 run={async_run_id} action={action_type} next={after_minutes}m "
                f"server_run_id={result.get('server_run_id') or ''} server_error={result.get('server_error') or ''}"
            )
        except Exception as error:
            logger.error(f"异步自醒失败 run={async_run_id}: {error}", exc_info=True)

    threading.Thread(target=worker, name=f"monagent-self-awake-{async_run_id}", daemon=True).start()
    return {
        "accepted": True,
        "status": "queued",
        "async_run_id": async_run_id,
        "server_run_id": None,
        "server_error": "",
        "message": "自醒任务已提交，MonAgent 将在后台执行并写入 Core。",
    }
