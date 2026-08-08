from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from typing import Any, Awaitable, Callable

import chess
import httpx


PublishEvent = Callable[[dict[str, Any]], Awaitable[None]]
ReportState = Callable[[str, str], Awaitable[None]]


def lichess_token_environment(identity_key: str) -> str:
    identity = re.sub(r"[^A-Za-z0-9]+", "_", identity_key).strip("_").upper()
    if not identity:
        raise RuntimeError("Lichess identity_key 无效。")
    return f"MON_CONNECTOR_LICHESS_{identity}"


class LichessConnector:
    base_url = "https://lichess.org"

    def __init__(
        self,
        connector: dict[str, Any],
        publish: PublishEvent,
        report_state: ReportState,
        *,
        client: httpx.AsyncClient | None = None,
        base_url: str | None = None,
    ) -> None:
        self.connector = connector
        self.publish = publish
        self.report_state = report_state
        self._client = client
        self._owns_client = client is None
        self._game_tasks: dict[str, asyncio.Task[None]] = {}
        self._game_contexts: dict[str, dict[str, Any]] = {}
        if base_url is not None:
            self.base_url = base_url.rstrip("/")

    def _token(self) -> str:
        name = lichess_token_environment(str(self.connector.get("identity_key") or ""))
        token = os.environ.get(name, "").strip()
        if not token:
            raise RuntimeError(f"缺少 Lichess 凭据：请在 Agent Server 环境配置 {name}。")
        return token

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={"Authorization": f"Bearer {self._token()}", "Accept": "application/x-ndjson"},
                timeout=httpx.Timeout(30.0, read=None),
            )
        return self._client

    @staticmethod
    def _event_id(prefix: str, payload: dict[str, Any]) -> str:
        direct = payload.get("id")
        if isinstance(direct, str) and direct:
            return f"{prefix}:{direct}"
        digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:32]
        return f"{prefix}:{digest}"

    async def _publish(self, event_type: str, prefix: str, payload: dict[str, Any]) -> None:
        await self.publish({
            "external_event_id": self._event_id(prefix, payload),
            "event_type": event_type,
            "payload": payload,
        })

    async def run(self) -> None:
        client = await self._http()
        await self.report_state("connecting", "")
        try:
            async with client.stream("GET", "/api/stream/event") as response:
                response.raise_for_status()
                await self.report_state("online", "")
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    event_type = str(event.get("type") or "account_event")
                    await self._publish(f"lichess.{event_type}", "account", event)
                    if event_type == "gameStart":
                        game = event.get("game") if isinstance(event.get("game"), dict) else {}
                        game_id = str(game.get("id") or "")
                        if game_id and game_id not in self._game_tasks:
                            task = asyncio.create_task(self._stream_game(game_id))
                            self._game_tasks[game_id] = task
                            task.add_done_callback(lambda _task, key=game_id: self._game_tasks.pop(key, None))
        finally:
            tasks = list(self._game_tasks.values())
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self._game_tasks.clear()
            self._game_contexts.clear()

    async def _stream_game(self, game_id: str) -> None:
        client = await self._http()
        async with client.stream("GET", f"/api/bot/game/stream/{game_id}") as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                state = json.loads(line)
                if state.get("type") == "gameFull":
                    self._game_contexts[game_id] = state
                elif state.get("type") == "gameState":
                    previous = self._game_contexts.get(game_id, {})
                    self._game_contexts[game_id] = {**previous, "state": state}
                payload = {
                    "game_id": game_id,
                    "raw": state,
                    "position": self._normalized_position(game_id, state),
                }
                await self._publish("lichess.game_state", f"game:{game_id}", payload)

    def _normalized_position(self, game_id: str, latest: dict[str, Any]) -> dict[str, Any]:
        full = self._game_contexts.get(game_id, {})
        state = latest.get("state") if latest.get("type") == "gameFull" else latest
        if not isinstance(state, dict):
            state = full.get("state") if isinstance(full.get("state"), dict) else {}
        moves = [move for move in str(state.get("moves") or "").split() if move]
        initial_fen = str(full.get("initialFen") or "startpos")
        variant = full.get("variant") if isinstance(full.get("variant"), dict) else {}
        white = full.get("white") if isinstance(full.get("white"), dict) else {}
        black = full.get("black") if isinstance(full.get("black"), dict) else {}
        identity = str(self.connector.get("identity_key") or "").casefold()
        white_id = str(white.get("id") or white.get("name") or "")
        black_id = str(black.get("id") or black.get("name") or "")
        bot_color = "white" if white_id.casefold() == identity else "black" if black_id.casefold() == identity else None
        result: dict[str, Any] = {
            "game_id": game_id,
            "variant": variant.get("key") or variant.get("name") or "standard",
            "initial_fen": initial_fen,
            "moves_uci": moves,
            "ply": len(moves),
            "side_to_move": "white" if len(moves) % 2 == 0 else "black",
            "bot_color": bot_color,
            "is_bot_turn": bot_color == ("white" if len(moves) % 2 == 0 else "black"),
            "white": {"id": white_id, "rating": white.get("rating"), "title": white.get("title")},
            "black": {"id": black_id, "rating": black.get("rating"), "title": black.get("title")},
            "status": state.get("status") or "started",
            "winner": state.get("winner"),
            "white_time_ms": state.get("wtime"),
            "black_time_ms": state.get("btime"),
            "white_increment_ms": state.get("winc"),
            "black_increment_ms": state.get("binc"),
            "draw_offer_by_white": bool(state.get("wdraw")),
            "draw_offer_by_black": bool(state.get("bdraw")),
        }
        try:
            board = chess.Board() if initial_fen == "startpos" else chess.Board(initial_fen)
            for move in moves:
                board.push_uci(move)
            result.update({
                "fen": board.fen(),
                "legal_moves_uci": [move.uci() for move in board.legal_moves],
                "check": board.is_check(),
                "checkmate": board.is_checkmate(),
                "stalemate": board.is_stalemate(),
                "position_valid": board.is_valid(),
            })
        except (ValueError, AssertionError) as error:
            result.update({"position_valid": False, "position_error": str(error), "legal_moves_uci": []})
        return result

    async def execute(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        client = await self._http()
        game_id = str(payload.get("game_id") or "")
        challenge_id = str(payload.get("challenge_id") or "")
        if action == "accept_challenge" and challenge_id:
            path = f"/api/challenge/{challenge_id}/accept"
            data = {}
        elif action == "decline_challenge" and challenge_id:
            path = f"/api/challenge/{challenge_id}/decline"
            data = {"reason": str(payload.get("reason") or "generic")}
        elif action == "make_move" and game_id and payload.get("move"):
            path = f"/api/bot/game/{game_id}/move/{payload['move']}"
            data = {"offeringDraw": "true" if payload.get("offer_draw") else "false"}
        elif action == "resign" and game_id:
            path = f"/api/bot/game/{game_id}/resign"
            data = {}
        elif action == "offer_draw" and game_id:
            path = f"/api/bot/game/{game_id}/draw/yes"
            data = {}
        elif action == "send_chat" and game_id and payload.get("text"):
            path = f"/api/bot/game/{game_id}/chat"
            data = {"room": str(payload.get("room") or "player"), "text": str(payload["text"])}
        else:
            raise RuntimeError("Lichess 动作参数无效或动作不受支持。")
        response = await client.post(path, data=data)
        response.raise_for_status()
        if not response.content:
            return {"ok": True, "status": response.status_code}
        try:
            result = response.json()
        except ValueError:
            result = {"text": response.text}
        return {"ok": True, "status": response.status_code, "result": result}

    async def close(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
        self._client = None
