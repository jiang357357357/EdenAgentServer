from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from mon_agent_server.runtime.companion import (
    DirectorBeat,
    DirectorExecution,
    DirectorScene,
    actor_task_prompt,
    create_director_plan,
)
from mon_agent_server.runtime.config import RuntimeModelConfig


PARTICIPANTS = [
    {"assistantID": 1, "assistantName": "伊芙", "characterName": "伊芙", "signature": "端正克制"},
    {"assistantID": 2, "assistantName": "莉莉安", "characterName": "莉莉安", "signature": "元气主动"},
    {"assistantID": 3, "assistantName": "雪音", "characterName": "雪音", "signature": "冷静敏锐"},
]


def director_response(
    beats: list[dict[str, object]],
    scene: dict[str, object] | None = None,
    execution: dict[str, object] | None = None,
) -> dict[str, object]:
    payload = {"beats": beats}
    if scene is not None:
        payload["scene"] = scene
    if execution is not None:
        payload["execution"] = execution
    return {"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]}


class CompanionDirectorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.config = RuntimeModelConfig(
            {"id": "test", "provider": "openai", "input": ["text"]},
            "key",
            "openai/test",
            "core",
            {},
        )

    async def create_model_plan(
        self,
        beats: list[dict[str, object]],
        *,
        policy: dict[str, object] | None = None,
        scene: dict[str, object] | None = None,
        execution: dict[str, object] | None = None,
    ):
        with patch(
            "mon_agent_server.runtime.companion.call_openai_compatible",
            return_value=director_response(beats, scene, execution),
        ):
            return await create_director_plan(
                user_text="请根据当前对话自然安排回应",
                participants=PARTICIPANTS,
                director_config=self.config,
                policy=policy,
            )

    async def test_director_returns_scene_and_execution_policy(self) -> None:
        plan = await self.create_model_plan(
            [
                {"assistantID": 3, "intent": "负责分析并实施", "speechAct": "respond"},
                {"assistantID": 1, "intent": "复核结果", "speechAct": "support", "replyToBeat": 0},
            ],
            scene={
                "domain": "coding",
                "interactionType": "task",
                "confidence": 0.94,
                "summary": "修复工作区代码",
            },
            execution={
                "mode": "lead_support",
                "leadAssistantID": 3,
                "toolOwnerAssistantID": 3,
                "observationStrategy": "independent",
            },
        )
        self.assertEqual(plan.scene.domain, "coding")
        self.assertEqual(plan.scene.interaction_type, "task")
        self.assertEqual(plan.scene.confidence, 0.94)
        self.assertEqual(plan.execution.mode, "lead_support")
        self.assertEqual(plan.execution.lead_assistant_id, 3)
        self.assertEqual(plan.execution.tool_owner_assistant_id, 3)
        self.assertEqual(plan.execution.observation_strategy, "independent")

    async def test_director_receives_recent_conversation_and_attachment_context(self) -> None:
        response = director_response([{"assistantID": 1, "intent": "继续处理"}])
        with patch(
            "mon_agent_server.runtime.companion.call_openai_compatible",
            return_value=response,
        ) as call:
            await create_director_plan(
                user_text="继续",
                participants=PARTICIPANTS,
                director_config=self.config,
                conversation_context="用户：请先检查项目\n伊芙：我已经找到入口文件。",
                attachment_context="用户上传了错误截图。",
            )
        request_context = call.call_args.args[1]
        payload = json.loads(request_context["messages"][0]["content"][0]["text"])
        self.assertIn("我已经找到入口文件", payload["recentConversation"])
        self.assertEqual(payload["userMessage"], "继续")
        self.assertIn("错误截图", payload["attachmentContext"])
        self.assertEqual(call.call_args.args[2]["thinking"], {"type": "disabled"})

    async def test_director_supports_one_two_one_sequence(self) -> None:
        plan = await self.create_model_plan(
            [
                {"assistantID": 1, "intent": "开启话题", "speechAct": "respond", "addressTo": "user"},
                {"assistantID": 2, "intent": "接住话题", "speechAct": "react", "replyToBeat": 0},
                {"assistantID": 1, "intent": "再次回应并收束", "speechAct": "close", "replyToBeat": 1},
            ]
        )
        self.assertEqual([beat.assistant_id for beat in plan.beats], [1, 2, 1])
        self.assertEqual(plan.beats[2].address_to, "assistant:2")
        self.assertEqual(plan.beats[2].reply_to_beat, 1)

    async def test_director_supports_two_one_sequence(self) -> None:
        plan = await self.create_model_plan(
            [
                {"assistantID": 2, "intent": "先回应"},
                {"assistantID": 1, "intent": "补充", "replyToBeat": 0},
            ]
        )
        self.assertEqual([beat.assistant_id for beat in plan.beats], [2, 1])

    async def test_director_supports_one_two_sequence(self) -> None:
        plan = await self.create_model_plan(
            [
                {"assistantID": 1, "intent": "先回应"},
                {"assistantID": 2, "intent": "补充", "replyToBeat": 0},
            ]
        )
        self.assertEqual([beat.assistant_id for beat in plan.beats], [1, 2])

    async def test_director_can_use_every_participant_without_fixed_pair(self) -> None:
        plan = await self.create_model_plan(
            [
                {"assistantID": 3, "intent": "观察"},
                {"assistantID": 1, "intent": "回应", "replyToBeat": 0},
                {"assistantID": 2, "intent": "补充", "replyToBeat": 1},
                {"assistantID": 3, "intent": "收束", "replyToBeat": 2},
            ],
            policy={"maxBeatsPerTurn": 4, "maxReturnsPerAssistant": 1},
        )
        self.assertEqual([beat.assistant_id for beat in plan.beats], [3, 1, 2, 3])

    async def test_validation_filters_unknown_consecutive_and_excess_return_beats(self) -> None:
        plan = await self.create_model_plan(
            [
                {"assistantID": 2, "intent": "先说"},
                {"assistantID": 2, "intent": "连续重复"},
                {"assistantID": 99, "intent": "不存在"},
                {"assistantID": 1, "intent": "补充"},
                {"assistantID": 2, "intent": "回场"},
                {"assistantID": 1, "intent": "超出节拍"},
            ],
            policy={"maxBeatsPerTurn": 3},
        )
        self.assertEqual([beat.assistant_id for beat in plan.beats], [2, 1, 2])

    async def test_zero_returns_policy_prevents_an_assistant_from_reappearing(self) -> None:
        plan = await self.create_model_plan(
            [
                {"assistantID": 1, "intent": "先说"},
                {"assistantID": 2, "intent": "补充"},
                {"assistantID": 1, "intent": "尝试回场"},
            ],
            policy={"maxReturnsPerAssistant": 0},
        )
        self.assertEqual([beat.assistant_id for beat in plan.beats], [1, 2])

    async def test_disabled_inter_assistant_replies_targets_user(self) -> None:
        plan = await self.create_model_plan(
            [
                {"assistantID": 1, "intent": "先说"},
                {"assistantID": 2, "intent": "补充", "addressTo": "assistant:1", "replyToBeat": 0},
            ],
            policy={"allowInterAssistantReplies": False},
        )
        self.assertEqual(plan.beats[1].address_to, "user")
        self.assertIsNone(plan.beats[1].reply_to_beat)

    async def test_model_failure_falls_back_to_data_derived_mentioned_assistant(self) -> None:
        with patch(
            "mon_agent_server.runtime.companion.call_openai_compatible",
            side_effect=RuntimeError("director unavailable"),
        ):
            plan = await create_director_plan(
                user_text="莉莉安，请先回应",
                participants=PARTICIPANTS,
                director_config=self.config,
            )
        self.assertEqual(plan.source, "fallback")
        self.assertEqual(plan.diagnostic, "director_request_failed")
        self.assertEqual([beat.assistant_id for beat in plan.beats], [2])

    async def test_reasoning_model_truncation_is_diagnosed_and_uses_configured_budget(self) -> None:
        response = {
            "choices": [
                {
                    "message": {"content": None, "reasoning_content": "internal reasoning"},
                    "finish_reason": "length",
                }
            ]
        }
        with patch(
            "mon_agent_server.runtime.companion.call_openai_compatible",
            return_value=response,
        ) as call:
            plan = await create_director_plan(
                user_text="请自然回应",
                participants=PARTICIPANTS,
                director_config=self.config,
                policy={"directorMaxTokens": 2400},
            )
        self.assertEqual(plan.source, "fallback")
        self.assertEqual(plan.diagnostic, "director_output_truncated")
        self.assertEqual(call.call_args.args[2]["maxTokens"], 2400)
        self.assertEqual(call.call_args.args[2]["thinking"], {"type": "disabled"})

    async def test_director_rejects_reasoning_output_even_when_content_exists(self) -> None:
        response = director_response([{"assistantID": 2, "intent": "回应用户"}])
        response["choices"][0]["message"]["reasoning_content"] = "hidden reasoning"
        with patch(
            "mon_agent_server.runtime.companion.call_openai_compatible",
            return_value=response,
        ):
            plan = await create_director_plan(
                user_text="请自然回应",
                participants=PARTICIPANTS,
                director_config=self.config,
            )
        self.assertEqual(plan.source, "fallback")
        self.assertEqual(plan.diagnostic, "director_reasoning_not_disabled")

    async def test_single_participant_bypasses_director_model(self) -> None:
        with patch("mon_agent_server.runtime.companion.call_openai_compatible") as call:
            plan = await create_director_plan(
                user_text="修复这个项目的代码",
                participants=PARTICIPANTS[:1],
                director_config=self.config,
            )
        self.assertEqual([beat.assistant_id for beat in plan.beats], [1])
        self.assertEqual(plan.source, "single")
        call.assert_not_called()

    def test_beat_payload_uses_frontend_protocol_field_names(self) -> None:
        payload = DirectorBeat(2, "接住话题", "react", "assistant:1", 0).to_payload()
        self.assertEqual(
            payload,
            {
                "assistantID": 2,
                "intent": "接住话题",
                "speechAct": "react",
                "addressTo": "assistant:1",
                "replyToBeat": 0,
            },
        )
        self.assertNotIn("assistant_id", payload)

    def test_returning_actor_prompt_responds_to_public_dialogue(self) -> None:
        prompt = actor_task_prompt(
            "请自然聊聊",
            DirectorBeat(1, "回应伙伴并收束", "close", "assistant:2", 1),
            [
                {"beatIndex": 0, "assistantID": 1, "assistantName": "伊芙", "reply": "我会先泡杯茶。"},
                {"beatIndex": 1, "assistantID": 2, "assistantName": "莉莉安", "reply": "那我想出去散步。"},
            ],
            scene=DirectorScene("game", "conversation", 0.9, "讨论当前游戏局面"),
            execution=DirectorExecution("lead_support", 1, None, "independent"),
        )
        self.assertIn("主要回应对象：莉莉安", prompt)
        self.assertIn("禁止以自己的姓名、角色名或“助手：”作为开头", prompt)
        self.assertIn("这次是再次接话", prompt)
        self.assertIn("承接节拍 1", prompt)
        self.assertIn("domain=game", prompt)
        self.assertIn("observationStrategy=independent", prompt)
        self.assertIn("是否读取屏幕仍由你根据任务需要自行判断", prompt)

    def test_single_actor_prompt_has_no_director_or_multi_assistant_language(self) -> None:
        prompt = actor_task_prompt(
            "请帮我修复代码",
            DirectorBeat(1, "直接回应用户"),
            [],
        )
        self.assertIn("单助手用户会话", prompt)
        self.assertNotIn("导演意图", prompt)
        self.assertNotIn("多人智能体会话", prompt)


if __name__ == "__main__":
    unittest.main()
