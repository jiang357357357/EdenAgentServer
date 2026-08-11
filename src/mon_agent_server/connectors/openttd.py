from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import struct
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from .openttd_instance import OpenTTDInstance, default_instance_registry, load_active_instance


PublishEvent = Callable[[dict[str, Any]], Awaitable[None]]
ReportState = Callable[[str, str], Awaitable[None]]

ADMIN_JOIN = 0
ADMIN_QUIT = 1
ADMIN_UPDATE_FREQUENCY = 2
ADMIN_POLL = 3
ADMIN_CHAT = 4
ADMIN_RCON = 5
ADMIN_GAMESCRIPT = 6
ADMIN_PING = 7

SERVER_ERROR = 102
SERVER_PROTOCOL = 103
SERVER_WELCOME = 104
SERVER_NEWGAME = 105
SERVER_SHUTDOWN = 106
SERVER_DATE = 107
SERVER_COMPANY_NEW = 113
SERVER_COMPANY_INFO = 114
SERVER_COMPANY_UPDATE = 115
SERVER_COMPANY_REMOVE = 116
SERVER_COMPANY_ECONOMY = 117
SERVER_COMPANY_STATS = 118
SERVER_CHAT = 119
SERVER_RCON = 120
SERVER_CONSOLE = 121
SERVER_GAMESCRIPT = 124
SERVER_RCON_END = 125
SERVER_PONG = 126

UPDATE_DATE = 0
UPDATE_COMPANY_INFO = 2
UPDATE_COMPANY_ECONOMY = 3
UPDATE_COMPANY_STATS = 4
UPDATE_CHAT = 5
UPDATE_CONSOLE = 6
UPDATE_GAMESCRIPT = 9

FREQUENCY_DAILY = 1 << 1
FREQUENCY_QUARTERLY = 1 << 4
FREQUENCY_AUTOMATIC = 1 << 6

def openttd_password_environment(identity_key: str) -> str:
    identity = re.sub(r"[^A-Za-z0-9]+", "_", identity_key).strip("_").upper()
    if not identity:
        raise RuntimeError("OpenTTD identity_key 无效。")
    return f"MON_CONNECTOR_OPENTTD_{identity}"


def _cstring(value: str) -> bytes:
    return value.encode("utf-8") + b"\0"


def _packet(packet_type: int, payload: bytes = b"") -> bytes:
    size = 3 + len(payload)
    if size > 65535:
        raise ValueError("OpenTTD Admin Port 数据包过大。")
    return struct.pack("<HB", size, packet_type) + payload


@dataclass
class _Reader:
    data: bytes
    offset: int = 0

    def _take(self, size: int) -> bytes:
        end = self.offset + size
        if end > len(self.data):
            raise ValueError("OpenTTD Admin Port 数据包被截断。")
        value = self.data[self.offset:end]
        self.offset = end
        return value

    def u8(self) -> int:
        return self._take(1)[0]

    def u16(self) -> int:
        return struct.unpack("<H", self._take(2))[0]

    def u32(self) -> int:
        return struct.unpack("<I", self._take(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self._take(8))[0]

    def s64(self) -> int:
        return struct.unpack("<q", self._take(8))[0]

    def boolean(self) -> bool:
        return bool(self.u8())

    def string(self) -> str:
        end = self.data.find(b"\0", self.offset)
        if end < 0:
            raise ValueError("OpenTTD Admin Port 字符串没有结束符。")
        value = self.data[self.offset:end].decode("utf-8", errors="replace")
        self.offset = end + 1
        return value


class OpenTTDConnector:
    """OpenTTD 15 Admin Port adapter.

    This adapter intentionally exposes the official administrative protocol.
    Company construction commands are reserved for a separate gameplay bridge;
    they are not emulated through unstable GUI automation.
    """

    def __init__(
        self,
        connector: dict[str, Any],
        publish: PublishEvent,
        report_state: ReportState,
    ) -> None:
        self.connector = connector
        self.publish = publish
        self.report_state = report_state
        settings = connector.get("settings") if isinstance(connector.get("settings"), dict) else {}
        self.instance_registry = str(settings.get("instance_registry") or default_instance_registry())
        self.instance: OpenTTDInstance | None = None
        self.host = ""
        self.port = 0
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._write_lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()
        self._ready = asyncio.Event()
        self._companies: dict[int, dict[str, Any]] = {}
        self._server: dict[str, Any] = {}
        self._date: int | None = None
        self._sequence = 0
        self._bridge_ready = False
        self._bridge_probe_id = ""
        self._bridge_version: int | None = None
        self._state_version = 0
        self._state_waiters: list[asyncio.Future[int]] = []
        self._gameplay_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}

    def _password(self) -> str:
        name = openttd_password_environment(str(self.connector.get("identity_key") or ""))
        password = os.environ.get(name, "").strip()
        if not password:
            raise RuntimeError(f"缺少 OpenTTD Admin Port 凭据：请在 Agent Server 环境配置 {name}。")
        return password

    async def _send(self, packet_type: int, payload: bytes = b"") -> None:
        if self._writer is None:
            raise RuntimeError("OpenTTD Admin Port 尚未连接。")
        async with self._write_lock:
            self._writer.write(_packet(packet_type, payload))
            await self._writer.drain()

    async def _read_packet(self) -> tuple[int, bytes]:
        if self._reader is None:
            raise RuntimeError("OpenTTD Admin Port 尚未连接。")
        header = await self._reader.readexactly(2)
        size = struct.unpack("<H", header)[0]
        if size < 3:
            raise RuntimeError(f"OpenTTD Admin Port 返回非法数据包长度：{size}。")
        body = await self._reader.readexactly(size - 2)
        return body[0], body[1:]

    async def _connect(self) -> None:
        async with self._connect_lock:
            if self._writer is not None and not self._writer.is_closing():
                return
            self.instance = load_active_instance(self.instance_registry)
            self.host = self.instance.host
            self.port = self.instance.admin_port
            self._reader, self._writer = await asyncio.open_connection(self.host, self.port)
            join = _cstring(self._password()) + _cstring("MonAgent") + _cstring("1")
            await self._send(ADMIN_JOIN, join)

    async def run(self) -> None:
        await self.report_state("connecting", "")
        await self._connect()
        authenticated = False
        while True:
            try:
                packet_type, payload = await asyncio.wait_for(self._read_packet(), timeout=30)
            except asyncio.TimeoutError:
                self._sequence += 1
                await self._send(ADMIN_PING, struct.pack("<I", self._sequence))
                continue
            if packet_type == SERVER_ERROR:
                code = _Reader(payload).u8() if payload else -1
                raise RuntimeError(f"OpenTTD Admin Port 拒绝连接或命令，错误码 {code}。")
            if packet_type == SERVER_PROTOCOL:
                authenticated = True
                self._ready.set()
                await self.report_state("online", "")
                await self._subscribe(payload)
                continue
            if not authenticated:
                continue
            event = self._decode(packet_type, payload)
            if event is not None:
                if event[0] == "openttd.new_game":
                    # A fresh game starts a fresh GameScript bridge; reset capability
                    # state and re-probe so we never dispatch to a stale bridge.
                    self._bridge_ready = False
                    await self._probe_gameplay_bridge()
                if self._is_actionable_event(event[0], event[1]):
                    await self._publish(event[0], event[1])

    @staticmethod
    def _is_actionable_event(event_type: str, payload: dict[str, Any]) -> bool:
        if event_type in {"openttd.chat", "openttd.new_game", "openttd.shutdown", "openttd.company_removed"}:
            return True
        if event_type != "openttd.gamescript":
            return False
        message = payload.get("message")
        return not (
            isinstance(message, dict)
            and message.get("type") in {"bridge_ready", "command_result", "heartbeat", "state"}
        )

    async def _subscribe(self, payload: bytes) -> None:
        reader = _Reader(payload)
        protocol_version = reader.u8()
        supported: dict[int, int] = {}
        while reader.offset < len(payload) and reader.boolean():
            update_type = reader.u16()
            frequencies = reader.u16()
            supported[update_type] = frequencies
        self._server["admin_protocol_version"] = protocol_version
        subscriptions = {
            UPDATE_DATE: FREQUENCY_DAILY,
            UPDATE_COMPANY_INFO: FREQUENCY_AUTOMATIC,
            UPDATE_COMPANY_ECONOMY: FREQUENCY_QUARTERLY,
            UPDATE_COMPANY_STATS: FREQUENCY_QUARTERLY,
            UPDATE_CHAT: FREQUENCY_AUTOMATIC,
            UPDATE_CONSOLE: FREQUENCY_AUTOMATIC,
            UPDATE_GAMESCRIPT: FREQUENCY_AUTOMATIC,
        }
        for update_type, preferred in subscriptions.items():
            frequencies = supported.get(update_type, 0)
            selected = preferred if frequencies & preferred else 0
            if selected:
                await self._send(ADMIN_UPDATE_FREQUENCY, struct.pack("<HH", update_type, selected))
        await self._poll_state()
        await self._probe_gameplay_bridge()

    async def _probe_gameplay_bridge(self) -> None:
        """Actively negotiate gameplay support after every Admin connection.

        MonAgentBridge announces itself when a game starts, but a connector may
        attach later and miss that one-shot message. A ping makes capability
        discovery deterministic instead of depending on event timing.
        """
        self._bridge_ready = False
        self._bridge_probe_id = f"bridge-probe-{uuid.uuid4().hex}"
        command = {"action": "ping", "request_id": self._bridge_probe_id}
        await self._send(
            ADMIN_GAMESCRIPT,
            _cstring(json.dumps(command, ensure_ascii=False, separators=(",", ":"))),
        )

    def _signal_state_updated(self) -> None:
        self._state_version += 1
        version = self._state_version
        for waiter in list(self._state_waiters):
            if not waiter.done():
                waiter.set_result(version)
        self._state_waiters.clear()

    async def _await_state_updated(self, timeout: float = 2.0) -> None:
        """Wait until the admin port has delivered a fresh company-state update.

        refresh_state only *sends* poll packets; the responses arrive
        asynchronously through the read loop. Awaiting one update here prevents
        callers from reading stale cached state right after a poll.
        """
        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[int] = loop.create_future()
        self._state_waiters.append(waiter)
        try:
            await asyncio.wait_for(waiter, timeout=timeout)
        except asyncio.TimeoutError:
            return
        finally:
            if waiter in self._state_waiters:
                self._state_waiters.remove(waiter)

    async def _poll_state(self) -> None:
        for update_type, target in (
            (UPDATE_DATE, 0),
            (UPDATE_COMPANY_INFO, 0xFFFFFFFF),
            (UPDATE_COMPANY_ECONOMY, 0),
            (UPDATE_COMPANY_STATS, 0),
        ):
            await self._send(ADMIN_POLL, struct.pack("<BI", update_type, target))

    def _decode(self, packet_type: int, payload: bytes) -> tuple[str, dict[str, Any]] | None:
        reader = _Reader(payload)
        if packet_type == SERVER_WELCOME:
            self._server.update({
                "name": reader.string(),
                "revision": reader.string(),
                "dedicated": reader.boolean(),
                "map_name": reader.string(),
                "generation_seed": reader.u32(),
                "landscape": reader.u8(),
                "start_date": reader.u32(),
                "map_width": reader.u16(),
                "map_height": reader.u16(),
            })
            self._server["start_year"] = self._server["start_date"] // 365
            return "openttd.server_state", self._state_payload("welcome")
        if packet_type == SERVER_DATE:
            self._date = reader.u32()
            return "openttd.date", self._state_payload("date")
        if packet_type in {SERVER_COMPANY_INFO, SERVER_COMPANY_UPDATE}:
            company_id = reader.u8()
            company = self._companies.setdefault(company_id, {"company_id": company_id})
            company.update({
                "name": reader.string(),
                "president": reader.string(),
                "colour": reader.u8(),
                "passworded": reader.boolean(),
            })
            if packet_type == SERVER_COMPANY_INFO:
                company.update({
                    "inaugurated_year": reader.u32(),
                    "is_ai": reader.boolean(),
                })
            company["quarters_bankrupt"] = reader.u8()
            self._signal_state_updated()
            return "openttd.company", self._state_payload("company")
        if packet_type == SERVER_COMPANY_NEW:
            company_id = reader.u8()
            self._companies.setdefault(company_id, {"company_id": company_id})
            return "openttd.company", self._state_payload("company_new")
        if packet_type == SERVER_COMPANY_REMOVE:
            company_id, reason = reader.u8(), reader.u8()
            removed = self._companies.pop(company_id, {"company_id": company_id})
            return "openttd.company_removed", {"company": removed, "reason": reason, **self._state_payload("company_removed")}
        if packet_type == SERVER_COMPANY_ECONOMY:
            company_id = reader.u8()
            company = self._companies.setdefault(company_id, {"company_id": company_id})
            company["economy"] = {
                "money": reader.s64(),
                "loan": reader.s64(),
                "income": reader.s64(),
                "delivered_cargo": reader.u16(),
                "quarters": [
                    {"company_value": reader.s64(), "performance": reader.u16(), "delivered_cargo": reader.u16()}
                    for _ in range(2)
                ],
            }
            self._signal_state_updated()
            return "openttd.economy", self._state_payload("economy")
        if packet_type == SERVER_COMPANY_STATS:
            company_id = reader.u8()
            company = self._companies.setdefault(company_id, {"company_id": company_id})
            company["statistics"] = {
                "vehicles": dict(zip(("train", "lorry", "bus", "aircraft", "ship"), (reader.u16() for _ in range(5)))),
                "stations": dict(zip(("train", "lorry", "bus", "aircraft", "ship"), (reader.u16() for _ in range(5)))),
            }
            self._signal_state_updated()
            return "openttd.statistics", self._state_payload("statistics")
        if packet_type == SERVER_CHAT:
            return "openttd.chat", {
                "action": reader.u8(), "destination_type": reader.u8(), "client_id": reader.u32(),
                "message": reader.string(), "data": reader.u64(),
            }
        if packet_type == SERVER_CONSOLE:
            return "openttd.console", {"origin": reader.string(), "message": reader.string()}
        if packet_type == SERVER_GAMESCRIPT:
            raw = reader.string()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                message = raw
            if isinstance(message, dict):
                if message.get("type") in {"bridge_ready", "command_result"}:
                    self._bridge_ready = True
                if "bridge_version" in message:
                    try:
                        self._bridge_version = int(message.get("bridge_version"))
                    except (TypeError, ValueError):
                        pass
                request_id = str(message.get("request_id") or "")
                if request_id == self._bridge_probe_id:
                    self._bridge_probe_id = ""
                waiter = self._gameplay_waiters.get(request_id)
                if waiter is not None and not waiter.done():
                    waiter.set_result(message)
            return "openttd.gamescript", {"message": message}
        if packet_type == SERVER_NEWGAME:
            self._companies.clear()
            self._date = None
            return "openttd.new_game", self._state_payload("new_game")
        if packet_type == SERVER_SHUTDOWN:
            return "openttd.shutdown", self._state_payload("shutdown")
        if packet_type == SERVER_RCON:
            return "openttd.rcon", {"colour": reader.u16(), "message": reader.string()}
        if packet_type in {SERVER_RCON_END, SERVER_PONG}:
            return None
        return None

    def _state_payload(self, cause: str) -> dict[str, Any]:
        return {
            "cause": cause,
            "instance": {
                "instance_id": self.instance.instance_id,
                "host": self.instance.host,
                "game_port": self.instance.game_port,
                "admin_port": self.instance.admin_port,
                "pid": self.instance.pid,
                "mode": self.instance.mode,
                "started_at": self.instance.started_at,
            } if self.instance else None,
            "date": self._date,
            "year": (self._date // 365) if self._date is not None else None,
            "server": dict(self._server),
            "companies": [dict(value) for _, value in sorted(self._companies.items())],
            "capabilities": {
                "observe_admin_state": True,
                "server_management": True,
                "company_gameplay": self._bridge_ready,
                "gameplay_bridge_ready": self._bridge_ready,
                "bridge_version": self._bridge_version,
            },
        }

    def runtime_snapshot(self) -> dict[str, Any]:
        return self._state_payload("runtime_snapshot")

    async def _publish(self, event_type: str, payload: dict[str, Any]) -> None:
        self._sequence += 1
        digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
        await self.publish({
            "external_event_id": f"openttd:{self._sequence}:{digest}",
            "event_type": event_type,
            "payload": payload,
        })

    async def execute(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        await self._connect()
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=10)
        except asyncio.TimeoutError as error:
            raise RuntimeError("OpenTTD Admin Port 认证尚未完成，暂时不能执行动作。") from error
        if action == "refresh_state":
            await self._poll_state()
            await self._await_state_updated()
        elif action == "pause_game":
            await self._send(ADMIN_RCON, _cstring("pause"))
        elif action == "resume_game":
            await self._send(ADMIN_RCON, _cstring("unpause"))
        elif action == "save_game":
            name = str(payload.get("save_name") or "monagent").strip()
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", name):
                raise RuntimeError("save_name 只能包含字母、数字、点、下划线和连字符，且不超过 64 个字符。")
            await self._send(ADMIN_RCON, _cstring(f"save {name}"))
        elif action == "send_chat":
            message = str(payload.get("text") or "").strip()
            if not message:
                raise RuntimeError("send_chat 需要 payload.text。")
            body = struct.pack("<BBI", 2, 0, 0) + _cstring(message)
            await self._send(ADMIN_CHAT, body)
        elif action == "gameplay_command":
            command = payload.get("command")
            if not isinstance(command, dict) or not str(command.get("action") or "").strip():
                raise RuntimeError("gameplay_command 需要 payload.command，且 command.action 不能为空。")
            response = await self._execute_gameplay_command(command)
            return {"ok": bool(response.get("ok")), "action": action, "result": response}
        elif action == "gameplay_plan":
            commands = payload.get("commands")
            if not isinstance(commands, list) or not commands:
                raise RuntimeError("gameplay_plan 需要非空 payload.commands。")
            if len(commands) > 50:
                raise RuntimeError("单个 OpenTTD 计划最多包含 50 个步骤。")
            results: list[dict[str, Any]] = []
            for index, command in enumerate(commands):
                if not isinstance(command, dict):
                    raise RuntimeError(f"OpenTTD 计划第 {index + 1} 步不是对象。")
                response = await self._execute_gameplay_command(command)
                results.append({"index": index, "command": command, "result": response})
                if not response.get("ok"):
                    return {"ok": False, "action": action, "failed_at": index, "results": results}
            return {"ok": True, "action": action, "results": results}
        else:
            raise RuntimeError(f"OpenTTD 连接器不支持动作 {action}。")
        return {"ok": True, "action": action, "state": self._state_payload("action")}

    async def _execute_gameplay_command(self, command: dict[str, Any]) -> dict[str, Any]:
        if not str(command.get("action") or "").strip():
            raise RuntimeError("OpenTTD gameplay command.action 不能为空。")
        request_id = uuid.uuid4().hex
        command = dict(command)
        command["request_id"] = request_id
        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._gameplay_waiters[request_id] = waiter
        try:
            await self._send(ADMIN_GAMESCRIPT, _cstring(json.dumps(command, ensure_ascii=False, separators=(",", ":"))))
            try:
                return await asyncio.wait_for(waiter, timeout=10)
            except asyncio.TimeoutError as error:
                raise RuntimeError("OpenTTD GameScript bridge 未响应；请确认新游戏已加载 MonAgentBridge。") from error
        finally:
            self._gameplay_waiters.pop(request_id, None)

    async def close(self) -> None:
        writer, self._writer = self._writer, None
        self._reader = None
        self._ready.clear()
        self._bridge_ready = False
        self._bridge_probe_id = ""
        for waiter in self._gameplay_waiters.values():
            if not waiter.done():
                waiter.set_exception(RuntimeError("OpenTTD 连接已关闭。"))
        self._gameplay_waiters.clear()
        if writer is not None:
            try:
                writer.write(_packet(ADMIN_QUIT))
                await writer.drain()
            except (ConnectionError, OSError):
                pass
            writer.close()
            await writer.wait_closed()
