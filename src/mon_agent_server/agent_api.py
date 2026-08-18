from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Callable, Iterable, Mapping
from contextlib import suppress
from copy import deepcopy
from dataclasses import dataclass, field, replace
from inspect import isawaitable
from threading import RLock
from time import time
from typing import Any, Generic, TypeVar


def now_ms() -> int:
    return int(time() * 1000)


@dataclass(slots=True)
class AgentTool:
    name: str
    label: str
    description: str
    parameters: Mapping[str, Any] = field(default_factory=dict)
    execute: Callable[..., Any] | None = None
    prepare_arguments: Callable[[Any], Any] | None = None
    execution_mode: str | None = None
    timeout_seconds: float | None = None
    source: str = "runtime"
    version: str = "1"
    capabilities: frozenset[str] = field(default_factory=frozenset)
    permission_resolver: Callable[[Any], dict[str, Any] | None] | None = None
    exposure: str = "direct"
    search_text: str | None = None
    output_schema: Mapping[str, Any] | None = None
    namespace: str = "general"

    async def run(
        self,
        tool_call_id: str,
        params: Any,
        signal: Any = None,
        on_update: Callable[..., Any] | None = None,
    ) -> dict[str, Any]:
        if self.execute is None:
            raise RuntimeError(f"Tool {self.name} has no executor")
        result = self.execute(tool_call_id, params, signal, on_update)
        return await result if isawaitable(result) else result

    def permission_request(self, params: Any) -> dict[str, Any] | None:
        return self.permission_resolver(params) if self.permission_resolver else None


class ToolExecutionError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.details = details


_TOOL_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
_TOOL_NAMESPACE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_SEARCH_STOP_TERMS = frozenset({
    "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "tool", "use",
    "一个", "一些", "以及", "使用", "信息", "关于", "可以", "工具", "当前", "怎么",
    "怎样", "我想", "我们", "所有", "查询", "相关", "这个", "进行", "需要",
})


def _search_terms(query: str) -> tuple[str, ...]:
    terms: list[str] = []
    for token in re.findall(r"[a-z0-9_-]+|[\u4e00-\u9fff]+", query.lower().strip()):
        if re.fullmatch(r"[\u4e00-\u9fff]+", token) and len(token) > 1:
            if len(token) > 2:
                terms.append(token)
            terms.extend(token[index:index + 2] for index in range(len(token) - 1))
        else:
            terms.append(token)
    return tuple(dict.fromkeys(
        term for term in terms
        if term and term not in _SEARCH_STOP_TERMS and (len(term) > 1 or term.isdigit())
    ))


class ToolRegistry:
    def __init__(self) -> None:
        self._lock = RLock()
        self._tools: dict[str, AgentTool] = {}
        self._revision = 0

    @property
    def revision(self) -> int:
        return self._revision

    def register(
        self,
        tool: AgentTool,
        *,
        source: str | None = None,
        strict_schema: bool = True,
        replace_existing: bool = False,
    ) -> AgentTool:
        schema = dict(tool.parameters)
        if schema.get("type") != "object":
            raise ValueError(f"Tool {tool.name} must declare an object JSON Schema")
        if strict_schema:
            schema.setdefault("additionalProperties", False)
        output_schema = dict(tool.output_schema) if tool.output_schema is not None else None
        if output_schema is not None and not isinstance(output_schema.get("type"), str):
            raise ValueError(f"Tool {tool.name} output schema must declare a JSON Schema type")
        if tool.exposure not in {"direct", "deferred", "hidden"}:
            raise ValueError(f"Tool {tool.name} has invalid exposure: {tool.exposure}")
        if not _TOOL_NAMESPACE.fullmatch(tool.namespace):
            raise ValueError(f"Tool {tool.name} has invalid namespace: {tool.namespace}")
        normalized = replace(tool, parameters=schema, output_schema=output_schema, source=source or tool.source)
        if not _TOOL_NAME.fullmatch(normalized.name):
            raise ValueError(f"Invalid tool name: {normalized.name or '(empty)'}")
        if not callable(normalized.execute):
            raise ValueError(f"Tool {normalized.name} has no executor")
        if normalized.timeout_seconds is not None and normalized.timeout_seconds <= 0:
            raise ValueError(f"Tool {normalized.name} timeout must be positive or None")
        with self._lock:
            if normalized.name in self._tools and not replace_existing:
                raise ValueError(f"Tool already registered: {normalized.name}")
            self._tools[normalized.name] = normalized
            self._revision += 1
        return normalized

    def register_many(self, tools: Iterable[AgentTool], **options: Any) -> tuple[AgentTool, ...]:
        return tuple(self.register(tool, **options) for tool in tools)

    def snapshot(self, names: Iterable[str] | None = None) -> tuple[AgentTool, ...]:
        with self._lock:
            if names is None:
                return tuple(self._tools.values())
            selected = set(names)
            return tuple(tool for name, tool in self._tools.items() if name in selected)

    def searchable_snapshot(self) -> tuple[AgentTool, ...]:
        return tuple(tool for tool in self.snapshot() if tool.exposure == "deferred")

    def reveal(self, names: Iterable[str]) -> tuple[AgentTool, ...]:
        selected = set(names)
        revealed = []
        with self._lock:
            for name, tool in self._tools.items():
                if name in selected and tool.exposure == "deferred":
                    tool.exposure = "direct"
                    revealed.append(tool)
            if revealed:
                self._revision += 1
        return tuple(revealed)

    def search(
        self,
        query: str,
        *,
        limit: int = 5,
        namespace: str | None = None,
        source: str | None = None,
    ) -> tuple[AgentTool, ...]:
        terms = _search_terms(query)
        if not terms:
            return ()
        scored: list[tuple[int, int, str, AgentTool]] = []
        for tool in self.searchable_snapshot():
            if namespace and tool.namespace != namespace or source and tool.source != source:
                continue
            name = tool.name.lower()
            spaced_name = name.replace("_", " ").replace("-", " ")
            namespace_text = tool.namespace.lower()
            label = tool.label.lower()
            description = tool.description.lower()
            search_text = (tool.search_text or "").lower()
            capabilities = " ".join(sorted(tool.capabilities)).lower()
            parameter_names = " ".join((tool.parameters.get("properties") or {}).keys()).lower()

            score = 0
            identity_matches = 0
            semantic_matches = 0
            for term in terms:
                if term == name or term == spaced_name:
                    score += 14
                    identity_matches += 1
                elif term in name or term in spaced_name:
                    score += 9
                    identity_matches += 1
                elif term in label:
                    score += 7
                    identity_matches += 1
                elif term in search_text or term in capabilities:
                    score += 5
                    semantic_matches += 1
                elif term in namespace_text:
                    score += 4
                    semantic_matches += 1
                elif term in description:
                    score += 2
                    semantic_matches += 1
                elif term in parameter_names:
                    score += 1
                    semantic_matches += 1

            # A tool identity hit is sufficient. Description-only results need
            # at least two independent query terms so generic words cannot fill
            # the result list merely because the caller requested a high limit.
            if identity_matches or semantic_matches >= 2:
                scored.append((score, identity_matches, tool.name, tool))
        scored.sort(key=lambda item: (-item[0], -item[1], item[2]))
        return tuple(item[3] for item in scored[:max(1, min(limit, 20))])

    def get(self, name: str) -> AgentTool | None:
        return self._tools.get(name)


T = TypeVar("T")
R = TypeVar("R")
_SENTINEL = object()


class EventStream(Generic[T, R]):
    def __init__(self, is_complete: Callable[[T], bool], extract_result: Callable[[T], R]) -> None:
        self._queue: asyncio.Queue[T | object] = asyncio.Queue()
        self._done = False
        self._is_complete = is_complete
        self._extract_result = extract_result
        self._final_result: asyncio.Future[R] = asyncio.get_event_loop().create_future()
        self._producer_task: asyncio.Task[Any] | None = None

    def attach_producer(self, task: asyncio.Task[Any]) -> None:
        self._producer_task = task

    async def aclose(self) -> None:
        task = self._producer_task
        if task is not None and not task.done() and task is not asyncio.current_task():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    def push(self, event: T) -> None:
        if self._done:
            return
        if self._is_complete(event):
            self._done = True
            if not self._final_result.done():
                self._final_result.set_result(self._extract_result(event))
        self._queue.put_nowait(event)

    def end(self, result: R | None = None) -> None:
        self._done = True
        if result is not None and not self._final_result.done():
            self._final_result.set_result(result)
        self._queue.put_nowait(_SENTINEL)

    async def __aiter__(self) -> AsyncIterator[T]:
        try:
            while True:
                event = await self._queue.get()
                if event is _SENTINEL:
                    return
                yield event  # type: ignore[misc]
                if self._done and self._queue.empty():
                    return
        finally:
            await self.aclose()

    async def result(self) -> R:
        return await self._final_result


class AssistantMessageEventStream(EventStream[dict[str, Any], dict[str, Any]]):
    def __init__(self) -> None:
        super().__init__(lambda event: event.get("type") in {"done", "error"}, self._extract)

    @staticmethod
    def _extract(event: dict[str, Any]) -> dict[str, Any]:
        if event.get("type") == "done":
            return event["message"]
        if event.get("type") == "error":
            return event["error"]
        raise RuntimeError("Unexpected event type for final result")


def text_tool_result(
    text: str,
    details: Any | None = None,
    terminate: bool | None = None,
    *,
    structured_content: Any | None = None,
    success: bool = True,
) -> dict[str, Any]:
    result = {"content": [{"type": "text", "text": text}], "details": {} if details is None else details, "success": success}
    if structured_content is not None:
        result["structuredContent"] = structured_content
    if terminate is not None:
        result["terminate"] = terminate
    return result


@dataclass(slots=True)
class Result:
    ok: bool
    value: Any = None
    error: Any = None


def ok(value: Any) -> Result:
    return Result(True, value=value)


def convert_to_llm(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    converted = []
    for message in messages:
        role = message.get("role")
        if role == "bashExecution":
            if message.get("excludeFromContext"):
                continue
            output = str(message.get("output") or "")
            text = f"Ran `{message.get('command', '')}`\n" + (f"```\n{output}\n```" if output else "(no output)")
            converted.append({"role": "user", "content": [{"type": "text", "text": text}], "timestamp": message.get("timestamp")})
        elif role == "custom":
            content = message.get("content", "")
            converted.append({"role": "user", "content": [{"type": "text", "text": content}] if isinstance(content, str) else content, "timestamp": message.get("timestamp")})
        elif role in {"branchSummary", "compactionSummary"}:
            label = "branch that this conversation came back from" if role == "branchSummary" else "conversation history before this point was compacted"
            text = f"The following is a summary of the {label}:\n\n<summary>\n{message.get('summary', '')}\n</summary>"
            converted.append({"role": "user", "content": [{"type": "text", "text": text}], "timestamp": message.get("timestamp")})
        elif role in {"user", "assistant", "toolResult"}:
            converted.append(message)
    return converted


def fork_messages(messages: list[dict[str, Any]], fork_turns: str | int | None = "none") -> list[dict[str, Any]]:
    if fork_turns in {None, "none", 0, "0"}:
        return []
    durable = []
    for message in messages:
        if message.get("role") not in {"system", "developer", "user", "assistant"}:
            continue
        content = message.get("content")
        if isinstance(content, list):
            content = [deepcopy(item) for item in content if isinstance(item, dict) and item.get("type") in {"text", "image"}]
        if content in (None, "", []):
            continue
        cloned = {key: deepcopy(value) for key, value in message.items() if key not in {"content", "thinking", "reasoning", "toolCalls", "tool_calls"}}
        cloned["content"] = content
        durable.append(cloned)
    if fork_turns == "all":
        return durable
    try:
        count = max(0, int(fork_turns))
    except (TypeError, ValueError) as error:
        raise ValueError("fork_turns must be 'none', 'all', or a non-negative integer") from error
    indexes = [index for index, message in enumerate(durable) if message.get("role") == "user"]
    return durable if len(indexes) <= count else durable[indexes[-count]:]
