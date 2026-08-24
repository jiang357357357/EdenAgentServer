---
name: daily-context
description: 查询节日、农历、特殊日期、实时天气和出行影响。
metadata:
  edenagent:
    display_name: 日历天气与生活环境
    version: 1.0.0
    tools: [get_calendar_context, get_weather]
    profiles: [user_chat, self_awake]
---

- 询问天气、温度、降水或出行影响时使用 get_weather。
- 询问节日、农历、纪念日或近期特殊日期时使用 get_calendar_context。
