import { z } from 'zod'
import { jsonValue } from '@eden/api'
import { CuaTransport } from './cua-transport.ts'
import type { CuaNativeResult, DesktopDriver, DriverAction, NativeObservation, NativeWindow } from './contracts.ts'
import { DesktopError } from './contracts.ts'

const bounds = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() })
const windowSchema = z.object({ pid: z.number().int().positive(), windowId: z.string().regex(/^\d+$/), app: z.string(), title: z.string(), bounds, minimized: z.boolean() })
const element = z.object({ token: z.string(), role: z.string(), label: z.string(), value: z.string(), enabled: z.boolean(), actions: z.array(z.string()),
  index: z.string().optional(), parent: z.string().optional(), frame: bounds.optional(), valueAvailable: z.boolean().optional(),
  valueTruncated: z.boolean().optional(), labelTruncated: z.boolean().optional() })
const observation = z.object({ window: windowSchema, elements: z.array(element).max(400), images: z.array(z.object({ mime: z.string(), data: z.string() })),
  width: z.number().nonnegative(), height: z.number().nonnegative(), truncated: z.boolean(), scale: z.number().optional(), frameValid: z.boolean().optional(),
  elementsComplete: z.boolean().optional(), degraded: z.boolean().optional(), degradedReason: z.string().optional(), truncationReason: z.string().optional(),
  screenshotIncluded: z.boolean().optional(), snapshot: z.string().optional(), elementCoordinateSpace: z.enum(['physical_screen_pixels', 'unknown']),
  captureBackend: z.literal('cua_driver_native'), textRequested: z.boolean() })
const action = z.object({ status: z.enum(['delivered', 'verified', 'refused', 'unknown']), message: z.string(), code: z.string().optional(),
  driverMessage: z.string().max(12000).optional(), diagnostics: z.record(z.string(), jsonValue).optional(),
  effect: z.enum(['confirmed', 'partial', 'unverifiable', 'suspected_noop', 'refused']).optional(),
  route: z.enum(['accessibility', 'synthetic_events', 'global_input', 'system_api', 'dom', 'trusted_input']).optional(),
  evidence: z.array(z.enum(['value_readback', 'window_change'])).optional() })
const native = action.extend({ structuredJson: z.string().optional(), text: z.string(), images: z.array(z.object({ mime: z.string(), data: z.string() })) })

export async function createCuaDriver(): Promise<DesktopDriver> {
  if (process.platform !== 'win32') throw new DesktopError('Cua 桌面宿主当前仅支持 Windows', 'PLATFORM_UNSUPPORTED')
  const transport = new CuaTransport()
  const client = new CuaDriverClient(transport, 'shared')
  return { ...client.driver(), scoped: scope => new CuaDriverClient(transport, scope).driver(), close: () => transport.close(), terminate: () => transport.terminate() }
}
export class CuaDriverClient {
  private generation = 0
  private previous = ''
  constructor(private readonly transport: Pick<CuaTransport, 'request' | 'prepare'>, private readonly scope: string) {}
  private request(name: string, args: Record<string, unknown>, signal: AbortSignal, input = false) {
    return this.transport.request(name, args, signal, input, this.scope)
  }
  driver(): DesktopDriver {
    return {
      prepare: async signal => {
        const process = await this.transport.prepare(signal)
        const session = z.number().int().nonnegative().parse(await this.request('prepare', {}, signal))
        const current = `${process}:${session}`
        if (current !== this.previous) { this.previous = current; this.generation++ }
        return this.generation
      },
      windows: async signal => z.array(windowSchema).parse(await this.request('windows', {}, signal)) as NativeWindow[],
      screenSize: async signal => z.object({ width: z.number().positive(), height: z.number().positive() }).parse(await this.request('screen', {}, signal)),
      observe: async (window, signal, options) => observation.parse(await this.request('observe', { window,
        screenshot: options?.screenshot ?? true, text: options?.text ?? true }, signal)) as NativeObservation,
      act: async (name, args, signal) => action.parse(await this.request('act', { name, input: args }, signal, true)) as DriverAction,
      native: async (name, args, signal) => native.parse(await this.request('native', { name, input: args }, signal, true)) as CuaNativeResult,
      release: async () => { await this.request('release', {}, AbortSignal.timeout(7000)) },
      close: async () => { await this.request('release', {}, AbortSignal.timeout(7000)) },
    }
  }
}
