import unittest
from http import HTTPStatus

from mon_agent_server.app import is_agent_api_route
from mon_agent_server.http.routes.model import _model_option
from mon_agent_server.http.routes.self_awake import handle_self_awake
from mon_agent_server.http.routes.sessions import handle_sessions
from mon_agent_server.http_server import AgentRequestHandler
from mon_agent_server.llm.models import core_model


class RouteTest(unittest.TestCase):
    def test_api_route_detection(self):
        self.assertTrue(is_agent_api_route("/session"))
        self.assertTrue(is_agent_api_route("/session/abc/prompt"))
        self.assertTrue(is_agent_api_route("/memos/1/complete"))
        self.assertTrue(is_agent_api_route("/screen-capture/cap_1/reply"))
        self.assertFalse(is_agent_api_route("/assets/index.js"))

    def test_strip_api_prefix(self):
        self.assertEqual(AgentRequestHandler.strip_api_prefix("/api/tools/status"), "/tools/status")
        self.assertEqual(AgentRequestHandler.strip_api_prefix("/api"), "/")
        self.assertEqual(AgentRequestHandler.strip_api_prefix("/events"), "/events")

    def test_internal_self_awake_rejects_non_monos_event(self):
        class Handler:
            headers = {}

            def read_json_body(self):
                return {"context": {"event": {"source": "monagent", "type": "startup"}}}

            def json_response(self, data, status=200):
                self.response = (data, status)

        handler = Handler()
        handled = handle_self_awake(handler, "/internal/self-awake/run", {}, "POST")

        self.assertTrue(handled)
        self.assertEqual(handler.response[1], HTTPStatus.FORBIDDEN)
        self.assertIn("只能由 MonOs", handler.response[0]["error"])

    def test_model_option_exposes_runtime_context_window(self):
        option = _model_option(
            {
                "id": 7,
                "vendor": "openai",
                "ai_name": "Test model",
                "ai_model": "gpt-test",
                "context_window": 128000,
            },
            7,
            {"openai": {"name": "OpenAI"}},
        )

        self.assertEqual(option["contextWindow"], 128000)

    def test_core_model_preserves_context_window_for_runtime_compaction(self):
        model, _api_key, _label, _source = core_model(
            {
                "aiEntity": {
                    "vendor": "openai",
                    "ai_model": "gpt-test",
                    "context_window": 128000,
                }
            }
        )

        self.assertEqual(model["contextWindow"], 128000)

    def test_compact_route_starts_manual_compaction(self):
        calls = []

        class Runtime:
            def compact_async(self, session_id, instructions, token):
                calls.append((session_id, instructions, token))

        class App:
            runtime = Runtime()

            def ensure_hydrated(self, token, session_id):
                calls.append(("hydrate", session_id, token))

        class Handler:
            headers = {"Authorization": "Bearer core-token"}
            app = App()

            def read_json_body(self):
                return {"instructions": "保留项目路径"}

            def json_response(self, data, status=200):
                self.response = (data, status)

        handler = Handler()
        handled = handle_sessions(handler, "/session/session%201/compact", {}, "POST")

        self.assertTrue(handled)
        self.assertEqual(calls[0], ("hydrate", "session 1", "core-token"))
        self.assertEqual(calls[1], ("session 1", "保留项目路径", "core-token"))
        self.assertEqual(handler.response, ({"accepted": True, "sessionID": "session 1"}, 202))


if __name__ == "__main__":
    unittest.main()
