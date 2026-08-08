---
name: due-reminder-dispatch
description: 供系统到期事件检查、通知并收尾已到时间的提醒。
disable-model-invocation: true
metadata:
  monagent:
    display_name: 到期提醒派发
    version: 1.0.0
    tools: [list_due_memos, dispatch_due_memos, get_next_memo_wake, contact_user, mark_memo_triggered]
    profiles: [self_awake]
---

- 先确认到期事项，再调用 contact_user 产生真实通知；通知成功后才能标记提醒已触发。
- 仅观察到期事项时，dispatch_due_memos 必须使用 mark_dispatched=false。
- 精准 memo_due 唤醒的状态回写由运行时统一完成，必须遵循本轮任务协议。
