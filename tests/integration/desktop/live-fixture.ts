import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { DesktopService, desktopTools } from '../../../src/modules/desktop/index.ts'
import { serveDesktopBroker } from '../../../src/modules/desktop/broker-server.ts'
import { modelTool } from '../../../src/modules/tool-results/index.ts'
import { startInputObserver } from '../../../src/modules/desktop/input-observer.ts'

export async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout
  let value: T | undefined
  do { try { value = await read(); if (accept(value)) return value } catch { /* Fixture publishes atomically after startup. */ }
    await delay(80)
  } while (Date.now() < deadline)
  throw new Error(`Live fixture did not reach expected state: ${JSON.stringify(value)}`)
}

export async function liveDesktopFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-cua-live-'))
  const title = `Eden-Cua-Live-${randomUUID().slice(0, 8)}`
  const executable = path.join(root, 'fixture.exe')
  await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll',
      `/out:${executable}`, fileURLToPath(new URL('./native-fixture.cs', import.meta.url))], { windowsHide: true })
  const child = spawn(executable, [root, title], { windowsHide: true, stdio: 'ignore' })
  const state = async (): Promise<any> => JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'))
  let broker: Awaited<ReturnType<typeof serveDesktopBroker>> | undefined
  const database = new EdenDatabase(':memory:', 'local')
  const inputEvents: Record<string, unknown>[] = []
  let service: DesktopService | undefined
  try {
    await until(state, value => Boolean(value.windows) && value.A.visibleBounds.width > 0)
    broker = await serveDesktopBroker(path.join(root, 'broker'), { observer: callback => startInputObserver((stop, windowId, source) => {
      inputEvents.push({ at: Date.now(), stop, windowId, source }); callback(stop, windowId, source)
    }) })
    const sessions = new SessionRepository(database, 'local')
    const session = sessions.create(title, [{ assistantId: 1 }], null)
    const permissions = new PermissionService(database, sessions.events); permissions.setMode('full_access')
    const blobs = new BlobService(path.join(root, 'blobs'), new BlobRepository(database))
    service = new DesktopService(database, sessions, blobs, path.join(root, 'broker'), true)
    function tools(turn = randomUUID(), model = false) {
      const catalog = desktopTools(service!, permissions, session.id, turn).map(modelTool)
      return async (name: string, input: Record<string, unknown>): Promise<any> => {
        const tool = catalog.find(tool => tool.name === name)!
        const raw = await tool.execute(input, { callId: randomUUID(), signal: AbortSignal.timeout(30000) })
        return model ? { raw, value: tool.modelResult!(raw, input), images: await service!.images(raw) } : raw
      }
    }
    return { title, state, call: tools(), callModel: tools(randomUUID(), true), anotherTurn: tools, pid: child.pid, root,
      operations: () => database.connection.prepare('SELECT action,state FROM desktop_operations ORDER BY created_at').all(),
      control: () => broker!.arbiter.status('test-inspection', true), inputEvents,
      async close() { service?.close(); await broker?.close(); database.close(); await closeChild() } }
  } catch (error) { service?.close(); await broker?.close(); database.close(); await closeChild(); throw error }
  async function closeChild() {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit }
    assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('eden-cua-live-'))
    await rm(root, { recursive: true, force: true })
  }
}
