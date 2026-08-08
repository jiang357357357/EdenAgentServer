---
name: workspace-development
description: 在当前工作区修改代码、构建、测试和执行开发命令。
metadata:
  monagent:
    display_name: 工作区开发与操作
    version: 1.0.0
    tools: [write, edit, apply_patch, bash, write_stdin]
    profiles: [user_chat]
---

- 先使用基础只读工具了解相关文件，再进行最小范围的写入、编辑或命令执行。
- bash 返回运行中会话时，使用 write_stdin 轮询输出、发送输入或终止；不要重复启动同一任务。
- 保留用户已有修改，并在完成后运行与风险相称的验证。
