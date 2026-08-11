from __future__ import annotations

import asyncio
import copy
import json
import os
import shutil
from dataclasses import replace
from pathlib import Path
from typing import Any

from mon_agent_core import AgentTool

from ..connectors.catalog import ConnectorCatalog, ConnectorContractError, DEFAULT_CONNECTOR_CATALOG
from .context import MonToolContext
from .core_access import core_call, require_core_access
from .result import compact_text, text_result, tool_failure, truncate


def _connector_summary(row: dict[str, Any]) -> dict[str, Any]:
    """Return the bounded, model-facing connector management projection."""
    runtime = row.get("runtime") if isinstance(row.get("runtime"), dict) else {}
    raw_capabilities = runtime.get("capabilities") if isinstance(runtime.get("capabilities"), dict) else {}
    capabilities = {
        str(name): enabled
        for name, enabled in list(raw_capabilities.items())[:24]
        if isinstance(enabled, (str, int, float, bool)) or enabled is None
    }
    raw_instance = runtime.get("instance") if isinstance(runtime.get("instance"), dict) else {}
    instance = {
        key: raw_instance[key]
        for key in ("instance_id", "host", "game_port", "admin_port", "pid", "mode", "started_at")
        if key in raw_instance and raw_instance[key] not in (None, "")
    }
    last_error = compact_text(
        row.get("last_error") or row.get("error") or row.get("runtime_error") or "",
        600,
    )
    summary: dict[str, Any] = {
        "id": row.get("id"),
        "connector_key": row.get("connector_key"),
        "identity_key": row.get("identity_key"),
        "display_name": row.get("display_name"),
        "desired_state": row.get("desired_state"),
        "runtime_state": row.get("runtime_state"),
        "last_error": last_error,
        "capabilities": capabilities,
    }
    if instance:
        summary["instance"] = instance
    worker = runtime.get("worker") if isinstance(runtime.get("worker"), dict) else {}
    if worker:
        summary["worker"] = {
            key: worker[key]
            for key in ("pid", "connector_key", "connector_version", "revision", "isolated")
            if key in worker
        }
    return summary


def _validate_connector_action(
    catalog: ConnectorCatalog,
    connector_key: str,
    action: str,
    payload: dict[str, Any],
) -> None:
    try:
        catalog.validate_action(connector_key, action, payload)
    except ConnectorContractError as error:
        message = str(error)
        code = "connector_not_installed" if "未安装连接器类型" in message else "unsupported_action" if "不支持动作" in message else "invalid_arguments"
        raise tool_failure(code, message) from error


def _installed_action_contracts(catalog: ConnectorCatalog) -> tuple[list[str], dict[str, Any]]:
    """Build model hints from manifests without hard-coding connector types."""
    action_names: set[str] = set()
    merged_properties: dict[str, Any] = {}
    for connector_key in catalog.keys():
        try:
            manifest = catalog.load(connector_key)
        except ConnectorContractError:
            continue
        for action, schema in manifest.actions.items():
            action_names.add(action)
            properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
            for name, property_schema in properties.items():
                existing = merged_properties.get(name)
                if existing is None:
                    merged_properties[name] = copy.deepcopy(property_schema)
                    continue
                if existing == property_schema:
                    continue
                choices = existing.get("anyOf") if isinstance(existing, dict) else None
                if not isinstance(choices, list):
                    choices = [existing]
                if property_schema not in choices:
                    choices.append(copy.deepcopy(property_schema))
                merged_properties[name] = {"anyOf": choices}
    return sorted(action_names), merged_properties


def _visible_connector_result(label: str, result: dict[str, Any]) -> str:
    rendered = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    return truncate(f"{label}\n\n{rendered}", 24_000)


def _current_assistant_id(context: MonToolContext) -> int | str:
    current = (context.assistant or {}).get("id")
    if current in (None, ""):
        raise tool_failure("invalid_context", "当前运行没有绑定助手，无法使用连接器。")
    return current


def create_connector_tools(context: MonToolContext) -> list[AgentTool]:
    catalog = getattr(context.connector_manager, "catalog", None)
    if not isinstance(catalog, ConnectorCatalog):
        catalog = DEFAULT_CONNECTOR_CATALOG
    action_names, action_properties = _installed_action_contracts(catalog)
    installed_connector_keys = list(catalog.keys())
    try:
        openttd_queries = list(catalog.load("openttd").queries)
    except ConnectorContractError:
        openttd_queries = []
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
        summaries = [_connector_summary(row) for row in rows]
        for summary in summaries:
            try:
                manifest = catalog.load(str(summary.get("connector_key") or ""))
            except ConnectorContractError:
                continue
            summary["contract"] = {
                "version": manifest.version,
                "actions": sorted(manifest.actions),
                "action_schemas": copy.deepcopy(manifest.actions),
                "queries": list(manifest.queries),
                "revision": manifest.revision[:16],
                "hot_reload": True,
                "worker_isolated": True,
            }
        lines = [
            f"#{row.get('id')} {row.get('connector_key')}:{row.get('identity_key')} "
            f"目标={row.get('desired_state')} 运行={row.get('runtime_state')}"
            + (f" 最近错误={row.get('last_error')}" if row.get("last_error") else "")
            + (
                f" 能力={json.dumps(row.get('capabilities') or {}, ensure_ascii=False)}"
                if row.get("capabilities") else ""
            )
            for row in summaries
        ]
        return text_result(
            "连接器：\n" + ("\n".join(lines) if lines else "暂无。"),
            {"count": len(summaries), "connectors": summaries},
        )

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
        try:
            catalog.load(payload["connector_key"])
        except ConnectorContractError as error:
            raise tool_failure("connector_not_installed", str(error)) from error
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
        _validate_connector_action(catalog, str(connector.get("connector_key") or ""), action, payload)
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
        if query not in set(openttd_queries):
            raise tool_failure("unsupported_action", f"不支持的 OpenTTD 观察查询：{query or '(empty)'}。")
        command: dict[str, Any] = {"action": query}
        for name in ("x", "y", "limit", "company_id", "length"):
            if params.get(name) not in (None, ""):
                command[name] = int(params[name])
        if query == "inspect_tile" and ("x" not in command or "y" not in command):
            raise tool_failure("invalid_arguments", "inspect_tile 需要 x 和 y。")
        if query in {"get_company_assets", "list_road_engines"} and "company_id" not in command:
            raise tool_failure("invalid_arguments", f"{query} 需要 company_id。")
        if query == "get_state":
            # Route to the admin-port state (companies with economy/statistics, server,
            # instance) instead of the bridge's minimal get_state, so a single
            # "看状态" call returns the rich state instead of only date + names.
            result = await asyncio.to_thread(
                context.connector_manager.execute, token, connector, "refresh_state", {},
            )
        else:
            result = await asyncio.to_thread(
                context.connector_manager.execute, token, connector, "gameplay_command", {"command": command},
            )
        return text_result(_visible_connector_result(f"OpenTTD 查询 {query} 已完成，返回数据：", result), result)

    def _openttd_data_root() -> Path:
        return Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))) / "openttd"

    def _scan_newgrf(root: Path) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for base in ("newgrf", os.path.join("content_download", "newgrf")):
            folder = root / base
            if not folder.is_dir():
                continue
            for entry in sorted(folder.iterdir()):
                if entry.suffix.lower() != ".grf":
                    continue
                results.append({
                    "file": entry.name,
                    "size": entry.stat().st_size if entry.is_file() else 0,
                    "source": base,
                })
        return results

    async def newgrf_execute(_id: str, params: dict[str, Any], *_args: Any) -> dict[str, Any]:
        action = str(params.get("action") or "").strip()
        root = _openttd_data_root()
        if action == "list":
            installed = _scan_newgrf(root)
            lines = [f"{row['source']} / {row['file']}（{row['size']} 字节）" for row in installed]
            return text_result(
                "已安装 NewGRF（OpenTTD 数据目录：" + str(root) + "）：\n"
                + ("\n".join(lines) if lines else "暂无。"),
                {"data_root": str(root), "newgrfs": installed},
            )
        if action == "place":
            source = str(params.get("source") or "").strip()
            if not source:
                raise tool_failure("invalid_arguments", "openttd_newgrf place 需要 source（.grf 文件路径）。")
            source_path = Path(source).expanduser()
            if not source_path.is_file() or source_path.suffix.lower() != ".grf":
                raise tool_failure("invalid_arguments", f"源不是有效的 .grf 文件：{source_path}")
            target_dir = root / "newgrf"
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / source_path.name
            shutil.copy2(source_path, target)
            return text_result(
                f"已将 {source_path.name} 复制到 {target}。下次新建游戏时可在 NewGRF 设置里启用。",
                {"source": str(source_path), "target": str(target), "size": target.stat().st_size},
            )
        raise tool_failure("unsupported_action", f"openttd_newgrf 不支持动作 {action or '(empty)'}。")

    tools = [
        AgentTool("list_connectors", "查看连接器", "查看当前用户共享的外部连接器及其目标、运行状态。", {"type": "object", "properties": {}}, list_execute),
        AgentTool(
            "register_connector", "注册连接器", "为当前用户注册一个共享的连接器身份；凭据只填写后端凭据引用，不填写密钥。",
            {"type": "object", "properties": {
                "connector_key": {"type": "string", "enum": installed_connector_keys}, "identity_key": {"type": "string"},
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
                "query": {"type": "string", "enum": openttd_queries},
                "x": {"type": "integer", "minimum": 0}, "y": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "company_id": {"type": "integer", "minimum": 0},
                "length": {"type": "integer", "minimum": 6, "maximum": 40},
            }, "required": ["connector_id", "query"]}, query_openttd_execute,
        ),
        AgentTool(
            "openttd_newgrf", "管理 OpenTTD NewGRF 内容", "列出本地已安装的 OpenTTD NewGRF，或将 .grf 文件放置到内容目录供新建游戏使用。",
            {"type": "object", "properties": {
                "action": {"type": "string", "enum": ["list", "place"], "description": "list 列出已装 NewGRF；place 将 .grf 复制到内容目录。"},
                "source": {"type": "string", "description": "place 时的 .grf 源文件路径。"},
            }, "required": ["action"]}, newgrf_execute,
        ),
        AgentTool(
            "execute_connector_action", "执行连接器动作", "通过当前助手的已安装连接器执行动作。动作和 payload 的精确契约来自 list_connectors；字段名严格区分大小写。",
            {"type": "object", "properties": {
                "connector_id": {"type": "integer"},
                "action": {"type": "string", "enum": action_names, "description": "动作名称来自已安装连接器清单。"},
                "payload": {
                    "type": "object",
                    "description": "必须匹配所选连接器与 action 在 list_connectors.contract.action_schemas 中的 JSON Schema。",
                    "properties": action_properties,
                    "additionalProperties": True,
                },
            }, "required": ["connector_id", "action", "payload"]}, action_execute,
        ),
    ]
    # Connector responses are always JSON objects from Core/runtime. Declaring
    # this contract makes the data available to the model independently from
    # the human-readable rendering and rejects accidental text-only adapters.
    return [replace(tool, output_schema={"type": "object"}) for tool in tools]
