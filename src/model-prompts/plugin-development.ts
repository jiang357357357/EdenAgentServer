export function connectorPluginGuide() {
  return {
    sdk: '连接器 SDK 位于 @eden/plugin-sdk/connector，提供 ConnectorDefinition、runConnector、ConnectorContext、bridgeHttp、followLog。',
    source: '在 src/main.ts 中导入 runConnector，并调用 await runConnector(definition)。definition 包含 id、version、events、queries、actions、initialize(context)，并返回 health()、query(call)、execute(call)、close()。',
    package: 'package/plugin.json：包含 schemaVersion=1、id/name/description/version、components.runtimes=[{id,kind:"connector",manifest:"connector.json"}] 和 permissions。package/connector.json：包含 runtime="node"、entrypoints.node={path:"worker/main.mjs",args:[]}、id/name/description/icon/version、settingsSchema、permissions、events/queries/actions。',
    build: '使用工作区命令 node Script/Project/package_connector.mjs --source <source-root> <built-package-root> 构建，并将运行依赖打入制品。',
    test: '使用 WorkerFrameReader/encodeWorkerFrame 和宿主进程运行器编写 node:test。覆盖 initialize/health/query/execute/event/shutdown、分段帧、错误身份、取消和资源拒绝场景；夹具使用临时目录。',
    workflow: '编写源码和清单；构建；测试 worker；inspect({path:built-package-root})；install({previewID})；在插件设置中配置版本权限；enable({id}) 后进入连接器发现目录。',
    permissions: '连接器权限在 plugin.json 中声明。filesystem.read/write 资源引用 settings.<field>，宿主将获批设置解析成绝对路径。network 使用 connector.json 声明的端点桥，身份凭据通过 environment.read connector.identityCredential 提供。',
    limits: '请求队列最多 32 项，帧最大 8 MiB，事件缓冲有界，版本包快照不可变，运行于独立 Node 进程；网络通过已配置的端点桥访问。',
  }
}
