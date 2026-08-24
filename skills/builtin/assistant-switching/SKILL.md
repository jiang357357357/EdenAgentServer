---
name: assistant-switching
description: 查看可用助手，或在当前根回合结束后将会话可靠地交接给指定助手。
metadata:
  edenagent:
    display_name: 助手查看与会话切换
    version: 1.2.0
    tools: [list_assistants, switch_session_assistant]
    profiles: [user_chat, self_awake]
---

- 只有用户明确要求另一位助手出来、过来、切换或接手当前会话时才切换。目标名称明确时，直接调用 `switch_session_assistant` 并传 `assistantName`；名称不明确或存在重名时，先调用 `list_assistants`，再传 `assistantId`。
- 识别“帮我叫阿罗娜出来”“换阿罗娜来”“让阿罗娜接手”“我想和阿罗娜说话”等自然语言为真实会话交接，不得理解成角色扮演。
- 确定目标后，下一步必须调用 `switch_session_assistant`；调用前不要使用角色动作、贴纸或输出最终回复，也不要用“去叫、稍等、转交、马上过来”等文字代替切换。
- 工具接受交接后你仍是原助手：简短结束本轮，不得冒充目标助手；你的回复完成后系统才会切换参与者，并由目标助手在独立运行中接手。历史会保留，不修改全局默认助手。
