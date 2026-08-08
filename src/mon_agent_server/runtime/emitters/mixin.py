from __future__ import annotations

import re
from typing import Any

from mon_agent_core.harness.compaction import estimate_context_tokens

from ...core import CoreAuthenticationExpiredError
from ...ids import create_id, now_ms
from ..messages import text_from_tool_result
from ..state import RunState


def strip_current_speaker_prefix(text: str, speaker: dict[str, Any] | None) -> str:
    names = {
        str((speaker or {}).get(key) or "").strip()
        for key in ("assistantName", "characterName")
        if str((speaker or {}).get(key) or "").strip()
    }
    for name in sorted(names, key=len, reverse=True):
        pattern = rf"^\s*(?:\[{re.escape(name)}\]|【{re.escape(name)}】|{re.escape(name)}\s*[：:])\s*"
        cleaned = re.sub(pattern, "", text, count=1)
        if cleaned != text:
            return cleaned
    return text


def runtime_error_summary(error: Any) -> str:
    message = str(error).strip() or "未知错误"
    normalized = message.lower()
    if "ssl" in normalized and ("unexpected_eof" in normalized or "eof occurred" in normalized):
        return "模型连接失败：安全连接被远端提前断开。"
    if "timed out" in normalized or "timeout" in normalized:
        return "模型请求超时：服务在限定时间内没有返回结果。"
    if "401" in normalized or "unauthorized" in normalized or "invalid api key" in normalized:
        return "模型鉴权失败：请检查当前模型的 API Key。"
    if "429" in normalized or "too many requests" in normalized or "rate limit" in normalized:
        return "模型服务繁忙：请求受到频率限制，请稍后重试。"
    if any(code in normalized for code in ("500", "502", "503", "504")) or "internal server error" in normalized:
        return "模型服务暂时不可用：自动重试后仍未恢复，请稍后再试。"
    if "connection refused" in normalized or "name or service not known" in normalized:
        return "模型连接失败：当前无法连接模型服务。"
    concise = message if len(message) <= 240 else f"{message[:237]}..."
    return f"运行失败：{concise}"


class RuntimeEmitterMixin:
    def ensure_runtime_message(self, session_id: str, run_state: RunState) -> str:
        message_id = run_state.runtime_message_id or create_id("msg")
        created = run_state.runtime_created_at or now_ms()
        run_state.runtime_message_id = message_id
        run_state.runtime_created_at = created
        if run_state.runtime_speaker is None:
            run_state.runtime_speaker = dict(run_state.speaker)
        info = {
            "id": message_id,
            "role": "assistant",
            "agent": "python-agent-core",
            "kind": "runtime",
            "runID": run_state.run_id,
            "speaker": run_state.runtime_speaker,
            "orchestration": run_state.orchestration,
            "time": {"created": created},
        }
        self.store.upsert_message(session_id, info)
        self.emit_message(session_id, info)
        return message_id

    def emit_runtime_thinking(self, session_id: str, run_state: RunState, line: str, done: bool = False) -> None:
        message_id = self.ensure_runtime_message(session_id, run_state)
        created = run_state.runtime_created_at or now_ms()
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
        if done:
            self.finish_runtime_message(session_id, run_state)

    def finish_runtime_message(self, session_id: str, run_state: RunState, error: Any | None = None) -> None:
        if not run_state.runtime_message_id:
            return
        completed = now_ms()
        info = {
            "id": run_state.runtime_message_id,
            "role": "assistant",
            "agent": "python-agent-core",
            "kind": "runtime",
            "runID": run_state.run_id,
            "speaker": run_state.runtime_speaker,
            "orchestration": run_state.orchestration,
            "time": {
                "created": run_state.runtime_created_at or completed,
                "completed": completed,
            },
            "error": {"name": "AgentError", "message": str(error)} if error is not None else None,
        }
        self.store.upsert_message(session_id, info)
        self.emit_message(session_id, info)

    def begin_assistant_message(self, run_state: RunState, message: dict[str, Any]) -> str:
        message_id = create_id("msg")
        run_state.assistant_message_id = message_id
        run_state.assistant_created_at = message.get("timestamp") or now_ms()
        run_state.assistant_message_ids.append(message_id)
        return message_id

    def handle_agent_event(self, session_id: str, event: dict[str, Any], run_state: RunState) -> None:
        event_type = event.get("type")
        message = event.get("message") or {}
        if event_type == "message_end" and message.get("role") == "user":
            # Agent.prompt emits an internal actor/handoff task as a user-role
            # message. Persist the real user request prepared by the runtime
            # exactly once instead of copying that internal prompt.
            if run_state.context_user_message is not None and not run_state.context_user_persisted:
                self.store.append_context_message(
                    session_id,
                    run_state.context_user_message,
                    turn_id=run_state.run_id,
                )
                run_state.context_user_persisted = True
            return
        if event_type == "message_start" and message.get("role") == "assistant":
            self.begin_assistant_message(run_state, message)
            self.upsert_assistant(session_id, message, run_state, done=False)
            return
        if event_type == "message_update" and message.get("role") == "assistant":
            self.upsert_assistant(session_id, message, run_state, done=False)
            return
        if event_type == "message_end" and message.get("role") == "assistant":
            if not run_state.assistant_message_id:
                self.begin_assistant_message(run_state, message)
            self.upsert_assistant(session_id, message, run_state, done=True)
            has_tool_calls = any(block.get("type") == "toolCall" for block in (message.get("content") or []))
            failed = bool(message.get("errorMessage")) or message.get("stopReason") in {"error", "aborted"}
            if not has_tool_calls:
                run_state.final_assistant_message_id = run_state.assistant_message_id
            if message.get("errorMessage"):
                run_state.error_message = str(message.get("errorMessage"))
            if not failed:
                context_message = dict(message)
                if run_state.speaker:
                    context_message["contextSpeaker"] = dict(run_state.speaker)
                self.store.append_context_message(session_id, context_message, turn_id=run_state.run_id)
            return
        if event_type == "model_retry":
            attempt = int(event.get("attempt") or 1)
            max_attempts = int(event.get("maxAttempts") or attempt)
            delay_ms = int(event.get("delayMs") or 0)
            wait_text = f"，将在 {delay_ms / 1000:g} 秒后继续" if delay_ms > 0 else ""
            self.emit_runtime_thinking(
                session_id,
                run_state,
                f"模型连接暂时失败，正在自动重试（第 {attempt}/{max_attempts} 次）{wait_text}。",
            )
            return
        if event_type == "message_end" and message.get("role") == "toolResult":
            self.store.append_context_message(session_id, message, turn_id=run_state.run_id)
            return
        if event_type == "tool_execution_start":
            call_id = event.get("toolCallId")
            tool_name = event.get("toolName")
            run_state.seen_tool_calls.add(str(call_id))
            run_state.tool_names[str(call_id)] = str(tool_name)
            if run_state.assistant_message_id:
                run_state.tool_message_ids[str(call_id)] = run_state.assistant_message_id
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
        if event_type == "tool_execution_update":
            call_id = str(event.get("toolCallId"))
            tool_name = str(event.get("toolName") or run_state.tool_names.get(call_id) or "tool")
            started = run_state.tool_starts.get(call_id) or now_ms()
            body = text_from_tool_result(event.get("partialResult") or {})
            if run_state.assistant_message_id:
                self.emit_tool_part(
                    session_id,
                    run_state.assistant_message_id,
                    call_id,
                    tool_name,
                    {
                        "status": "running",
                        "input": run_state.tool_inputs.get(call_id),
                        "output": body,
                        "time": {"start": started},
                    },
                )
            return
        if event_type == "tool_execution_end":
            call_id = str(event.get("toolCallId"))
            tool_name = str(event.get("toolName"))
            started = run_state.tool_starts.get(call_id)
            body = text_from_tool_result(event.get("result") or {})
            error_info = event.get("error") if isinstance(event.get("error"), dict) else {}
            run_state.finished_tool_calls.add(call_id)
            self.emit_runtime_thinking(session_id, run_state, f"工具 {tool_name} {'执行失败' if event.get('isError') else '执行完成'}。")
            if run_state.assistant_message_id:
                state = (
                    {
                        "status": "error",
                        "input": run_state.tool_inputs.get(call_id),
                        "error": str(error_info.get("message") or body or "工具执行失败。"),
                        "errorCode": str(error_info.get("code") or "execution_error"),
                        "retryable": bool(error_info.get("retryable", False)),
                        "time": {"start": started, "end": now_ms()},
                    }
                    if event.get("isError")
                    else {"status": "completed", "input": run_state.tool_inputs.get(call_id), "output": body, "time": {"start": started, "end": now_ms()}}
                )
                self.emit_tool_part(session_id, run_state.assistant_message_id, call_id, tool_name, state)

    def upsert_assistant(self, session_id: str, message: dict[str, Any], run_state: RunState, done: bool) -> None:
        for block in message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                block["text"] = strip_current_speaker_prefix(
                    str(block.get("text") or ""),
                    run_state.speaker,
                )
                break
        message_id = run_state.assistant_message_id or create_id("msg")
        created = run_state.assistant_created_at or message.get("timestamp") or now_ms()
        run_state.assistant_message_id = message_id
        run_state.assistant_created_at = created
        has_tool_calls = any(block.get("type") == "toolCall" for block in (message.get("content") or []))
        info = {
            "id": message_id,
            "role": "assistant",
            "agent": "python-agent-core",
            "kind": "model",
            "runID": run_state.run_id,
            "phase": "tool" if has_tool_calls else "final" if done else "streaming",
            "final": bool(done and not has_tool_calls),
            "speaker": run_state.speaker,
            "orchestration": run_state.orchestration,
            "modelID": message.get("model"),
            "providerID": message.get("provider"),
            "time": {"created": created, "completed": now_ms() if done else None},
            "error": {"name": "AgentError", "message": message.get("errorMessage")} if message.get("errorMessage") else None,
        }
        self.store.upsert_message(session_id, info)
        self.emit_message(session_id, info)
        for index, block in enumerate(message.get("content") or []):
            if block.get("type") == "text":
                part_id = f"{message_id}_text_{index}"
                self.emit_text_part(
                    session_id,
                    run_state,
                    {
                        "id": part_id,
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
                        "id": f"{message_id}_reasoning_{index}",
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
                tool_call_id = str(block.get("id"))
                run_state.seen_tool_calls.add(tool_call_id)
                run_state.tool_names[tool_call_id] = str(block.get("name") or "tool")
                run_state.tool_message_ids[tool_call_id] = message_id
                run_state.tool_inputs[tool_call_id] = block.get("arguments")
                self.emit_tool_part(
                    session_id,
                    message_id,
                    tool_call_id,
                    block.get("name"),
                    {"status": "pending", "input": block.get("arguments"), "time": {"start": created}},
                )

    def fail_unfinished_tool_calls(
        self, session_id: str, run_state: RunState, error: Any, *, aborted: bool = False
    ) -> None:
        if not run_state.assistant_message_id and not run_state.tool_message_ids:
            return
        completed = now_ms()
        message = str(error) or "智能体运行已终止。"
        for call_id in run_state.seen_tool_calls - run_state.finished_tool_calls:
            message_id = run_state.tool_message_ids.get(call_id) or run_state.assistant_message_id
            if not message_id:
                continue
            run_state.finished_tool_calls.add(call_id)
            self.emit_tool_part(
                session_id,
                message_id,
                call_id,
                run_state.tool_names.get(call_id, "tool"),
                {
                    "status": "aborted" if aborted else "error",
                    "input": run_state.tool_inputs.get(call_id),
                    "error": message,
                    "time": {"start": run_state.tool_starts.get(call_id), "end": completed},
                },
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
        session["info"]["contextTokens"] = int(
            estimate_context_tokens(self.store.context_messages(session_id)).get("tokens") or 0
        )
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
