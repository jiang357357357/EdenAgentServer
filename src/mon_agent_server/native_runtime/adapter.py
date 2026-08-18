from __future__ import annotations

import asyncio
import inspect
import os
import threading
import uuid
import weakref
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .client import NativeRuntimeClient, NativeRuntimeError

AgentMessage = dict[str, Any]
NATIVE_FS_TOOLS = frozenset({
    "read", "ls", "find", "grep", "write", "edit", "apply_patch", "bash", "powershell", "write_stdin", "get_diff"
})


@dataclass(slots=True)
class NativeAgentOptions:
    initial_state: dict[str, Any] | None = None
    convert_to_llm: Callable[..., Any] | None = None
    transform_context: Callable[..., Any] | None = None
    stream_fn: Callable[..., Any] | None = None
    get_api_key: Callable[..., Any] | None = None
    before_tool_call: Callable[..., Any] | None = None
    after_tool_call: Callable[..., Any] | None = None
    prepare_next_turn: Callable[..., Any] | None = None
    prepare_next_turn_with_context: Callable[..., Any] | None = None
    should_stop_after_turn: Callable[..., Any] | None = None
    steering_mode: str = "one-at-a-time"
    follow_up_mode: str = "one-at-a-time"
    session_id: str | None = None
    thinking_budgets: dict[str, int] | None = None
    transport: str = "auto"
    max_retry_delay_ms: int | None = None
    tool_execution: str = "parallel"
    workspace_root: str | None = None


@dataclass(slots=True)
class NativeAbortSignal:
    aborted: bool = False


@dataclass
class NativeAgentState:
    system_prompt: str = ""
    model: dict[str, Any] = field(default_factory=dict)
    thinking_level: str = "off"
    tools: list[Any] = field(default_factory=list)
    messages: list[AgentMessage] = field(default_factory=list)
    active_speaker: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    is_streaming: bool = False
    streaming_message: AgentMessage | None = None
    pending_tool_calls: set[str] = field(default_factory=set)
    error_message: str | None = None


class NativeRuntimeService:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self._agents: dict[str, NativeAgent] = {}
        self._start_lock = asyncio.Lock()
        self._started = False
        self.client = NativeRuntimeClient(
            server_version="mon-agent-server",
            model_callback=self._model_callback,
            tool_callback=self._tool_callback,
            hook_callback=self._hook_callback,
            event_callback=self._event_callback,
        )

    async def ensure_started(self) -> None:
        if self._started and self.client.running:
            return
        async with self._start_lock:
            if self._started and self.client.running:
                return
            await self.client.start()
            self._started = True
            for session_id, agent in self._agents.items():
                await self.client.create_session(session_id, agent._session_config())

    async def register(self, agent: NativeAgent) -> None:
        await self.ensure_started()
        if agent.runtime_session_id in self._agents:
            return
        self._agents[agent.runtime_session_id] = agent
        try:
            await self.client.create_session(agent.runtime_session_id, agent._session_config())
        except BaseException:
            self._agents.pop(agent.runtime_session_id, None)
            raise

    async def unregister(self, agent: NativeAgent) -> None:
        if self._agents.pop(agent.runtime_session_id, None) is not None and self.client.running:
            try:
                await self.client.close_session(agent.runtime_session_id)
            except NativeRuntimeError:
                pass

    def schedule(self, coroutine) -> None:
        if self.loop.is_closed():
            coroutine.close()
            return
        try:
            current = asyncio.get_running_loop()
        except RuntimeError:
            current = None
        if current is self.loop:
            asyncio.create_task(coroutine)
        else:
            asyncio.run_coroutine_threadsafe(coroutine, self.loop)

    async def close(self) -> None:
        self._agents.clear()
        await self.client.close()
        self._started = False

    def _agent_for(self, frame: dict[str, Any]) -> NativeAgent:
        session_id = str(frame.get("sessionID") or "")
        agent = self._agents.get(session_id)
        if agent is None:
            raise NativeRuntimeError(f"no Server adapter is registered for native session {session_id!r}")
        return agent

    async def _model_callback(self, frame, update):
        return await self._agent_for(frame)._model_callback(frame, update)

    async def _tool_callback(self, frame, update):
        return await self._agent_for(frame)._tool_callback(frame, update)

    async def _hook_callback(self, frame):
        return await self._agent_for(frame)._hook_callback(frame)

    async def _event_callback(self, frame):
        await self._agent_for(frame)._process_event(dict(frame.get("event") or {}))


_services: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, NativeRuntimeService] = weakref.WeakKeyDictionary()
_services_lock = threading.RLock()


def native_runtime_service() -> NativeRuntimeService:
    loop = asyncio.get_running_loop()
    with _services_lock:
        service = _services.get(loop)
        if service is None:
            service = NativeRuntimeService(loop)
            _services[loop] = service
        return service


async def close_native_runtime() -> None:
    loop = asyncio.get_running_loop()
    with _services_lock:
        service = _services.pop(loop, None)
    if service is not None:
        await service.close()


class NativeAgent:
    def __init__(self, options: NativeAgentOptions | None = None) -> None:
        self.options = options or NativeAgentOptions()
        self.stream_fn = self.options.stream_fn
        initial = self.options.initial_state or {}
        self._state = NativeAgentState(
            system_prompt=str(initial.get("systemPrompt", initial.get("system_prompt", ""))),
            model=dict(initial.get("model") or {}),
            thinking_level=str(initial.get("thinkingLevel", initial.get("thinking_level", "off"))),
            tools=list(initial.get("tools") or []),
            messages=[_copy_message(message) for message in initial.get("messages") or []],
            active_speaker=dict(initial.get("activeSpeaker") or {}),
            metadata={
                **dict(initial.get("metadata") or {}),
                **{
                    key: initial[key]
                    for key in (
                        "promptCacheKey", "promptCacheFingerprint",
                        "promptCacheEpoch", "promptCacheInvalidationReason",
                    )
                    if key in initial
                },
            },
        )
        self.session_id = self.options.session_id
        self.runtime_session_id = f"{self.session_id or 'session'}:{uuid.uuid4().hex}"
        self.listeners: list[Callable[..., Any]] = []
        self._service: NativeRuntimeService | None = None
        self._registered = False
        self._active: asyncio.Future[None] | None = None
        self._signal: NativeAbortSignal | None = None
        self._pending_steering: list[AgentMessage] = []
        self._pending_follow_up: list[AgentMessage] = []

    @property
    def state(self) -> NativeAgentState:
        return self._state

    @property
    def signal(self) -> NativeAbortSignal | None:
        return self._signal

    def subscribe(self, listener: Callable[..., Any]) -> Callable[[], None]:
        self.listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self.listeners:
                self.listeners.remove(listener)

        return unsubscribe

    def steer(self, message: AgentMessage) -> None:
        if self._service and self._registered:
            self._service.schedule(self._service.client.steer(self.runtime_session_id, message))
        else:
            self._pending_steering.append(message)

    def follow_up(self, message: AgentMessage) -> None:
        if self._service and self._registered:
            self._service.schedule(self._service.client.follow_up(self.runtime_session_id, message))
        else:
            self._pending_follow_up.append(message)

    def clear_steering_queue(self) -> None:
        self._pending_steering.clear()

    def clear_follow_up_queue(self) -> None:
        self._pending_follow_up.clear()

    def clear_all_queues(self) -> None:
        self.clear_steering_queue()
        self.clear_follow_up_queue()

    def has_queued_messages(self) -> bool:
        return bool(self._pending_steering or self._pending_follow_up)

    def abort(self) -> None:
        if self._signal:
            self._signal.aborted = True
        if self._service and self._registered:
            self._service.schedule(self._service.client.cancel_turn(self.runtime_session_id))

    async def wait_for_idle(self) -> None:
        if self._active:
            await asyncio.shield(self._active)

    def reset(self) -> None:
        if self._active:
            raise RuntimeError("Cannot reset a running native agent")
        self._state.messages.clear()
        self._state.streaming_message = None
        self._state.pending_tool_calls.clear()
        self._state.error_message = None
        self.clear_all_queues()

    async def prompt(self, input_value: str | AgentMessage | list[AgentMessage], images=None) -> None:
        if self._active:
            raise RuntimeError("Agent is already processing a prompt")
        messages = self._normalize_prompt(input_value, images)
        loop = asyncio.get_running_loop()
        completion: asyncio.Future[None] = loop.create_future()
        self._active = completion
        self._signal = NativeAbortSignal()
        self._state.is_streaming = True
        self._state.error_message = None
        try:
            await self._ensure_registered()
            await self._flush_pending_messages()
            turn = await self._service.client.start_turn(self.runtime_session_id, messages)
            result = await turn.wait()
            context = result.get("context") or {}
            self._state.system_prompt = str(context.get("systemPrompt") or self._state.system_prompt)
            self._state.messages = [_copy_message(message) for message in context.get("messages") or []]
        except BaseException as error:
            if isinstance(error, asyncio.CancelledError):
                self.abort()
                raise
            await self._emit_adapter_failure(error)
        finally:
            self._state.is_streaming = False
            self._state.streaming_message = None
            self._state.pending_tool_calls.clear()
            if not completion.done():
                completion.set_result(None)
            self._active = None
            self._signal = None

    async def continue_run(self) -> None:
        if not self._pending_steering and not self._pending_follow_up:
            raise RuntimeError("Native continuation requires a queued steering or follow-up message")
        queued = self._pending_steering or self._pending_follow_up
        message = queued.pop(0)
        await self.prompt(message)

    async def close(self) -> None:
        if self._service and self._registered:
            await self._service.unregister(self)
            self._registered = False

    async def _ensure_registered(self) -> None:
        if self._registered:
            assert self._service is not None
            await self._service.ensure_started()
            return
        self._service = native_runtime_service()
        await self._service.register(self)
        self._registered = True

    async def _flush_pending_messages(self) -> None:
        assert self._service is not None
        for message in self._pending_steering:
            await self._service.client.steer(self.runtime_session_id, message)
        for message in self._pending_follow_up:
            await self._service.client.follow_up(self.runtime_session_id, message)
        self._pending_steering.clear()
        self._pending_follow_up.clear()

    def _session_config(self) -> dict[str, Any]:
        callbacks = {
            "prepareModelContext": True,
            "prepareNextTurn": True,
            "shouldStopAfterTurn": self.options.should_stop_after_turn is not None,
            "beforeToolCall": self.options.before_tool_call is not None,
            "afterToolCall": self.options.after_tool_call is not None,
        }
        metadata = {
            **self._state.metadata,
            "activeSpeaker": self._state.active_speaker,
            "thinkingLevel": self._state.thinking_level,
        }
        native_enabled = os.environ.get("MON_AGENT_NATIVE_FS_TOOLS", "1").strip().lower() not in {
            "0", "false", "no", "off"
        }
        native_tools = [
            str(getattr(tool, "name", ""))
            for tool in self._state.tools
            if native_enabled and self.options.workspace_root and getattr(tool, "name", "") in NATIVE_FS_TOOLS
        ]
        return {
            "model": _model_spec(self._state.model),
            "systemPrompt": self._state.system_prompt,
            "messages": self._state.messages,
            "tools": [_tool_definition(tool) for tool in self._state.tools],
            "workspaceRoot": self.options.workspace_root,
            "nativeTools": native_tools,
            "metadata": metadata,
            "toolExecution": self.options.tool_execution,
            "steeringMode": self.options.steering_mode,
            "followUpMode": self.options.follow_up_mode,
            "callbacks": callbacks,
        }

    async def _model_callback(self, frame, update):
        if self.stream_fn is None:
            raise NativeRuntimeError("No model stream function configured")
        model = dict(frame.get("model") or {})
        context = {
            "systemPrompt": frame.get("systemPrompt") or "",
            "messages": frame.get("messages") or [],
            "tools": [
                tool
                for tool in self._state.tools
                if getattr(tool, "exposure", "direct") == "direct"
                and any(item.get("name") == getattr(tool, "name", "") for item in frame.get("tools") or [])
            ],
            **dict(frame.get("metadata") or {}),
        }
        provider = str(model.get("provider") or "")
        api_key = await _maybe_await(self.options.get_api_key(provider)) if self.options.get_api_key else None
        response = await _maybe_await(
            self.stream_fn(
                model,
                context,
                {
                    "apiKey": api_key,
                    "signal": self._signal,
                    "reasoning": None if self._state.thinking_level == "off" else self._state.thinking_level,
                    "sessionId": self.session_id,
                    "transport": self.options.transport,
                    "thinkingBudgets": self.options.thinking_budgets,
                    "maxRetryDelayMs": self.options.max_retry_delay_ms,
                },
            )
        )
        partial: AgentMessage | None = None
        async for event in response:
            event_type = str(event.get("type") or "")
            if event_type == "provider_retry":
                await update(partial or _empty_assistant(model), "", event=event)
            elif event_type in {"start", "stream_reset"} or event_type.endswith(("_start", "_delta", "_end")):
                partial = dict(event.get("partial") or partial or _empty_assistant(model))
                await update(partial, str(event.get("delta") or ""), event=event)
            elif event_type in {"done", "error"}:
                return self._prepare_assistant_tool_calls(await response.result())
        return self._prepare_assistant_tool_calls(await response.result())

    def _prepare_assistant_tool_calls(self, message: AgentMessage) -> AgentMessage:
        prepared = _copy_message(message)
        for block in prepared.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "toolCall":
                continue
            tool = self._find_tool(str(block.get("name") or ""))
            prepare = getattr(tool, "prepare_arguments", None) if tool is not None else None
            if prepare is None:
                continue
            try:
                arguments = prepare(block.get("arguments") or {})
                if isinstance(arguments, dict):
                    public_properties = set((getattr(tool, "parameters", {}) or {}).get("properties") or {})
                    arguments = {
                        key: value
                        for key, value in arguments.items()
                        if not str(key).startswith("_") or key in public_properties
                    }
                block["arguments"] = arguments
            except Exception:
                # Let native execution return the malformed-input error as a
                # tool result instead of turning it into a provider failure.
                pass
        return prepared

    async def _tool_callback(self, frame, update):
        call = dict(frame.get("call") or {})
        tool = self._find_tool(str(call.get("name") or ""))
        if tool is None:
            raise NativeRuntimeError(f"Tool {call.get('name')} not found")
        update_tasks: list[asyncio.Task[None]] = []

        def on_update(result: dict[str, Any]) -> None:
            update_tasks.append(asyncio.create_task(update(dict(result))))

        arguments = call.get("arguments") or {}
        if getattr(tool, "prepare_arguments", None):
            arguments = tool.prepare_arguments(arguments)
        execution = tool.run(str(call.get("id") or ""), arguments, self._signal, on_update)
        timeout_seconds = getattr(tool, "timeout_seconds", None)
        if timeout_seconds and timeout_seconds > 0:
            result = await asyncio.wait_for(execution, timeout=float(timeout_seconds))
        else:
            result = await execution
        if update_tasks:
            await asyncio.gather(*update_tasks)
        return dict(result)

    async def _hook_callback(self, frame):
        hook = str(frame.get("hook") or "")
        payload = dict(frame.get("payload") or {})
        if hook == "prepareModelContext":
            messages = list(payload.get("messages") or [])
            if self.options.transform_context:
                messages = list(await _maybe_await(self.options.transform_context(messages, self._signal)))
            converter = self.options.convert_to_llm or _default_convert_to_llm
            payload["messages"] = list(await _maybe_await(converter(messages)))
            return payload
        if hook == "prepareNextTurn":
            turn = self._rehydrate_turn(payload)
            if self.options.prepare_next_turn_with_context:
                update = await _maybe_await(self.options.prepare_next_turn_with_context(turn, self._signal))
            elif self.options.prepare_next_turn:
                update = await _maybe_await(self.options.prepare_next_turn(self._signal))
            else:
                # Tool objects can change exposure after a deferred tool_search.
                # Refresh native definitions even when no host turn hook exists.
                update = {"context": turn["context"]}
            return self._serialize_turn_update(update)
        if hook == "shouldStopAfterTurn":
            if self.options.should_stop_after_turn is None:
                return False
            return bool(await _maybe_await(self.options.should_stop_after_turn(self._rehydrate_turn(payload))))
        if hook == "beforeToolCall":
            if self.options.before_tool_call is None:
                return None
            tool_call = dict(payload.get("toolCall") or {})
            tool = self._find_tool(str(tool_call.get("name") or ""))
            args = payload.get("args") or {}
            if tool and getattr(tool, "prepare_arguments", None):
                try:
                    args = tool.prepare_arguments(args)
                except Exception:
                    pass
            payload["args"] = args
            payload["tool"] = tool
            payload["permissionRequest"] = tool.permission_request(args) if tool else None
            return await _maybe_await(self.options.before_tool_call(payload, self._signal))
        if hook == "afterToolCall":
            if self.options.after_tool_call is None:
                return None
            tool_call = dict(payload.get("toolCall") or {})
            payload["tool"] = self._find_tool(str(tool_call.get("name") or ""))
            return await _maybe_await(self.options.after_tool_call(payload, self._signal))
        raise NativeRuntimeError(f"Unsupported native hook: {hook}")

    def _rehydrate_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        context = dict(payload.get("context") or {})
        metadata = dict(context.pop("metadata", {}) or {})
        context.update(metadata)
        context["tools"] = list(self._state.tools)
        return {**payload, "context": context}

    def _serialize_turn_update(self, update: Any) -> Any:
        if not update:
            return None
        update = dict(update)
        context = dict(update.get("context") or {}) if "context" in update else None
        result: dict[str, Any] = {}
        if context is not None:
            tools = context.pop("tools", None)
            metadata = {
                key: value
                for key, value in context.items()
                if key not in {"systemPrompt", "messages"}
            }
            result["context"] = {
                "systemPrompt": context.get("systemPrompt", self._state.system_prompt),
                "messages": context.get("messages", self._state.messages),
                "metadata": metadata,
            }
            self._state.system_prompt = result["context"]["systemPrompt"]
            self._state.metadata = metadata
            if tools is not None:
                self._state.tools = list(tools)
                result["tools"] = [_tool_definition(tool) for tool in self._state.tools]
        if "model" in update:
            self._state.model = dict(update["model"] or {})
            result["model"] = _model_spec(self._state.model)
        return result

    async def _process_event(self, event: AgentMessage) -> None:
        event_type = str(event.get("type") or "")
        message = event.get("message")
        if event_type in {"message_start", "message_update"} and isinstance(message, dict):
            self._state.streaming_message = message
        elif event_type == "message_end" and isinstance(message, dict):
            self._state.streaming_message = None
            self._state.messages.append(_copy_message(message))
            if message.get("errorMessage"):
                self._state.error_message = str(message["errorMessage"])
        elif event_type == "tool_execution_start":
            self._state.pending_tool_calls.add(str(event.get("toolCallId") or ""))
        elif event_type == "tool_execution_end":
            self._state.pending_tool_calls.discard(str(event.get("toolCallId") or ""))
        elif event_type == "agent_end":
            self._state.streaming_message = None
        for listener in list(self.listeners):
            result = listener(event, self._signal)
            if inspect.isawaitable(result):
                await result

    async def _emit_adapter_failure(self, error: BaseException) -> None:
        message = {
            "role": "assistant",
            "content": [{"type": "text", "text": ""}],
            "provider": self._state.model.get("provider", "unknown"),
            "model": self._state.model.get("id", "unknown"),
            "stopReason": "aborted" if self._signal and self._signal.aborted else "error",
            "errorMessage": str(error),
        }
        for event in (
            {"type": "message_start", "message": message},
            {"type": "message_end", "message": message},
            {"type": "turn_end", "message": message, "toolResults": []},
            {"type": "agent_end", "messages": [message]},
        ):
            await self._process_event(event)

    def _find_tool(self, name: str) -> Any | None:
        return next((tool for tool in self._state.tools if getattr(tool, "name", None) == name), None)

    @staticmethod
    def _normalize_prompt(input_value, images=None) -> list[AgentMessage]:
        if isinstance(input_value, list):
            return input_value
        if isinstance(input_value, dict):
            return [input_value]
        content = [{"type": "text", "text": str(input_value)}]
        content.extend(images or [])
        return [{"role": "user", "content": content}]


def _tool_definition(tool: Any) -> dict[str, Any]:
    return {
        "name": str(tool.name),
        "label": str(getattr(tool, "label", tool.name)),
        "description": str(getattr(tool, "description", "")),
        "parameters": dict(getattr(tool, "parameters", {}) or {}),
        "outputSchema": dict(getattr(tool, "output_schema", {}) or {}) or None,
        "source": str(getattr(tool, "source", "runtime")),
        "version": str(getattr(tool, "version", "1")),
        "namespace": str(getattr(tool, "namespace", "general")),
        "executionMode": str(getattr(tool, "execution_mode", None) or "parallel"),
        "exposure": str(getattr(tool, "exposure", "direct")),
    }


def _model_spec(model: dict[str, Any]) -> dict[str, Any]:
    return {
        **model,
        "id": str(model.get("id") or "unknown"),
        "provider": str(model.get("provider") or "unknown"),
        "api": str(model.get("api") or ""),
    }


def _empty_assistant(model: dict[str, Any]) -> AgentMessage:
    return {
        "role": "assistant",
        "content": [{"type": "text", "text": ""}],
        "api": model.get("api", ""),
        "provider": model.get("provider", ""),
        "model": model.get("id", ""),
        "stopReason": "stop",
    }


def _copy_message(message: AgentMessage) -> AgentMessage:
    copied = dict(message)
    if isinstance(copied.get("content"), list):
        copied["content"] = [dict(item) if isinstance(item, dict) else item for item in copied["content"]]
    return copied


def _default_convert_to_llm(messages: list[AgentMessage]) -> list[AgentMessage]:
    return [message for message in messages if message.get("role") in {"user", "assistant", "toolResult"}]


async def _maybe_await(value):
    return await value if inspect.isawaitable(value) else value
