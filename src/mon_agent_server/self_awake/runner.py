from __future__ import annotations

import asyncio
import os
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
from ..runtime.character_memory import recall_character_memories
from .result import final_assistant_text, final_assistant_usage, request_character

if TYPE_CHECKING:
    from ..app import AppState

logger = get_logger("MonAgent", "SelfAwake")
_SELF_AWAKE_JOBS: dict[str, dict[str, Any]] = {}
_SELF_AWAKE_JOBS_LOCK = threading.Lock()
_SELF_AWAKE_ASSISTANT_LOCKS: dict[str, threading.Lock] = {}
_SELF_AWAKE_JOB_CACHE_LIMIT = 512


class SelfAwakeModelError(RuntimeError):
    pass


def self_awake_run_timeout_seconds() -> float:
    try:
        value = float(os.environ.get("MON_AGENT_SELF_AWAKE_TIMEOUT_SECONDS", "180"))
    except (TypeError, ValueError):
        value = 180.0
    return min(max(value, 10.0), 900.0)


def self_awake_operation_id(request: dict[str, Any]) -> str:
    return str(request.get("idempotency_key") or request.get("event_id") or request.get("job_id") or "").strip()


def persist_connector_chat_message(
    app: AppState,
    token: str | None,
    context: dict[str, Any],
    decision: dict[str, Any],
) -> dict[str, Any] | None:
    """Append one connector-owned background turn to its captured chat session."""
    if not token or str(context.get("trigger") or "") != "connector_event":
        return None
    session_id = str(context.get("chat_session_id") or "").strip()
    assistant_id = decision.get("assistant_id")
    character_id = decision.get("character_id")
    if not session_id or assistant_id in (None, ""):
        return None

    restored = app.core_client.get_agent_session(token, session_id)
    session = restored.get("info") if isinstance(restored.get("info"), dict) else None
    if not session:
        return None
    participant_ids = list(session.get("participantAssistantIDs") or [])
    if not any(str(item) == str(assistant_id) for item in participant_ids):
        participant_ids.append(assistant_id)
        app.core_client.update_agent_session_participants(token, session, participant_ids)

    event = context.get("event") if isinstance(context.get("event"), dict) else {}
    diary = decision.get("diary") if isinstance(decision.get("diary"), dict) else {}
    action = decision.get("action") if isinstance(decision.get("action"), dict) else {}
    event_type = str(event.get("event_type") or "event").strip()
    body = str(diary.get("content") or action.get("message") or decision.get("current_desire") or "").strip()
    text = f"【Lichess · {event_type}】\n{body}" if event.get("connector_key") == "lichess" else body
    if not text:
        return None

    current = now_ms()
    message_id = create_id("connector_msg")
    message = {
        "info": {
            "id": message_id,
            "role": "assistant",
            "kind": "connector-event",
            "speaker": {
                "assistantID": assistant_id,
                "characterID": character_id,
            },
            "orchestration": {
                "source": "connector_event",
                "connectorID": event.get("connector_id"),
                "connectorEventID": event.get("connector_event_id"),
                "externalEventID": event.get("external_event_id"),
            },
            "time": {"created": current, "completed": current},
        },
        "parts": [{
            "id": f"{message_id}_text_0",
            "messageID": message_id,
            "sessionID": session_id,
            "type": "text",
            "text": text,
            "time": {"start": current, "end": current},
        }],
    }
    session["time"] = {**(session.get("time") or {}), "updated": current}
    return app.core_client.sync_agent_message(token, session, message)


def connector_conversation_history(
    app: AppState,
    token: str | None,
    context: dict[str, Any],
    *,
    limit: int = 30,
) -> list[dict[str, Any]]:
    if not token or str(context.get("trigger") or "") != "connector_event":
        return []
    session_id = str(context.get("chat_session_id") or "").strip()
    if not session_id:
        return []
    restored = app.core_client.get_agent_session(token, session_id)
    result: list[dict[str, Any]] = []
    for message in (restored.get("messages") or [])[-limit:]:
        info = message.get("info") if isinstance(message.get("info"), dict) else {}
        texts = [
            str(part.get("text") or "").strip()
            for part in message.get("parts") or []
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()
        ]
        if not texts:
            continue
        speaker = info.get("speaker") if isinstance(info.get("speaker"), dict) else {}
        result.append({
            "role": info.get("role") or "assistant",
            "assistant_id": speaker.get("assistantID"),
            "created_at": (info.get("time") or {}).get("created"),
            "text": "\n".join(texts)[:4000],
        })
    return result


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
        "channel": "email" if important else "auto",
        "source_type": "self_awake",
    }


async def ensure_self_awake_notification(
    app: AppState,
    token: str | None,
    context: dict[str, Any],
    decision: dict[str, Any],
    agent_notification: dict[str, Any] | None = None,
    operation_id: str | None = None,
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
                connector_manager=getattr(app, "connector_manager", None),
                environment=context.get("environment") if isinstance(context.get("environment"), dict) else None,
                operation_id=operation_id,
            ),
            "self_awake",
        )
        notify_tool = next((tool for tool in tools if tool.name == "contact_user"), None)
        if notify_tool is None:
            raise RuntimeError("自醒工具集中没有 contact_user。")
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
    runtime_core = runtime_config.core or {}
    current_character = request_character(request, runtime_config.core)
    current_assistant = runtime_core.get("assistant") if isinstance(runtime_core.get("assistant"), dict) else {}
    skill_owner_key = None
    skill_owner_id = None
    if token:
        try:
            profile = await asyncio.to_thread(app.core_client.get_user_profile, token)
            skill_owner_id = profile.get("id")
            skill_owner_key = owner_storage_key(skill_owner_id)
        except Exception as error:
            logger.warning(f"读取自醒技能所有者失败，继续使用内置技能: {error}")

    def create_skill(payload: dict[str, Any]) -> dict[str, Any]:
        if not token or skill_owner_id in (None, ""):
            raise RuntimeError("自醒创建技能需要有效登录态。")
        return app.skill_installer.create_generated(skill_owner_id, token, "local", payload)

    def update_skill(payload: dict[str, Any]) -> dict[str, Any]:
        if not token or skill_owner_id in (None, ""):
            raise RuntimeError("自醒更新技能需要有效登录态。")
        action = str(payload.get("action") or "").strip()
        if action == "preview":
            return app.skill_installer.inspect_generated_update(
                skill_owner_id, token, "local", payload
            )
        if action == "apply":
            preview_id = str(payload.get("preview_id") or "").strip()
            if not preview_id:
                raise ValueError("action=apply 时必须提供 preview_id")
            return app.skill_installer.apply_generated_update(
                skill_owner_id, token, "local", preview_id
            )
        raise ValueError("action 必须是 preview 或 apply")

    def list_skills(payload: dict[str, Any]) -> list[dict[str, Any]]:
        if not token or skill_owner_id in (None, ""):
            raise RuntimeError("自醒查看技能需要有效登录态。")
        return app.skill_installer.list_for_model(skill_owner_id, token, "local", payload)

    skill_runtime = create_skill_runtime(
        app.config.workspace_root,
        MonToolContext(
            session_id=session_id,
            core_client=app.core_client,
            core_token=token,
            connector_manager=getattr(app, "connector_manager", None),
            current_model_supports_images=runtime_config.supports_images,
            vision_ai_entity=(runtime_config.core or {}).get("visionAIEntity") if runtime_config.core else None,
            screen_captures=getattr(app, "screen_captures", None),
            camera_captures=getattr(app, "camera_captures", None),
            environment=context.get("environment") if isinstance(context.get("environment"), dict) else None,
            character=current_character,
            assistant=current_assistant,
            get_current_files=lambda: [],
            operation_id=self_awake_operation_id(request) or None,
            list_skills=list_skills,
            create_skill=create_skill,
            update_skill=update_skill,
        ),
        profile="self_awake",
        owner_key=skill_owner_key,
    )
    tools = skill_runtime.active_tools()
    character = request_character(request, runtime_config.core)
    prompt_core = runtime_config.core if runtime_config.core else {"character": character}
    relevant_memories: list[dict[str, Any]] = []
    if token:
        try:
            relevant_memories = await asyncio.to_thread(
                recall_character_memories,
                app.core_client,
                token,
                prompt_core,
                str(context.get("trigger") or context.get("event") or "系统自醒"),
            )
        except Exception as error:
            logger.warning(f"自醒角色记忆召回失败，继续使用当前上下文: {error}")
    def system_prompt_for(active_skill_ids: tuple[str, ...]) -> str:
        return build_agent_system_prompt(
            prompt_core,
            source="self_awake",
            supports_images=runtime_config.supports_images,
            active_skill_ids=active_skill_ids,
            skill_resource_prompt=skill_runtime.prompt_section(),
            environment=context.get("environment") if isinstance(context.get("environment"), dict) else None,
            relevant_memories=relevant_memories,
        )

    system_prompt = system_prompt_for(skill_runtime.active_skill_ids)
    prompt_context = context
    try:
        history = await asyncio.to_thread(connector_conversation_history, app, token, context)
        if history:
            prompt_context = {**context, "conversation_history": history}
    except Exception as error:
        logger.warning(f"读取连接器绑定会话历史失败，继续按事件处理: {error}")
    user_prompt = build_self_awake_task_prompt(prompt_context)
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
            if event.get("toolName") == "contact_user":
                notification["attempted"] = True
        elif event_type == "tool_execution_end":
            logger.info(f"工具{'失败' if event.get('isError') else '完成'}: {event.get('toolName')} {event.get('toolCallId')}")
            if event.get("toolName") == "contact_user":
                # 模型偶尔会在首次联系成功后再次调用 contact_user。第二次调用会被
                # 权限钩子拦截，但不能让这个“重复调用失败”覆盖已经完成的真实投递。
                if not event.get("isError"):
                    notification["succeeded"] = True
                    notification["error"] = ""
                elif not notification["succeeded"]:
                    error_info = event.get("error") if isinstance(event.get("error"), dict) else {}
                    notification["error"] = str(error_info.get("message") or "通知工具调用失败")
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
    runtime_config = await resolve_self_awake_runtime_config(app, token, request.get("assistant_id"))
    runtime_core = runtime_config.core or {}
    runtime_assistant = runtime_core.get("assistant") if isinstance(runtime_core.get("assistant"), dict) else {}
    runtime_character = runtime_core.get("character") if isinstance(runtime_core.get("character"), dict) else {}
    character = request_character(request, runtime_config.core)
    result: dict[str, Any] = {}
    try:
        timeout_seconds = self_awake_run_timeout_seconds()
        try:
            async with asyncio.timeout(timeout_seconds):
                result = await run_self_awake_agent(request, app, token, runtime_config)
        except TimeoutError as error:
            raise SelfAwakeModelError(f"自醒整轮执行超过 {timeout_seconds:g} 秒，已终止并转入 fallback。") from error
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
        self_awake_operation_id(request) or None,
    )
    decision["notification"]["memo_finalization"] = await finalize_memo_due_notification(
        app,
        token,
        context,
        decision["notification"],
    )
    decision["assistant_id"] = runtime_assistant.get("id")
    decision["character_id"] = runtime_character.get("id")
    decision["author"] = {
        "assistant_id": runtime_assistant.get("id"),
        "assistant_name": runtime_assistant.get("name") or runtime_character.get("name") or "助手",
        "character_id": runtime_character.get("id"),
        "character_name": runtime_character.get("name") or runtime_assistant.get("name") or "助手",
        "avatar_url": runtime_character.get("avatar_url") or "",
    }
    render_self_awake_decision(app, decision, runtime_config, now_ms() - started, character, decision["usage"])
    return decision


def run_self_awake_sync(request: dict[str, Any], app: AppState, token: str | None) -> dict[str, Any]:
    return asyncio.run(run_self_awake(request, app, token))


def run_self_awake_sync_with_watchdog(
    request: dict[str, Any], app: AppState, token: str | None
) -> dict[str, Any]:
    """Bound the whole model runtime even when a provider blocks the asyncio loop."""
    completed = threading.Event()
    outcome: dict[str, Any] = {}

    def target() -> None:
        try:
            outcome["decision"] = run_self_awake_sync(request, app, token)
        except BaseException as error:
            outcome["error"] = error
        finally:
            completed.set()

    timeout_seconds = self_awake_run_timeout_seconds()
    thread = threading.Thread(target=target, name="monagent-self-awake-model", daemon=True)
    thread.start()
    if not completed.wait(timeout_seconds):
        context = request.get("context") if isinstance(request.get("context"), dict) else {}
        character = request.get("character") if isinstance(request.get("character"), dict) else {}
        reason = f"自醒整轮执行超过 {timeout_seconds:g} 秒，外层监控已终止等待并转入 fallback。"
        decision = fallback_self_awake_decision(context, reason, character)
        decision["usage"] = final_assistant_usage([])
        decision["notification"] = {
            "attempted": False,
            "succeeded": False,
            "source": "watchdog_timeout",
            "delivered_channels": [],
            "error": reason,
            "memo_finalization": {"attempted": False, "completed": [], "errors": []},
        }
        decision["assistant_id"] = request.get("assistant_id")
        decision["character_id"] = character.get("id")
        decision["author"] = {
            "assistant_id": request.get("assistant_id"),
            "assistant_name": character.get("name") or "助手",
            "character_id": character.get("id"),
            "character_name": character.get("name") or "助手",
            "avatar_url": character.get("avatar_url") or "",
        }
        return decision
    if "error" in outcome:
        raise outcome["error"]
    return outcome["decision"]


def run_self_awake_and_persist_sync(
    request: dict[str, Any],
    app: AppState,
    token: str | None,
    async_run_id: str | None = None,
) -> dict[str, Any]:
    request = enrich_self_awake_request(request, app, token=token)
    context = request.get("context") if isinstance(request.get("context"), dict) else {}
    decision = run_self_awake_sync_with_watchdog(request, app, token)
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
        try:
            persist_connector_chat_message(app, token, context, decision)
        except Exception as error:
            logger.error(f"连接器活动写入聊天会话失败 run={async_run_id or '-'}: {error}", exc_info=True)
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

    # The process-local cache is only an optimization. Core is the durable
    # idempotency ledger, so completed jobs remain deduplicated after restart.
    if token and hasattr(app.core_client, "get_self_awake_run_by_external_id"):
        persisted = app.core_client.get_self_awake_run_by_external_id(token, async_run_id)
        if isinstance(persisted, dict) and persisted.get("status") in {"succeeded", "skipped"}:
            return {
                **contract_fields,
                "accepted": False,
                "status": persisted.get("status"),
                "async_run_id": async_run_id,
                "server_run_id": persisted.get("id"),
                "server_error": "",
                "deduplicated": True,
                "message": "自醒任务已在 Core 中完成。",
            }

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
        assistant_key = str(request.get("assistant_id") or "default")
        with _SELF_AWAKE_JOBS_LOCK:
            assistant_lock = _SELF_AWAKE_ASSISTANT_LOCKS.setdefault(assistant_key, threading.Lock())
        try:
            with assistant_lock:
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
