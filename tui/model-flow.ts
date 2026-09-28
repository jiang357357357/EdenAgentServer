import type { SchemaRpcMethodMap } from '@eden/api'
import type { TuiConfig } from './config.ts'
import type { TuiRpcClient } from './rpc-client.ts'
import type { Terminal } from './terminal.ts'

type Catalog = SchemaRpcMethodMap['model.catalog']['result']
type Option = Catalog['options'][number]

/** Refreshes the Core model binding before a TUI session can submit a turn. */
export class ModelFlow {
  private catalog: Catalog | undefined
  private catalogSession: string | undefined
  private catalogToken: string | undefined
  private options: Option[] = []

  constructor(private readonly config: TuiConfig, private readonly rpc: TuiRpcClient,
    private readonly terminal: Terminal, private readonly token: () => string | undefined,
    private readonly session: () => string | undefined) {}

  private connection(): { coreBaseUrl: string; coreToken: string } {
    const coreToken = this.token()
    if (!coreToken) throw new Error('请先登录 Mon Core')
    return { coreBaseUrl: this.config.coreUrl, coreToken }
  }

  private active(sessionId: string | undefined, token: string | undefined): boolean {
    return this.session() === sessionId && this.token() === token
  }

  async refresh(sessionId?: string): Promise<boolean> {
    const token = this.token()
    let status = await this.rpc.request('model.read', sessionId ? { sessionId } : {})
    if (this.config.origin === 'mon' && !status.available) {
      const catalog = await this.rpc.request('model.catalog', { ...this.connection(), ...(sessionId ? { sessionId } : {}) })
      this.catalog = catalog
      this.catalogSession = sessionId
      this.catalogToken = token
      status = await this.rpc.request('model.read', sessionId ? { sessionId } : {})
    }
    if (this.active(sessionId, token)) this.terminal.setModel(status.label || status.id, status.available)
    return status.available
  }

  async ensure(sessionId: string): Promise<boolean> {
    if (await this.refresh(sessionId)) return true
    await this.showMenu(sessionId)
    return false
  }

  async showMenu(sessionId?: string, force = false): Promise<void> {
    if (this.config.origin !== 'mon') {
      this.terminal.showPanel('模型配置', ['尘世模型由本地 Server 配置。请设置 EDEN_AGENT_MODEL 和对应供应商配置后重启 Server。'])
      return
    }
    if (force || !this.catalog || this.catalogSession !== sessionId || this.catalogToken !== this.token()) {
      this.catalog = await this.rpc.request('model.catalog', { ...this.connection(), ...(sessionId ? { sessionId } : {}) })
      this.catalogSession = sessionId
      this.catalogToken = this.token()
    }
    const catalog = this.catalog
    if (catalog.actors.length > 1) {
      this.terminal.showPanel('多角色模型', ['当前会话包含多个角色，须分别绑定角色与导演模型。请在 Web 客户端完成多角色模型配置。'])
      return
    }
    this.options = catalog.options.filter(option => option.status === 'active')
    if (!this.options.length) {
      this.terminal.showPanel('没有可用模型', ['Mon Core 模型目录没有启用的模型；请先在 Core 中添加或启用模型，再输入 /models 刷新。'])
      return
    }
    this.terminal.showMenu('选择 Mon Core 模型', this.options.map((option, index) => ({
      label: `${option.selected ? '●' : '◇'} ${option.label} · ${option.providerName || option.provider}`,
      detail: option.modelID, command: `/model-preview ${index + 1}`,
    })), [catalog.current ? `当前：${catalog.current.label}` : '当前助手尚未选择模型'], true)
  }

  preview(value: string): void {
    const option = this.option(value)
    this.terminal.showMenu('确认 Core 模型选择', [
      { label: `确认使用 ${option.label}`, command: `/model-confirm ${value}` },
      { label: '返回模型目录', command: '/models' },
    ], [`将更新 Mon Core 中当前助手或角色的模型设置：${option.provider}/${option.modelID}`])
  }

  async select(value: string): Promise<void> {
    const option = this.option(value)
    if (this.catalogSession !== this.session() || this.catalogToken !== this.token()) throw new Error('账号或会话已改变，请重新打开模型目录')
    const sessionId = this.catalogSession
    const catalog = await this.rpc.request('model.select', { ...this.connection(), aiEntityId: option.aiEntityId,
      ...(sessionId ? { sessionId } : {}) })
    this.catalog = catalog
    const available = await this.refresh(sessionId)
    if (!available) throw new Error('Core 模型选择已提交，但会话仍未获得可用模型；请检查模型详情')
    this.terminal.print('系统', `已绑定模型：${catalog.current?.label ?? option.label}`)
  }

  private option(value: string): Option {
    if (this.catalog?.actors.length && this.catalog.actors.length > 1) throw new Error('多角色会话须分别绑定模型')
    const index = Number(value)
    const option = Number.isSafeInteger(index) && index >= 1 ? this.options[index - 1] : undefined
    if (!option) throw new Error('模型编号无效，请输入 /models 重新选择')
    return option
  }
}
