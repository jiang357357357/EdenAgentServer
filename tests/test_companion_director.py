from __future__ import annotations

import unittest
from unittest.mock import patch

from mon_agent_server.runtime.companion import create_director_plan
from mon_agent_server.runtime.config import RuntimeModelConfig


PARTICIPANTS = [
    {"assistantID": 1, "assistantName": "伊芙", "characterName": "伊芙", "signature": "端正克制"},
    {"assistantID": 2, "assistantName": "莉莉安", "characterName": "莉莉安", "signature": "元气主动"},
]


class CompanionDirectorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.config = RuntimeModelConfig(
            {"id": "test", "provider": "openai", "input": ["text"]},
            "key",
            "openai/test",
            "core",
            {},
        )

    async def test_collective_request_selects_multiple_without_model_call(self) -> None:
        with patch("mon_agent_server.runtime.companion.call_openai_compatible") as call:
            plan = await create_director_plan(
                user_text="你们两个一起陪我聊聊吧",
                participants=PARTICIPANTS,
                director_config=self.config,
                policy={"maxSpeakersPerTurn": 2},
            )
        self.assertEqual([turn.assistant_id for turn in plan.turns], [1, 2])
        call.assert_not_called()

    async def test_direct_mention_only_selects_mentioned_assistant(self) -> None:
        plan = await create_director_plan(
            user_text="莉莉安，你怎么看？",
            participants=PARTICIPANTS,
            director_config=self.config,
        )
        self.assertEqual([turn.assistant_id for turn in plan.turns], [2])

    async def test_model_plan_is_validated_against_roster(self) -> None:
        response = {"choices": [{"message": {"content": '{"turns":[{"assistantID":2,"intent":"先安慰用户"},{"assistantID":99,"intent":"非法"}]}'}}]}
        with patch("mon_agent_server.runtime.companion.call_openai_compatible", return_value=response):
            plan = await create_director_plan(
                user_text="今天心情有点复杂",
                participants=PARTICIPANTS,
                director_config=self.config,
            )
        self.assertEqual(plan.source, "model")
        self.assertEqual([turn.assistant_id for turn in plan.turns], [2])


if __name__ == "__main__":
    unittest.main()
