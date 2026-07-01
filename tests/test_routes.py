import unittest

from mon_agent_server.app import is_agent_api_route
from mon_agent_server.http_server import AgentRequestHandler


class RouteTest(unittest.TestCase):
    def test_api_route_detection(self):
        self.assertTrue(is_agent_api_route("/session"))
        self.assertTrue(is_agent_api_route("/session/abc/prompt"))
        self.assertTrue(is_agent_api_route("/memos/1/complete"))
        self.assertFalse(is_agent_api_route("/assets/index.js"))

    def test_strip_api_prefix(self):
        self.assertEqual(AgentRequestHandler.strip_api_prefix("/api/tools/status"), "/tools/status")
        self.assertEqual(AgentRequestHandler.strip_api_prefix("/api"), "/")
        self.assertEqual(AgentRequestHandler.strip_api_prefix("/events"), "/events")


if __name__ == "__main__":
    unittest.main()
