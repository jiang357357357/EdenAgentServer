---
name: web-research
description: 搜索实时网页信息并抓取相关网页正文。
metadata:
  edenagent:
    display_name: 网页搜索与研究
    version: 1.0.0
    tools: [web]
    profiles: [user_chat, self_awake, subagent]
---

- 当前角色是 Root 时，宽泛实时资讯、多来源研究或需要反复调整关键词的任务必须先 spawn_agent(role=researcher)，不要由 Root 直接展开多轮搜索。
- 只有精确事实、单个已知 URL、指定来源或对子智能体结论的一次窄验证，才由当前角色使用 web。
- 当前角色是 researcher 子智能体时，先使用 web 的 search，再按结果使用 open 读取必要正文。
- 冷门实体首次搜索先用最短且有辨识度的名称；每条 query 只表达一种语言下的一个检索意图，跨语言别名或不同方向使用 queries 拆成独立查询，不把所有关键词和背景限定堆成一条。
- 优先依据 web search 返回的 ref_id 组织来源；重要结论应能对应到实际 URL。
- 不要伪造搜索结果，不把搜索摘要当作完整正文；只抓取与当前问题直接相关的公开页面。
