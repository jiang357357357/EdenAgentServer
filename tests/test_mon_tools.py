import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from mon_agent_server.mon_tools import MonToolContext, create_mon_agent_tools


class FakeCoreClient:
    def get_self_awake_diary_context(self, token, limit=5):
        self.context_args = (token, limit)
        return {
            "source": "core",
            "last": {
                "id": 35,
                "run_id": 38,
                "title": "服务器启动自检日志",
                "summary": "上一次自醒记录摘要。",
                "content_excerpt": "这是短摘录。",
                "tags": ["startup", "quiet"],
                "importance": "normal",
                "continuity_key": "startup-check",
                "created_at": "2026-07-04T12:00:00+08:00",
                "updated_at": "2026-07-04T12:00:00+08:00",
            },
            "recent": [
                {
                    "id": 35,
                    "run_id": 38,
                    "title": "服务器启动自检日志",
                    "summary": "上一次自醒记录摘要。",
                    "content_excerpt": "这是短摘录。",
                    "tags": ["startup", "quiet"],
                    "importance": "normal",
                    "continuity_key": "startup-check",
                    "created_at": "2026-07-04T12:00:00+08:00",
                    "updated_at": "2026-07-04T12:00:00+08:00",
                }
            ],
            "memory": {"summary": "近期都很安静。", "open_threads": ["启动检查"], "avoid_repeating": ["重复提醒"]},
        }

    def get_self_awake_diary(self, token, diary_id):
        self.read_args = (token, diary_id)
        return {
            "id": diary_id,
            "run": 38,
            "title": "服务器启动自检日志",
            "content": "这是完整工作日记正文。",
            "summary": "上一次自醒记录摘要。",
            "tags": ["startup", "quiet"],
            "importance": "normal",
            "continuity_key": "startup-check",
            "visible_to_user": True,
            "created_at": "2026-07-04T12:00:00+08:00",
            "updated_at": "2026-07-04T12:00:00+08:00",
        }


class FakeQQCoreClient:
    def __init__(self):
        self.management_args = None
        self.send_args = None

    def get_qq_bot_management(self, token, bot_id=None):
        self.management_args = (token, bot_id)
        return {
            "success": True,
            "data": {
                "bot_id": 7,
                "default_bot_id": 7,
                "is_default": True,
                "default_send_target": {
                    "target_type": "user",
                    "target_qq_number": "123456",
                    "name": "主人",
                    "permission_level": "super_admin",
                    "permission_label": "超级管理员",
                },
                "permissions": {"allowed_contacts": [], "allowed_groups": []},
            },
        }

    def send_qq_message(self, token, bot_id, payload):
        self.send_args = (token, bot_id, payload)
        return {
            "success": True,
            "data": {
                "request_id": "qq_send_test",
                "bot": {"id": bot_id},
                "target_type": payload["target_type"],
                "target_qq_number": payload["target_qq_number"],
                "queued": True,
            },
        }


class FakeMemoCoreClient:
    def __init__(self):
        self.mark_args = None
        self.complete_args = None
        self.update_args = None

    def mark_memo_triggered(self, token, memo_id):
        self.mark_args = (token, memo_id)
        return {
            "id": memo_id,
            "title": "测试：一次性提醒",
            "content": "该提醒已经通知用户。",
            "kind": "reminder",
            "status": "active",
            "priority": "normal",
            "remind_at": "2026-07-07T22:07:42+08:00",
            "last_triggered_at": "2026-07-07T22:10:36+08:00",
            "repeat_rule": "",
        }

    def complete_memo(self, token, memo_id):
        self.complete_args = (token, memo_id)
        return {
            "id": memo_id,
            "title": "测试：一次性提醒",
            "content": "该提醒已经通知用户。",
            "kind": "reminder",
            "status": "done",
            "priority": "normal",
            "remind_at": "2026-07-07T22:07:42+08:00",
            "last_triggered_at": "2026-07-07T22:10:36+08:00",
            "completed_at": "2026-07-07T22:10:37+08:00",
            "repeat_rule": "",
        }

    def update_memo(self, token, memo_id, payload):
        self.update_args = (token, memo_id, payload)
        return {
            "id": memo_id,
            "title": "测试：旧提醒",
            "content": "",
            "kind": "reminder",
            "status": payload.get("status", "active"),
            "priority": "normal",
            "remind_at": "2026-07-07T22:07:42+08:00",
        }


class FakeCharacterActionCoreClient:
    def __init__(self):
        self.action_args = None
        self.group_args = None

    def list_character_visual_actions(self, token, character_id):
        self.action_args = (token, character_id)
        return [
            {
                "id": 101,
                "character_id": character_id,
                "name": "开心",
                "intent": "happy",
                "aliases": ["高兴"],
                "description": "心情很好时使用。",
                "static_image_url": "/media/actions/happy.png",
                "dynamic_preview_url": "",
                "has_dynamic": False,
                "enabled": True,
            },
            {
                "id": 102,
                "character_id": character_id,
                "name": "思考",
                "intent": "think",
                "static_image_url": "/media/actions/think.png",
                "enabled": True,
            },
        ]

    def list_character_visual_action_groups(self, token, character_id):
        self.group_args = (token, character_id)
        return [
            {
                "id": 201,
                "character_id": character_id,
                "name": "说话",
                "trigger": "talk",
                "selection_mode": "first",
                "enabled": True,
                "items": [
                    {
                        "id": 301,
                        "action": {
                            "id": 101,
                            "name": "开心",
                            "intent": "happy",
                            "static_image_url": "/media/actions/happy.png",
                            "enabled": True,
                        },
                        "weight": 1,
                        "priority": 1,
                        "enabled": True,
                    }
                ],
            }
        ]


def tool_by_name(tools, name):
    return next(tool for tool in tools if tool.name == name)


class FakeHTTPResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class MonToolsTest(unittest.IsolatedAsyncioTestCase):
    async def test_notify_auto_routes_normal_events_to_qq(self):
        with TemporaryDirectory() as temp_dir:
            tools = create_mon_agent_tools(Path(temp_dir), MonToolContext(), "self_awake")
            notify_tool = tool_by_name(tools, "notify_user")
            qq_result = {"details": {"queued": True}}

            with (
                patch("mon_agent_server.tools.notify.send_qq_message", new=AsyncMock(return_value=qq_result)) as send_qq,
                patch("mon_agent_server.tools.notify.send_external_email", new=AsyncMock()) as send_email,
            ):
                result = await notify_tool.run(
                    "call_notify_normal",
                    {"message": "普通提醒", "channel": "auto", "priority": "normal"},
                )

            send_qq.assert_awaited_once()
            send_email.assert_not_awaited()
            self.assertEqual(result["details"]["delivered_channels"], ["qq"])

    async def test_notify_auto_routes_important_events_to_email(self):
        with TemporaryDirectory() as temp_dir:
            tools = create_mon_agent_tools(Path(temp_dir), MonToolContext(), "self_awake")
            notify_tool = tool_by_name(tools, "notify_user")
            email_result = {"details": {"sent": True}}

            with (
                patch("mon_agent_server.tools.notify.send_external_email", new=AsyncMock(return_value=email_result)) as send_email,
                patch("mon_agent_server.tools.notify.send_qq_message", new=AsyncMock()) as send_qq,
            ):
                result = await notify_tool.run(
                    "call_notify_high",
                    {"message": "重要事件", "channel": "auto", "priority": "high"},
                )

            send_email.assert_awaited_once()
            send_qq.assert_not_awaited()
            self.assertEqual(result["details"]["delivered_channels"], ["email"])

    async def test_character_action_tools_emit_frontend_event(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            core = FakeCharacterActionCoreClient()
            events = []
            states = []
            tools = create_mon_agent_tools(
                root,
                MonToolContext(
                    session_id="session-1",
                    core_client=core,
                    core_token="token-character",
                    character={"id": 9, "name": "江梦晚", "visual_preference": "static"},
                    current_character_action={
                        "sessionID": "session-1",
                        "characterID": 9,
                        "characterName": "江梦晚",
                        "action": {"id": 102, "name": "思考", "intent": "think", "static_image_url": "/media/actions/think.png"},
                        "group": None,
                        "groupItem": None,
                        "imageUrl": "/media/actions/think.png",
                        "source": "default",
                    },
                    emit_event=events.append,
                    set_character_action=states.append,
                ),
                "user_chat",
            )

            listing = await tool_by_name(tools, "list_character_actions").run("call_list_actions", {})
            self.assertEqual(core.action_args, ("token-character", 9))
            self.assertIsNone(core.group_args)
            self.assertIn("当前角色：江梦晚", listing["content"][0]["text"])
            self.assertIn("当前角色动作：思考", listing["content"][0]["text"])
            self.assertIn("开心", listing["content"][0]["text"])
            self.assertIn("思考 [当前]", listing["content"][0]["text"])

            result = await tool_by_name(tools, "switch_character_action").run(
                "call_switch_action",
                {
                    "立绘动作": "开心",
                    "表情符号": "爱心",
                    "立绘动效": "上下跳动",
                },
            )

            self.assertEqual(len(events), 1)
            event = events[0]
            self.assertEqual(event["type"], "character.action.changed")
            self.assertEqual(event["properties"]["sessionID"], "session-1")
            self.assertEqual(event["properties"]["characterID"], 9)
            self.assertEqual(event["properties"]["imageUrl"], "/media/actions/happy.png")
            self.assertEqual(event["properties"]["source"], "tool")
            self.assertEqual(event["properties"]["motion"], "jump")
            self.assertEqual(event["properties"]["effect"], "heart")
            self.assertEqual(event["properties"]["intensity"], "normal")
            self.assertEqual(event["properties"]["effectAnchor"], "head_right")
            self.assertEqual(
                set(event["properties"]),
                {
                    "sessionID",
                    "characterID",
                    "characterName",
                    "action",
                    "group",
                    "groupItem",
                    "imageUrl",
                    "reason",
                    "source",
                    "motion",
                    "effect",
                    "intensity",
                    "effectAnchor",
                    "performanceID",
                    "time",
                },
            )
            self.assertEqual(states[-1]["action"]["intent"], "happy")
            self.assertEqual(result["details"]["action"]["intent"], "happy")
            self.assertIn("表情符号：爱心", result["content"][0]["text"])
            self.assertIn("立绘动效：上下跳动", result["content"][0]["text"])

            switch_tool = tool_by_name(tools, "switch_character_action")
            self.assertEqual(
                switch_tool.parameters["required"],
                ["立绘动作", "表情符号", "立绘动效"],
            )
            self.assertEqual(
                set(switch_tool.parameters["properties"]),
                {"立绘动作", "表情符号", "立绘动效"},
            )
            self.assertTrue(
                {"快速颤抖", "垂直震动", "轻微下沉", "强调放大"}.issubset(
                    set(switch_tool.parameters["properties"]["立绘动效"]["enum"])
                )
            )
            self.assertTrue(
                {"疑问", "惊讶", "汗滴", "爱心", "生气", "叹气", "无语", "低落", "困倦"}.issubset(
                    set(switch_tool.parameters["properties"]["表情符号"]["enum"])
                )
            )

    async def test_character_action_tool_can_play_performance_without_switching_image(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            core = FakeCharacterActionCoreClient()
            events = []
            states = []
            tools = create_mon_agent_tools(
                root,
                MonToolContext(
                    session_id="session-1",
                    core_client=core,
                    core_token="token-character",
                    character={"id": 9, "name": "江梦晚", "visual_preference": "static"},
                    current_character_action={
                        "sessionID": "session-1",
                        "characterID": 9,
                        "characterName": "江梦晚",
                        "action": {"id": 102, "name": "思考", "intent": "think", "static_image_url": "/media/actions/think.png"},
                        "group": None,
                        "groupItem": None,
                        "imageUrl": "/media/actions/think.png",
                        "source": "default",
                    },
                    emit_event=events.append,
                    set_character_action=states.append,
                ),
                "user_chat",
            )

            result = await tool_by_name(tools, "switch_character_action").run(
                "call_performance_only",
                {"立绘动作": "保持当前", "表情符号": "汗滴", "立绘动效": "左右摇晃"},
            )

            self.assertEqual(len(events), 1)
            event = events[0]
            self.assertEqual(event["type"], "character.action.changed")
            self.assertEqual(event["properties"]["action"]["intent"], "think")
            self.assertEqual(event["properties"]["imageUrl"], "/media/actions/think.png")
            self.assertEqual(event["properties"]["motion"], "shake")
            self.assertEqual(event["properties"]["effect"], "sweat")
            self.assertEqual(event["properties"]["intensity"], "normal")
            self.assertEqual(states[-1]["action"]["intent"], "think")
            self.assertIn("立绘动作：保持当前", result["content"][0]["text"])

    async def test_character_action_tool_rejects_incomplete_or_english_performance(self):
        with TemporaryDirectory() as temp_dir:
            tools = create_mon_agent_tools(
                Path(temp_dir),
                MonToolContext(
                    session_id="session-1",
                    core_client=FakeCharacterActionCoreClient(),
                    core_token="token-character",
                    character={"id": 9, "name": "江梦晚", "visual_preference": "static"},
                    current_character_action={
                        "action": {"id": 102, "name": "思考", "intent": "think"},
                        "imageUrl": "/media/actions/think.png",
                    },
                    emit_event=lambda _event: None,
                ),
                "user_chat",
            )
            switch_tool = tool_by_name(tools, "switch_character_action")

            with self.assertRaisesRegex(RuntimeError, "缺少必填参数「表情符号」"):
                await switch_tool.run("call_incomplete", {"立绘动作": "保持当前", "立绘动效": "无"})
            with self.assertRaisesRegex(RuntimeError, "不支持“shake”"):
                await switch_tool.run(
                    "call_english",
                    {"立绘动作": "保持当前", "表情符号": "无", "立绘动效": "shake"},
                )

    async def test_qq_send_uses_default_bot_and_super_admin_target(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            core = FakeQQCoreClient()
            tools = create_mon_agent_tools(
                root,
                MonToolContext(core_client=core, core_token="token-qq"),
                "user_chat",
            )
            send_tool = tool_by_name(tools, "send_qq_message")

            self.assertEqual(send_tool.parameters["required"], ["content"])
            result = await send_tool.run("call_qq", {"content": "测试消息"})

            self.assertEqual(core.management_args, ("token-qq", None))
            self.assertEqual(
                core.send_args,
                (
                    "token-qq",
                    7,
                    {
                        "target_type": "user",
                        "target_qq_number": "123456",
                        "content": "测试消息",
                        "metadata": {},
                    },
                ),
            )
            self.assertIn("默认目标: 是", result["content"][0]["text"])
            self.assertTrue(result["details"]["resolved"]["used_default_target"])

    async def test_mark_triggered_auto_completes_one_time_reminder(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            core = FakeMemoCoreClient()
            tools = create_mon_agent_tools(
                root,
                MonToolContext(core_client=core, core_token="token-memo"),
                "self_awake",
            )
            mark_tool = tool_by_name(tools, "mark_memo_triggered")

            result = await mark_tool.run("call_memo", {"id": 12})

            self.assertEqual(core.mark_args, ("token-memo", 12))
            self.assertEqual(core.complete_args, ("token-memo", 12))
            self.assertTrue(result["details"]["auto_completed"])
            self.assertEqual(result["details"]["memo"]["status"], "done")
            self.assertIn("完成一次性提醒", result["content"][0]["text"])

    async def test_archive_memo_sets_archived_status(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            core = FakeMemoCoreClient()
            tools = create_mon_agent_tools(
                root,
                MonToolContext(core_client=core, core_token="token-memo"),
                "user_chat",
            )
            archive_tool = tool_by_name(tools, "archive_memo")

            result = await archive_tool.run("call_archive", {"id": 12})

            self.assertEqual(core.update_args, ("token-memo", 12, {"status": "archived"}))
            self.assertEqual(result["details"]["memo"]["status"], "archived")
            self.assertIn("已归档备忘录", result["content"][0]["text"])

    async def test_self_awake_profile_exposes_observation_tools(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            base_os = root / "Backend" / "BaseOs"
            base_os.mkdir(parents=True)
            (base_os / ".monconfig").write_text("[self_awake]\nDATA_DIR=Data/SelfAwake\n", encoding="utf-8")
            state_path = base_os / "Data" / "SelfAwake" / "state.json"
            state_path.parent.mkdir(parents=True)
            state_path.write_text(
                '{"enabled": true, "next_wake_at": "2026-07-04T12:00:00+08:00", "next_wake_after_minutes": 60, "next_wake_reason": "测试"}',
                encoding="utf-8",
            )
            core = FakeCoreClient()
            tools = create_mon_agent_tools(
                root,
                MonToolContext(
                    core_client=core,
                    core_token="token-1",
                    environment={
                        "timezone": "Asia/Shanghai",
                        "locale": "zh-CN",
                        "location": {
                            "country": "中国",
                            "region": "上海市",
                            "city": "上海",
                            "latitude": 31.2304,
                            "longitude": 121.4737,
                        },
                    },
                ),
                "self_awake",
            )

            names = {tool.name for tool in tools}
            self.assertIn("get_self_awake_state", names)
            self.assertIn("list_self_awake_diaries", names)
            self.assertIn("read_self_awake_diary", names)
            self.assertIn("get_calendar_context", names)
            self.assertIn("get_weather", names)
            self.assertNotIn("set_self_awake_timer", names)
            self.assertNotIn("send_qq_message", names)
            self.assertNotIn("send_external_email", names)
            self.assertIn("notify_user", names)

            state = await tool_by_name(tools, "get_self_awake_state").run("call_1", {})
            self.assertIn("MonOs 自醒状态", state["content"][0]["text"])

            self.assertEqual(state["details"]["next_wake_after_minutes"], 60)

            diaries = await tool_by_name(tools, "list_self_awake_diaries").run("call_2", {"limit": 1})
            self.assertEqual(core.context_args, ("token-1", 1))
            self.assertEqual(diaries["details"]["diaries"][0]["title"], "服务器启动自检日志")
            self.assertIn("工作记忆", diaries["content"][0]["text"])
            self.assertNotIn("完整工作日记正文", str(diaries))

            diary = await tool_by_name(tools, "read_self_awake_diary").run("call_3", {"id": 35})
            self.assertEqual(core.read_args, ("token-1", 35))
            self.assertIn("这是完整工作日记正文。", diary["content"][0]["text"])

            calendar = await tool_by_name(tools, "get_calendar_context").run("call_calendar", {"date": "2026-02-17", "nearby_days": 20})
            self.assertIn("当天节日：春节", calendar["content"][0]["text"])
            self.assertEqual(calendar["details"]["lunar"]["text"], "正月初一")

            weather_payload = {
                "current": {
                    "temperature_2m": 28.5,
                    "relative_humidity_2m": 60,
                    "apparent_temperature": 30.0,
                    "precipitation": 0,
                    "weather_code": 0,
                    "wind_speed_10m": 8,
                },
                "daily": {
                    "time": ["2026-07-04"],
                    "weather_code": [0],
                    "temperature_2m_max": [31],
                    "temperature_2m_min": [24],
                    "precipitation_sum": [0],
                },
                "timezone": "Asia/Shanghai",
            }
            with patch("urllib.request.urlopen", return_value=FakeHTTPResponse(weather_payload)):
                weather = await tool_by_name(tools, "get_weather").run("call_4", {"days": 1})

            self.assertIn("天气：上海", weather["content"][0]["text"])
            self.assertIn("晴朗", weather["content"][0]["text"])
            self.assertEqual(weather["details"]["location"]["city"], "上海")

    async def test_timer_tool_submits_request_without_writing_monos_state(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            base_os = root / "Backend" / "BaseOs"
            base_os.mkdir(parents=True)
            (base_os / ".monconfig").write_text(
                "[self_awake]\nDATA_DIR=Data/SelfAwake\nMIN_WAKE_MINUTES=1\nMAX_WAKE_MINUTES=1440\n",
                encoding="utf-8",
            )
            state_path = base_os / "Data" / "SelfAwake" / "state.json"
            state_path.parent.mkdir(parents=True)
            original_state = '{"next_wake_at": "2026-07-20T12:00:00+08:00"}'
            state_path.write_text(original_state, encoding="utf-8")
            tools = create_mon_agent_tools(root, MonToolContext(), "user_chat")

            result = await tool_by_name(tools, "set_self_awake_timer").run(
                "call_timer",
                {"after_minutes": 60, "reason": "测试单一调度权"},
            )

            self.assertEqual(state_path.read_text(encoding="utf-8"), original_state)
            requests = list((state_path.parent / "schedule_requests").glob("*.json"))
            self.assertEqual(len(requests), 1)
            payload = json.loads(requests[0].read_text(encoding="utf-8"))
            self.assertEqual(payload["reason"], "测试单一调度权")
            self.assertEqual(payload["requested_by"], "monagent")
            self.assertEqual(result["details"]["status"], "submitted")

    async def test_weather_uses_full_environment_location_label(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            base_os = root / "Backend" / "BaseOs"
            base_os.mkdir(parents=True)
            (base_os / ".monconfig").write_text("", encoding="utf-8")
            tools = create_mon_agent_tools(
                root,
                MonToolContext(
                    environment={
                        "timezone": "Asia/Shanghai",
                        "locale": "zh-CN",
                        "location": {
                            "country": "中国",
                            "region": "湖北省",
                            "city": "武汉市",
                            "district": "江夏区",
                            "latitude": 30.57889,
                            "longitude": 114.29212,
                        },
                    },
                ),
                "user_chat",
            )
            weather_payload = {
                "current": {
                    "temperature_2m": 30,
                    "relative_humidity_2m": 66,
                    "apparent_temperature": 33,
                    "precipitation": 0,
                    "weather_code": 2,
                    "wind_speed_10m": 6,
                },
                "daily": {
                    "time": ["2026-07-05"],
                    "weather_code": [2],
                    "temperature_2m_max": [34],
                    "temperature_2m_min": [27],
                    "precipitation_sum": [0],
                },
            }
            with patch("urllib.request.urlopen", return_value=FakeHTTPResponse(weather_payload)):
                weather = await tool_by_name(tools, "get_weather").run("call_weather", {})

            self.assertIn("天气：江夏区 · 武汉市 · 湖北省 · 中国", weather["content"][0]["text"])
            self.assertEqual(weather["details"]["location"]["district"], "江夏区")

    async def test_weather_explicit_city_does_not_reuse_environment_coordinates(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            base_os = root / "Backend" / "BaseOs"
            base_os.mkdir(parents=True)
            (base_os / ".monconfig").write_text("", encoding="utf-8")
            tools = create_mon_agent_tools(
                root,
                MonToolContext(
                    environment={
                        "timezone": "Asia/Shanghai",
                        "locale": "zh-CN",
                        "location": {
                            "country": "中国",
                            "region": "湖北省",
                            "city": "武汉市",
                            "latitude": 30.57889,
                            "longitude": 114.29212,
                        },
                    },
                ),
                "user_chat",
            )
            seen_urls = []

            def fake_urlopen(request, timeout=20):
                url = request.full_url
                seen_urls.append(url)
                if "geocoding-api.open-meteo.com" in url:
                    return FakeHTTPResponse(
                        {
                            "results": [
                                {
                                    "name": "北京市",
                                    "country": "中国",
                                    "admin1": "北京市",
                                    "latitude": 39.9042,
                                    "longitude": 116.4074,
                                    "timezone": "Asia/Shanghai",
                                }
                            ]
                        }
                    )
                return FakeHTTPResponse(
                    {
                        "current": {
                            "temperature_2m": 26,
                            "apparent_temperature": 27,
                            "relative_humidity_2m": 50,
                            "precipitation": 0,
                            "weather_code": 0,
                            "wind_speed_10m": 4,
                        },
                        "daily": {
                            "time": ["2026-07-05"],
                            "weather_code": [0],
                            "temperature_2m_max": [30],
                            "temperature_2m_min": [22],
                            "precipitation_sum": [0],
                        },
                    }
                )

            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                weather = await tool_by_name(tools, "get_weather").run("call_weather_city", {"city": "北京"})

            self.assertIn("天气：北京市", weather["content"][0]["text"])
            self.assertEqual(weather["details"]["location"]["latitude"], 39.9042)
            self.assertTrue(any("latitude=39.904200" in url and "longitude=116.407400" in url for url in seen_urls))


if __name__ == "__main__":
    unittest.main()
