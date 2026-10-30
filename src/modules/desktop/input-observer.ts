import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { DesktopError, type DesktopIdentity, type InputObserver, type NativeWindow, type DesktopInputCallback } from './contracts.ts'

declare const EDEN_BUNDLED_SERVER: boolean
const identitySchema = z.object({ started: z.string().min(1), foreground: z.boolean(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  visibleBounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  minimized: z.boolean().optional(), maximized: z.boolean().optional(),
  screen: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
  dpi: z.number().nonnegative().optional(), coordinateSpace: z.enum(['physical_screen_pixels', 'unknown']).optional(),
  workArea: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  virtualScreen: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional() })
const windowsSchema = z.array(z.object({ pid: z.number().int().positive(), windowId: z.string().regex(/^\d+$/), app: z.string(), title: z.string(),
  bounds: identitySchema.shape.bounds, minimized: z.boolean() }).strict()).max(512)

function observerFilename() {
  const directory = fileURLToPath(new URL(typeof EDEN_BUNDLED_SERVER !== 'undefined' ? './' : '../../../../dist/server/', import.meta.url))
  const { filename } = z.object({ filename: z.string().regex(/^desktop-input-observer-[a-f0-9]{16}\.exe$/) })
    .parse(JSON.parse(readFileSync(path.join(directory, 'desktop-input-observer.json'), 'utf8')))
  return path.join(directory, filename)
}

export async function startInputObserver(onInput: DesktopInputCallback): Promise<InputObserver> {
  const child = spawn(observerFilename(), [], { windowsHide: true, stdio: 'pipe' })
  const observer = new WindowsInputObserver(child, onInput)
  await observer.ready
  return observer
}

class WindowsInputObserver implements InputObserver {
  available = false
  readonly ready: Promise<void>
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  private remainder = ''
  private closed = false
  private readonly failReady: (error: Error) => void
  constructor(private readonly child: ChildProcessWithoutNullStreams, onInput: DesktopInputCallback) {
    let ready!: () => void, fail!: (error: Error) => void
    this.ready = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject })
    this.failReady = fail
    const deadline = setTimeout(() => this.fail(new Error('桌面输入观察器启动超时')), 5000)
    this.ready.then(() => clearTimeout(deadline), () => clearTimeout(deadline))
    const decoder = new StringDecoder('utf8')
    child.stdout.on('data', chunk => {
      this.remainder += decoder.write(chunk)
      if (this.remainder.length > 2 * 1024 * 1024) { this.fail(new Error('桌面观察器消息过长')); return }
      let end: number
      while ((end = this.remainder.indexOf('\n')) >= 0) {
        const line = this.remainder.slice(0, end); this.remainder = this.remainder.slice(end + 1)
        try {
          const record = JSON.parse(line) as { type: string; id?: string; error?: string; result?: unknown; windowId?: string }
          if (record.type === 'ready') { this.available = true; ready() }
          else if (record.type === 'input' || record.type === 'stop') onInput(record.type === 'stop', record.windowId, record.type === 'stop' ? 'shortcut' : 'physical_input')
          else if (record.type === 'reply' && record.id) {
            const request = this.pending.get(record.id); this.pending.delete(record.id)
            if (record.error) request?.reject(new DesktopError(record.error, 'WINDOW_UNAVAILABLE'))
            else request?.resolve(record.result)
          } else if (record.type === 'error') this.fail(new Error('桌面输入观察器不可用'))
        } catch { this.fail(new Error('桌面输入观察器返回无效数据')) }
      }
    })
    child.on('error', error => this.fail(error))
    child.on('exit', () => { const active = !this.closed; this.fail(new Error('桌面输入观察器已退出')); if (active) onInput(true, undefined, 'observer_unavailable') })
    child.stdin.on('error', error => this.fail(error))
    child.stderr.resume()
  }
  private fail(error: Error) {
    this.available = false; this.failReady(error)
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear(); this.child.kill()
  }
  private async request(window: NativeWindow | undefined, action: string, started?: string, point?: { x: number; y: number }): Promise<unknown> {
    if (!this.available) throw new DesktopError('桌面输入观察器不可用；请重新构建并启动桌面服务', 'OBSERVER_UNAVAILABLE')
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new DesktopError('窗口身份检查超时')) }, 3000)
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      this.child.stdin.write(JSON.stringify({ id, pid: window?.pid, windowId: window?.windowId, action, started, ...point }) + '\n')
    })
  }
  async windows() { return windowsSchema.parse(await this.request(undefined, 'list')) }
  async identify(window: NativeWindow): Promise<DesktopIdentity> { return identitySchema.parse(await this.request(window, 'identify')) }
  async hit(window: NativeWindow, x: number, y: number) { return z.object({ hit: z.boolean() }).parse(await this.request(window, 'hit', undefined, { x, y })).hit }
  async window(window: NativeWindow, action: 'minimize' | 'maximize' | 'restore', started?: string) { await this.request(window, action, started) }
  async close() {
    this.closed = true; this.available = false
    this.child.stdin.end(); this.child.kill()
  }
}
