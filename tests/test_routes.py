import unittest
from http import HTTPStatus

from mon_agent_server.app import is_agent_api_route
from mon_agent_server.http.routes.self_awake import handle_self_awake
from mon_agent_server.http_server import AgentRequestHandler


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


if __name__ == "__main__":
    unittest.main()
