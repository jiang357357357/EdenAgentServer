from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError, ValidationError, best_match


CONNECTOR_ROOT = Path(__file__).resolve().parent
CONNECTOR_MANIFEST_ROOT = CONNECTOR_ROOT / "manifests"
CONNECTOR_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")


class ConnectorContractError(ValueError):
    """Raised when a connector manifest or action payload is invalid."""


@dataclass(frozen=True, slots=True)
class ConnectorManifest:
    key: str
    name: str
    description: str
    icon: str
    version: str
    adapter: str
    execute_requires_stream: bool
    actions: dict[str, dict[str, Any]]
    queries: dict[str, dict[str, Any]]
    events: dict[str, dict[str, Any]]
    watch_paths: tuple[Path, ...]
    revision: str
    manifest_path: Path

    def worker_payload(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "key": self.key,
            "version": self.version,
            "adapter": self.adapter,
            "revision": self.revision,
        }

    def public_payload(self) -> dict[str, Any]:
        capabilities: list[dict[str, Any]] = []
        for event_name, definition in self.events.items():
            capabilities.append({
                "id": event_name,
                "kind": "event",
                "direction": "input",
                "label": str(definition.get("title") or event_name),
                "description": str(definition.get("description") or ""),
                "schema": copy_json_object(definition.get("payloadSchema")),
            })
        for query_name, schema in self.queries.items():
            capability = {
                "id": query_name,
                "kind": "query",
                "direction": "output",
                "label": str(schema.get("title") or query_name),
                "description": str(schema.get("description") or ""),
                "schema": copy_json_object(schema),
            }
            invocation = schema.get("x-monagent-invocation")
            if isinstance(invocation, dict):
                capability["invocation"] = copy_json_object(invocation)
            capabilities.append(capability)
        for action_name, schema in self.actions.items():
            capabilities.append({
                "id": action_name,
                "kind": "action",
                "direction": "output",
                "label": str(schema.get("title") or action_name),
                "description": str(schema.get("description") or ""),
                "schema": copy_json_object(schema),
                "invocation": {"tool": "execute_connector_action", "action": action_name},
            })
        return {
            "key": self.key,
            "name": self.name,
            "description": self.description,
            "icon": self.icon,
            "version": self.version,
            "revision": self.revision[:16],
            "hot_reload": True,
            "worker_isolated": True,
            "capabilities": capabilities,
        }


def copy_json_object(value: Any) -> dict[str, Any]:
    # Manifest data already came from JSON, so this round-trip is a compact
    # defensive copy before handing it to HTTP/tool consumers.
    return json.loads(json.dumps(value if isinstance(value, dict) else {}, ensure_ascii=False))


def _require_object(value: Any, message: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConnectorContractError(message)
    return value


def _value_path(error: ValidationError) -> str:
    path = "payload"
    for item in error.absolute_path:
        path += f"[{item}]" if isinstance(item, int) else f".{item}"
    return path


def _contract_error(error: ValidationError) -> ConnectorContractError:
    path = _value_path(error)
    if error.validator == "required" and isinstance(error.instance, dict):
        required = error.validator_value if isinstance(error.validator_value, list) else []
        missing = next((str(name) for name in required if name not in error.instance), "字段")
        alternate = next(
            (
                str(name)
                for name in error.instance
                if str(name).replace("_", "").lower() == missing.replace("_", "").lower()
            ),
            "",
        )
        suffix = f"；字段名必须使用 snake_case（收到 {alternate}）" if alternate else ""
        return ConnectorContractError(f"{path}.{missing} 不能为空{suffix}。")
    if error.validator == "additionalProperties" and isinstance(error.instance, dict):
        properties = error.schema.get("properties") if isinstance(error.schema, dict) else {}
        extras = sorted(set(map(str, error.instance)) - set(properties or {}))
        return ConnectorContractError(f"{path} 包含不支持的字段：{', '.join(extras)}。")
    if error.validator == "enum":
        choices = error.validator_value if isinstance(error.validator_value, list) else []
        return ConnectorContractError(f"{path} 必须是以下值之一：{', '.join(map(str, choices))}。")
    if error.validator == "type":
        type_names = {
            "object": "对象",
            "array": "数组",
            "string": "字符串",
            "integer": "整数",
            "number": "数字",
            "boolean": "布尔值",
            "null": "空值",
        }
        expected = error.validator_value
        rendered = type_names.get(str(expected), str(expected))
        return ConnectorContractError(f"{path} 必须是{rendered}。")
    if error.validator == "minLength":
        return ConnectorContractError(f"{path} 不能为空。")
    if error.validator == "minItems":
        return ConnectorContractError(f"{path} 至少需要 {error.validator_value} 项。")
    if error.validator == "maxItems":
        return ConnectorContractError(f"{path} 最多允许 {error.validator_value} 项。")
    if error.validator in {"minimum", "exclusiveMinimum"}:
        return ConnectorContractError(f"{path} 不能小于 {error.validator_value}。")
    if error.validator in {"maximum", "exclusiveMaximum"}:
        return ConnectorContractError(f"{path} 不能大于 {error.validator_value}。")
    return ConnectorContractError(f"{path} 不符合连接器动作契约：{error.message}。")


class ConnectorCatalog:
    """Discovers trusted connector adapters from data manifests.

    The Agent Server imports only this generic catalog and the worker proxy.
    Adapter implementation modules are imported inside short-lived connector
    worker processes, which makes an implementation update reloadable without
    restarting the host server.
    """

    def __init__(
        self,
        manifest_root: str | Path = CONNECTOR_MANIFEST_ROOT,
        source_root: str | Path = CONNECTOR_ROOT,
    ) -> None:
        self.manifest_root = Path(manifest_root).resolve()
        self.source_root = Path(source_root).resolve()

    def keys(self) -> tuple[str, ...]:
        if not self.manifest_root.is_dir():
            return ()
        return tuple(sorted(path.stem for path in self.manifest_root.glob("*.json")))

    def load(self, connector_key: str) -> ConnectorManifest:
        key = str(connector_key or "").strip()
        if not CONNECTOR_KEY_PATTERN.fullmatch(key):
            raise ConnectorContractError(f"连接器类型名称无效：{key or '(empty)'}。")
        manifest_path = (self.manifest_root / f"{key}.json").resolve()
        if manifest_path.parent != self.manifest_root:
            raise ConnectorContractError(f"连接器清单越过清单目录：{key}。")
        try:
            raw_bytes = manifest_path.read_bytes()
            raw = json.loads(raw_bytes)
        except FileNotFoundError as error:
            raise ConnectorContractError(f"未安装连接器类型：{key}。") from error
        except (OSError, json.JSONDecodeError) as error:
            raise ConnectorContractError(f"连接器清单无效：{manifest_path}。") from error
        data = _require_object(raw, f"连接器清单必须是对象：{manifest_path}。")
        if data.get("schemaVersion") != 1 or data.get("key") != key:
            raise ConnectorContractError(f"连接器清单版本或 key 无效：{manifest_path}。")
        adapter = str(data.get("adapter") or "").strip()
        if ":" not in adapter or any(not part.strip() for part in adapter.split(":", 1)):
            raise ConnectorContractError(f"连接器清单 adapter 必须是 module:Class：{key}。")
        actions_raw = _require_object(data.get("actions", {}), f"连接器 actions 必须是对象：{key}。")
        actions: dict[str, dict[str, Any]] = {}
        for name, schema in actions_raw.items():
            if not CONNECTOR_KEY_PATTERN.fullmatch(str(name)):
                raise ConnectorContractError(f"连接器动作名称无效：{name}。")
            contract = _require_object(schema, f"连接器动作契约必须是对象：{key}.{name}。")
            if contract.get("type") != "object":
                raise ConnectorContractError(f"连接器动作契约根节点必须是 object：{key}.{name}。")
            try:
                Draft202012Validator.check_schema(contract)
            except SchemaError as error:
                raise ConnectorContractError(f"连接器动作 JSON Schema 无效：{key}.{name}：{error.message}。") from error
            actions[str(name)] = contract
        queries_raw = data.get("queries", {})
        if isinstance(queries_raw, list):
            if not all(isinstance(item, str) for item in queries_raw):
                raise ConnectorContractError(f"连接器 queries 必须是对象或字符串数组：{key}。")
            queries_raw = {
                item: {"type": "object", "title": item, "properties": {}, "additionalProperties": True}
                for item in queries_raw
            }
        queries_object = _require_object(queries_raw, f"连接器 queries 必须是对象：{key}。")
        queries: dict[str, dict[str, Any]] = {}
        for name, schema in queries_object.items():
            if not CONNECTOR_KEY_PATTERN.fullmatch(str(name)):
                raise ConnectorContractError(f"连接器查询名称无效：{name}。")
            contract = _require_object(schema, f"连接器查询契约必须是对象：{key}.{name}。")
            if contract.get("type") != "object":
                raise ConnectorContractError(f"连接器查询契约根节点必须是 object：{key}.{name}。")
            try:
                Draft202012Validator.check_schema(contract)
            except SchemaError as error:
                raise ConnectorContractError(f"连接器查询 JSON Schema 无效：{key}.{name}：{error.message}。") from error
            queries[str(name)] = contract
        events_raw = _require_object(data.get("events", {}), f"连接器 events 必须是对象：{key}。")
        events: dict[str, dict[str, Any]] = {}
        for name, definition in events_raw.items():
            if not CONNECTOR_KEY_PATTERN.fullmatch(str(name)):
                raise ConnectorContractError(f"连接器事件名称无效：{name}。")
            event = _require_object(definition, f"连接器事件定义必须是对象：{key}.{name}。")
            payload_schema = event.get("payloadSchema")
            if payload_schema is not None:
                payload_contract = _require_object(payload_schema, f"连接器事件 payloadSchema 必须是对象：{key}.{name}。")
                try:
                    Draft202012Validator.check_schema(payload_contract)
                except SchemaError as error:
                    raise ConnectorContractError(f"连接器事件 JSON Schema 无效：{key}.{name}：{error.message}。") from error
            events[str(name)] = event
        watch_raw = data.get("watch") or []
        if not isinstance(watch_raw, list) or not all(isinstance(item, str) for item in watch_raw):
            raise ConnectorContractError(f"连接器 watch 必须是字符串数组：{key}。")
        watched: list[Path] = []
        digest = hashlib.sha256(raw_bytes)
        for relative in watch_raw:
            candidate = (self.source_root / relative).resolve()
            if candidate != self.source_root and self.source_root not in candidate.parents:
                raise ConnectorContractError(f"连接器监视路径越过源码目录：{relative}。")
            try:
                content = candidate.read_bytes()
            except OSError as error:
                raise ConnectorContractError(f"连接器监视文件不可读：{candidate}。") from error
            watched.append(candidate)
            digest.update(str(candidate.relative_to(self.source_root)).encode("utf-8"))
            digest.update(b"\0")
            digest.update(content)
        return ConnectorManifest(
            key=key,
            name=str(data.get("name") or key),
            description=str(data.get("description") or ""),
            icon=str(data.get("icon") or "cable"),
            version=str(data.get("version") or "1").strip() or "1",
            adapter=adapter,
            execute_requires_stream=bool(data.get("executeRequiresStream")),
            actions=actions,
            queries=queries,
            events=events,
            watch_paths=tuple(watched),
            revision=digest.hexdigest(),
            manifest_path=manifest_path,
        )

    def validate_action(self, connector_key: str, action: str, payload: dict[str, Any]) -> None:
        manifest = self.load(connector_key)
        schema = manifest.actions.get(action)
        if schema is None:
            raise ConnectorContractError(f"连接器 {connector_key} 不支持动作 {action or '(empty)'}。")
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
        error = best_match(validator.iter_errors(payload))
        if error is not None:
            raise _contract_error(error)

    def action_names(self) -> tuple[str, ...]:
        names: set[str] = set()
        for key in self.keys():
            try:
                names.update(self.load(key).actions)
            except ConnectorContractError:
                # A newly copied or currently edited manifest must not make
                # every built-in tool unavailable. Its running worker keeps
                # the previous revision until the manifest is valid again.
                continue
        return tuple(sorted(names))

    def public_catalog(self) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        entries: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        for key in self.keys():
            try:
                entries.append(self.load(key).public_payload())
            except ConnectorContractError as error:
                errors.append({"key": key, "error": str(error)})
        return entries, errors


DEFAULT_CONNECTOR_CATALOG = ConnectorCatalog()
