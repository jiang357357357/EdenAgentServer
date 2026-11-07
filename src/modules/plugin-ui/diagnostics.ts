import type { PluginUiCall, PluginUiDiagnostic } from '@eden/api'

type Entry = { account: string; sessionId: string; pluginId: string; componentId: string; viewId: string; kind: string; message: string; time: number; client: string }
type Operation = { account: string; sessionId: string; pluginId: string; componentId: string; viewId: string; tool: string;
  backend?: string; remoteTool?: string; phase: string; outcome?: string; error?: string; startedAt: number; updatedAt: number }

/** Bounded diagnostics contain no tool arguments or results. */
export class PluginUiDiagnostics {
  private readonly entries: Entry[] = []
  private readonly operations: Operation[] = []
  private readonly clients = new Map<string, string>()
  private nextClient = 0
  client(id: string) {
    let label = this.clients.get(id)
    if (!label) { label = `客户端 ${++this.nextClient}`; this.clients.set(id, label) }
    if (this.clients.size > 512) this.clients.delete(this.clients.keys().next().value!)
    return label
  }
  report(account: string, input: PluginUiDiagnostic) {
    if (!input.sessionId) throw new Error('诊断信息需要绑定会话')
    const client = this.client(input.clientId), time = Date.now()
    for (const item of input.entries) this.entries.push({ account, sessionId: input.sessionId, pluginId: input.pluginId,
      componentId: input.componentId, viewId: input.viewId, client, kind: item.kind, message: item.message.slice(0, 2000), time })
    if (this.entries.length > 512) this.entries.splice(0, this.entries.length - 512)
  }
  start(account: string, input: PluginUiCall): Operation | undefined {
    if (input.action !== 'tool.call' || !input.sessionId) return undefined
    const args = input.input.input && typeof input.input.input === 'object' && !Array.isArray(input.input.input) ? input.input.input : {}
    const name = typeof input.input.name === 'string' ? input.input.name : ''
    const item: Operation = { account, sessionId: input.sessionId, pluginId: input.pluginId, componentId: input.componentId,
      viewId: input.viewId, tool: name.slice(0, 256), phase: 'waiting', startedAt: Date.now(), updatedAt: Date.now() }
    if (name === 'call_mcp_tool') {
      if (typeof args.runtimeId === 'string') item.backend = args.runtimeId.slice(0, 300)
      if (typeof args.name === 'string') item.remoteTool = args.name.slice(0, 256)
    }
    this.operations.push(item)
    if (this.operations.length > 512) this.operations.splice(0, this.operations.length - 512)
    return item
  }
  phase(item: Operation | undefined, phase: string, outcome?: string, error?: string) {
    if (!item) return
    item.phase = phase; item.updatedAt = Date.now()
    if (outcome) item.outcome = outcome
    if (error) item.error = error.slice(0, 2000)
  }
  read(account: string, sessionId: string, pluginId?: string) {
    const matches = (item: { account: string; sessionId: string; pluginId: string }) => item.account === account && item.sessionId === sessionId && (!pluginId || item.pluginId === pluginId)
    const strip = <T extends { account: string; sessionId: string }>(item: T) => { const { account: _account, sessionId: _sessionId, ...visible } = item; return visible }
    return { entries: this.entries.filter(matches).slice(-50).map(strip), operations: this.operations.filter(matches).slice(-50).map(strip),
      note: '进程内近期诊断；没有记录不代表成功，重启或超出保留上限后可能不可用。调用结果不包含业务数据。' }
  }
  clear() { this.entries.length = 0; this.operations.length = 0; this.clients.clear(); this.nextClient = 0 }
}
