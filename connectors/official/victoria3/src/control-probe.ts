import { randomUUID } from 'node:crypto'
import { writeFile, rename, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import type { ConnectorContext } from '@eden/plugin-sdk/connector'
import type { JsonValue } from '@eden/api/connector'
import { injectConsole } from './console-input.ts'

function duration(settings: Record<string, JsonValue>, name: string, fallback: number, minimum: number, maximum: number) {
  const value = settings[name]
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
}
export async function probeControl(context: ConnectorContext, state: Record<string, JsonValue>, inject = injectConsole): Promise<JsonValue> {
  const settings = context.settings as Record<string, JsonValue>, directory = settings.commandDirectory
  if (!settings.controlEnabled || !state.attached || !state.bridgeSeen) throw new Error('Control requires enabled settings and an attached bridge')
  if (typeof directory !== 'string' || !context.grantedPermissions.some(item => item.capability === 'filesystem.write' && item.resource === directory && item.access === 'write')) throw new Error('Command directory is not approved')
  if (!context.grantedPermissions.some(item => item.capability === 'desktop.input' && item.resource === 'application:victoria3' && item.access === 'control')) throw new Error('Game console input is not approved')
  const commandId = randomUUID(), stem = `edenagent_${commandId.replaceAll('-', '')}`
  const file = path.join(directory, stem + '.txt'), temporary = path.join(directory, stem + '.tmp')
  try {
    await writeFile(temporary, `debug_log = "[EDENAGENT]|1|ACK|command_id=${commandId}|status=success|action=probe_control"\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
    await inject({ stem, virtualKey: duration(settings, 'consoleVirtualKey', 192, 1, 255), focusDelay: duration(settings, 'focusDelayMs', 350, 100, 2000),
      keyDelay: duration(settings, 'keyDelayMs', 8, 1, 100), signal: context.signal })
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(duration(settings, 'ackTimeoutMs', 10000, 1000, 30000))])
    const ack = await waitForAck(state, commandId, signal)
    if (ack.status !== 'success') throw new Error('Game rejected control probe')
    return { commandId, status: ack.status, action: 'probe_control', acknowledged: true, ack }
  } finally { await rm(temporary, { force: true }); await rm(file, { force: true }) }
}
async function waitForAck(state: Record<string, JsonValue>, id: string, signal: AbortSignal) {
  while (true) {
    signal.throwIfAborted()
    const ack = state.latestAck
    if (ack && typeof ack === 'object' && !Array.isArray(ack) && ack.commandId === id) return ack
    await delay(20, undefined, { signal })
  }
}
