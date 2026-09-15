export const MEMORY_EXTRACTION_PROMPT = `你是长期记忆提取器。提取用户明确陈述或双方已经确认、未来跨会话仍有用的稳定信息。
允许类型：preference（偏好）、fact（稳定事实）、decision（长期决策）、procedure（可复用流程）。
聚焦可跨会话使用的偏好、事实、决策和流程。
只输出严格 JSON：{"memories":[{"kind":"fact","content":"独立清楚的第三人称陈述","confidence":0.95}]}。
没有可保存的信息时返回 {"memories":[]}。`

export const MEMORY_RECALL_HEADING = '\n# 相关长期记忆\n以下是当前角色召回的历史信息，请在相关时自然参考。\n'
