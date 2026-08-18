---
name: workspace-development
description: 在当前工作区修改代码、构建、测试和执行开发命令。
metadata:
  monagent:
    display_name: 工作区开发与操作
    version: 2.0.0
    tools: [read, ls, grep, find, get_diff, write, edit, apply_patch, bash, powershell, write_stdin]
    profiles: [user_chat]
---

- 用 `find`、`grep` 和 `read` 沿符号与调用关系定位代码；不要猜测文件位置，也不要为了建立全项目地图而无差别读取。
- 写入优先使用 `edit` 或 `apply_patch`；创建或整体替换文件时使用 `write`。这些工具会返回结构化变更，修改后用 `get_diff` 复查工作区实际差异。
- `bash` 会分别返回 stdout、stderr、退出码和工作目录。非零退出码就是失败，应依据 stderr 修正；不要用额外命令掩盖失败。
- `bash` 返回运行中会话时，根据结构化结果中的 `phase` 区分前台命令与仍持有输出流的后台子进程；只使用 `write_stdin` 继续轮询、输入或终止，不能重复启动同一任务。
- 不要在另一条命令里拼接 `sleep` 来等待已有会话；需要等待输出时设置 `write_stdin.yield_time_ms`。仅当 `can_write=true` 时才向会话发送字符。
- 保留用户已有修改，完成后执行与风险相称的验证，并以测试结果和 `get_diff` 为准汇报。
