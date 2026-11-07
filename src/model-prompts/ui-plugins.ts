import { pluginBackendGuide } from './plugin-backends.ts'
import { extensionPlatformGuide } from './extension-platform.ts'

export const UI_PLUGIN_TOOL_DESCRIPTION = '查询应用的前端扩展协议，检查、安装、启停或卸载工作区中的交互界面插件。status 区分客户端、视图与后台状态；diagnostics 可查看当前会话近期页面异常和 UI 工具调用阶段。组合开发流程见技能 eden-ui-development；安装使用检查快照并经过宿主审批。'

export function uiPluginGuide() {
  return {
    apiVersion: 1,
    extensions: extensionPlatformGuide(),
    backends: pluginBackendGuide(),
    connectors: '需要在同一插件包中组合 UI 和连接器时，读取内置技能 eden-ui-development 的组合开发流程，并调用 manage_connector_plugins({action:"describe",args:{}}) 获取连接器 SDK 和构建协议；实例须单独创建、授权并绑定会话。',
    workflow: ['在工作区编写 plugin.json、ui.json 和 client.js。',
      'inspect 使用工作区相对目录或绝对目录，例如 {action:"inspect",path:"package"}。检查成功后用返回的插件业务 id 安装，例如 {action:"install",id:"my-widget"}；install 不能省略 id，不传 previewID/revision。默认按当前审批模式授权并启用清单选中的组件；enabled:false 仅安装。enableComponents 可显式启用指定的关闭组件。',
      '已打开的应用自动加载或替换界面。status 查询近期浏览器的加载、挂载或失败回报；仍需验证实际显示和交互。',
      '更新时重新检查并安装；disable/uninstall 撤下组件并取消其未完成的调用。'],
    slots: [
      { id: 'sidebar_panel', description: '可与聊天并排使用的工作台视图，从扩展入口打开为标签；用户可以移至主区或右侧辅助区。' },
      { id: 'page', description: '工作台中的独立页面标签，由宿主管理标签、分组和关闭操作。' },
      { id: 'tool_card', description: '匹配 toolNames 的工具卡片下方，接收该调用的名称、状态、输入和输出。' },
    ],
    sdk: {
      memos: '备忘插件完整列表使用 list_memos_page({limit,query,cursor})，返回 {items,nextCursor,hasMore}；查询变化清空游标，翻页追加并按 id 去重。旧 list_memos 返回最多 200 条数组，不代表全量。创建提醒优先 create_reminder；delivery.channel 默认 auto，只有用户明确指定才固定渠道。创建成功不代表已投递，验收必须检查到点的实际通信或客户端显示回执。',
      entry: '导出同步 activate(api)，可返回清理函数。模块为完整 ESM JavaScript，不能依赖外部 import、CDN 或另一份 React；TypeScript/JSX 需先编译打包。',
      api: ['api.React：宿主共享的 React，包含 createElement 和 hooks。',
        'api.registerView(viewId, Component)：注册 ui.json 中声明的视图，返回撤销函数。',
        'api.addStyle(css)：注册随模块卸载清理的样式，使用插件自己的类名前缀。',
        'api.effect(setup)：setup 返回资源清理函数；api.signal 在卸载时中止。'],
      props: ['Component 接收 { host, tool }。普通视图的 host.sessionId 固定为打开该实例时绑定的应用会话，也可能为空；工具卡片绑定其所在聊天编辑器。切换其他聊天不改变已有实例的会话。',
        '宿主负责工作台标签、分组、拖动调宽与布局保存；视图只布局自己的内容，不设置覆盖整个窗口的 fixed 根节点，不重复实现宿主标签栏。',
        '切换标签、递归编辑组与工具侧栏保持实例和表单状态，同一视图可复制为多个独立实例。关闭实例、账号／世界切换、停用或卸载时释放视图并取消其在途调用。布局恢复不代表插件表单草稿已持久化，业务数据仍须通过后端保存。',
        'host.setDirty?.(dirty)：登记当前实例的未保存状态。host.registerSave?.(async () => { ... })：登记用户保存命令的回调，返回撤销函数；保存失败应抛出异常，成功后宿主清除未保存标记。这些接口只管理界面生命周期，不授予业务写入权限。',
        'host.readSession()：需声明 sessionRead，返回当前会话概要。',
        'host.sendMessage(text)：需声明 sessionSend，走正常会话输入与排队链路。',
        'host.callTool(name, input, { signal }?)：须列入 capabilities.tools，仍执行会话策略、参数校验和审批；会话忙时等待下一个空闲边界，按提交顺序执行一次。宿主显示等待／审批／执行状态及取消入口；第三参可提供单次调用的 AbortSignal。等待和执行共计最多 120 秒，不自动重试写操作。',
      'host.onConnectorEvent(listener)：须在 capabilities.tools 声明 read_connector_events，收到当前绑定会话的 {type:"event",connectorId,eventId,eventType} 或重连后的 {type:"resync"}；只提供变更提示，不含事件正文。根据需要通过工具读取事件或重新查询业务状态；应先读初始状态，处理重复或离线期间的变化。返回取消订阅函数，视图卸载也会自动清理。',
        'host.signal 随当前实例关闭或模块撤下中止，宿主会自动取消该实例所有 SDK 在途调用；不必自行重复发送取消请求。组件自行创建的 fetch、监听和定时器仍须绑定 signal 或清理。取消不能撤销已经发生的副作用；结果未知时先查询状态，不重复创建或发送。其他聊天切换不重新挂载当前实例。组件应显示异步失败。',
        'tool 仅在工具卡片提供 { name, status, input, output, error }；它是显示数据，不扩大权限。'],
      rules: ['业务服务持有权威状态；不要修改其他组件 DOM、读取应用令牌或自行调用内部 RPC。',
        '沿用宿主主题 CSS 变量 --color-bg、--color-text、--color-accent，提供可访问的控件标签。',
        '沿用本机插件执行机制，不具有操作系统沙箱。模块上限 256 KiB。'],
    },
    files: {
      'plugin.json': JSON.stringify({ schemaVersion: 1, id: 'my-widget', name: '我的工具', description: '可交互的应用扩展',
        version: '1.0.0', components: { ui: [{ id: 'main', entry: 'ui.json', enabledByDefault: true }] } }, null, 2),
      'ui.json': JSON.stringify({ schemaVersion: 1, type: 'module', apiVersion: 1, entry: 'client.js',
        views: [{ id: 'main', title: '我的工具', slot: 'sidebar_panel' }],
        capabilities: { sessionRead: true, sessionSend: false, tools: [] } }, null, 2),
      'client.js': `export function activate(api) {
  const React = api.React;
  function Widget({ host }) {
    const [title, setTitle] = React.useState('点击读取当前会话');
    const [error, setError] = React.useState('');
    async function read() {
      try { setError(''); setTitle((await host.readSession()).title); }
      catch (reason) { setError(String(reason.message || reason)); }
    }
    return React.createElement('div', { style: { padding: 16 } },
      React.createElement('p', null, title),
      React.createElement('button', { onClick: read, disabled: !host.sessionId }, '读取会话'),
      error && React.createElement('p', { role: 'alert' }, error));
  }
  api.registerView('main', Widget);
}`,
    },
  }
}
