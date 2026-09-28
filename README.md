# Eden Agent Server

Eden Agent 的 TypeScript / Node.js 宿主，包含业务模块、JSON-RPC 服务及官方连接器插件。

本仓库作为主项目的 `Server/` Git 子模块使用。共享基础包位于主项目 `packages/`，构建脚本、锁文件和工程约束也由主项目管理；单独克隆本仓库不构成完整构建环境。

## 开发

```sh
git clone --recurse-submodules https://github.com/jiang357357357/EdenAgent.git
cd EdenAgent
npm ci --ignore-scripts
npm run build:server
```

在主项目根目录运行类型检查和测试：

```sh
npm run typecheck:server
npm run test:server
```

修改服务端后先在本仓库提交并推送，再在主项目提交 `Server` 子模块指针。共享 SDK 等改动需要与主项目配套提交。

## 终端保底界面

前端不可用但 Agent Server 仍在运行时，可用 `eden` 进入全屏终端工作台：

```sh
eden
eden --origin local
```

无参数默认连接 Mon 世界 `127.0.0.1:40092`；`--origin local` 连接本地世界 `127.0.0.1:40093`。源码入口位于 `Server/bin/eden`（Windows 为 `Server/bin/eden.cmd`），打包入口位于运行时的 `bin/eden`。可将对应的 `bin` 目录加入 PATH，或在 Linux 上把 `Server/bin/eden` 链接到 `~/.local/bin/eden`。TUI 优先从运行中的 Server 进程数据目录读取 `capability.token`，也可用 `--token-file /path/to/capability.token` 指定。Mon 世界的 Core 登录位于 TUI 首页：先输入用户名，再输入遮蔽显示的密码。登录后首页显示账号名，`/account` 查看身份、Core 地址和令牌来源；`/login` 切换账号，`/logout` 清除本地登录并请求 Core 退出，`/retry` 在服务暂不可用时重连。密码从不落盘，TUI 只把 Core 令牌和账号标识保存到当前 OS 用户的 `XDG_STATE_HOME/eden-agent/`（未设置时为 `~/.local/state/eden-agent/`），目录权限为 0700、文件权限为 0600；不同 Core 地址使用不同文件。下次启动会先向 Core 验证保存的令牌，失效后回到首页登录。`EDEN_AGENT_CORE_TOKEN` 或 `--core-token-file` 提供的外部令牌优先使用，不另行保存；外部令牌由提供方管理，TUI 的 `/logout` 不撤销它。

界面参考 OpenCode 的终端交互，默认进入大字标识与居中输入框的首页；登录与账号状态也留在首页。`--session UUID` 可直接打开指定会话。首页发送第一条文字才创建会话，`/home` 或 Ctrl+N 从会话返回新会话首页。首页的命令与会话菜单直接覆盖在首页，不切换到另一种布局。首页使用终端默认背景，若终端设置了背景图或透明效果，会从空白区域透出；TUI 自身不加载图片。会话页默认采用居中的单栏对话，隐藏侧栏，仅在有执行、审批、提问或模型问题时显示状态；Ctrl+B 可展开精简的近期会话侧栏。输入 `/` 会在输入框旁列出命令，继续输入可筛选，↑↓ 选择、Tab 补全、Enter 执行或补齐参数、Esc 关闭提示；发送以 `/` 开头的普通文字要输入 `//`。Enter 发送，Alt+Enter 或 Ctrl+J 换行，Ctrl+P 搜索命令，Ctrl+S 搜索会话，Ctrl+N 回到新会话首页，Ctrl+T 打开消息时间线，Ctrl+X 停止当前回合，Ctrl+D 展开工具参数，Ctrl+L 返回消息底部，PgUp/PgDn 滚动，Ctrl+C 退出。粘贴时会将整段文字放入输入区，避免其中的换行立即发送。

`/sessions`、`/use`、`/new`、`/rename` 管理应用聊天会话，`/older` 载入更早消息，`/timeline` 跳转到某条消息，`/status` 查看会话状态；`/details`、`/timestamps`、`/sidebar` 切换显示。TUI 打开 Mon 会话时会从 Core 模型目录同步该会话绑定；发送前再次确认模型可用。若尚未选择模型，`/models` 会列出 Core 已启用的模型，选择时显示会修改 Core 当前助手或角色设置的确认面板；未发送的消息保留在输入框，绑定完成后再按 Enter。尘世世界的模型仍由 Server 本地配置。`/stop` 取消当前回合，`/steer` 和 `/followup` 调整执行中的输入；`/permissions`、`/allow`、`/always`、`/deny` 处理审批；`/questions`、`/answer` 回答智能体提问。审批和选项会在界面面板中显示，可用方向键和 Enter 操作；“总是允许”通过界面操作时会再次确认，完整请求可单独查看。`/help` 显示完整命令。退出 TUI 不会停止 Server 或取消正在运行的回合；断线可输入 `/retry` 重连并恢复当前会话，TUI 不自动重发超时输入。

TUI 源码位于 `Server/tui/`，是独立终端入口，不导入当前 Web/Electron 前端，也不直接读写 Agent 数据库。`npm --workspace @eden/server run build:tui` 可单独构建 `dist/server/tui.mjs`；Server 运行时打包时包含该文件及 `eden` 启动器。图片、附件、摄像头和其他桌面媒体操作仍需现有客户端。

## 历史

当前 TS 实现在原 Rust 仓库历史之上继续提交。旧版本由主项目 `Archive/2026-09-09-rust-runtime/Server` 固定到原提交，不随当前 Server 更新。
