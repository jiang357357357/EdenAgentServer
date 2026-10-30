import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { DesktopService, desktopTools } from '../../../src/modules/desktop/index.ts'
import { serveDesktopBroker } from '../../../src/modules/desktop/broker-server.ts'
import { modelTool } from '../../../src/modules/tool-results/index.ts'
import { DesktopError, type DesktopDriver, type NativeWindow, type InputObserver } from '../../../src/modules/desktop/contracts.ts'

export function fakeDesktop() {
  const windows: NativeWindow[] = [1, 2].map(n => ({ pid: n, windowId: String(n), app: 'Fixture', title: `Fixture ${n}`,
    bounds: { x: n * 400, y: 0, width: 400, height: 300 }, minimized: false }))
  const values = new Map<string, string>(), calls: { name: string; args: Record<string, unknown> }[] = []
  let generation = 0, started = 'first', foregroundId = '1', occluded = false, physical: (stop: boolean) => void = () => {}
  const observer: InputObserver = {
    available: true,
    async identify(window) {
      const current = windows.find(w => w.windowId === window.windowId)
      if (!current) throw new DesktopError('Window closed', 'WINDOW_UNAVAILABLE')
      return { started, bounds: { ...current.bounds }, foreground: window.windowId === foregroundId,
        coordinateSpace: 'physical_screen_pixels', screen: { width: 1920, height: 1080 } }
    },
    async hit() { return !occluded },
    async window() {}, async close() {},
  }
  const driver: DesktopDriver = {
    async screenSize() { return { width: 960, height: 540 } },
    async windows() { return structuredClone(windows) },
    async observe(window) { return { window: structuredClone(window), elements: [{ token: `private-${++generation}`, role: 'Edit',
      label: 'Input', value: values.get(window.windowId) ?? '', valueAvailable: true, enabled: true, actions: ['set_value'] }],
      width: 400, height: 300, truncated: false, elementsComplete: true, images: [] } },
    async act(name, args) { calls.push({ name, args }); if (name === 'type_text' || name === 'set_value') values.set(String(args.window_id), String(args.text ?? args.value));
      return { status: 'verified', message: 'Verified fixture state' } },
    async close() {},
  }
  return { windows, driver, observer, calls, values, restart: () => { started = 'second' },
    foreground: (windowId: string) => { foregroundId = windowId }, occlude: (value: boolean) => { occluded = value },
    physical: (stop: boolean) => physical(stop),
    observerFactory: async (callback: (stop: boolean) => void) => { physical = callback; return observer } }
}

export async function desktopFixture(options: { initialize?: () => Promise<void> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-desktop-'))
  const desktop = fakeDesktop()
  const broker = await serveDesktopBroker(root, { driver: async () => { await options.initialize?.(); return desktop.driver }, observer: desktop.observerFactory })
  const accounts: ReturnType<typeof account>[] = []
  function account(origin: 'mon' | 'local' = 'local') {
    const database = new EdenDatabase(':memory:', origin)
    const sessions = new SessionRepository(database, origin)
    const session = sessions.create('Desktop fixture', [{ assistantId: 1 }], null)
    const permissions = new PermissionService(database, sessions.events)
    const blobs = new BlobService(path.join(root, randomUUID()), new BlobRepository(database))
    const service = new DesktopService(database, sessions, blobs, root, true)
    const turnId = randomUUID()
    const tools = desktopTools(service, permissions, session.id, turnId).map(modelTool)
    const call = (name: string, input: Record<string, unknown>, callId: string = randomUUID(), signal = new AbortController().signal) =>
      tools.find(t => t.name === name)!.execute(input, { callId, signal }) as Promise<any>
    const callModel = async (name: string, input: Record<string, unknown>) => {
      const tool = tools.find(t => t.name === name)!, raw = await call(name, input)
      return { raw, value: tool.modelResult!(raw, input) as any, images: await service.images(raw) }
    }
    return { database, sessions, session, permissions, service, tools, call, callModel, turnId }
  }
  return { ...desktop, broker, root,
    account(origin: 'mon' | 'local' = 'local') { const value = account(origin); accounts.push(value); return value },
    async close() { for (const a of accounts) a.service.close(); await broker.close(); for (const a of accounts) a.database.close(); rmSync(root, { recursive: true, force: true }) },
  }
}
export async function tick() { await new Promise<void>(resolve => setImmediate(resolve)) }
