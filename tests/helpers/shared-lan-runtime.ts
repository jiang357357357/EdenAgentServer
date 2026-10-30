import type { SharedLanRuntime } from '../../src/modules/shared-workspace/contracts.ts'

export function fakeSharedLanRuntime(onRequest: (method: string, path: string, body?: unknown) => void = () => {}): SharedLanRuntime {
  return {
    start: async () => {}, suspend: async () => {}, close: async () => {},
    network: () => ({ deviceId: '33333333-3333-4333-8333-333333333333', name: 'fixture', addresses: [], listening: true, discoveryError: null, peers: [] }),
    invite: () => ({ code: 'fixture', expiresAt: 600_000 }), pair: async () => ({ paired: true }), revoke: () => {},
    connectHost: async () => ({ paired: true, deviceId: '33333333-3333-4333-8333-333333333333' }),
    hosts: async () => ({ hosts: [] }), acceptsSpace: () => true, deploymentIdentity: () => ({ deviceId: '33333333-3333-4333-8333-333333333333', publicKey: 'fixture' }),
    hostRequest: async <T>(_: string, method: string, path: string, body?: unknown): Promise<T> => { onRequest(method, path, body); return { protocolVersion: 2 } as T },
    remote: { request: async <T>(method: string, path: string, body?: unknown): Promise<T> => { onRequest(method, path, body); return { protocolVersion: 2 } as T },
      upload: async () => {}, download: async () => new Uint8Array() },
  }
}
