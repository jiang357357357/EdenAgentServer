/** Public authoring contract, shared by UI and connector development discovery. */
export function pluginBackendGuide() {
  return {
    nodeVersion: process.versions.node,
    environment: '运行时描述中的 command=node 由宿主选择所提供的 Node；终端 PATH 中的 node 不保证存在。可以直接编写使用 Node 标准库的后端，无须先在终端探测 Node 或扫描系统目录；安装后经用户授权，使用真实工具调用验收。',
    localBusiness: '需要独立本地业务后端时，可以在同一统一包中组合 UI 和 mcp_stdio 运行时。纯 JavaScript MCP 后端可直接使用随产品提供的 Node，无须寻找源码仓库、package_connector.mjs 或另装 npm SDK。连接器是另一种协议，不要把其构建要求套用到 MCP。',
    package: {
      components: { runtimes: [{ id: 'backend', kind: 'mcp_stdio', manifest: 'runtime.json', enabledByDefault: true }] },
      permissions: [{ capability: 'process.execute', resource: 'node', access: 'execute', required: true, description: '运行插件的独立本地后端' }],
      note: '将上述字段合并进现有 plugin.json，保留 UI 组件和其他必要声明。组件 id 自行命名。',
    },
    descriptor: { schemaVersion: 1, command: 'node', args: ['/package/backend.mjs', '<持久数据目录的真实绝对路径>'], cwd: '.' },
    storage: 'args 中的占位符必须替换为当前选定工作区内自选数据目录的真实绝对路径。后端从 process.argv[2] 读取目录并创建业务存储，可使用 node:sqlite。/package/ 表示宿主物化的包文件；安装快照和 cwd 会替换或清理，不得保存持久业务数据。Node 按当前 OS 账户权限运行；不要读取其他安装或个人文件来寻找构建工具。',
    protocol: {
      framing: 'stdin/stdout 每行一条 UTF-8 JSON-RPC 2.0 消息。响应回显请求 id。stdout 只能输出协议消息，诊断写 stderr。可以使用 node:readline 读取；这不是连接器的长度前缀帧协议。',
      initialize: 'initialize 返回 result={protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:<后端名称>,version:<插件版本>}}。收到 notifications/initialized 不发送响应。',
      catalog: 'tools/list 返回 result={tools:[{name,description,inputSchema}]}；inputSchema 是描述实际业务参数的 JSON Schema object。工具名称、动作和业务表结构由需求决定。',
      call: 'tools/call 请求 params={name,arguments}；返回 result={content:[{type:"text",text:<业务结果JSON字符串>}],structuredContent:<业务结果>}。业务失败设 isError:true；协议错误使用 JSON-RPC error。工具列表只能声明已实现的操作。',
    },
    ui: {
      capability: 'ui.json capabilities.tools 声明 call_mcp_tool。',
      bridge: 'host.callTool("call_mcp_tool",{runtimeId:"<插件id>:<运行时组件id>",name:"<MCP工具名>",arguments:{...业务参数}})。runtimeId 由自己的 plugin.json 业务 id 和组件 id 组成，不使用内部修订号。',
      result: '先检查返回结果的 isError，再读取 structuredContent；无结构化结果时解析 content 中的文本。显示加载、空数据、错误和未授权状态，保留宿主／后台返回的具体错误，不把所有错误归为跨域或未授权。后台不可用时不要悄悄切换另一份 localStorage、内存或示例数据冒充真实存储；用户明确选择的离线模式须标明存储来源。确认回执后更新界面；取消或断线结果未知时，不自动重试写操作。',
    },
    approval: 'manage_ui_plugins 的 install 默认完成安装与启用：宿主按当前权限模式申请并记录当前版本的必需权限及已启用后台实际需要的进程／网络权限，完全访问下自动通过，不必让用户再去管理页勾选。enabled:false 仅安装，不授权、不启动；之后 enable 完成授权和启用。enableComponents:[组件id] 可明确启用原本关闭的组件；未指定的关闭组件保持关闭。必需后台应设置 enabledByDefault:true，权限 required:true；不要为绕过授权把它们改成关闭或可选。授权失败如实报告并保留停用状态，不自行改数据库。安装回执 backend.state=ready 才表示后台就绪，starting/failed/disabled 均不能当作业务成功；仍须实际调用验证。',
    verification: '完成检查与安装后，先核对授权和 MCP 运行状态，再验证实际读写、关闭重开后的恢复。卸载默认保留工作区中的业务数据。缺少工具或协议时说明具体缺项，不扫描系统或个人目录。',
  }
}
