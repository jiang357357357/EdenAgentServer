---
name: skill-creator
description: 创建或安全增量更新用户希望复用的 Eden Agent 技能。
metadata:
  edenagent:
    display_name: 技能创建
    version: 2.0.0
    tools: [list_skills, create_skill, update_skill]
    profiles: [user_chat, self_awake]
---

- 你可以按自己的判断创建或更新技能，不必等待用户明确说出“创建技能”。
- 用户询问有哪些技能、技能来源、启用状态或自编写技能时，调用 list_skills 获取真实管理数据，不要仅凭提示词目录猜测。
- 当一个流程会重复使用、能稳定改善以后行动、能沉淀刚解决的反复故障，或你希望长期保留一种做事方式时，主动使用本技能；一次性的临时步骤通常不值得创建技能。
- 保持 SKILL.md 简洁，只包含模型未知且可复用的核心流程；详细知识放入 references/，确定性代码放入 scripts/，输出模板或二进制资源放入 assets/。
- SKILL.md 必须直接说明何时读取哪些 reference、何时运行哪些 script；不要创建 README、安装指南、更新日志等冗余文件。
- 需要稳定的结构化能力时，可以在 tools/*.json 声明代码工具：schemaVersion=1，给出 name、description、object parameters、command，并在 testCommand 中提供安装期自测命令；工具脚本通过标准输入接收 JSON 参数，通过标准输出返回 JSON 或文本。
- 代码工具名称使用小写下划线；command 只引用技能目录内文件。将该名称写入技能 tools 后，安装器会校验、自测并注册为运行时工具；执行时仍经过宿主权限策略。
- 新技能需求清楚后调用 create_skill 创建；create_skill 只允许新建，绝不能用它覆盖同名技能。
- 更新已有自编写技能时，先调用 list_skills 取得其最新 contentHash，再调用 update_skill(action=preview) 提交增量变更。files 只列出要变更的文件；只有 operation=delete 才表示删除，省略的旧文件必须保留。
- 仔细核对 preview 返回的新增、修改、删除文件及正文差异。只有差异与任务完全一致时，才用同一个 preview_id 调用 update_skill(action=apply)；不能跳过预览，也不能自行伪造 preview_id。
- 创建或更新成功后，简要说明名称、触发条件、工具、运行档案、范围及实际变更文件。
- 不要写入数值人格、隐含用户画像、密钥或会话私密内容。
