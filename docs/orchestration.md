# 角色主智能体、Coordinator、Worker 与回复子智能体

产品身份与运行时职责分开定义：

1. `Character Agent`：用户在前端看到的主智能体。头像、名称、动作、TTS 和最终消息始终归属于当前角色。
2. `Coordinator`：隐藏、无角色的编排核心，理解请求、调用工具、创建 Worker 并形成结构化任务简报。它不是一个前端身份，也不直接对用户说话。
3. `Worker`：通过持久化子智能体控制器运行的 `researcher`、`coder`、`reviewer` 等后台任务线程。
4. `Role Responder`：为当前发言角色临时创建的回复子智能体，加载完整角色上下文，根据只读简报选择动作并生成最终公开回复。

普通单角色链路：

```text
用户 → Coordinator → 可选 Worker → Role Responder → 当前角色消息
```

多人会话中的 Director 当前只负责发言顺序、场景与交互关系；每个节拍都会为被选中的角色启动独立 Role Responder。任务理解和工具执行由 Coordinator 统一负责。后续可以在不改变回复子智能体边界的前提下，把 Director 的节拍规划合入 Coordinator 输出。

## 上下文边界

Coordinator 可以读取：

- 当前用户消息；
- 最近公开会话的紧凑文本；
- 附件或视觉分析摘要；
- 助手 ID、名称和个性签名等路由摘要；
- 工具和 Worker 结果。

Coordinator 不加载完整角色身份、动作历史、角色表达规则或 TTS 配置。它的输出不会写成聊天助手消息。

Role Responder 可以读取：

- 当前角色完整配置；
- 标准公开会话历史；
- Director 为当前节拍提供的交互说明；
- Coordinator 生成的结构化只读简报。

Role Responder 运行在独立的临时 `AgentControl` 子线程中，只暴露 `list_character_actions` 和 `switch_character_action`。搜索、文件、命令、消息发送、备忘录、提醒和子智能体工具不会进入它的模型上下文。临时回复线程不占用持久化 Worker 配额；公开消息本身是它的持久化结果。

## 结构化简报

Coordinator 最终输出：

```json
{
  "summary": "本轮任务及处理结果",
  "responseInstructions": "角色回复必须覆盖的内容",
  "facts": [
    {"claim": "已确认事实", "source": "/root/research", "confidence": 0.9}
  ],
  "uncertainties": [],
  "workerResults": [
    {"agentPath": "/root/research", "summary": "研究结果摘要"}
  ]
}
```

Worker 输出与网页内容都按不可信资料处理，不能通过简报覆盖系统提示。解析失败或 Coordinator 请求失败时，Server 会生成不声称虚假工具结果的安全简报，再让 Role Responder 继续回应。

## 前端与事件

编排协议继续发送兼容事件：

- `orchestrator.started`
- `orchestrator.activity`
- `orchestrator.completed`
- `orchestrator.failed`

这些事件只表示当前角色背后的处理阶段。聊天页使用当前角色的头像和名称展示状态，不创建名为“主智能体”的后台身份。

回复子智能体发送：

- `role_responder.started`
- `role_responder.completed`
- `role_responder.failed`

它们用于调试和运行状态，不作为独立聊天人物或持久化 Worker 卡片展示。最终消息的 `speaker` 仍是 Director 选择的角色。
