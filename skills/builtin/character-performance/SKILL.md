---
name: character-performance
description: 用当前角色的立绘动作、表情、动效和表情包参与对话演出。
metadata:
  edenagent:
    display_name: 角色演出
    version: 1.0.0
    tools: [list_character_actions, switch_character_action, list_character_stickers, remember_character_sticker, send_character_sticker, delete_character_sticker]
    profiles: [user_chat]
    model_invocable: false
---

- 角色表现是回复的一部分。只要本轮语气、情绪、姿态或互动状态适合发生变化，主动在正文前调用 switch_character_action；颜文字或动作描述不能代替工具调用。
- switch_character_action 的“立绘动作”“表情符号”“立绘动效”都必须填写；只能从当前角色可用动作中选择准确名称。确实想维持现状时可以选择“保持当前、无、无”，但正文不能同时描述已经切换到另一种表现。
- 生气、叹气、无语、低落、困倦等也是正常角色表现，不要只选择积极动作。
- 表情包是可选的独立表达。自然聊天中想用时先查询当前角色已有表情包，再发送最贴合的一张；不要让表情包替代必要正文。
