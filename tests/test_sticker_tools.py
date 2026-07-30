import base64
import unittest

from mon_agent_server.tools.context import MonToolContext
from mon_agent_server.tools.stickers import create_sticker_tools


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class FakeStickerCore:
    def __init__(self):
        self.stickers = []

    def list_character_stickers(self, _token, _character_id, query=""):
        return [item for item in self.stickers if not query or query in item["name"]]

    def create_character_sticker(self, _token, character_id, fields, filename, mime, image):
        sticker = {
            "id": len(self.stickers) + 1,
            "character": character_id,
            "image_url": f"http://core.test/media/{filename}",
            **fields,
        }
        self.stickers.append(sticker)
        self.last_upload = (mime, image)
        return sticker

    def delete_character_sticker(self, _token, _character_id, sticker_id):
        self.stickers = [item for item in self.stickers if item["id"] != sticker_id]
        return {"deleted": True, "sticker_id": sticker_id}


def by_name(tools, name):
    return next(tool for tool in tools if tool.name == name)


class StickerToolsTest(unittest.IsolatedAsyncioTestCase):
    async def test_record_list_and_send_sticker_as_structured_part(self):
        core = FakeStickerCore()
        parts = []
        context = MonToolContext(
            session_id="ses_test",
            core_client=core,
            core_token="token",
            character={"id": 7},
            append_assistant_part=lambda part: parts.append(part) or part,
        )
        tools = create_sticker_tools(context)
        data_url = "data:image/png;base64," + base64.b64encode(PNG_1X1).decode()

        await by_name(tools, "remember_character_sticker").execute(
            "call_record",
            {
                "image_url": data_url,
                "name": "开心",
                "description": "露出开心笑容",
                "emotion": "开心",
                "intent": "表达喜悦",
                "aliases": ["高兴"],
            },
        )
        listed = await by_name(tools, "list_character_stickers").execute("call_list", {"query": "开"})
        sent = await by_name(tools, "send_character_sticker").execute("call_send", {"sticker": "高兴"})

        self.assertEqual(core.last_upload, ("image/png", PNG_1X1))
        self.assertEqual(listed["details"]["stickers"][0]["name"], "开心")
        self.assertEqual(parts[0]["type"], "sticker")
        self.assertEqual(parts[0]["stickerID"], 1)
        self.assertEqual(sent["details"]["part"], parts[0])

        deleted = await by_name(tools, "delete_character_sticker").execute(
            "call_delete", {"sticker": "高兴"}
        )
        self.assertTrue(deleted["details"]["deleted"])
        self.assertEqual(core.stickers, [])

    async def test_subagent_receives_no_sticker_tools(self):
        tools = create_sticker_tools(
            MonToolContext(core_client=FakeStickerCore(), core_token="token", character={"id": 7}, agent_path="/root/child")
        )
        self.assertEqual(tools, [])

    async def test_record_requires_semantic_tags(self):
        tools = create_sticker_tools(
            MonToolContext(core_client=FakeStickerCore(), core_token="token", character={"id": 7})
        )
        with self.assertRaisesRegex(ValueError, "描述.*情绪.*使用意图.*检索别名"):
            await by_name(tools, "remember_character_sticker").execute(
                "call", {"image_url": "data:image/png;base64,AA==", "name": "未标注"}
            )

    async def test_record_resolves_attachment_reference(self):
        core = FakeStickerCore()
        data_url = "data:image/png;base64," + base64.b64encode(PNG_1X1).decode()
        tools = create_sticker_tools(MonToolContext(
            core_client=core,
            core_token="token",
            character={"id": 7},
            get_current_files=lambda: [{"filename": "哭哭.png", "mime": "image/png", "url": data_url}],
        ))

        await by_name(tools, "remember_character_sticker").execute("call", {
            "image_url": "attachment://%E5%93%AD%E5%93%AD.png",
            "name": "委屈大哭",
            "description": "角色趴在地上哭泣",
            "emotion": "委屈",
            "intent": "表达难过",
            "aliases": ["哭哭"],
        })

        self.assertEqual(core.last_upload, ("image/png", PNG_1X1))
