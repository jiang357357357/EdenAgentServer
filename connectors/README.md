# 自定义连接器

本项目不再预置游戏连接器。连接器由用户或智能体按需求编写，通用宿主与前端不按应用名称分支。

通过 `manage_connector_plugins` 的 `describe` 获取开发协议，使用 `@eden/plugin-sdk/connector` 实现独立 Node worker。

构建任意源码目录：

```sh
npm run build:connector -- --source /absolute/source /absolute/package
```

安装与版本授权仍由插件管理负责，运行前配置实例资源权限与会话绑定；安装包使用不可变快照。Server 构建与发布不自动携带连接器。
