import type { DesktopStatus, DesktopControlEvent } from '@eden/api'
import { DesktopError } from './contracts.ts'

export interface OperationScope { owner: string; session: string; id: string }
interface Pending { scope: OperationScope; action: string; title: string; state: 'queued' | 'running'; startedAt: number; controller: AbortController; foreground: boolean; windowId?: string | undefined }
export class InputArbiter {
  private tail: Promise<void> = Promise.resolve()
  private readonly pending = new Map<string, Pending>()
  private active: Pending | undefined
  paused = false
  stopped = false
  controlEvent: DesktopControlEvent | undefined
  constructor(private readonly persist: (paused: boolean, stopped: boolean, control?: DesktopControlEvent) => void,
    private readonly stuck: () => void = () => {}, private readonly invalidate: () => void = () => {}) {}

  status(owner: string, observerAvailable: boolean): DesktopStatus {
    return { available: process.platform === 'win32', busy: Boolean(this.active), paused: this.paused, stopped: this.stopped, observerAvailable,
      ...(this.controlEvent ? { control: this.controlEvent } : {}),
      operations: [...this.pending.values()].filter(p => p.scope.owner === owner).map(p => ({ sessionId: p.scope.session,
        action: p.action, windowTitle: p.title, state: p.state, startedAt: p.startedAt })) }
  }
  control(action: 'pause' | 'resume' | 'stop', source: DesktopControlEvent['source'] = 'manual') {
    this.paused = action === 'pause'; this.stopped = action === 'stop'
    const message = source === 'physical_input' ? '检测到本机输入，已暂停桌面控制' : source === 'shortcut' ? '全局停止快捷键已停止桌面控制'
      : source === 'observer_unavailable' ? '输入观察器不可用，已停止桌面控制' : source === 'watchdog' ? '原生输入取消后仍未结束，已停止桌面控制'
      : source === 'state_corrupt' ? '控制状态文件无效，已停止桌面控制'
      : action === 'resume' ? '用户在控制窗口恢复了桌面控制' : action === 'stop' ? '用户在控制窗口停止了桌面控制' : '用户在控制窗口暂停了桌面控制'
    this.controlEvent = { action, source, changedAt: Date.now(), message }
    this.persist(this.paused, this.stopped, this.controlEvent)
    if (action !== 'resume') for (const pending of this.pending.values()) pending.controller.abort(new DesktopError(
      message, source === 'physical_input' ? 'DESKTOP_TAKEOVER_PAUSED' : 'DESKTOP_PAUSED', pending.state === 'running' ? 'unknown' : 'cancelled'))
    this.invalidate()
  }
  physicalInput(stop: boolean, windowId?: string, source: DesktopControlEvent['source'] = stop ? 'shortcut' : 'physical_input') {
    if (stop) this.control('stop', source)
    else if (this.active && (this.active.foreground || (windowId && this.active.windowId === windowId))) this.control('pause', source)
  }
  cancel(owner: string, id?: string, session?: string) {
    for (const pending of this.pending.values()) if (pending.scope.owner === owner && (!id || pending.scope.id === id) && (!session || pending.scope.session === session))
      pending.controller.abort(new DesktopError('桌面调用已取消；输入可能已经送达', 'DESKTOP_CANCELLED', pending.state === 'running' ? 'unknown' : 'cancelled'))
  }
  async run<T>(scope: OperationScope, action: string, title: string, foreground: boolean, work: (signal: AbortSignal) => Promise<T>, windowId?: string, timeoutMs = 30000): Promise<T> {
    if (this.paused || this.stopped) throw new DesktopError('桌面控制已暂停或停止；请由用户从托盘打开桌面控制并恢复', 'DESKTOP_PAUSED', 'failed',
      { recovery: ['user_open_tray_desktop_control', 'user_resume'] })
    if (this.pending.size >= 32) throw new DesktopError('桌面操作队列已满，请稍后重试', 'DESKTOP_BUSY')
    const key = `${scope.owner}:${scope.id}`
    if (this.pending.has(key)) throw new DesktopError('重复桌面请求被拒绝')
    const pending: Pending = { scope, action, title, state: 'queued', startedAt: Date.now(), controller: new AbortController(), foreground, windowId }
    this.pending.set(key, pending)
    const previous = this.tail
    let release!: () => void
    const slot = new Promise<void>(resolve => { release = resolve })
    this.tail = previous.then(() => slot)
    let timeout: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined
    const signal = pending.controller.signal
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
    const queueDeadline = setTimeout(() => pending.controller.abort(new DesktopError('等待桌面输入超时，未执行输入', 'DESKTOP_QUEUE_TIMEOUT', 'cancelled')), 120000)
    try {
      await Promise.race([previous, cancelled])
      clearTimeout(queueDeadline)
      signal.throwIfAborted()
      if (this.paused || this.stopped) throw new DesktopError('桌面控制已暂停', 'DESKTOP_PAUSED')
      pending.state = 'running'; this.active = pending
      timeout = setTimeout(() => pending.controller.abort(new DesktopError('桌面操作超时；输入结果未知', 'DESKTOP_TIMEOUT', 'unknown')), timeoutMs)
      const stalled = () => { watchdog = setTimeout(() => { this.control('stop', 'watchdog'); this.stuck() }, 8000); watchdog.unref() }
      signal.addEventListener('abort', stalled, { once: true })
      try {
        const result = await work(signal)
        signal.throwIfAborted()
        return result
      } finally { signal.removeEventListener('abort', stalled) }
    } finally {
      clearTimeout(queueDeadline)
      if (timeout) clearTimeout(timeout)
      if (watchdog) clearTimeout(watchdog)
      signal.removeEventListener('abort', abort)
      this.pending.delete(key)
      if (this.active === pending) this.active = undefined
      release()
    }
  }
}
