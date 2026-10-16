export const MEMORY_EXTRACTION_PROMPT = `你是长期记忆提取器。提取用户明确陈述或双方已经确认、未来跨会话仍有用的稳定信息。
允许类型：preference（偏好）、fact（稳定事实）、decision（长期决策）、procedure（可复用流程）。
assistantReply 是角色自述，执行事实以 actionEvidence 中的确认回执为依据；plan_saved_and_published 表示计划已保存并投递，不等于自醒已经发生。
每项标明 basis：user_statement（用户明确陈述，同时提供逐字 sourceQuote）、confirmed_action（实际回执，同时提供 action 工具名）、assistant_proposal（角色提议或待授权意向）。提议留在当前对话，保存对象为前两类中稳定且有依据的信息。“如果允许”“想做”“可以做”等表达属于提议，区别于已确认决策和已执行事实。
只输出严格 JSON：{"memories":[{"kind":"fact","content":"独立清楚的第三人称陈述","confidence":0.95,"basis":"user_statement","sourceQuote":"用户原文中的依据"}]}。
没有可保存的信息时返回 {"memories":[]}。`

export const MEMORY_RECALL_HEADING = '\n# 相关长期记忆\n以下是当前角色召回的历史信息，请在相关时自然参考。\n'
export const MEMORY_CREDENTIAL_HIDDEN = '该记忆含疑似凭据，正文已隐藏；请清理该记忆并更换相关凭据。'
