import asyncio
import json
import os
import unittest
from unittest.mock import patch

import httpx

from mon_agent_server.connectors.lichess import LichessConnector, lichess_token_environment


class LichessConnectorTest(unittest.IsolatedAsyncioTestCase):
    async def test_stream_normalizes_account_event(self):
        published = []
        states = []

        async def handler(request):
            self.assertEqual(request.headers["authorization"], "Bearer secret-token")
            self.assertEqual(request.url.path, "/api/stream/event")
            body = json.dumps({"type": "challenge", "challenge": {"id": "c1"}}) + "\n"
            return httpx.Response(200, text=body)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://lichess.org")
        connector = LichessConnector(
            {"identity_key": "kayoko"},
            lambda event: _append(published, event),
            lambda state, error="": _append(states, (state, error)),
            client=client,
        )
        with patch.dict(os.environ, {"MON_CONNECTOR_LICHESS_KAYOKO": "secret-token"}):
            # An injected client already owns auth in production; set it here to verify the request contract.
            client.headers["Authorization"] = "Bearer secret-token"
            await connector.run()
        self.assertEqual([item[0] for item in states], ["connecting", "online"])
        self.assertEqual(published[0]["event_type"], "lichess.challenge")
        self.assertEqual(published[0]["payload"]["challenge"]["id"], "c1")
        await client.aclose()

    async def test_execute_move_uses_bot_api(self):
        requests = []

        async def handler(request):
            requests.append(request)
            return httpx.Response(200, json={"ok": True})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://lichess.org")
        connector = LichessConnector({"identity_key": "kayoko"}, _noop, _state_noop, client=client)
        result = await connector.execute("make_move", {"game_id": "g1", "move": "e2e4"})
        self.assertTrue(result["ok"])
        self.assertEqual(requests[0].url.path, "/api/bot/game/g1/move/e2e4")
        await client.aclose()

    def test_identity_has_fixed_environment_namespace(self):
        self.assertEqual(lichess_token_environment("Kayoko-main"), "MON_CONNECTOR_LICHESS_KAYOKO_MAIN")

    def test_game_state_contains_fen_clocks_and_legal_moves(self):
        connector = LichessConnector({"identity_key": "kayoko"}, _noop, _state_noop)
        connector._game_contexts["g1"] = {
            "initialFen": "startpos",
            "variant": {"key": "standard"},
            "white": {"id": "kayoko", "rating": 1500},
            "black": {"id": "opponent", "rating": 1600},
            "state": {"moves": "e2e4 e7e5", "wtime": 59000, "btime": 58000, "status": "started"},
        }

        position = connector._normalized_position(
            "g1",
            {"type": "gameState", "moves": "e2e4 e7e5", "wtime": 59000, "btime": 58000, "status": "started"},
        )

        self.assertTrue(position["position_valid"])
        self.assertEqual(position["side_to_move"], "white")
        self.assertEqual(position["white_time_ms"], 59000)
        self.assertEqual(position["bot_color"], "white")
        self.assertTrue(position["is_bot_turn"])
        self.assertIn("g1f3", position["legal_moves_uci"])
        self.assertEqual(position["fen"].split()[1], "w")


async def _append(target, value):
    target.append(value)


async def _noop(_event):
    return None


async def _state_noop(_state, _error=""):
    return None
