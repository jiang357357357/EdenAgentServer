export interface SharedFile {
  fileId: string; path: string; revision: number; deleted: boolean; sha256: string | null; size: number
}
export interface SharedStatus {
  bound: boolean; spaceId: string | null; paused: boolean
  state: 'unbound' | 'idle' | 'syncing' | 'offline' | 'conflict' | 'paused'
  pending: number; conflicts: number; lastSync: number | null; error: string | null; root: string
}
export interface SharedRemote {
  request<T>(method: string, path: string, body?: unknown): Promise<T>
  upload(spaceId: string, sha256: string, bytes: Uint8Array): Promise<void>
  download(spaceId: string, sha256: string): Promise<Uint8Array>
}
export interface SharedClient {
  status(): SharedStatus
  bind(spaceId: string): Promise<unknown>
  sync(): Promise<unknown>
  pause(paused: boolean): unknown | Promise<unknown>
  files(): SharedFile[]
  conflicts(): unknown[]
  resolve(conflictId: string, strategy: 'local' | 'remote'): Promise<unknown>
  history(fileId: string): Promise<unknown>
  restore(fileId: string, revision: number): Promise<unknown>
  start(): void
  suspend(): Promise<void>
  close(): Promise<void>
}
export interface SharedClientOptions {
  dataRoot: string
  workspace(): { root: string; key: string }
  mutate<T>(root: string, work: () => Promise<T>): Promise<T>
  remote: SharedRemote
}
export interface SharedNetwork {
  deviceId: string; name: string; addresses: string[]; port?: number; listening: boolean; discoveryError: string | null
  peers: { deviceId: string; name: string; addresses: string[]; paired: boolean; discovered: boolean; revoked: boolean; error?: string | null }[]
}
export interface SharedLanRuntime {
  remote: SharedRemote
  start(): Promise<void>; suspend(): Promise<void>; close(): Promise<void>
  network(): SharedNetwork
  invite(): { code: string; expiresAt: number }
  pair(code: string, address?: string): Promise<{ paired: true }>
  revoke(deviceId: string): void
}
export type SharedClientFactory = ((options: SharedClientOptions) => SharedClient) & {
  createLanRuntime?: (options: { dataRoot: string; active(): boolean; canPublish(): boolean }) => Promise<SharedLanRuntime>
}
export interface SharedCredential { accountKey: string; coreBaseUrl: string; token: string }
export type CredentialLease = () => Promise<SharedCredential>
