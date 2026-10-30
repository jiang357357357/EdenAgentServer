import { randomBytes } from 'node:crypto'
import { DesktopError, type DesktopDriver, type InputObserver, type NativeWindow, type NativeObservation, type DesktopIdentity } from './contracts.ts'
import type { ElementLocator, NativeElement } from './contracts.ts'
import { elementGeometry, observationGeometry, observationQuality, screenshotUsable, treeComplete } from './observation-geometry.ts'
import { elementLocator, elementText, refreshWindowLocator, uniqueElement } from './element-text.ts'

export interface Target { window: NativeWindow; identity: DesktopIdentity; observation?: NativeObservation; elements: Map<string, NativeElement>;
  editable?: { ref: string; label: string }; screenshotId?: string; consumed?: boolean }
const reference = (kind: string) => `${kind}-${randomBytes(8).toString('hex')}`
const sameBounds = (a: DesktopIdentity['bounds'], b: DesktopIdentity['bounds']) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
export class WindowTargets {
  private readonly targets = new Map<string, Target>()
  private generation = 0
  constructor(private readonly observer: InputObserver) {}
  invalidate() {
    this.generation++
    for (const target of this.targets.values()) { delete target.observation; delete target.editable; delete target.screenshotId; target.consumed = true; target.elements.clear() }
  }

  async register(window: NativeWindow): Promise<string> {
    const identity = await this.observer.identify(window)
    for (const [ref, target] of this.targets) if (target.window.pid === window.pid && target.window.windowId === window.windowId
      && target.identity.started === identity.started) { target.window = window; return ref }
    if (this.targets.size >= 256) throw new DesktopError('窗口目录已满，请结束本任务后重新发现窗口')
    const ref = reference('window')
    this.targets.set(ref, { window, identity, elements: new Map() })
    return ref
  }
  get(ref: unknown): Target {
    const target = typeof ref === 'string' ? this.targets.get(ref) : undefined
    if (!target) throw new DesktopError('窗口引用不属于当前会话，或桌面服务已重启；请重新查找窗口', 'WINDOW_REFERENCE_EXPIRED', 'failed',
      { recovery: ['desktop_list_windows', 'desktop_observe'], replayAllowed: false })
    return target
  }
  async current(ref: unknown): Promise<Target> {
    const target = this.get(ref), identity = await this.observer.identify(target.window)
    if (identity.started !== target.identity.started) throw new DesktopError('原窗口进程已被替换，请重新查找窗口', 'WINDOW_REPLACED')
    return target
  }
  async observe(ref: string, driver: DesktopDriver, signal: AbortSignal, options?: { screenshot?: boolean; text?: boolean }) {
    const generation = this.generation
    const target = await this.current(ref)
    const before = await this.observer.identify(target.window)
    // A fresh SDK snapshot invalidates previous tokens even if acquisition later fails.
    delete target.observation; delete target.editable; delete target.screenshotId; target.consumed = true; target.elements.clear()
    const observation = await driver.observe(target.window, signal, options)
    if (options?.screenshot === false) {
      observation.screenshotIncluded = false; observation.images = []; observation.width = 0; observation.height = 0
    }
    const identity = await this.observer.identify(target.window)
    signal.throwIfAborted()
    if (generation !== this.generation) throw new DesktopError('桌面控制状态已变化，请重新观察', 'OBSERVATION_REQUIRED')
    if (identity.started !== before.started || !sameBounds(identity.bounds, before.bounds) || identity.dpi !== before.dpi)
      throw new DesktopError('观察期间窗口发生变化，请重新观察', 'WINDOW_CHANGED', 'failed',
        { beforeBounds: { ...before.bounds }, currentBounds: { ...identity.bounds }, recovery: ['observe_window'] })
    if (observation.captureBackend === 'cua_driver_native' && geometryMismatch(observation.window.bounds, identity.bounds))
      observation.elementCoordinateSpace = 'unknown'
    const elements = observation.elements.map(element => {
      const ref = reference('element')
      return { ref, element }
    })
    target.elements = new Map(elements.map(({ ref, element }) => [ref, element]))
    delete target.editable
    const editable = elements.filter(({ element }) => element.enabled && element.role === 'Edit' && element.actions.includes('set_value'))
    if (treeComplete(observation) && editable.length === 1) target.editable = { ref: editable[0]!.ref, label: editable[0]!.element.label }
    target.observation = { ...observation, images: [] }; target.identity = identity; target.window = observation.window
    target.consumed = false
    if (screenshotUsable(observation)) target.screenshotId = reference('screenshot')
    const focused = elements.find(({ element }) => element.focused)
    return { value: { kind: 'observation', status: 'read', window: ref, application: target.window.app, title: target.window.title,
      foreground: identity.foreground, bounds: { ...identity.bounds },
      ...observationQuality(observation), screenshot: { ...observationQuality(observation).screenshot, ...(target.screenshotId ? { id: target.screenshotId } : {}) },
      geometry: observationGeometry(observation, identity), truncated: observation.truncated,
      focused_element: focused ? { element: focused.ref, role: focused.element.role, label: focused.element.label,
        value: focused.element.value, frame: focused.element.frame ? { ...focused.element.frame } : null } : null,
      elements: elements.map(({ ref, element }) => ({ element: ref,
        parent: element.parent ? elements.find(item => item.element.index === element.parent)?.ref ?? null : null, role: element.role, label: element.label,
        value: element.value, valueAvailable: element.valueAvailable ?? null, valueTruncated: element.valueTruncated ?? false,
        labelTruncated: element.labelTruncated ?? false,
        enabled: element.enabled, actions: element.actions, locator: { ...elementLocator(element, observation.elements) },
        ...elementGeometry(element, observation) })) }, images: observation.images }
  }
  async readText(ref: string, element: string | undefined, locator: ElementLocator | undefined, maxChars: number,
    driver: DesktopDriver, signal: AbortSignal) {
    const target = await this.current(ref), previous = element ? target.elements.get(element) : undefined
    if (element && !previous) throw new DesktopError('控件引用已失效，请重新观察或使用文字定位条件', 'ELEMENT_REFERENCE_EXPIRED')
    const selected = previous ? elementLocator(previous, target.observation!.elements) : locator!
    const title = target.window.title
    await this.observe(ref, driver, signal, { screenshot: false, text: true })
    const refreshed = refreshWindowLocator(selected, title, target.observation!)
    const found = uniqueElement(refreshed, target.observation!)
    const result = elementText(found, target.observation!, maxChars)
    const updatedRef = [...target.elements].find(([, e]) => e === found)![0]
    return { value: { kind: 'observation', window: ref, element: updatedRef, locator: { ...refreshed }, status: result.text === null ? 'unavailable' : 'read',
      ...result, referencesRenewed: true, screenshotRequiredForCoordinates: true,
      ...(target.window.title !== title ? { context: { titleChanged: true, beforeTitle: title, title: target.window.title,
        locatorMatched: true, businessTargetUnchanged: 'not_established' } } : {}),
      accessibility: observationQuality(target.observation!).accessibility } }
  }
  async input(raw: Record<string, unknown>): Promise<{ target: Target; args: Record<string, unknown> }> {
    const target = await this.current(raw.window)
    if (!target.observation || target.consumed) throw new DesktopError('输入前必须先观察目标窗口，旧观察已使用时须重新观察', 'OBSERVATION_REQUIRED')
    const identity = await this.observer.identify(target.window)
    const previous = target.identity
    target.identity = identity
    if (identity.bounds.width !== previous.bounds.width || identity.bounds.height !== previous.bounds.height || identity.dpi !== previous.dpi)
      throw new DesktopError('窗口大小或 DPI 已变化，请重新观察后输入', 'WINDOW_CHANGED')
    const args: Record<string, unknown> = { pid: target.window.pid, window_id: target.window.windowId, delivery_mode: raw.delivery }
    if (raw.element) args.snapshot = target.observation.snapshot
    if (raw.element) {
      if (target.observation.elementCoordinateSpace === 'unknown')
        throw new DesktopError('驱动与系统窗口几何不一致，不能确认控件坐标；请重新观察或使用有效截图定位', 'COORDINATE_SPACE_UNCERTAIN')
      const element = target.elements.get(String(raw.element))
      if (!element) throw new DesktopError('控件引用已失效，请重新观察窗口', 'ELEMENT_REFERENCE_EXPIRED')
      if (!element.token) throw new DesktopError('该节点只有观察数据，驱动未提供操作引用，请使用有效截图定位', 'ELEMENT_NOT_ACTIONABLE')
      args.element_token = element.token
    }
    if ((raw.x === undefined) !== (raw.y === undefined)) throw new DesktopError('坐标 x 和 y 必须同时提供')
    if (raw.element && raw.x !== undefined) throw new DesktopError('控件引用和坐标只能选择一种')
    if (raw.x !== undefined) {
      this.assertScreenshot(target, raw.screenshotId)
      this.pixel(target, raw.x, raw.y); args.x = raw.x; args.y = raw.y
    }
    return { target, args }
  }
  assertScreenshot(target: Target, id: unknown) {
    if (target.observation?.snapshot && (!target.screenshotId || id !== target.screenshotId))
      throw new DesktopError('坐标必须绑定最近截图的 screenshotId，请重新观察', 'SCREENSHOT_REFERENCE_EXPIRED')
  }
  consume(target: Target) { target.consumed = true }
  pixel(target: Target, x: unknown, y: unknown) {
    const observation = target.observation!
    if (!screenshotUsable(observation)) throw new DesktopError('最近截图未取得或帧无效，请重新观察后使用坐标', 'SCREENSHOT_UNAVAILABLE', 'failed', this.diagnostics(target))
    if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || y < 0 || x >= observation.width || y >= observation.height)
      throw new DesktopError('坐标必须位于最近截图范围内', 'COORDINATE_OUTSIDE_WINDOW', 'failed', this.diagnostics(target))
  }
  diagnostics(target: Target, raw?: Record<string, unknown>, code?: string) {
    const observation = target.observation
    const element = raw?.element ? target.elements.get(String(raw.element)) : undefined
    return { geometry: observation ? observationGeometry(observation, target.identity) : null,
      element: element && observation ? elementGeometry(element, observation) : null,
      screenshot: observation ? observationQuality(observation).screenshot : null,
      recovery: code === 'DESKTOP_PAUSED' || code === 'DESKTOP_TAKEOVER_PAUSED' ? ['user_open_tray_desktop_control', 'user_resume']
        : code === 'CAPTURE_REQUIRES_FOREGROUND' || code === 'WINDOW_OCCLUDED' || code === 'WINDOW_NOT_FOREGROUND' ? ['activate_target_window', 'observe_window']
        : code === 'background_unavailable' ? ['observe_window', 'consider_explicit_foreground']
        : ['observe_window', 'check_geometry', 'consider_maximize_or_restore_if_outside_window'] }
  }
}

function geometryMismatch(a: NativeWindow['bounds'], b: NativeWindow['bounds']) {
  return Math.abs(a.width - b.width) > Math.max(32, b.width * 0.2)
    || Math.abs(a.height - b.height) > Math.max(32, b.height * 0.2)
}
