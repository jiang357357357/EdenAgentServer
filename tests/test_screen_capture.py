import base64
import threading
import time
import unittest
import tempfile
from pathlib import Path

from mon_agent_server.brokers import ScreenCaptureBroker
from mon_agent_server.events import EventBus
from mon_agent_server.tools.context import MonToolContext
from mon_agent_server.tools.vision import create_vision_tools


class AllowPermissionBroker:
    def __init__(self, full_access=False):
        self.requests = []
        self.full_access = full_access

    def is_always_allowed(self, permission, pattern):
        return self.full_access

    def ask(self, request):
        self.requests.append(request)
        return "once"


class FakeScreenCaptureBroker:
    def __init__(self):
        self.requests = []

    def capture(self, request):
        self.requests.append(request)
        encoded = base64.b64encode(b"screen-png").decode("ascii")
        return {
            "dataUrl": f"data:image/png;base64,{encoded}",
            "width": 1920,
            "height": 1080,
            "displayId": "1",
            "sourceName": "Display 1",
        }


class FakeVisionCoreClient:
    def __init__(self):
        self.calls = []

    def analyze_vision(self, token, payload):
        self.calls.append((token, payload))
        return {"success": True, "content": "屏幕中显示 MonAgent 聊天窗口。"}


def tool_by_name(tools, name):
    return next(tool for tool in tools if tool.name == name)


class ScreenCaptureBrokerTest(unittest.TestCase):
    def test_capture_waits_for_desktop_reply(self):
        broker = ScreenCaptureBroker(EventBus())
        result = {}

        def capture():
            result.update(broker.capture({"sessionID": "session-1"}, timeout=1))

        thread = threading.Thread(target=capture)
        thread.start()
        request = None
        for _ in range(50):
            pending = broker.list()
            if pending:
                request = pending[0]
                break
            time.sleep(0.01)
        self.assertIsNotNone(request)
        broker.reply(request["id"], {"dataUrl": "data:image/png;base64,YQ=="})
        thread.join(timeout=1)

        self.assertFalse(thread.is_alive())
        self.assertEqual(result["dataUrl"], "data:image/png;base64,YQ==")
        self.assertEqual(broker.list(), [])


class AnalyzeScreenToolTest(unittest.IsolatedAsyncioTestCase):
    async def test_multimodal_model_exposes_analyze_image_for_local_paths(self):
        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(current_model_supports_images=True),
        )

        self.assertEqual([tool.name for tool in tools], ["analyze_image", "analyze_screen"])

    async def test_multimodal_model_reads_file_url_outside_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "贴图.gif"
            image_path.write_bytes(b"GIF89a-test")
            tools = create_vision_tools(
                Path.cwd(),
                MonToolContext(current_model_supports_images=True),
            )

            result = await tool_by_name(tools, "analyze_image").run(
                "tool-local-image",
                {"path": image_path.as_uri(), "question": "分析这个表情包"},
            )

            self.assertEqual(result["content"][1]["type"], "image")
            self.assertEqual(result["content"][1]["mimeType"], "image/gif")
            self.assertEqual(result["details"]["source"], str(image_path))

    async def test_text_model_exposes_analyze_image_fallback(self):
        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(current_model_supports_images=False),
        )

        self.assertEqual([tool.name for tool in tools], ["analyze_image", "analyze_screen"])

    async def test_multimodal_model_receives_electron_screen_image(self):
        permissions = AllowPermissionBroker()
        captures = FakeScreenCaptureBroker()
        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(
                session_id="session-1",
                permissions=permissions,
                screen_captures=captures,
                current_model_supports_images=True,
                get_message_id=lambda: "message-1",
            ),
        )

        result = await tool_by_name(tools, "analyze_screen").run(
            "tool-1",
            {"question": "当前屏幕显示了什么？"},
        )

        self.assertEqual(permissions.requests, [])
        self.assertEqual(len(captures.requests), 1)
        self.assertEqual(captures.requests[0]["source"], "auto")
        self.assertEqual(result["content"][0]["text"], "屏幕截图已捕获并提供给当前模型（1920×1080，Display 1）。")
        self.assertEqual(result["content"][1]["type"], "image")
        self.assertEqual(result["details"]["width"], 1920)
        self.assertEqual(result["details"]["sourceName"], "Display 1")
        self.assertEqual(result["details"]["requestedSource"], "auto")

    async def test_explicit_game_source_is_forwarded_to_capture_client(self):
        permissions = AllowPermissionBroker()
        captures = FakeScreenCaptureBroker()
        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(
                session_id="session-1",
                permissions=permissions,
                screen_captures=captures,
                current_model_supports_images=True,
                get_message_id=lambda: "message-1",
            ),
        )

        result = await tool_by_name(tools, "analyze_screen").run(
            "tool-game",
            {"question": "游戏画面显示了什么？", "source": "game"},
        )

        self.assertEqual(permissions.requests, [])
        self.assertEqual(captures.requests[0]["source"], "game")
        self.assertEqual(result["details"]["requestedSource"], "game")

    async def test_invalid_screen_source_is_rejected_before_capture(self):
        permissions = AllowPermissionBroker()
        captures = FakeScreenCaptureBroker()
        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(
                session_id="session-1",
                permissions=permissions,
                screen_captures=captures,
                current_model_supports_images=True,
            ),
        )

        with self.assertRaisesRegex(RuntimeError, "屏幕来源无效"):
            await tool_by_name(tools, "analyze_screen").run(
                "tool-invalid",
                {"source": "window"},
            )

        self.assertEqual(permissions.requests, [])
        self.assertEqual(captures.requests, [])

    async def test_full_access_skips_screen_permission_card(self):
        permissions = AllowPermissionBroker(full_access=True)
        captures = FakeScreenCaptureBroker()
        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(
                session_id="session-1",
                permissions=permissions,
                screen_captures=captures,
                current_model_supports_images=True,
                get_message_id=lambda: "message-1",
            ),
        )

        await tool_by_name(tools, "analyze_screen").run(
            "tool-1",
            {"question": "当前屏幕显示了什么？"},
        )

        self.assertEqual(permissions.requests, [])
        self.assertEqual(len(captures.requests), 1)

    async def test_text_model_uses_bound_vision_for_screen_image(self):
        permissions = AllowPermissionBroker()
        captures = FakeScreenCaptureBroker()
        core = FakeVisionCoreClient()
        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(
                session_id="session-1",
                permissions=permissions,
                screen_captures=captures,
                current_model_supports_images=False,
                core_client=core,
                core_token="token",
                vision_config={"id": 33, "status": "active"},
                get_message_id=lambda: "message-1",
            ),
        )

        result = await tool_by_name(tools, "analyze_screen").run(
            "tool-1",
            {"question": "当前屏幕显示了什么？"},
        )

        self.assertIn("MonAgent 聊天窗口", result["content"][0]["text"])
        self.assertEqual(core.calls[0][1]["config_id"], 33)
        self.assertEqual(core.calls[0][1]["metadata"]["width"], 1920)


if __name__ == "__main__":
    unittest.main()
