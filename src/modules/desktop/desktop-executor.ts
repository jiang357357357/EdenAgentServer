import { toJson } from '@eden/api'
import { win32 } from 'node:path'
import { DesktopError, type DesktopDriver, type DesktopResult, type InputObserver } from './contracts.ts'
import { desktopSchemas, desktopToolName } from './action-schema.ts'
import { WindowTargets } from './window-targets.ts'
import { crossWindowDrag } from './cross-window-drag.ts'
import { confirmDesktopAction } from './action-confirmation.ts'
import { CuaNativeExecutor } from './cua-native-executor.ts'
import { confirmWindowFrame } from './window-frame.ts'
import { confirmWindowState } from './window-state.ts'
import { nativeOutcome } from './native-outcome.ts'

export class DesktopExecutor {
  private readonly targets: WindowTargets
  private nativeGeneration: number | undefined
  private readonly cua: CuaNativeExecutor
  constructor(private readonly driver: DesktopDriver, private readonly observer: InputObserver) {
    this.targets = new WindowTargets(observer); this.cua = new CuaNativeExecutor(driver)
  }
  title(input: Record<string, unknown>): string { return input.window ? this.targets.get(input.window).window.title : '' }
  windowId(input: Record<string, unknown>): string | undefined { return input.window ? this.targets.get(input.window).window.windowId : undefined }
  invalidate() { this.targets.invalidate(); this.cua.invalidate() }
  async release() { this.invalidate(); await this.driver.release?.() }
  async execute(name: string, raw: Record<string, unknown>, signal: AbortSignal): Promise<DesktopResult> {
    const tool = name.startsWith('cua_') ? undefined : desktopToolName(name)
    const input = tool ? desktopSchemas[tool].parse(raw) as Record<string, unknown> : raw
    signal.throwIfAborted()
    try {
      if (this.driver.prepare) {
        const generation = await this.driver.prepare(signal).catch(error => { this.invalidate(); throw error })
        if (this.nativeGeneration !== undefined && generation !== this.nativeGeneration) this.invalidate()
        this.nativeGeneration = generation
      }
      signal.throwIfAborted()
      return tool ? await this.dispatch(tool, input, signal) : await this.cua.execute(name.slice(4), input, signal)
    }
    catch (error) {
      if (!(error instanceof DesktopError) || !input.window) throw error
      if (error.code === 'WINDOW_REFERENCE_EXPIRED') throw error
      const target = this.targets.get(input.window)
      throw new DesktopError(error.message, error.code, error.toolOutcome, { ...this.targets.diagnostics(target, input, error.code), ...error.diagnostics })
    }
  }
  private async dispatch(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<DesktopResult> {
    if (tool === 'desktop_list_windows') return this.windows(String(input.query), signal)
    if (tool === 'desktop_observe') return this.targets.observe(String(input.window), this.driver, signal,
      { screenshot: Boolean(input.include_screenshot), text: Boolean(input.include_text) })
    if (tool === 'desktop_read_text') {
      const read = desktopSchemas.desktop_read_text.parse(input)
      const locator = read.locator ? { role: read.locator.role, label: read.locator.label,
        ...(read.locator.ancestors ? { ancestors: read.locator.ancestors } : {}) } : undefined
      return this.targets.readText(read.window, read.element, locator, read.maxChars, this.driver, signal)
    }
    if (tool === 'desktop_launch') {
      const app = String(input.application)
      const result = await this.driver.act('launch_app', { [win32.isAbsolute(app) ? 'path' : 'name']: app, additional_arguments: input.arguments }, signal)
      return { value: toJson({ ...nativeOutcome(result, false), application: app, nextAction: 'discover_and_observe_window' }) }
    }
    if (tool === 'desktop_window') return this.window(input, signal)
    if (tool === 'desktop_drag' && input.toWindow && input.toWindow !== input.window)
      return { value: toJson({ window: input.window, toWindow: input.toWindow, ...await crossWindowDrag(this.targets, this.driver, this.observer, input, signal) }) }
    return this.input(tool, input, signal)
  }
  private async input(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<DesktopResult> {
    const { target, args } = await this.targets.input(input)
    await this.checkInputTitle(tool, input, target.window, signal)
    if (tool === 'desktop_click') {
      if (!input.element && input.x === undefined) throw new DesktopError('点击必须指定控件或窗口内坐标')
      Object.assign(args, { button: input.button, count: input.count })
    } else if (tool === 'desktop_type') {
      if (!input.element && input.x === undefined) throw new DesktopError('填写必须指定输入控件或输入框坐标')
      if (input.mode === 'replace') {
        if (!input.element) throw new DesktopError('整体替换必须指定可编辑控件')
        this.targets.consume(target)
        const replacement = await this.driver.act('set_value', { ...args, value: input.text }, signal)
        return confirmDesktopAction(this.targets, this.driver, input, this.diagnose(replacement, input), signal, tool)
      }
      args.text = input.text
    } else if (tool === 'desktop_key') args.keys = input.keys
    else if (tool === 'desktop_scroll') Object.assign(args, { direction: input.direction, amount: input.amount })
    else if (tool === 'desktop_drag') {
      this.targets.assertScreenshot(target, input.screenshotId)
      this.targets.pixel(target, input.fromX, input.fromY); this.targets.pixel(target, input.toX, input.toY)
      Object.assign(args, { from_x: input.fromX, from_y: input.fromY, to_x: input.toX, to_y: input.toY, duration_ms: input.durationMs })
    }
    const native = nativeInput(tool, args)
    signal.throwIfAborted()
    this.targets.consume(target)
    const result = await this.driver.act(native!, args, signal)
    return confirmDesktopAction(this.targets, this.driver, input, this.diagnose(result, input), signal, tool)
  }
  private async checkInputTitle(tool: string, input: Record<string, unknown>, target: import('./contracts.ts').NativeWindow, signal: AbortSignal) {
    if (!['desktop_type', 'desktop_key'].includes(tool) || typeof input.expectedTitle !== 'string') return
    const current = (await this.driver.windows(signal)).find(window => window.pid === target.pid && window.windowId === target.windowId)
    if (!current || !current.title.includes(input.expectedTitle))
      throw new DesktopError('当前窗口标题与预期目标不匹配，已阻止输入；请重新观察确认目标', 'TARGET_MISMATCH')
  }
  private diagnose(result: import('./contracts.ts').DriverAction, input: Record<string, unknown>) {
    return result.status === 'refused' || result.status === 'unknown'
      ? { ...result, diagnostics: { ...result.diagnostics, ...this.targets.diagnostics(this.targets.get(input.window), input, result.code) } } : result
  }
  private async windows(query: string, signal: AbortSignal): Promise<DesktopResult> {
    const discovered = this.observer.windows ? await this.observer.windows() : await this.driver.windows(signal)
    const windows = discovered.filter(w => `${w.app} ${w.title}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    const result = []
    for (const window of windows.slice(0, 100)) {
      signal.throwIfAborted()
      try {
        result.push({ window: await this.targets.register(window), application: window.app, title: window.title, minimized: window.minimized })
      } catch (error) { if (!(error instanceof DesktopError && error.code === 'WINDOW_UNAVAILABLE')) throw error }
    }
    return { value: toJson({ kind: 'observation', status: 'read', windows: result, truncated: windows.length > 100 }) }
  }
  private async window(input: Record<string, unknown>, signal: AbortSignal): Promise<DesktopResult> {
    const target = await this.targets.current(input.window)
    this.targets.consume(target)
    if (input.action === 'minimize' || input.action === 'maximize' || input.action === 'restore') {
      signal.throwIfAborted()
      await this.observer.window(target.window, input.action, target.identity.started)
      const result = await confirmWindowState(this.observer, target.window, target.identity, String(input.action),
        { status: 'delivered', message: '窗口操作已请求', route: 'system_api' }, signal)
      return { value: toJson({ window: input.window, ...result.value as Record<string, unknown> }) }
    }
    const args: Record<string, unknown> = { pid: target.window.pid, window_id: target.window.windowId }
    if (input.action === 'resize') {
      for (const field of ['x', 'y', 'width', 'height']) {
        if (input[field] === undefined) throw new DesktopError('调整窗口必须提供 x、y、width 和 height')
        args[field] = input[field]
      }
    }
    const result = await this.driver.act(input.action === 'activate' ? 'bring_to_front' : 'set_window_frame', args, signal)
    if (input.action === 'resize') {
      const frame = await confirmWindowFrame(this.observer, target.window, target.identity,
        { x: Number(input.x), y: Number(input.y), width: Number(input.width), height: Number(input.height) }, this.diagnose(result, input), signal)
      return { value: toJson({ window: input.window, ...frame.value as Record<string, unknown> }) }
    }
    const state = await confirmWindowState(this.observer, target.window, target.identity, 'activate', this.diagnose(result, input), signal)
    return { value: toJson({ window: input.window, ...state.value as Record<string, unknown> }) }
  }
}

function nativeInput(tool: string, args: Record<string, unknown>): string {
  if (tool === 'desktop_key' && Array.isArray(args.keys) && args.keys.length === 1) {
    args.key = args.keys[0]; delete args.keys; return 'press_key'
  }
  return ({ desktop_click: 'click', desktop_type: 'type_text', desktop_key: 'hotkey', desktop_scroll: 'scroll', desktop_drag: 'drag' } as Record<string, string>)[tool]!
}
