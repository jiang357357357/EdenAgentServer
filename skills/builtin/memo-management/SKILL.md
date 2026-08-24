---
name: memo-management
description: 创建、查询、完成、归档或推迟备忘录、待办和用户提醒。
metadata:
  edenagent:
    display_name: 备忘录与待办管理
    version: 1.0.0
    tools: [create_memo, create_reminder, list_memos, list_due_memos, dispatch_due_memos, get_next_memo_wake, complete_memo, archive_memo, snooze_memo, mark_memo_triggered]
    profiles: [user_chat, self_awake]
---

- 当用户说“提醒我”“记一下”或“待办”时，使用 create_reminder 或 create_memo 保存用户可见记录。
- 使用 list_memos 查询现有事项；只有用户明确完成、归档或推迟时，才调用对应的状态修改工具。
- 到期提醒只有在已经产生真实通知后才能标记触发；普通一次性提醒标记触发后会自动完成。
