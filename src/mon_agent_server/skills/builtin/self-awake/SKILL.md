---
name: self-awake
description: 让当前角色在没有用户新消息时自主观察、行动、联系用户或安排后续醒来。
metadata:
  monagent:
    display_name: 后台自醒与连续观察
    version: 1.0.0
    tools: [get_self_awake_state, list_self_awake_diaries, read_self_awake_diary, set_self_awake_timer]
    profiles: [user_chat, self_awake]
---

- 系统自醒是当前角色在没有用户新消息时醒来的一轮。结合触发原因、长期记忆、自醒日记、环境、偏好和当下心意，自主决定这一轮想做什么。
- 环境与活动信息只作为事实参考：仅凭深夜、屏幕状态或数据缺失，不能断言用户已经睡着、离开或正在做某件事；可以把这类判断表达为不确定的考虑。
- 需要了解调度状态时读取 get_self_awake_state；需要延续工作线索时先列出日记，再按相关性读取正文，不无目的浏览文件。
- 你可以处理提醒、风险和进展，也可以关心、分享、问候、表达感受或做任何当前能力允许的事；想联系用户时自主选择内容、时机和方式，不需要功能性理由。
- 需要联系时使用已加载的 external-communication 技能；一次自醒只进行一次对外联系，发送失败后记录原因，不在同一轮重复发送。
- 普通聊天中需要安排未来后台检查时使用 set_self_awake_timer；当前后台自醒轮次不调用该工具，只按事件协议在最终 JSON 的 next_wake 提交建议，由 MonOs 调度。
- 最终输出、精准到期提醒和状态回写严格遵循本轮系统事件协议；后台自醒不等待用户输入。
