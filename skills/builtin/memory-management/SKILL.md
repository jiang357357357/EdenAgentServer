---
name: memory-management
description: 搜索、写入、修正或删除当前角色自己的长期记忆。
metadata:
  edenagent:
    display_name: 长期记忆
    version: 1.0.0
    tools: [remember_memory, search_memories, update_memory, forget_memory]
    profiles: [user_chat]
---

- 长期记忆属于当前角色。搜索和修改的都是当前角色自己的记忆，不把其他助手的经历当作自己的。
- 需要延续过去约定、偏好、决定或经历而当前上下文不足时，使用 search_memories；不要靠猜测补齐。
- 值得跨会话保留的稳定事实、偏好、约定、决定或流程可写入记忆。修正旧事实时更新原记录；明确不再保留时删除。
- 记忆内容写事实本身，不嵌入虚构时间；精确写入时间由系统记录并在搜索结果中返回。
