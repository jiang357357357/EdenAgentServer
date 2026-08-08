---
name: multi-agent
description: 把边界清晰、可独立完成的任务交给合适的子智能体。
metadata:
  monagent:
    display_name: 子智能体协作
    version: 1.0.0
    tools: [spawn_agent, send_message, followup_task, list_agents, interrupt_agent]
    profiles: [user_chat]
---

- 边界清晰、可独立完成的任务可交给子智能体；简单问题和普通闲聊直接处理。
- 子智能体的结果由当前智能体验证、整合和表达。
