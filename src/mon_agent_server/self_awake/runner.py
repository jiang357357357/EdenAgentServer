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
from ..skills import create_skill_runtime, owner_storage_key
from ..tools import MonToolContext, create_mon_agent_tools
from ..tools.memo_schedule import submit_memo_schedule_refresh
from .config import SelfAwakeRuntimeConfig, resolve_self_awake_runtime_config
from .contract import contract_response_fields
from .environment import enrich_self_awake_context, enrich_self_awake_request
from .permissions import memo_due_notification_args, self_awake_before_tool_call
from .render import render_self_awake_decision, render_self_awake_request
from .result import final_assistant_text, final_assistant_usage, request_character

if TYPE_CHECKING:
    from ..app import AppState

logger = get_logger("MonAgent", "SelfAwake")
_SELF_AWAKE_JOBS: dict[str, dict[str, Any]] = {}
_SELF_AWAKE_JOBS_LOCK = threading.Lock()
_SELF_AWAKE_JOB_CACHE_LIMIT = 512


class SelfAwakeModelError(RuntimeError):
    pass


def memo_due_items(context: dict[str, Any] | None) -> list[dict[str, Any]]:
    data = context or {}
    event = data.get("event") if isinstance(data.get("event"), dict) else {}
    reason = str(event.get("reason") or data.get("trigger") or "").strip().lower()
    if reason != "memo_due":
        return []
    raw_items = data.get("due_memos") if isinstance(data.get("due_memos"), list) else []
    items = [item for item in raw_items if isinstance(item, dict)]
    if not items and isinstance(data.get("memo"), dict):
        items = [data["memo"]]
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        key = str(item.get("id") or "")
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        unique.append(item)
    return unique


def self_awake_notification_payload(decision: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    memo_payload = memo_due_notification_args(context)
    if memo_payload:
        return memo_payload
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

    action = decision.get("action") if isinstance(decision.get("action"), dict) else {}
    should_notify = bool(memo_due_notification_args(context)) or bool(
        decision.get("should_interrupt_user")
    ) or str(action.get("type") or "").strip() == "remind_user"
    if not should_notify:
        return {
            "attempted": False,
            "succeeded": False,
            "source": "quiet_decision",
            "delivered_channels": [],
            "error": "",
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
        result = await notify_tool.run(create_id("selfawakenotify"), self_awake_notification_payload(decision, context))
        details = result.get("details") if isinstance(result, dict) and isinstance(result.get("details"), dict) else {}
        return {
            "attempted": True,
            "succeeded": True,
            "source": "runtime_enforced",
            "delivered_channels": list(details.get("delivered_channels") or []),
            "error": "",
        }
    except Exception as error:
        logger.error(f"自醒通知兜底失败: {error}", exc_info=True)
        return {
            "attempted": True,
            "succeeded": False,
            "source": "runtime_enforced",
            "delivered_channels": [],
            "error": str(error),
        }


async def finalize_memo_due_notification(
    app: AppState,
    token: str | None,
    context: dict[str, Any],
    notification: dict[str, Any],
) -> dict[str, Any]:
    memos = memo_due_items(context)
    if not memos:
        return {"attempted": False, "completed": [], "errors": []}
    if not token or not notification.get("succeeded"):
        return {
            "attempted": False,
            "completed": [],
            "errors": ["notification_not_delivered" if token else "core_token_missing"],
        }

    completed: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for memo in memos:
        memo_id = memo.get("id")
        if memo_id in (None, ""):
            continue
        try:
            marked = await asyncio.to_thread(app.core_client.mark_memo_triggered, token, int(memo_id))
            final_memo = marked
            auto_completed = (
                str(memo.get("kind") or "") == "reminder"
                and str(memo.get("status") or "active") == "active"
                and not str(memo.get("repeat_rule") or "").strip()
            )
            if auto_completed:
                final_memo = await asyncio.to_thread(app.core_client.complete_memo, token, int(memo_id))
            submit_memo_schedule_refresh(app.config.workspace_root, reason="memo_due_delivered", memo=final_memo)
            completed.append({"id": int(memo_id), "auto_completed": auto_completed})
        except Exception as error:
            logger.error(f"到期提醒已通知但标记触发失败 memo={memo_id}: {error}", exc_info=True)
            errors.append({"id": memo_id, "error": str(error)})
    return {"attempted": True, "completed": completed, "errors": errors}


async def run_self_awake_agent(
    request: dict[str, Any],
    app: AppState,
    token: str | None,
    runtime_config: SelfAwakeRuntimeConfig,
) -> dict[str, Any]:
    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    session_id = create_id("selfawake")
    skill_owner_key = None
    if token:
        try:
            profile = await asyncio.to_thread(app.core_client.get_user_profile, token)
            skill_owner_key = owner_storage_key(profile.get("id"))
        except Exception as error:
            logger.warning(f"读取自醒技能所有者失败，继续使用内置技能: {error}")
    skill_runtime = create_skill_runtime(
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
        profile="self_awake",
        owner_key=skill_owner_key,
    )
    tools = skill_runtime.active_tools()
    character = request_character(request, runtime_config.core)
    prompt_core = runtime_config.core if runtime_config.core else {"character": character}
    def system_prompt_for(active_skill_ids: tuple[str, ...]) -> str:
        return build_agent_system_prompt(
            prompt_core,
            source="self_awake",
            supports_images=runtime_config.supports_images,
            active_skill_ids=active_skill_ids,
            skill_resource_prompt=skill_runtime.prompt_section(),
            environment=context.get("environment") if isinstance(context.get("environment"), dict) else None,
        )

    system_prompt = system_prompt_for(skill_runtime.active_skill_ids)
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
            prepare_next_turn_with_context=lambda turn, _signal: {
                **(skill_runtime.prepare_next_turn(turn, system_prompt_for) or {}),
                "context": {
                    **turn["context"],
                    "systemPrompt": system_prompt_for(skill_runtime.active_skill_ids),
                    "tools": skill_runtime.active_tools(),
                },
            },
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
    decision["notification"]["memo_finalization"] = await finalize_memo_due_notification(
        app,
        token,
        context,
        decision["notification"],
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
        **contract_response_fields(request),
        "accepted": False,
        "async_run_id": async_run_id,
        "server_run_id": server_run_id,
        "server_error": server_error,
    }

def start_self_awake_run_async(request: dict[str, Any], app: AppState, token: str | None) -> dict[str, Any]:
    async_run_id = str(request.get("job_id") or "").strip() or create_id("selfawakejob")
    request = {**request, "job_id": async_run_id}
    contract_fields = contract_response_fields(request)
    with _SELF_AWAKE_JOBS_LOCK:
        existing = _SELF_AWAKE_JOBS.get(async_run_id)
        if existing:
            if existing.get("idempotency_key") != contract_fields["idempotency_key"]:
                raise RuntimeError(f"自醒任务 ID 冲突: {async_run_id}")
            return {**existing, "deduplicated": True}

    # Enrichment may call external services. Do it before publishing the job so a
    # failed attempt cannot leave a permanently queued cache entry behind.
    request = enrich_self_awake_request(request, app, token=token)
    context = request.get("context") if isinstance(request.get("context"), dict) else {}

    with _SELF_AWAKE_JOBS_LOCK:
        # Another caller may have completed enrichment for the same job while we
        # were outside the lock. Preserve the first accepted run.
        existing = _SELF_AWAKE_JOBS.get(async_run_id)
        if existing:
            if existing.get("idempotency_key") != contract_fields["idempotency_key"]:
                raise RuntimeError(f"自醒任务 ID 冲突: {async_run_id}")
            return {**existing, "deduplicated": True}
        accepted_response = {
            **contract_fields,
            "accepted": True,
            "status": "queued",
            "async_run_id": async_run_id,
            "server_run_id": None,
            "server_error": "",
            "message": "自醒任务已提交，MonAgent 将在后台执行并写入 Core。",
        }
        _SELF_AWAKE_JOBS[async_run_id] = accepted_response
        while len(_SELF_AWAKE_JOBS) > _SELF_AWAKE_JOB_CACHE_LIMIT:
            _SELF_AWAKE_JOBS.pop(next(iter(_SELF_AWAKE_JOBS)))
    server_run_id = None
    server_error = ""
    if token:
        try:
            pending = app.core_client.persist_self_awake_pending(token, context, async_run_id)
            server_run_id = pending.get("id") if isinstance(pending, dict) else None
        except Exception as error:
            server_error = str(error)
            logger.error(f"创建自醒 pending 记录失败 run={async_run_id}: {error}", exc_info=True)
    with _SELF_AWAKE_JOBS_LOCK:
        accepted_response.update({"server_run_id": server_run_id, "server_error": server_error})

    def worker() -> None:
        try:
            with _SELF_AWAKE_JOBS_LOCK:
                accepted_response["status"] = "running"
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
            with _SELF_AWAKE_JOBS_LOCK:
                accepted_response.update(
                    {
                        "status": "completed",
                        "server_run_id": result.get("server_run_id"),
                        "server_error": result.get("server_error") or "",
                    }
                )
        except Exception as error:
            logger.error(f"异步自醒失败 run={async_run_id}: {error}", exc_info=True)
            with _SELF_AWAKE_JOBS_LOCK:
                accepted_response.update({"status": "failed", "server_error": str(error)})

    threading.Thread(target=worker, name=f"monagent-self-awake-{async_run_id}", daemon=True).start()
    return dict(accepted_response)
