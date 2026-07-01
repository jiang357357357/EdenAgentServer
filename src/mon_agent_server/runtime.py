from __future__ import annotations

import asyncio
import base64
import threading
from pathlib import Path
from typing import Any

from mon_agent_core import Agent, AgentOptions

from .brokers import PermissionBroker, QuestionBroker
from .core import CoreAuthenticationExpiredError, CoreClient
from .events import EventBus
from .ids import create_id, now_ms
from .model_stream import core_model, env_model, stream_openai_compatible
from .mon_tools import MonToolContext, create_mon_agent_tools
from .prompts import attachment_context, build_agent_system_prompt, build_user_chat_task_prompt
from .store import SessionStore


def content_text(parts: list[dict[str, Any]]) -> str:
    return "\n".join(str(part.get("text") or "") for part in parts if part.get("type") == "text").strip()


def prompt_files(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "url": part.get("url") or "",
            "filename": part.get("filename"),
            "mime": part.get("mime") or "application/octet-stream",
            "size": part.get("size"),
        }
        for part in parts
        if part.get("type") == "file"
    ]


def images_from_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    for part in parts:
        if part.get("type") != "file":
            continue
        mime = part.get("mime") or "image/png"
        url = part.get("url") or ""
        if not str(mime).startswith("image/") or not url.startswith("data:"):
            continue
        try:
            payload = url.split(",", 1)[1]
            base64.b64decode(payload, validate=False)
        except Exception:
            continue
        images.append({"type": "image", "mimeType": mime, "data": payload})
    return images


def text_from_tool_result(result: dict[str, Any]) -> str:
    return "\n".join(
        str(item.get("text") or "") for item in result.get("content", []) if isinstance(item, dict) and item.get("type") == "text"
    )


class RuntimeModelConfig:
    def __init__(self, model: dict[str, Any], api_key: str | None, label: str, source: str, core: dict[str, Any] | None) -> None:
        self.model = model
        self.api_key = api_key
        self.label = label
        self.source = source
        self.core = core
        self.supports_images = "image" in (model.get("input") or [])
        self.thinking_level = "medium" if model.get("reasoning") else "off"


class RunState:
    def __init__(self) -> None:
        self.assistant_message_id: str | None = None
        self.assistant_created_at: int | None = None
        self.assistant_current_segment_index: int | None = None
        self.assistant_next_segment_index = 0
        self.runtime_thinking_lines: list[str] = []
        self.tool_inputs: dict[str, Any] = {}
        self.tool_starts: dict[str, int] = {}
        self.finished_tool_calls: set[str] = set()
        self.text_part_snapshots: dict[str, str] = {}


class MonAgentRuntime:
    def __init__(
        self,
        workspace_root: Path,
        store: SessionStore,
        events: EventBus,
        permissions: PermissionBroker,
        questions: QuestionBroker,
        core_client: CoreClient,
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        self.store = store
        self.events = events
        self.permissions = permissions
        self.questions = questions
        self.core_client = core_client
        self._running: dict[str, threading.Thread] = {}
        self._lock = threading.Lock()

    def is_running(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._running

    def append_user_only(self, session_id: str, parts: list[dict[str, Any]]) -> dict[str, Any]:
        message = self.store.append_user_message(session_id, content_text(parts), prompt_files(parts))
        self.emit_message(session_id, message["info"])
        for part in message["parts"]:
            self.emit_part(session_id, part)
        self.emit_session(session_id)
        return message

    def prompt_async(self, session_id: str, parts: list[dict[str, Any]], auth_token: str | None) -> None:
        with self._lock:
            if session_id in self._running:
                raise RuntimeError("Session is already running")
            thread = threading.Thread(target=self._thread_main, args=(session_id, parts, auth_token), daemon=True)
            self._running[session_id] = thread
            thread.start()

    def _thread_main(self, session_id: str, parts: list[dict[str, Any]], auth_token: str | None) -> None:
        try:
            asyncio.run(self._run_prompt(session_id, parts, auth_token))
        except Exception as error:
            self.emit_session_error(session_id, error)
        finally:
            with self._lock:
                self._running.pop(session_id, None)

    async def _resolve_runtime_config(self, auth_token: str | None) -> RuntimeModelConfig:
        if auth_token:
            core = await asyncio.to_thread(self.core_client.resolve_runtime_config, auth_token)
            if core:
                model, api_key, label, source = core_model(core)
                return RuntimeModelConfig(model, api_key, label, source, core)
        model, api_key, label, source = env_model()
        return RuntimeModelConfig(model, api_key, label, source, None)

    async def _run_prompt(self, session_id: str, parts: list[dict[str, Any]], auth_token: str | None) -> None:
        session = self.store.require_session(session_id)
        started = now_ms()
        run_state = RunState()
        self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "busy"}}})
        user_message = self.store.append_user_message(session_id, content_text(parts), prompt_files(parts))
        self.emit_message(session_id, user_message["info"])
        for part in user_message["parts"]:
            self.emit_part(session_id, part)
        self.emit_session(session_id)
        self.emit_runtime_thinking(session_id, run_state, "正在读取 Core 默认助手、角色与模型配置。")

        try:
            runtime_config = await self._resolve_runtime_config(auth_token)
            await self.sync_core_session(session_id, auth_token, runtime_config.core)
            await self.sync_core_message(session_id, user_message, auth_token, runtime_config.core)
            self.emit_runtime_thinking(
                session_id,
                run_state,
                f"已选择模型：{runtime_config.label}，配置来源：{'Core' if runtime_config.source == 'core' else '环境变量'}。",
            )
            files = prompt_files(parts)
            tools = create_mon_agent_tools(
                self.workspace_root,
                MonToolContext(
                    session_id=session_id,
                    core_client=self.core_client,
                    core_token=auth_token,
                    permissions=self.permissions,
                    questions=self.questions,
                    current_model_supports_images=runtime_config.supports_images,
                    vision_config=(runtime_config.core or {}).get("visionConfig") if runtime_config.core else None,
                    get_message_id=lambda: run_state.assistant_message_id,
                    get_current_files=lambda: files,
                ),
                "user_chat",
            )
            self.emit_runtime_thinking(session_id, run_state, f"已注册 Python Mon 工具：{len(tools)} 个。")
            task_prompt = build_user_chat_task_prompt(
                content_text(parts),
                attachment_context(files, runtime_config.supports_images),
            )
            system_prompt = build_agent_system_prompt(runtime_config.core)
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
                        "messages": list(session.get("agentMessages") or []),
                    },
                    get_api_key=lambda _provider: runtime_config.api_key,
                    before_tool_call=self._before_tool_call(session_id, run_state),
                )
            )
            agent.subscribe(lambda event, _signal: self.handle_agent_event(session_id, event, run_state))
            content: list[dict[str, Any]] = []
            if runtime_config.supports_images:
                content.extend(images_from_parts(parts))
            if task_prompt:
                content.append({"type": "text", "text": task_prompt})
            self.emit_runtime_thinking(session_id, run_state, "正在发送给 Python AgentCore，并等待模型回复。")
            await agent.prompt({"role": "user", "timestamp": user_message["info"]["time"]["created"], "content": content})
            self.store.set_agent_messages(session_id, list(agent.state.messages))
            self.emit_runtime_thinking(session_id, run_state, "回复生成完成。", done=True)
            if run_state.assistant_message_id:
                assistant_message = next(
                    (
                        item
                        for item in self.store.require_session(session_id)["messages"]
                        if item["info"]["id"] == run_state.assistant_message_id
                    ),
                    None,
                )
                if assistant_message:
                    await self.sync_core_message(session_id, assistant_message, auth_token, runtime_config.core)
            await self.sync_core_session(session_id, auth_token, runtime_config.core)
            self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "idle"}}})
            self.emit_session(session_id)
            duration = now_ms() - started
            print(f"[Runtime] session {session_id} completed in {duration}ms", flush=True)
        except Exception as error:
            self.emit_runtime_thinking(session_id, run_state, f"运行失败：{error}", done=True)
            self.emit_session_error(session_id, error)

    def _before_tool_call(self, session_id: str, run_state: RunState):
        async def before_tool_call(context: dict[str, Any], _signal: Any = None) -> dict[str, Any] | None:
            tool_call = context.get("toolCall") or {}
            tool_name = tool_call.get("name") or ""
            args = context.get("args") or {}
            pattern = self.permission_pattern(tool_name, args)
            if self.is_safe_tool(tool_name) or self.permissions.is_always_allowed(tool_name, pattern):
                return None
            reply = await asyncio.to_thread(
                self.permissions.ask,
                {
                    "sessionID": session_id,
                    "permission": tool_name,
                    "patterns": [pattern],
                    "always": self.permission_always_patterns(tool_name),
                    "metadata": {"args": args, "toolName": tool_name},
                    "tool": {
                        "messageID": run_state.assistant_message_id,
                        "callID": tool_call.get("id"),
                    }
                    if run_state.assistant_message_id
                    else None,
                },
            )
            if reply == "reject":
                return {"block": True, "reason": "用户拒绝执行工具。"}
            return None

        return before_tool_call

    async def sync_core_session(self, session_id: str, auth_token: str | None, core: dict[str, Any] | None) -> None:
        if not auth_token:
            return
        session = self.store.require_session(session_id)
        await asyncio.to_thread(self.core_client.sync_agent_session, auth_token, session["info"], core)

    async def sync_core_message(
        self,
        session_id: str,
        message: dict[str, Any],
        auth_token: str | None,
        core: dict[str, Any] | None,
    ) -> None:
        if not auth_token:
            return
        session = self.store.require_session(session_id)
        await asyncio.to_thread(self.core_client.sync_agent_message, auth_token, session["info"], message, core)

    def ensure_assistant_message(self, session_id: str, run_state: RunState) -> str:
        message_id = run_state.assistant_message_id or create_id("msg")
        created = run_state.assistant_created_at or now_ms()
        run_state.assistant_message_id = message_id
        run_state.assistant_created_at = created
        info = {"id": message_id, "role": "assistant", "agent": "python-agent-core", "time": {"created": created}}
        self.store.upsert_message(session_id, info)
        self.emit_message(session_id, info)
        return message_id

    def emit_runtime_thinking(self, session_id: str, run_state: RunState, line: str, done: bool = False) -> None:
        message_id = self.ensure_assistant_message(session_id, run_state)
        created = run_state.assistant_created_at or now_ms()
        text = line.strip()
        if text:
            run_state.runtime_thinking_lines.append(text)
        self.emit_text_part(
            session_id,
            run_state,
            {
                "id": f"{message_id}_runtime_thinking",
                "messageID": message_id,
                "sessionID": session_id,
                "type": "reasoning",
                "text": "\n".join(run_state.runtime_thinking_lines),
                "source": "runtime",
                "title": "运行过程",
                "time": {"start": created, "end": now_ms() if done else None},
            },
        )

    def begin_assistant_segment(self, run_state: RunState) -> int:
        index = run_state.assistant_next_segment_index
        run_state.assistant_current_segment_index = index
        run_state.assistant_next_segment_index += 1
        return index

    def ensure_assistant_segment(self, run_state: RunState) -> int:
        if run_state.assistant_current_segment_index is not None:
            return run_state.assistant_current_segment_index
        return self.begin_assistant_segment(run_state)

    def handle_agent_event(self, session_id: str, event: dict[str, Any], run_state: RunState) -> None:
        event_type = event.get("type")
        message = event.get("message") or {}
        if event_type == "message_start" and message.get("role") == "assistant":
            run_state.assistant_message_id = run_state.assistant_message_id or create_id("msg")
            run_state.assistant_created_at = run_state.assistant_created_at or message.get("timestamp") or now_ms()
            self.begin_assistant_segment(run_state)
            self.upsert_assistant(session_id, message, run_state, done=False)
            return
        if event_type == "message_update" and message.get("role") == "assistant":
            self.upsert_assistant(session_id, message, run_state, done=False)
            return
        if event_type == "message_end" and message.get("role") == "assistant":
            self.upsert_assistant(session_id, message, run_state, done=True)
            if message.get("errorMessage"):
                self.emit_session_error(session_id, message.get("errorMessage"))
            return
        if event_type == "tool_execution_start":
            call_id = event.get("toolCallId")
            tool_name = event.get("toolName")
            run_state.tool_inputs[str(call_id)] = event.get("args")
            run_state.tool_starts[str(call_id)] = now_ms()
            self.emit_runtime_thinking(session_id, run_state, f"正在调用工具：{tool_name}。")
            if run_state.assistant_message_id:
                self.emit_tool_part(
                    session_id,
                    run_state.assistant_message_id,
                    str(call_id),
                    str(tool_name),
                    {"status": "running", "input": event.get("args"), "time": {"start": run_state.tool_starts[str(call_id)]}},
                )
            return
        if event_type == "tool_execution_end":
            call_id = str(event.get("toolCallId"))
            tool_name = str(event.get("toolName"))
            started = run_state.tool_starts.get(call_id)
            body = text_from_tool_result(event.get("result") or {})
            run_state.finished_tool_calls.add(call_id)
            self.emit_runtime_thinking(session_id, run_state, f"工具 {tool_name} {'执行失败' if event.get('isError') else '执行完成'}。")
            if run_state.assistant_message_id:
                state = (
                    {"status": "error", "input": run_state.tool_inputs.get(call_id), "error": body or "工具执行失败。", "time": {"start": started, "end": now_ms()}}
                    if event.get("isError")
                    else {"status": "completed", "input": run_state.tool_inputs.get(call_id), "output": body, "time": {"start": started, "end": now_ms()}}
                )
                self.emit_tool_part(session_id, run_state.assistant_message_id, call_id, tool_name, state)

    def upsert_assistant(self, session_id: str, message: dict[str, Any], run_state: RunState, done: bool) -> None:
        message_id = run_state.assistant_message_id or create_id("msg")
        created = run_state.assistant_created_at or message.get("timestamp") or now_ms()
        run_state.assistant_message_id = message_id
        run_state.assistant_created_at = created
        segment_index = self.ensure_assistant_segment(run_state)
        info = {
            "id": message_id,
            "role": "assistant",
            "agent": "python-agent-core",
            "modelID": message.get("model"),
            "providerID": message.get("provider"),
            "time": {"created": created, "completed": now_ms() if done else None},
            "error": {"name": "AgentError", "message": message.get("errorMessage")} if message.get("errorMessage") else None,
        }
        self.store.upsert_message(session_id, info)
        self.emit_message(session_id, info)
        for index, block in enumerate(message.get("content") or []):
            if block.get("type") == "text":
                self.emit_text_part(
                    session_id,
                    run_state,
                    {
                        "id": f"{message_id}_seg_{segment_index}_text_{index}",
                        "messageID": message_id,
                        "sessionID": session_id,
                        "type": "text",
                        "text": block.get("text") or "",
                        "time": {"start": created, "end": now_ms() if done else None},
                    },
                )
            elif block.get("type") == "thinking":
                self.emit_text_part(
                    session_id,
                    run_state,
                    {
                        "id": f"{message_id}_seg_{segment_index}_reasoning_{index}",
                        "messageID": message_id,
                        "sessionID": session_id,
                        "type": "reasoning",
                        "text": block.get("thinking") or "",
                        "source": "model",
                        "title": "思考",
                        "time": {"start": created, "end": now_ms() if done else None},
                    },
                )
            elif block.get("type") == "toolCall" and block.get("id") not in run_state.finished_tool_calls:
                self.emit_tool_part(
                    session_id,
                    message_id,
                    block.get("id"),
                    block.get("name"),
                    {"status": "pending", "input": block.get("arguments"), "time": {"start": created}},
                )

    def emit_tool_part(self, session_id: str, message_id: str, tool_call_id: str, tool_name: str, state: dict[str, Any]) -> None:
        self.emit_part(
            session_id,
            {"id": tool_call_id, "messageID": message_id, "sessionID": session_id, "type": "tool", "tool": tool_name, "state": state},
        )

    def emit_message(self, session_id: str, info: dict[str, Any]) -> None:
        self.events.emit({"type": "message.updated", "properties": {"sessionID": session_id, "info": info}})

    def emit_part(self, session_id: str, part: dict[str, Any]) -> None:
        self.store.upsert_part(session_id, part)
        self.events.emit({"type": "message.part.updated", "properties": {"sessionID": session_id, "part": part, "time": now_ms()}})

    def emit_text_part(self, session_id: str, run_state: RunState, part: dict[str, Any]) -> None:
        self.store.upsert_part(session_id, part)
        previous = run_state.text_part_snapshots.get(part["id"])
        done = bool((part.get("time") or {}).get("end"))
        run_state.text_part_snapshots[part["id"]] = part.get("text") or ""
        if not previous or done or not str(part.get("text") or "").startswith(previous):
            self.events.emit({"type": "message.part.updated", "properties": {"sessionID": session_id, "part": part, "time": now_ms()}})
            return
        delta = str(part.get("text") or "")[len(previous) :]
        if delta:
            self.events.emit(
                {
                    "type": "message.part.delta",
                    "properties": {
                        "sessionID": session_id,
                        "messageID": part["messageID"],
                        "partID": part["id"],
                        "field": "text",
                        "delta": delta,
                        "baseLength": len(previous),
                        "targetText": part.get("text") or "",
                        "partType": part.get("type"),
                        "source": part.get("source"),
                        "title": part.get("title"),
                        "time": part.get("time"),
                    },
                }
            )

    def emit_session(self, session_id: str) -> None:
        session = self.store.require_session(session_id)
        self.events.emit({"type": "session.updated", "properties": {"sessionID": session_id, "info": session["info"]}})

    def emit_session_error(self, session_id: str, error: Any) -> None:
        message = str(error)
        auth_expired = isinstance(error, CoreAuthenticationExpiredError)
        self.events.emit(
            {
                "type": "session.error",
                "properties": {
                    "sessionID": session_id,
                    "error": {
                        "name": "CoreAuthenticationExpired" if auth_expired else "AgentError",
                        "message": message,
                        "data": {
                            "message": message,
                            **(
                                {"code": "core_authentication_expired", "path": error.path, "status": error.status}
                                if auth_expired
                                else {}
                            ),
                        },
                    },
                },
            }
        )
        self.events.emit({"type": "session.status", "properties": {"sessionID": session_id, "status": {"type": "idle"}}})

    @staticmethod
    def is_safe_tool(tool_name: str) -> bool:
        return tool_name in {
            "read",
            "ls",
            "grep",
            "find",
            "loaded_tools",
            "ask_user",
            "analyze_image",
            "list_memos",
            "list_due_memos",
            "get_next_memo_wake",
        }

    @staticmethod
    def permission_pattern(tool_name: str, args: Any) -> str:
        if isinstance(args, dict):
            for key in ["path", "url", "query", "command"]:
                if isinstance(args.get(key), str):
                    return args[key]
        return tool_name

    @staticmethod
    def permission_always_patterns(tool_name: str) -> list[str]:
        return ["*"] if tool_name in {"web_search", "web_fetch"} else []
