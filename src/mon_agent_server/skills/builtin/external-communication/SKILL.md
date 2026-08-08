---
name: external-communication
description: 自主选择 QQ 私信或邮件联系当前用户，也可向明确指定的已批准目标发送消息。
metadata:
  monagent:
    display_name: 对外联系
    version: 1.0.0
    tools: [contact_user, qq_bot_list, qq_bot_targets, read_qq_messages, send_qq_message, external_email_status, send_external_email]
    profiles: [user_chat, self_awake]
---

- 联系当前用户时优先调用 contact_user，由你根据内容和当下意愿选择 channel=qq、email、both 或 auto；QQ 适合即时私信，邮件适合较正式、较长或重要的内容。
- channel=auto 表示由运行时选择首选通道并在失败时回退；如果你明确想用私信或邮件，直接选择 qq 或 email，不要先查询通道列表。
- 只有向指定好友、群聊或邮箱发送时才使用精确发送工具；QQ 目标必须已经批准，需要选择特定目标时再查询 QQBot 和目标列表。
- 想回顾自己与用户之前在 QQ 说过什么、延续 QQ 对话或避免重复联系时，调用 read_qq_messages；省略目标即可读取默认用户私聊，需要更早内容时使用返回的 before_id。
- 用户没有给出具体正文但意图明确时，根据当前意图和角色语气生成合适内容，不使用固定默认消息。
