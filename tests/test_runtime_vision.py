import base64
import unittest
from pathlib import Path
from unittest.mock import Mock

from mon_agent_server.core import CoreClient
from mon_agent_server.runtime.config import RuntimeModelConfig
from mon_agent_server.runtime.manager import MonAgentRuntime
from mon_agent_server.runtime.messages import images_from_parts


class FakeVisionCoreClient:
    def __init__(self):
        self.calls = []

    def analyze_image(self, token, payload):
        self.calls.append((token, payload))
        return {
            "success": True,
            "content": "图片中显示一个 Electron 错误窗口，错误信息为 write EPIPE。",
        }


class CoreRuntimeVisionConfigTest(unittest.TestCase):
    def test_runtime_config_uses_input_model_when_character_has_no_binding(self):
        client = CoreClient("http://core.test")
        client.get_current_assistant = Mock(
            return_value={
                "id": 1,
                "character": {"id": 7, "name": "普拉娜", "ai_talk_entity_id": None},
            }
        )
        client.get_agent_settings = Mock(return_value={"default_model": "1"})
        client.list_ai_entities = Mock(return_value=[
            {"id": 3, "ai_name": "视觉", "status": "active", "is_multimodal": True, "is_vision_default": True},
            {"id": 1, "ai_name": "opencode", "ai_model": "deepseek-v4-flash", "status": "active", "api_key": "key"},
        ])
        client.get_ai_entity = Mock(return_value={
            "id": 1,
            "ai_name": "opencode",
            "ai_model": "deepseek-v4-flash",
            "status": "active",
            "api_key": "key",
        })

        resolved = client.resolve_runtime_config("token")

        self.assertEqual(resolved["aiEntity"]["id"], 1)
        self.assertEqual(resolved["visionAIEntity"]["id"], 3)
        client.get_ai_entity.assert_called_once_with("token", 1)

    def test_runtime_config_uses_character_bound_multimodal_ai(self):
        client = CoreClient("http://core.test")
        client.get_current_assistant = Mock(
            return_value={
                "id": 1,
                "character": {
                    "id": 7,
                    "name": "雪音",
                    "ai_talk_entity_id": 11,
                    "vision_ai_entity_id": 33,
                },
            }
        )
        client.get_ai_entity = Mock(side_effect=[
            {"id": 11, "ai_name": "对话模型", "api_key": "key"},
            {"id": 33, "ai_name": "角色视觉", "status": "active", "is_multimodal": True},
        ])
        client.list_ai_entities = Mock(side_effect=AssertionError("不应回退到用户默认模型"))

        resolved = client.resolve_runtime_config("token")

        self.assertEqual(resolved["visionAIEntity"]["id"], 33)
        self.assertEqual(client.get_ai_entity.call_args_list[-1].args, ("token", 33))
        client.list_ai_entities.assert_not_called()

    def test_runtime_config_uses_user_default_multimodal_ai(self):
        client = CoreClient("http://core.test")
        client.get_current_assistant = Mock(
            return_value={
                "id": 1,
                "character": {"id": 7, "name": "雪音", "ai_talk_entity_id": 11},
            }
        )
        client.get_ai_entity = Mock(return_value={"id": 11, "ai_name": "对话模型", "api_key": "key"})
        client.list_ai_entities = Mock(return_value=[
            {"id": 22, "ai_name": "普通模型", "status": "active", "is_multimodal": False},
            {"id": 33, "ai_name": "默认视觉", "status": "active", "is_multimodal": True, "is_vision_default": True},
        ])

        resolved = client.resolve_runtime_config("token")

        self.assertEqual(resolved["visionAIEntity"]["id"], 33)
        client.list_ai_entities.assert_called_once_with("token")

    def test_bound_multimodal_ai_lookup_failure_does_not_break_text_runtime(self):
        client = CoreClient("http://core.test")
        client.get_current_assistant = Mock(
            return_value={
                "id": 1,
                "character": {
                    "id": 7,
                    "name": "雪音",
                    "ai_talk_entity_id": 11,
                    "vision_ai_entity_id": 33,
                    "vision_ai_entity_name": "角色视觉",
                },
            }
        )
        client.get_ai_entity = Mock(side_effect=[
            {"id": 11, "ai_name": "对话模型", "api_key": "key"},
            RuntimeError("AI API unavailable"),
        ])
        client.list_ai_entities = Mock(side_effect=AssertionError("不应回退到用户配置列表"))

        resolved = client.resolve_runtime_config("token")

        self.assertEqual(resolved["visionAIEntity"]["id"], 33)
        self.assertEqual(resolved["visionAIEntity"]["status"], "unavailable")
        self.assertIn("AI API unavailable", resolved["visionAIEntity"]["error"])
        client.list_ai_entities.assert_not_called()


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
                "visionAIEntity": {"id": 33, "ai_name": "角色视觉", "status": "active"},
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
        self.assertEqual(payload["ai_entity_id"], 33)
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
                "visionAIEntity": {"id": 33, "ai_name": "角色视觉", "status": "active"},
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

    async def test_local_file_attachment_becomes_multimodal_content(self):
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "本地图片.jpg"
            image_path.write_bytes(b"local-jpeg-content")
            images = images_from_parts([
                {"type": "file", "filename": image_path.name, "mime": "image/jpeg", "url": image_path.as_uri()}
            ])

        self.assertEqual(len(images), 1)
        self.assertEqual(images[0]["mimeType"], "image/jpeg")
        self.assertEqual(base64.b64decode(images[0]["data"]), b"local-jpeg-content")

    async def test_non_multimodal_model_requires_default_multimodal_ai(self):
        runtime = self.create_runtime(FakeVisionCoreClient())
        config = RuntimeModelConfig(
            {"id": "text-model", "input": ["text"]},
            "key",
            "text-model",
            "core",
            {"character": {"id": 7, "name": "雪音"}, "visionAIEntity": None},
        )

        with self.assertRaisesRegex(RuntimeError, "没有配置默认多模态 AI"):
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
