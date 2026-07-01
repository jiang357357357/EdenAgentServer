import unittest

from mon_agent_server.store import SessionStore


class StoreTest(unittest.TestCase):
    def test_session_store_creates_and_appends_messages(self):
        store = SessionStore()
        session = store.create_session("")
        message = store.append_user_message(
            session["id"],
            "你好，MonAgent",
            [{"url": "data:text/plain,hello", "mime": "text/plain", "filename": "hello.txt"}],
        )

        self.assertEqual(session["title"], "你好，MonAgent")
        self.assertEqual(message["info"]["role"], "user")
        self.assertEqual(len(message["parts"]), 2)
        self.assertEqual(store.list_messages(session["id"], 10)[0]["info"]["id"], message["info"]["id"])

    def test_session_store_hydrates_agent_messages(self):
        store = SessionStore()
        session = store.create_session("")
        store.hydrate_messages(
            session["id"],
            [
                {
                    "info": {"id": "msg_1", "role": "user", "time": {"created": 1, "completed": 1}},
                    "parts": [
                        {"id": "part_1", "messageID": "msg_1", "sessionID": session["id"], "type": "text", "text": "第一条"}
                    ],
                }
            ],
        )

        stored = store.require_session(session["id"])
        self.assertEqual(stored["info"]["title"], "第一条")
        self.assertEqual(stored["agentMessages"][0]["role"], "user")


if __name__ == "__main__":
    unittest.main()
