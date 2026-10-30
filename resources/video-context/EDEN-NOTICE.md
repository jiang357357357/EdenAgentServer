# Eden VideoContext 集成

源自 https://github.com/sakshamjain2301/videocontext-mcp
固定提交：b1495070863fc65372c986df52f992b9e5f40c02，MIT，许可证见 LICENSE。

src/ 为上游处理引擎；Eden 通过 TypeScript 内置工具管理输入、审批和作用域，
不暴露未经约束的 MCP 通道。Windows 子进程环境保留 SystemRoot/WINDIR，
修复 Whisper 工作进程的 WinError 10106。eden_entry.py 设置 Eden 的传输与
时限预算，使用当前 OS 账户权限运行，不创建 OS 沙箱。

依赖冻结于 requirements.txt；原始 uv.lock 保留用于来源追溯。
语音模型、FFmpeg 与 Python 由 setup_video_context.mjs 准备，不进入源码历史。
Whisper tiny 模型源自 https://huggingface.co/Systran/faster-whisper-tiny，
其原模型 MIT 许可见 WHISPER-LICENSE（https://github.com/openai/whisper/blob/main/LICENSE）。
Eden 入口直接组装服务，按当前 OS 账户权限运行，包括管理员账户；不使用上游 CLI 的 root 拒绝策略。
