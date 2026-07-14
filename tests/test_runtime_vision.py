import base64
import unittest
from pathlib import Path
from unittest.mock import Mock

from mon_agent_server.core import CoreClient
from mon_agent_server.runtime.config import RuntimeModelConfig
from mon_agent_server.runtime.manager import MonAgentRuntime


class FakeVisionCoreClient:
    def __init__(self):
        self.calls = []

    def analyze_vision(self, token, payload):
        self.calls.append((token, payload))
        return {
            "success": True,
            "content": "图片中显示一个 Electron 错误窗口，错误信息为 write EPIPE。",
        }


class CoreRuntimeVisionConfigTest(unittest.TestCase):
    def test_runtime_config_uses_character_bound_vision_config(self):
        client = CoreClient("http://core.test")
        client.get_default_assistant = Mock(
            return_value={
                "id": 1,
                "character": {
                    "id": 7,
                    "name": "雪音",
                    "ai_talk_entity_id": 11,
                    "vision_config_id": 33,
                },
            }
        )
        client.get_ai_entity = Mock(return_value={"id": 11, "ai_name": "对话模型", "api_key": "key"})
        client.get_vision_config = Mock(
            return_value={"id": 33, "vision_name": "角色视觉", "status": "active"}
        )
        client.list_vision_configs = Mock(side_effect=AssertionError("不应回退到用户配置列表"))

        resolved = client.resolve_runtime_config("token")

        self.assertEqual(resolved["visionConfig"]["id"], 33)
        client.get_vision_config.assert_called_once_with("token", 33)
        client.list_vision_configs.assert_not_called()

    def test_runtime_config_does_not_choose_unbound_active_vision_config(self):
        client = CoreClient("http://core.test")
        client.get_default_assistant = Mock(
            return_value={
                "id": 1,
                "character": {"id": 7, "name": "雪音", "ai_talk_entity_id": 11},
            }
        )
        client.get_ai_entity = Mock(return_value={"id": 11, "ai_name": "对话模型", "api_key": "key"})
        client.get_vision_config = Mock()
        client.list_vision_configs = Mock(side_effect=AssertionError("不应读取用户配置列表"))

        resolved = client.resolve_runtime_config("token")

        self.assertIsNone(resolved["visionConfig"])
        client.get_vision_config.assert_not_called()
        client.list_vision_configs.assert_not_called()

    def test_bound_vision_lookup_failure_does_not_break_text_runtime_or_fallback(self):
        client = CoreClient("http://core.test")
        client.get_default_assistant = Mock(
            return_value={
                "id": 1,
                "character": {
                    "id": 7,
                    "name": "雪音",
                    "ai_talk_entity_id": 11,
                    "vision_config_id": 33,
                    "vision_config_name": "角色视觉",
                },
            }
        )
        client.get_ai_entity = Mock(return_value={"id": 11, "ai_name": "对话模型", "api_key": "key"})
        client.get_vision_config = Mock(side_effect=RuntimeError("Vision API unavailable"))
        client.list_vision_configs = Mock(side_effect=AssertionError("不应回退到用户配置列表"))

        resolved = client.resolve_runtime_config("token")

        self.assertEqual(resolved["visionConfig"]["id"], 33)
        self.assertEqual(resolved["visionConfig"]["status"], "unavailable")
        self.assertIn("Vision API unavailable", resolved["visionConfig"]["error"])
        client.list_vision_configs.assert_not_called()


class AutomaticVisionRuntimeTest(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def image_parts():
        encoded = base64.b64encode(b"fake-png-content").decode("ascii")
        return [
            {"type": "text", "text": "这张图是什么问题？"},
            {
                "type": "file",
                "filename": "错误截图.png",
                "mime": "image/png",
                "url": f"data:image/png;base64,{encoded}",
            },
        ]

    def create_runtime(self, core_client):
        return MonAgentRuntime(
            Path.cwd(),
            store=None,
            events=None,
            permissions=None,
            questions=None,
            core_client=core_client,
        )

    async def test_non_multimodal_model_automatically_calls_bound_vision(self):
        core_client = FakeVisionCoreClient()
        runtime = self.create_runtime(core_client)
        config = RuntimeModelConfig(
            {"id": "text-model", "input": ["text"]},
            "key",
            "text-model",
            "core",
            {
                "character": {"id": 7, "name": "雪音"},
                "visionConfig": {"id": 33, "vision_name": "角色视觉", "status": "active"},
            },
        )

        context = await runtime._analyze_non_multimodal_images(
            session_id="session-1",
            message_id="message-1",
            parts=self.image_parts(),
            user_text="这张图是什么问题？",
            auth_token="token",
            runtime_config=config,
        )

        self.assertIn("自动视觉分析结果", context)
        self.assertIn("write EPIPE", context)
        self.assertEqual(len(core_client.calls), 1)
        token, payload = core_client.calls[0]
        self.assertEqual(token, "token")
        self.assertEqual(payload["config_id"], 33)
        self.assertEqual(payload["images"][0]["ref"], "错误截图.png")
        self.assertTrue(payload["metadata"]["automatic"])

    async def test_multimodal_model_keeps_direct_image_path(self):
        core_client = FakeVisionCoreClient()
        runtime = self.create_runtime(core_client)
        config = RuntimeModelConfig(
            {"id": "vision-model", "input": ["text", "image"]},
            "key",
            "vision-model",
            "core",
            {
                "character": {"id": 7, "name": "雪音"},
                "visionConfig": {"id": 33, "vision_name": "角色视觉", "status": "active"},
            },
        )

        context = await runtime._analyze_non_multimodal_images(
            session_id="session-1",
            message_id="message-1",
            parts=self.image_parts(),
            user_text="这张图是什么问题？",
            auth_token="token",
            runtime_config=config,
        )

        self.assertEqual(context, "")
        self.assertEqual(core_client.calls, [])

    async def test_non_multimodal_model_requires_character_vision_binding(self):
        runtime = self.create_runtime(FakeVisionCoreClient())
        config = RuntimeModelConfig(
            {"id": "text-model", "input": ["text"]},
            "key",
            "text-model",
            "core",
            {"character": {"id": 7, "name": "雪音"}, "visionConfig": None},
        )

        with self.assertRaisesRegex(RuntimeError, "角色未绑定 Vision 配置"):
            await runtime._analyze_non_multimodal_images(
                session_id="session-1",
                message_id="message-1",
                parts=self.image_parts(),
                user_text="这张图是什么问题？",
                auth_token="token",
                runtime_config=config,
            )


if __name__ == "__main__":
    unittest.main()
