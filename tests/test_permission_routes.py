from __future__ import annotations

import unittest

from mon_agent_server.http.routes.permissions import handle_permissions


class PermissionRouteTest(unittest.TestCase):
    def test_get_hydrates_persisted_mode(self) -> None:
        class App:
            def hydrate_permission_mode(self, token):
                self.loaded = token
                return {"mode": "full_access"}

        class Handler:
            headers = {"Authorization": "Token core-token"}
            app = App()

            def json_response(self, data, status=200):
                self.response = (data, status)

        handler = Handler()
        self.assertTrue(handle_permissions(handler, "/permission/mode", {}, "GET"))
        self.assertEqual(handler.app.loaded, "core-token")
        self.assertEqual(handler.response, ({"mode": "full_access"}, 200))

    def test_post_persists_before_returning_mode(self) -> None:
        class App:
            def persist_permission_mode(self, token, mode):
                self.saved = (token, mode)
                return {"mode": mode}

        class Handler:
            headers = {"Authorization": "Bearer core-token"}
            app = App()

            def read_json_body(self):
                return {"mode": "restricted"}

            def json_response(self, data, status=200):
                self.response = (data, status)

        handler = Handler()
        self.assertTrue(handle_permissions(handler, "/permission/mode", {}, "POST"))
        self.assertEqual(handler.app.saved, ("core-token", "restricted"))
        self.assertEqual(handler.response, ({"mode": "restricted"}, 200))


if __name__ == "__main__":
    unittest.main()
