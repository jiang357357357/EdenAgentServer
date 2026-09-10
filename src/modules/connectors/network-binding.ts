import { openSync, closeSync, fstatSync, readSync, constants, realpathSync, lstatSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import type { ConnectorManifest } from '@eden/api'
import { createTcpBridge } from './tcp-bridge.ts'
import { assertManagedProcess } from './managed-process.ts'

type Grant = { capability: string; resource: string; access: string }
const field = (reference: string) => reference.slice('settings.'.length)
const allowed = (grants: Grant[], resource: string, capability = 'network.connect', access = 'connect') => grants.some(item => item.capability === capability && item.resource === resource && item.access === access)

/** Only descriptor-declared, instance-approved destinations reach a fixed-address socket. */
export async function connectorNetworkBinding(manifest: ConnectorManifest, settings: Record<string, unknown>, grants: Grant[], dataRoot: string, authorize: () => void, signal: AbortSignal) {
  const binding = manifest.network
  if (!binding) return undefined
  const target = binding.kind === 'http' ? await httpTarget(binding, settings, grants, signal) : tcpTarget(binding, settings, grants, dataRoot)
  const check = () => { signal.throwIfAborted(); authorize(); target.assertCurrent() }
  check()
  const bridge = await createTcpBridge({ address: target.address, port: target.port, limit: 32 }, check, signal)
  return { ...bridge, settings: target.settings, assertCurrent: check }
}

async function httpTarget(binding: Extract<NonNullable<ConnectorManifest['network']>, { kind: 'http' }>, settings: Record<string, unknown>, grants: Grant[], signal: AbortSignal) {
  const resource = settings[field(binding.setting)] ?? binding.fallback
  if (typeof resource !== 'string' || !allowed(grants, resource)) throw new Error('HTTP endpoint is not approved')
  const url = validateHttpUrl(resource)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  signal.throwIfAborted()
  const address = host === 'localhost' ? '127.0.0.1' : isIP(host) ? host : (await resolveAddress(host, signal)).address
  signal.throwIfAborted()
  return { address, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), settings: { [field(binding.setting)]: resource }, assertCurrent() {} }
}

function tcpTarget(binding: Extract<NonNullable<ConnectorManifest['network']>, { kind: 'tcp' }>, settings: Record<string, unknown>, grants: Grant[], dataRoot: string) {
  if (binding.resource !== 'loopback' || !allowed(grants, binding.resource)) throw new Error('TCP binding requires an approved loopback destination')
  const registry = binding.registry && settings[field(binding.registry.setting)]
  if (settings[field(binding.host)] === undefined && settings[field(binding.port)] === undefined && registry !== undefined) {
    if (typeof registry !== 'string' || !allowed(grants, registry, 'filesystem.read', 'read')) throw new Error('Endpoint registry is not approved')
    const snapshot = registrySnapshot(registry, dataRoot)
    const record = JSON.parse(snapshot.bytes.toString('utf8')) as Record<string, unknown>
    const target = loopback(record[binding.registry!.hostField], record[binding.registry!.portField])
    const assertCurrent = () => {
      const latest = registrySnapshot(registry, dataRoot)
      if (snapshot.canonical !== latest.canonical || !snapshot.bytes.equals(latest.bytes)) throw new Error('Endpoint registry changed; reconnect required')
      // Legacy managed registry identity validation is retained during the transport migration.
      if (binding.registry!.processIdentity) assertManagedProcess(record as unknown as Parameters<typeof assertManagedProcess>[0])
    }
    assertCurrent()
    return { ...target, settings: { ...Object.fromEntries(Object.entries(binding.registry!.settingsFields).map(([setting, source]) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(setting) || ['constructor', 'prototype', '__proto__'].includes(setting)) throw new Error('Invalid registry setting mapping')
      return [setting, record[source]]
    })), [field(binding.host)]: target.address, [field(binding.port)]: target.port }, assertCurrent }
  }
  const target = loopback(settings[field(binding.host)], settings[field(binding.port)])
  return { ...target, settings: {}, assertCurrent() {} }
}

function loopback(host: unknown, port: unknown) {
  if (!['localhost', '127.0.0.1', '::1'].includes(String(host)) || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid connector loopback endpoint')
  return { address: host === '::1' ? '::1' : '127.0.0.1', port }
}
function registrySnapshot(file: string, dataRoot: string) {
  if (!path.isAbsolute(file) || lstatSync(file).isSymbolicLink()) throw new Error('Invalid endpoint registry path')
  const canonical = realpathSync(file), stat = lstatSync(canonical)
  if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid endpoint registry size or type')
  for (const root of [realpathSync(dataRoot), path.resolve('Data')]) if (canonical === root || canonical.startsWith(root + path.sep)) throw new Error('Registry overlaps private data')
  const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  const bytes = Buffer.alloc(stat.size)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size !== stat.size) throw new Error('Endpoint registry changed before reading')
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error('Endpoint registry truncated')
      offset += count
    }
    const after = fstatSync(descriptor)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Endpoint registry changed during reading')
  } finally { closeSync(descriptor) }

  return { canonical, bytes }
}

function validateHttpUrl(resource: string) {
  const url = new URL(resource), local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && url.port))) throw new Error('Connector HTTP binding requires HTTPS or explicit loopback HTTP')
  return url
}

function resolveAddress(host: string, parent: AbortSignal): Promise<{ address: string }> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(15000)])
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Connector address resolution cancelled or timed out'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    void lookup(host).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
