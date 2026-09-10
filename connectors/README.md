# 连接器插件

`official/<id>/src` 保存 TS 业务实现，`package` 保存统一插件清单、连接器能力声明和游戏资产。宿主协调代码位于 `Server/src/modules/connectors`，只处理实例、版本、权限和声明式资源绑定。

```sh
npm run build:connectors
node Script/Project/package_connector.mjs --source /absolute/plugin-source /absolute/built-package
```

所有构建均产生 Node 单文件 worker 和完整内容校验清单。官方包写入 `dist/connectors/<id>`；安装后运行数据库保存的不可变包快照，源码变化不能替换已经批准的版本。安装、权限、组件启停和回滚由统一插件仓库所有，官方包没有免安装/免审批的执行路径。

新插件使用 `@eden/plugin-sdk/connector`：定义 `ConnectorDefinition`，返回会话的 `health/query/execute/close`，通过 `context.publish` 发布声明过的事件。文件通过 `settings.<字段>` 声明后挂载，HTTP/TCP 通过固定目标桥接，凭据仅注入当前实例。增加第五个连接器不修改宿主或官方名称数组。

旧 Rust 源码已归档到 `Archive/2026-09-10-rust-connectors`。当前隔离执行仍要求 Linux bubblewrap/prlimit。Victoria 3 控制探针已有 TS/PowerShell 实现，但 Windows 宿主连接器隔离尚不支持，不能把源码和模拟测试视为跨平台输入验收。游戏模组和 OpenTTD Squirrel 桥接资产继续保留。
