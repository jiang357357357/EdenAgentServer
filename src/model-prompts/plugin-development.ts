import { pluginBackendGuide } from './plugin-backends.ts'

export function connectorPluginGuide() {
  return {
    sdk: '连接器 SDK 位于 @eden/plugin-sdk/connector，提供 ConnectorDefinition、runConnector、ConnectorContext、bridgeHttp、followLog。',
    source: '在 src/main.ts 中导入 runConnector，并调用 await runConnector(definition)。definition 包含 id、version、events、queries、actions、initialize(context)，并返回 health()、query(call)、execute(call)、close()。',
    package: 'package/plugin.json：包含 schemaVersion=1、id/name/description/version、components.runtimes=[{id,kind:"connector",manifest:"connector.json"}] 和 permissions。package/connector.json：包含 runtime="node"、entrypoints.node={path:"worker/main.mjs",args:[]}、id/name/description/icon/version、settingsSchema、permissions、events/queries/actions。',
    sessionBinding: '业务设置按 settingsSchema.properties 严格校验。boundSessionId 和 selfAwakeOnEvent 由宿主保留，无需在清单中声明；创建时自动绑定当前会话，需要事件触发时可设置 selfAwakeOnEvent=true。拥有会话可经审批共享给同账号其他活动应用会话。安装包不会创建或连接实例。',
    build: '优先调用 build_connector_plugin({source:<源码目录>,output:<尚不存在的工作区目录>})，由宿主提供连接器 SDK 并打包依赖及 package 文件；构建需审批，不覆盖现有输出。源码开发环境也可使用 node Script/Project/package_connector.mjs --source <source-root> <built-package-root>。旧客户制品可能没有新工具，不能假定它已更新；仅需独立本地业务后端时可选择 backends 的 MCP stdio 协议。',
    ui: '可在同一 package/plugin.json 同时声明 components.runtimes 中的连接器和 components.ui 中的界面，并将 UI 文件放入 package 目录参与构建。组合开发和实例绑定流程见内置技能 eden-ui-development；当前 UI SDK 及模板以 manage_ui_plugins.describe 为准。',
    backends: JSON.stringify(pluginBackendGuide()),
    test: '使用 WorkerFrameReader/encodeWorkerFrame 和宿主进程运行器编写 node:test。覆盖 initialize/health/query/execute/event/shutdown、分段帧、错误身份、取消和资源拒绝场景；夹具使用临时目录。',
    workflow: '编写源码和清单；构建；inspect({path:built-package-root})；在当前回合用检查结果中的包 id 执行 install({id})；manage_plugin_grants 读取并申请包权限；enable({id})；manage_connector_instances 的 catalog、create、authorize、connect 和 status 配置当前会话的实例。各审批和版本校验由宿主执行。安装、授权、实例启动和业务操作成功是不同状态。',
    runtime: 'initialize(context) 的 dataDirectory 是实例的持久目录；context.publish 是兼容旧版的单向通知，不表示已落库。需要持久化回执时，在 initialize 返回之后 await context.publishConfirmed(eventType,externalId,payload)，收到 id/jobId/duplicate 才表示宿主已接受；超时或通道中断结果未知，用完全相同的 externalId 和内容重试，不要生成新的 ID。初始化尚未完成时不可等待确认发布。事件可声明受支持的 JSON Schema 来校验 payload，旧的空声明仍兼容。可抛出 ConnectorRequestError(code,message) 返回适合用户查看的业务拒绝，切勿在消息放凭据；其他异常只显示通用错误。health 返回 {state:"ready",initialized:true}，query/execute 接收 {capability,payload,operationId}；业务状态和合法性由连接器实现。',
    example: JSON.stringify({
      plugin: { schemaVersion: 1, id: 'example.connector', name: 'Example', description: 'Example connector', version: '1.0.0',
        components: { runtimes: [{ id: 'backend', kind: 'connector', manifest: 'connector.json', enabledByDefault: true }] }, permissions: [] },
      connector: { id: 'example', name: 'Example', description: 'Example connector', icon: 'cable', version: '1.0.0', runtime: 'node',
        entrypoints: { node: { path: 'worker/main.mjs', args: [] } }, permissions: [],
        settingsSchema: { type: 'object', properties: { boundSessionId: { type: 'string', format: 'uuid' }, selfAwakeOnEvent: { type: 'boolean' } }, additionalProperties: false },
        events: { changed: {} }, queries: { get: { type: 'object', properties: {}, additionalProperties: false } },
        actions: { put: { type: 'object', properties: { text: { type: 'string', maxLength: 4096 } }, required: ['text'], additionalProperties: false } } },
      note: '示例只展示清单形状；按任务实现业务。queries/actions 的每项必须是支持的输入 JSON Schema，空参数用 type=object、properties={}，不能用空对象代替。UI 与连接器的组件 id 必须不同。',
    }),
    permissions: '连接器权限在 plugin.json 中声明。filesystem.read/write 资源引用 settings.<field>，宿主将获批设置解析成绝对路径。network 使用 connector.json 声明的端点桥，身份凭据通过 environment.read connector.identityCredential 提供。',
    limits: '请求队列最多 32 项，帧最大 8 MiB，事件缓冲有界，版本包快照不可变，运行于独立 Node 进程；网络通过已配置的端点桥访问。',
  }
}
