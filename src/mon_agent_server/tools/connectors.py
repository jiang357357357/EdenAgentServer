from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from typing import Any

from mon_agent_core import AgentTool

from .context import MonToolContext
from .core_access import core_call, require_core_access
from .result import text_result, tool_failure, truncate


LICHESS_DECLINE_REASONS = (
    "generic",
    "later",
    "tooFast",
    "tooSlow",
    "timeControl",
    "rated",
    "casual",
    "standard",
    "variant",
    "noBot",
    "onlyBot",
)


def _validate_connector_action(connector_key: str, action: str, payload: dict[str, Any]) -> None:
    if connector_key == "openttd":
        if action not in {"refresh_state", "pause_game", "resume_game", "save_game", "send_chat", "gameplay_command", "gameplay_plan"}:
            raise tool_failure("unsupported_action",
                f"OpenTTD 连接器不支持动作 {action or '(empty)'}；"
                "支持刷新状态、服务器管理和经 MonAgentBridge 执行公司玩法命令。"
            )
        if action == "send_chat" and payload.get("text") in (None, ""):
            raise tool_failure("invalid_arguments", "连接器动作 send_chat 缺少 payload 字段：text。")
        if action == "gameplay_command":
            command = payload.get("command")
            if not isinstance(command, dict) or command.get("action") in (None, ""):
                raise tool_failure("invalid_arguments", "连接器动作 gameplay_command 缺少 payload.command.action。")
        if action == "gameplay_plan":
            commands = payload.get("commands")
            if not isinstance(commands, list) or not commands:
                raise tool_failure("invalid_arguments", "连接器动作 gameplay_plan 缺少非空 payload.commands。")
        return
    if connector_key != "lichess":
        raise tool_failure("connector_not_installed", f"未安装连接器类型：{connector_key}。")
    requirements = {
        "accept_challenge": ("challenge_id",),
        "decline_challenge": ("challenge_id",),
        "make_move": ("game_id", "move"),
        "resign": ("game_id",),
        "offer_draw": ("game_id",),
        "send_chat": ("game_id", "text"),
    }
    required = requirements.get(action)
    if required is None:
        raise tool_failure("unsupported_action", f"不支持的连接器动作：{action or '(empty)'}。")
    missing = [name for name in required if payload.get(name) in (None, "")]
    if missing:
        raise tool_failure("invalid_arguments",
            f"连接器动作 {action} 缺少 payload 字段：{', '.join(missing)}。"
            "字段名使用 snake_case；请按 execute_connector_action 的工具契约重新调用。"
        )
    if action == "decline_challenge":
        reason = str(payload.get("reason") or "generic")
        if reason not in LICHESS_DECLINE_REASONS:
            raise tool_failure("invalid_arguments",
                "decline_challenge 的 payload.reason 必须是 Lichess 原因代码："
                + ", ".join(LICHESS_DECLINE_REASONS)
                + "。"
            )


def _visible_connector_result(label: str, result: dict[str, Any]) -> str:
    rendered = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    return truncate(f"{label}\n\n{rendered}", 24_000)


def _current_assistant_id(context: MonToolContext) -> int | str:
    current = (context.assistant or {}).get("id")
    if current in (None, ""):
        raise tool_failure("invalid_context", "当前运行没有绑定助手，无法使用连接器。")
    return current


def create_connector_tools(context: MonToolContext) -> list[AgentTool]:
    active_event_leases: dict[int, str] = {}
    async def list_execute(_id: str, params: dict[str, Any], *_args: Any) -> dict[str, Any]:
        core, token = require_core_access(context)
        rows = await asyncio.to_thread(core_call, core.list_connectors, token)
        if context.connector_manager is not None:
            for row in rows:
                connector_id = row.get("id")
                if connector_id in (None, ""):
                    continue
                snapshot = await asyncio.to_thread(context.connector_manager.runtime_snapshot, int(connector_id))
                if snapshot:
                    row["runtime"] = snapshot
        lines = [
            f"#{row.get('id')} {row.get('connector_key')}:{row.get('identity_key')} "
            f"目标={row.get('desired_state')} 运行={row.get('runtime_state')}"
            + (
                f" 能力={json.dumps(row['runtime'].get('capabilities') or {}, ensure_ascii=False)}"
                if isinstance(row.get("runtime"), dict) else ""
            )
            for row in rows
        ]
        return text_result("连接器：\n" + ("\n".join(lines) if lines else "暂无。"), {"connectors": rows})

    async def register_execute(_id: str, params: dict[str, Any], *_args: Any) -> dict[str, Any]:
        core, token = require_core_access(context)
        payload = {
            "connector_key": str(params.get("connector_key") or "").strip(),
            "identity_key": str(params.get("identity_key") or "").strip(),
            "display_name": str(params.get("display_name") or "").strip(),
            "desired_state": "connected" if params.get("connect") else "disconnected",
            "settings": params.get("settings") if isinstance(params.get("settings"), dict) else {},
        }
        if not payload["connector_key"] or not payload["identity_key"]:
            raise tool_failure("invalid_arguments", "注册连接器需要 connector_key 和 identity_key。")
        row = await asyncio.to_thread(core_call, core.register_connector, token, payload)
        if context.connector_manager is not None:
            await asyncio.to_thread(context.connector_manager.reconcile_user, token)
        return text_result(
            f"已为当前用户注册共享连接器 #{row.get('id')} {row.get('connector_key')}:{row.get('identity_key')}。",
            {"connector": row},
        )

    async def state_execute(_id: str, params: dict[str, Any], *_args: Any) -> dict[str, Any]:
        core, token = require_core_access(context)
        connector_id = params.get("connector_id")
        if connector_id in (None, ""):
            raise tool_failure("invalid_arguments", "需要 connector_id。")
        owned = await asyncio.to_thread(core_call, core.list_connectors, token)
        if not any(str(row.get("id")) == str(connector_id) for row in owned):
            raise tool_failure("permission_denied", "该连接器不属于当前用户。")
        desired_state = str(params.get("desired_state") or "").strip()
        if desired_state not in {"connected", "disconnected"}:
            raise tool_failure("invalid_arguments", "desired_state 必须是 connected 或 disconnected。")
        row = await asyncio.to_thread(core_call, core.update_connector, token, connector_id, {"desired_state": desired_state})
        if context.connector_manager is not None:
            await asyncio.to_thread(context.connector_manager.reconcile_user, token)
        return text_result(f"连接器 #{connector_id} 目标状态已设为 {desired_state}。", {"connector": row})

    async def claim_execute(_id: str, params: dict[str, Any], *_args: Any) -> dict[str, Any]:
        core, token = require_core_access(context)
        assistant_id = _current_assistant_id(context)
        result = await asyncio.to_thread(
            core_call,
            core.claim_connector_events,
            token,
            {"assistant": assistant_id, "limit": int(params.get("limit") or 20), "lease_seconds": int(params.get("lease_seconds") or 120)},
        )
        events = result.get("events") if isinstance(result.get("events"), list) else []
        lease_id = str(result.get("lease_id") or "")
        for event in events:
            if event.get("id") not in (None, "") and lease_id:
                active_event_leases[int(event["id"])] = lease_id
        lines = [
            f"#{event.get('id')} [{event.get('connector_key')}:{event.get('event_type')}] "
            f"{json.dumps(event.get('payload') or {}, ensure_ascii=False)}"
            for event in events
        ]
        return text_result(
            f"租约 ID：{lease_id or '-'}\n已领取连接器事件：\n"
            + ("\n".join(lines) if lines else "当前没有待处理事件。"),
            result,
        )

    async def finish_execute(_id: str, params: dict[str, Any], *_args: Any) -> dict[str, Any]:
        core, token = require_core_access(context)
        _current_assistant_id(context)
        event_ids = [int(value) for value in (params.get("event_ids") or [])]
        lease_id = str(params.get("lease_id") or "").strip()
        if not lease_id and event_ids:
            inferred = {active_event_leases.get(event_id, "") for event_id in event_ids}
            inferred.discard("")
            if len(inferred) == 1:
                lease_id = inferred.pop()
        if not lease_id:
            raise tool_failure("invalid_arguments", "缺少租约 ID；请使用领取事件返回的租约，或在同一轮直接提交已领取的事件 ID 由运行时推断。")
        payload = {"event_ids": event_ids, "lease_id": lease_id}
        if params.get("retry"):
            payload["error"] = str(params.get("error") or "")
            result = await asyncio.to_thread(core_call, core.release_connector_events, token, payload)
            for event_id in event_ids:
                active_event_leases.pop(event_id, None)
            return text_result(f"已释放 {result.get('released', 0)} 条事件等待重试。", result)
        result = await asyncio.to_thread(core_call, core.complete_connector_events, token, payload)
        for event_id in event_ids:
            active_event_leases.pop(event_id, None)
        return text_result(f"已完成 {result.get('completed', 0)} 条事件。", result)

    async def action_execute(_id: str, params: dict[str, Any], *_args: Any) -> dict[str, Any]:
        core, token = require_core_access(context)
        _current_assistant_id(context)
        if context.connector_manager is None:
            raise tool_failure("capability_unavailable", "当前运行没有连接管理器。")
        connector_id = params.get("connector_id")
        owned = await asyncio.to_thread(core_call, core.list_connectors, token)
        connector = next((row for row in owned if str(row.get("id")) == str(connector_id)), None)
        if connector is None:
            raise tool_failure("permission_denied", "该连接器不属于当前用户。")
        action = str(params.get("action") or "").strip()
        payload = params.get("payload") if isinstance(params.get("payload"), dict) else {}
        _validate_connector_action(str(connector.get("connector_key") or ""), action, payload)
        result = await asyncio.to_thread(context.connector_manager.execute, token, connector, action, payload)
        return text_result(_visible_connector_result(f"连接器动作 {action} 已执行，返回结果：", result), result)

    async def query_openttd_execute(_id: str, params: dict[str, Any], *_args: Any) -> dict[str, Any]:
        core, token = require_core_access(context)
        _current_assistant_id(context)
        if context.connector_manager is None:
            raise tool_failure("capability_unavailable", "当前运行没有连接管理器。")
        connector_id = params.get("connector_id")
        owned = await asyncio.to_thread(core_call, core.list_connectors, token)
        connector = next((row for row in owned if str(row.get("id")) == str(connector_id)), None)
        if connector is None or connector.get("connector_key") != "openttd":
            raise tool_failure("permission_denied", "该 OpenTTD 连接器不属于当前用户。")
        query = str(params.get("query") or "").strip()
        if query not in {"get_state", "inspect_tile", "find_towns", "find_industries", "get_company_assets", "list_road_engines", "find_road_route_site"}:
            raise tool_failure("unsupported_action", f"不支持的 OpenTTD 观察查询：{query or '(empty)'}。")
        command: dict[str, Any] = {"action": query}
        for name in ("x", "y", "limit", "company_id", "length"):
            if params.get(name) not in (None, ""):
                command[name] = int(params[name])
        if query == "inspect_tile" and ("x" not in command or "y" not in command):
            raise tool_failure("invalid_arguments", "inspect_tile 需要 x 和 y。")
        if query in {"get_company_assets", "list_road_engines"} and "company_id" not in command:
            raise tool_failure("invalid_arguments", f"{query} 需要 company_id。")
        result = await asyncio.to_thread(
            context.connector_manager.execute, token, connector, "gameplay_command", {"command": command},
        )
        return text_result(_visible_connector_result(f"OpenTTD 查询 {query} 已完成，返回数据：", result), result)

    tools = [
        AgentTool("list_connectors", "查看连接器", "查看当前用户共享的外部连接器及其目标、运行状态。", {"type": "object", "properties": {}}, list_execute),
        AgentTool(
            "register_connector", "注册连接器", "为当前用户注册一个共享的连接器身份；凭据只填写后端凭据引用，不填写密钥。",
            {"type": "object", "properties": {
                "connector_key": {"type": "string"}, "identity_key": {"type": "string"},
                "display_name": {"type": "string"},
                "settings": {"type": "object"}, "connect": {"type": "boolean"},
            }, "required": ["connector_key", "identity_key"]}, register_execute,
        ),
        AgentTool(
            "set_connector_state", "连接或断开连接器", "设置当前助手连接器的持久目标状态；后端连接管理器负责实际连接与重连。",
            {"type": "object", "properties": {"connector_id": {"type": "integer"}, "desired_state": {"type": "string", "enum": ["connected", "disconnected"]}}, "required": ["connector_id", "desired_state"]}, state_execute,
        ),
        AgentTool(
            "claim_connector_events", "领取连接器事件", "一次领取当前助手事件池中的待处理信息。返回 lease_id；处理后必须完成或释放。",
            {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}, "lease_seconds": {"type": "integer", "minimum": 10, "maximum": 3600}}}, claim_execute,
        ),
        AgentTool(
            "finish_connector_events", "完成连接器事件", "处理成功时确认完成；处理失败时设置 retry=true 释放租约，事件会回到池中。",
            {"type": "object", "properties": {"event_ids": {"type": "array", "items": {"type": "integer"}}, "lease_id": {"type": "string", "description": "可省略；同一轮已领取事件时运行时会按 event_ids 推断。"}, "retry": {"type": "boolean"}, "error": {"type": "string"}}, "required": ["event_ids"]}, finish_execute,
        ),
        AgentTool(
            "query_openttd", "观察 OpenTTD", "只读查询 OpenTTD 的公司、地图格、附近城镇、产业和公司资产；不会改变游戏。",
            {"type": "object", "properties": {
                "connector_id": {"type": "integer"},
                "query": {"type": "string", "enum": ["get_state", "inspect_tile", "find_towns", "find_industries", "get_company_assets", "list_road_engines", "find_road_route_site"]},
                "x": {"type": "integer", "minimum": 0}, "y": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "company_id": {"type": "integer", "minimum": 0},
                "length": {"type": "integer", "minimum": 6, "maximum": 40},
            }, "required": ["connector_id", "query"]}, query_openttd_execute,
        ),
        AgentTool(
            "execute_connector_action", "执行连接器动作", "通过当前助手的 Lichess 或 OpenTTD 连接器执行一个动作。严格使用 payload 中声明的 snake_case 字段。",
            {"type": "object", "properties": {
                "connector_id": {"type": "integer"},
                "action": {"type": "string", "enum": [
                    "accept_challenge", "decline_challenge", "make_move", "resign", "offer_draw", "send_chat",
                    "refresh_state", "pause_game", "resume_game", "save_game",
                    "gameplay_command",
                    "gameplay_plan",
                ]},
                "payload": {
                    "type": "object",
                    "description": (
                        "动作参数：accept_challenge={challenge_id}；"
                        "decline_challenge={challenge_id, reason?}；"
                        "make_move={game_id, move, offer_draw?}；"
                        "send_chat 在 Lichess 使用 {game_id, text, room?}，在 OpenTTD 使用 {text}；"
                        "resign/offer_draw={game_id}；"
                        "OpenTTD refresh_state/pause_game/resume_game={}；save_game={save_name?}；"
                        "gameplay_command={command:{action,...}}；"
                        "gameplay_plan={commands:[{action,...},...]}，整套计划只触发一次工具授权并按顺序执行。"
                        "OpenTTD 变更命令包括 build_road、build_road_station、build_road_depot、buy_road_vehicle 和 build_hq_near。"
                    ),
                    "properties": {
                        "challenge_id": {"type": "string", "description": "接受或拒绝的 Lichess challenge ID。"},
                        "game_id": {"type": "string", "description": "棋局 ID。"},
                        "move": {"type": "string", "description": "UCI 格式走法，例如 e2e4。"},
                        "offer_draw": {"type": "boolean", "description": "走棋时同时提和。"},
                        "reason": {"type": "string", "enum": list(LICHESS_DECLINE_REASONS), "description": "拒绝挑战原因代码；默认 generic。"},
                        "text": {"type": "string", "description": "发送到棋局聊天室的文本。"},
                        "room": {"type": "string", "enum": ["player", "spectator"], "description": "聊天室；默认 player。"},
                        "save_name": {"type": "string", "description": "OpenTTD 存档名，只使用字母、数字、点、下划线和连字符。"},
                        "command": {"type": "object", "description": "发送给 MonAgentBridge 的结构化玩法命令。"},
                        "commands": {"type": "array", "items": {"type": "object"}, "description": "按顺序执行的 OpenTTD 玩法命令。"},
                    },
                    "additionalProperties": False,
                },
            }, "required": ["connector_id", "action", "payload"]}, action_execute,
        ),
    ]
    # Connector responses are always JSON objects from Core/runtime. Declaring
    # this contract makes the data available to the model independently from
    # the human-readable rendering and rejects accidental text-only adapters.
    return [replace(tool, output_schema={"type": "object"}) for tool in tools]
