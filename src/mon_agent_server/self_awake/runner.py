from __future__ import annotations

import asyncio
import threading
from typing import TYPE_CHECKING, Any

from mon_agent_core import Agent, AgentOptions

from ..ids import create_id, now_ms
from ..logging import get_logger
from ..model_stream import stream_openai_compatible
from ..prompts import (
    build_agent_system_prompt,
    build_self_awake_task_prompt,
    fallback_self_awake_decision,
    parse_self_awake_decision,
)
from ..tools import MonToolContext, create_mon_agent_tools
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


def self_awake_notification_payload(decision: dict[str, Any]) -> dict[str, Any]:
    important = bool(decision.get("should_interrupt_user"))
    diary = decision.get("diary") if isinstance(decision.get("diary"), dict) else {}
    action = decision.get("action") if isinstance(decision.get("action"), dict) else {}
    next_wake = decision.get("next_wake") if isinstance(decision.get("next_wake"), dict) else {}
    observations = decision.get("observations") if isinstance(decision.get("observations"), list) else []
    message_parts = [str(action.get("message") or decision.get("current_desire") or "完成一次后台自醒检查。").strip()]
    observation_text = "；".join(str(item).strip() for item in observations[:3] if str(item).strip())
    if observation_text:
        message_parts.append(f"观察：{observation_text}")
    next_reason = str(next_wake.get("reason") or "").strip()
    if next_reason:
        message_parts.append(f"后续：{next_reason}")
    return {
        "title": str(diary.get("title") or ("重要自醒提醒" if important else "自醒状态")).strip(),
        "message": "\n".join(part for part in message_parts if part),
        "channel": "auto",
        "priority": "high" if important else "normal",
        "source_type": "self_awake",
    }


async def ensure_self_awake_notification(
    app: AppState,
    token: str | None,
    context: dict[str, Any],
    decision: dict[str, Any],
    agent_notification: dict[str, Any] | None = None,
) -> dict[str, Any]:
    observed = agent_notification if isinstance(agent_notification, dict) else {}
    if observed.get("attempted"):
        return {
            "attempted": True,
            "succeeded": bool(observed.get("succeeded")),
            "source": "agent_tool",
            "error": str(observed.get("error") or ""),
        }

    try:
        tools = create_mon_agent_tools(
            app.config.workspace_root,
            MonToolContext(
                core_client=app.core_client,
                core_token=token,
                environment=context.get("environment") if isinstance(context.get("environment"), dict) else None,
            ),
            "self_awake",
        )
        notify_tool = next((tool for tool in tools if tool.name == "notify_user"), None)
        if notify_tool is None:
            raise RuntimeError("自醒工具集中没有 notify_user。")
        result = await notify_tool.run(create_id("selfawakenotify"), self_awake_notification_payload(decision))
        details = result.get("details") if isinstance(result, dict) and isinstance(result.get("details"), dict) else {}
        return {
            "attempted": True,
            "succeeded": True,
            "source": "runtime_enforced",
            "delivered_channels": list(details.get("delivered_channels") or []),
            "error": "",
        }
    except Exception as error:
        logger.error(f"自醒强制通知失败: {error}", exc_info=True)
        return {
            "attempted": True,
            "succeeded": False,
            "source": "runtime_enforced",
            "delivered_channels": [],
            "error": str(error),
        }


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
    system_prompt = build_agent_system_prompt(
        prompt_core,
        source="self_awake",
        supports_images=runtime_config.supports_images,
        environment=context.get("environment") if isinstance(context.get("environment"), dict) else None,
    )
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
    notification = {"attempted": False, "succeeded": False, "error": ""}

    def handle_event(event: dict[str, Any], _signal: Any = None) -> None:
        event_type = event.get("type")
        if event_type == "tool_execution_start":
            logger.info(f"工具开始: {event.get('toolName')} {event.get('toolCallId')}")
            if event.get("toolName") == "notify_user":
                notification["attempted"] = True
        elif event_type == "tool_execution_end":
            logger.info(f"工具{'失败' if event.get('isError') else '完成'}: {event.get('toolName')} {event.get('toolCallId')}")
            if event.get("toolName") == "notify_user":
                # 模型偶尔会在首次通知成功后再次调用 notify_user。第二次调用会被
                # 权限钩子拦截，但不能让这个“重复调用失败”覆盖已经完成的真实投递。
                if not event.get("isError"):
                    notification["succeeded"] = True
                    notification["error"] = ""
                elif not notification["succeeded"]:
                    notification["error"] = str(event.get("error") or "通知工具调用失败")
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
    return {
        "session_id": session_id,
        "messages": messages,
        "text": final_assistant_text(messages),
        "usage": final_assistant_usage(messages),
        "notification": notification,
    }


async def run_self_awake(request: dict[str, Any], app: AppState, token: str | None) -> dict[str, Any]:
    request = enrich_self_awake_request(request, app, token=token)
    started = now_ms()
    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    runtime_config = await resolve_self_awake_runtime_config(app, token)
    character = request_character(request, runtime_config.core)
    result: dict[str, Any] = {}
    try:
        result = await run_self_awake_agent(request, app, token, runtime_config)
        decision = parse_self_awake_decision(str(result.get("text") or ""))
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else final_assistant_usage(result.get("messages") or [])
        decision["usage"] = usage
        logger.info(
            f"决策完成 model={runtime_config.label} action={decision['action']['type']} "
            f"next={decision['next_wake']['after_minutes']}m duration={now_ms() - started}ms "
            f"cache_hit_tokens={usage.get('cacheRead') or 0} cache_miss_tokens={usage.get('cacheMiss') or 0} "
            f"output_tokens={usage.get('output') or 0} total_tokens={usage.get('totalTokens') or 0}"
        )
    except Exception as error:
        reason = str(error)
        if isinstance(error, SelfAwakeModelError):
            logger.error(f"调用失败，使用 fallback: {reason}")
        else:
            logger.error(f"调用失败，使用 fallback: {reason}", exc_info=True)
        decision = fallback_self_awake_decision(context, reason, character)
        decision["usage"] = final_assistant_usage([])
    decision["notification"] = await ensure_self_awake_notification(
        app,
        token,
        context,
        decision,
        result.get("notification") if isinstance(result.get("notification"), dict) else None,
    )
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
    server_run_id = None
    server_error = ""
    if token:
        try:
            persisted = app.core_client.persist_self_awake_run(
                token,
                decision,
                context,
                external_run_id=async_run_id,
            )
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

def start_self_awake_run_async(request: dict[str, Any], app: AppState, token: str | None) -> dict[str, Any]:
    async_run_id = create_id("selfawakejob")
    request = enrich_self_awake_request(request, app, token=token)
    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    server_run_id = None
    server_error = ""
    if token:
        try:
            pending = app.core_client.persist_self_awake_pending(token, context, async_run_id)
            server_run_id = pending.get("id") if isinstance(pending, dict) else None
        except Exception as error:
            server_error = str(error)
            logger.error(f"创建自醒 pending 记录失败 run={async_run_id}: {error}", exc_info=True)

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
        "server_run_id": server_run_id,
        "server_error": server_error,
        "message": "自醒任务已提交，MonAgent 将在后台执行并写入 Core。",
    }
