import base64
import threading
import time
import unittest
from pathlib import Path

from mon_agent_server.brokers import CameraCaptureBroker
from mon_agent_server.core import CoreAuthenticationExpiredError
from mon_agent_server.events import EventBus
from mon_agent_server.http.routes.camera_capture import handle_camera_capture
from mon_agent_server.tools import create_mon_agent_tools
from mon_agent_server.tools.context import MonToolContext
from mon_agent_server.tools.vision import create_vision_tools


class EventRecorder:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)


class FakeCameraCaptureBroker:
    def __init__(self):
        self.requests = []

    def capture(self, request):
        self.requests.append(request)
        encoded = base64.b64encode(b"camera-jpeg").decode("ascii")
        return {
            "dataUrl": f"data:image/jpeg;base64,{encoded}",
            "mime": "image/jpeg",
            "width": 1280,
            "height": 720,
            "deviceLabel": "Integrated Camera",
            "facingMode": "user",
        }


def tool_by_name(tools, name):
    return next(tool for tool in tools if tool.name == name)


class CameraCaptureBrokerTest(unittest.TestCase):
    def test_capture_waits_for_camera_reply_and_emits_camera_events(self):
        events = EventRecorder()
        broker = CameraCaptureBroker(events)
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
        broker.reply(request["id"], {"dataUrl": "data:image/jpeg;base64,YQ=="})
        thread.join(timeout=1)

        self.assertFalse(thread.is_alive())
        self.assertEqual(result["dataUrl"], "data:image/jpeg;base64,YQ==")
        self.assertEqual(events.events[0]["type"], "camera_capture.requested")
        self.assertEqual(events.events[-1]["type"], "camera_capture.replied")

    def test_reject_all_unblocks_camera_capture(self):
        broker = CameraCaptureBroker(EventBus())
        errors = []

        def capture():
            try:
                broker.capture({"sessionID": "session-1"}, timeout=1)
            except RuntimeError as error:
                errors.append(str(error))

        thread = threading.Thread(target=capture)
        thread.start()
        for _ in range(50):
            if broker.list():
                break
            time.sleep(0.01)
        self.assertEqual(broker.reject_all("session-1", "session_aborted"), 1)
        thread.join(timeout=1)

        self.assertEqual(errors, ["session_aborted"])


class CameraCaptureToolTest(unittest.IsolatedAsyncioTestCase):
    async def test_multimodal_model_receives_single_camera_frame(self):
        captures = FakeCameraCaptureBroker()
        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(
                session_id="session-1",
                camera_captures=captures,
                current_model_supports_images=True,
            ),
        )

        result = await tool_by_name(tools, "capture_camera").run(
            "tool-camera",
            {"question": "镜头里有什么？", "facing_mode": "user"},
        )

        self.assertEqual(captures.requests[0]["facingMode"], "user")
        self.assertEqual(result["content"][0]["text"], "摄像头单帧已捕获并提供给当前模型（1280×720，Integrated Camera）。")
        self.assertEqual(result["content"][1]["type"], "image")
        self.assertEqual(result["content"][1]["mimeType"], "image/jpeg")
        self.assertEqual(result["details"]["requestedFacingMode"], "user")

    async def test_invalid_facing_mode_is_rejected_before_capture(self):
        captures = FakeCameraCaptureBroker()
        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(
                session_id="session-1",
                camera_captures=captures,
            ),
        )

        with self.assertRaisesRegex(RuntimeError, "摄像头方向无效"):
            await tool_by_name(tools, "capture_camera").run(
                "tool-camera",
                {"facing_mode": "sideways"},
            )
        self.assertEqual(captures.requests, [])

    async def test_camera_payload_must_be_a_valid_image(self):
        class InvalidCapture:
            def capture(self, _request):
                return {"dataUrl": "data:text/plain;base64,YQ=="}

        tools = create_vision_tools(
            Path.cwd(),
            MonToolContext(session_id="session-1", camera_captures=InvalidCapture()),
        )
        with self.assertRaisesRegex(RuntimeError, "摄像头图片格式无效"):
            await tool_by_name(tools, "capture_camera").run("tool-camera", {})

    def test_camera_tool_requires_runtime_permission(self):
        tools = create_mon_agent_tools(Path.cwd(), MonToolContext(), "user_chat")
        request = tool_by_name(tools, "capture_camera").permission_request({})
        self.assertEqual(request["permission"], "capture_camera")


class CameraCaptureRouteTest(unittest.TestCase):
    def test_camera_routes_require_core_token(self):
        class Handler:
            headers = {}

        with self.assertRaises(CoreAuthenticationExpiredError):
            handle_camera_capture(Handler(), "/camera-capture", {}, "GET")

    def test_camera_reply_is_forwarded_to_broker(self):
        calls = []

        class Core:
            def get_user_profile(self, token):
                calls.append(("auth", token))
                return {"id": 1}

        class Captures:
            def reply(self, request_id, result, error):
                calls.append((request_id, result, error))
                return True

        class App:
            core_client = Core()
            camera_captures = Captures()

        class Handler:
            headers = {"Authorization": "Token core-token"}
            app = App()

            def read_json_body(self):
                return {
                    "result": {
                        "dataUrl": "data:image/jpeg;base64,YQ==",
                        "width": 1,
                        "height": 1,
                    }
                }

            def json_response(self, data, status=200):
                self.response = (data, status)

        handler = Handler()
        handled = handle_camera_capture(handler, "/camera-capture/cap%201/reply", {}, "POST")

        self.assertTrue(handled)
        self.assertEqual(calls[0], ("auth", "core-token"))
        self.assertEqual(calls[1][0], "cap 1")
        self.assertEqual(handler.response, (True, 200))


if __name__ == "__main__":
    unittest.main()
