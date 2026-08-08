---
name: assistant-switching
description: 查看可用助手，或将当前会话立即切换给指定助手。
metadata:
  monagent:
    display_name: 助手查看与会话切换
    version: 1.0.0
    tools: [list_assistants, switch_session_assistant]
    profiles: [user_chat, self_awake]
---

- 只有用户明确要求切换或接手当前会话时才切换；目标 ID 不明确则先调用 list_assistants。
- 确定目标 ID 后，下一步必须调用 switch_session_assistant；调用前不要使用角色动作或输出最终回复，也不要用“去叫、稍等、转交”等文字代替切换。
- 工具接受交接后你仍是原助手：简短结束本轮，不得冒充目标助手；你的回复完成后系统才会切换参与者，并由目标助手在独立运行中接手。历史会保留，不修改全局默认助手。
