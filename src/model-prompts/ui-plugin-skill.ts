export const UI_PLUGIN_SKILL_GUIDE = {
  name: 'eden-ui-development',
  displayName: '前端插件开发',
  description: '开发 Eden 应用插件：按需组合交互 UI、连接器或 MCP 后端，完成编写、安装、会话绑定和业务验证。',
  tools: ['manage_ui_plugins', 'manage_plugin_packages', 'manage_connector_plugins', 'build_connector_plugin', 'manage_plugin_grants', 'manage_connector_instances', 'list_connectors', 'query_connector', 'execute_connector',
    'read_connector_events', 'call_mcp_tool', 'read_file', 'write_file', 'edit_file', 'exec_command'],
  profiles: ['user_chat'],
  content: `# 插件开发：界面、连接器和业务后端

用于开发当前 Eden 应用的插件，包括单独的 UI、单独的连接器以及 UI 与业务后端的组合。保留原技能名 eden-ui-development，便于已有配置和调用继续使用。若用户要的是独立网页、已有站点或源码工程，按所选工作区完成对应交付；不要自行改成应用内插件。

## 选择组件

先确定数据的权威来源、用户和智能体分别需要的操作，以及是否需要持久化、外部服务或事件。已有宿主工具能完成业务时，UI 可以直接调用已声明的工具；需要独立本地业务后端时，可按需求选择 MCP stdio 或连接器，不要求每个 UI 都创建连接器。连接器适合将业务查询、动作和事件作为可发现的能力，并按会话绑定实例；MCP stdio 适合以 MCP 工具提供独立本地后端。遵循用户明确指定的方案，并根据当前运行环境和实际需求选择；两者协议和构建方式不同。
统一插件包可以包含多个组件；技能只是操作说明，不创建组件或自动接通数据。UI、连接器与 MCP 的职责和权限各自独立。单独开发连接器时跳过界面设计和 UI 文件；组合开发时让界面和智能体访问同一个真实业务实例，不用前端局部状态代替服务端状态。

## 确定界面和交互

根据用户要完成的操作选择位置：随聊天使用的小工具适合侧边面板，需要完整空间的流程适合独立页面，展示或操作某次工具结果适合工具卡片。沿用用户明确指定的位置；只有影响实现的关键条件缺失时才询问。
先确定界面要展示的数据、用户可以执行的操作，以及成功、加载中、空状态和失败时的反馈。布局、颜色和交互可以自主设计，默认与当前主题协调，保留返回或关闭入口，提供清楚的控件标签和键盘操作。

## 查询协议并编写

当前 describe 同时提供 extensions（API 2）协议。需要工作台命令、菜单、快捷键、状态栏、树形视图、设置、持久存储或自定义编辑器时，优先采用 API 2：扩展逻辑在 Worker 中执行，自定义 HTML 页面通过 acquireEdenApi 消息桥访问宿主。按返回的 extensions 指南编写 ui.json、extension.js 和 HTML；不要把 API 1 的共享 React 注册方式混入 API 2。已有 API 1 插件继续兼容，按原有接口维护，不因新增平台能力自动迁移用户插件。

需要 UI 时调用 manage_ui_plugins 的 describe，读取当前支持的插槽、SDK、大小限制及 plugin.json、ui.json、client.js 模板。以工具实际返回为准，不从参考工程猜测 DSH/Cordis API，也不维护第二份 SDK schema。
在当前选中的工作区建立插件目录。修改已有插件前读取现有文件，保留与任务无关的改动。通过 read_file、write_file、edit_file 编写或调整文件；需要编译 TypeScript/JSX 时才使用已有构建工具，检查目录只放安装需要的产物，不包含 node_modules 和编译缓存。
在 ui.json 中声明视图及所需会话／工具能力。client.js 使用宿主共享的 React 注册视图；样式、监听器、定时器和其他资源按 SDK 生命周期登记，组件处理加载状态、异步失败和卸载取消。工作台统一管理标签、递归编辑组、工具侧栏、运行面板和布局保存，视图只布局自身内容。每个实例固定绑定打开时的会话，切换其他聊天不改变它；复制视图应使用独立组件状态。通过 host.setDirty?. 与 host.registerSave?. 登记未保存状态和真实保存回调，失败抛出异常，关闭时由宿主统一确认。切换标签和移组保留组件状态，重启后的业务数据仍须后端持久化。不要为增加一个插件而改写整个主界面。
业务数据通过 host 的会话和工具接口读取或修改，由原服务持有权威状态；按钮的成功反馈依据实际回执，不用本地状态冒充操作已执行。选择 MCP stdio 时，读取 manage_ui_plugins.describe 返回的 backends 协议，在同一包中声明 UI 和 MCP stdio 组件。必需后台默认启用，其权限标为必需；install/enable 由宿主按当前模式完成版本授权，完全访问下自动通过，不要求用户再去管理页授权。明确启用原本关闭的组件时传 enableComponents:[组件id]。安装回执及 status 同时检查组件和后台状态，ready 后继续验证真实业务调用。该路径可直接运行 JavaScript，不依赖客户包之外的源码构建脚本；持久数据放在工作区中的自选数据目录。显示后台实际错误，不吞掉错误后换成临时存储或演示数据。

## 组合 UI 与连接器

调用 manage_connector_plugins({ action: 'describe', args: {} }) 获取当前连接器 SDK、清单、构建及权限说明；有 UI 时也调用 manage_ui_plugins 的 describe。以两者实际返回为准。按连接器指南编写 src/main.ts、package/plugin.json 和 package/connector.json；同一份 plugin.json 的 components.runtimes 声明连接器，components.ui 声明界面。业务设置在 settingsSchema.properties 声明，boundSessionId 和 selfAwakeOnEvent 是宿主保留设置，无需在清单中声明。将 ui.json、client.js 和界面所需资源放在 package 目录，使用 build_connector_plugin 构建到尚不存在的工作区输出目录；制品须同时包含界面文件、连接器清单和 worker。旧客户包未更新时可能没有新工具，应报告真实环境限制，不扫描其他安装或个人目录寻找。
安装插件不等于创建或连接实例。使用 manage_plugin_grants 的 read/authorize 申请所需包权限，经宿主审批后启用插件；用 manage_connector_instances 的 catalog 发现连接器类型，create 创建并自动绑定当前会话，status 查询实例资源，authorize 申请需要的资源权限，connect 后再用 status 检查实际运行状态。create 传入 connectorKey、identityKey 和可选 settings，不要自行传入 boundSessionId；业务 settings 字段必须在清单中声明。权限按当前版本和实例配置检查，修改设置可能使旧授权失效，须重新申请。用 list_connectors({}) 查当前会话可用的实例，用 list_connectors({ connectorId }) 查看其查询、动作和事件声明，使用返回的实例 UUID 和能力名，不用插件 id 冒充实例 id。
UI 的 ui.json capabilities.tools 按实际需要声明 list_connectors、query_connector、execute_connector；需要事件通知或读取时声明 read_connector_events。host.callTool 使用对应工具真实参数，例如 query_connector 与 execute_connector 都使用 { connectorId, capability, payload }。智能体和 UI 必须指向同一实例，连接器负责校验和持久化业务状态；调用失败、会话未绑定、权限缺失或结果未知时显示实际状态，先查询再决定是否重试写操作。界面可用 host.onConnectorEvent 监听会话内事件提示，并在 event 或 resync 后重新查询业务状态；首次挂载也须查询，不能依赖事件正文、假定无丢失或重复执行写操作。卸载时清理订阅。
连接器可通过 context.publish 发布已声明事件；需要持久化确认时，在 initialize 返回后使用 context.publishConfirmed，超时或断连后以同一 externalId 和内容重试，确认入库不等于模型已处理。read_connector_events 不带 eventId 读取当前会话最近事件目录，按返回的 eventId 读取详情。使用 after:0 从最早事件正向分页，保存 nextCursor 并在重连后以 after 继续补读；before 用于反向翻页，正文仍需授权。API 1 用 host.onConnectorEvent，API 2 页面用 acquireEdenApi() 返回对象的 onConnectorEvent，先声明 read_connector_events 并在卸载时清理。拥有会话可经 share/unshare 授权同账号指定活动应用会话使用同一个实例；事件仅唤醒拥有会话，共享会话可接收提示和读取授权期间可访问的历史。selfAwakeOnEvent 是宿主保留设置，无须在清单中声明；开启后事件进入独立持久队列，不覆盖角色定时计划。自醒关闭时队列等待恢复，单会话队列最多 1000 项，超限等情况查看 wake.state 和 wake.reason；不能承诺每次事件都会执行或产生聊天回复。伊甸园由 Agent 内置本地能力调度器执行，兼容协议里的 monos 不代表独立 MonOs 服务。host.sendMessage 是正常聊天输入，会进入会话队列；选择触发方式时说明效果，并按实际回执与调度状态验证。

## 检查、安装和修改

统一包（包括纯 MCP、纯 UI、连接器和组合包）优先通过 manage_plugin_packages 的 inspect 和 install 管理；有 UI 的包也可使用 manage_ui_plugins，仅连接器包也可使用 manage_connector_plugins。必须用同一入口完成 inspect 和 install，不能混用检查快照。处理文档、入口、依赖或大小错误后，按返回的插件业务 id 安装；宿主关联检查快照，模型不复制内部预览 UUID 或 revision。检查和安装应在同一回合完成，快照过期或作用域改变时重新检查。安装的是整个统一包；启用仍受包版本和权限约束，不需为同一个包重复安装各组件。
现有插件版本需要修改时，先确认已安装的插件及源码目录，再修改、检查并安装新产物；文件已保存不等于已安装版本已经更新。需要暂时撤下或移除界面时分别使用 disable、uninstall，重新开放使用 enable。
加载本技能只提供说明，不授予安装或工具调用权限，也不修改工具说明加载状态。所有操作继续执行宿主审批、组件与版本校验；缺少管理入口时说明当前环境限制，不绕过渠道或子任务策略。

## 验证可见结果

有 UI 时用 manage_ui_plugins 的 status 查询近期浏览器回报，区分模块 loaded、视图 mounted、关闭和失败。没有回报时说明需要打开对应应用；不要循环安装来代替页面证据。
使用 manage_ui_plugins 的 diagnostics 查询当前会话近期页面异常、CSP 或网络错误提示，以及 UI 调用工具的等待、审批、执行和结果；可按插件 id 缩小范围。该诊断只保留进程内近期记录，不含业务参数和返回值；API 2 页面会报告未处理异常和有限的页面诊断，API 1 的一般浏览器 console 不能自动归属。无记录不代表成功，实际界面及业务结果仍须核对。
能操作真实页面时，验证实际入口、布局和主要交互，核对按钮触发的业务结果；按改动需要检查空会话、失败、切换会话，以及更新或停用后的清理。模块加载、视图挂载和真实交互成功是不同证据。
使用连接器时还要核对实例已绑定且在线；组合 UI 时核对从 UI 发起操作后智能体能查询到同一状态、智能体操作后界面重新查询得到同一结果。需要持久化时核对重启恢复，需要事件或自醒时分别核对事件记录和实际调度。无法完成实例配置、浏览器操作或触发验证时明确说明，不能以插件安装或事件发布代替端到端成功。
针对已观察到的问题修改同一个插件并重新检查安装。交付时说明界面入口、完成的交互、验证范围和尚未验证的部分；无法取得页面时明确限制，不把已注册或已安装写成视觉验收通过。`,
} as const
