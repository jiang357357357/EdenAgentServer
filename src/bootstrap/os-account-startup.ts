import { setTimeout } from 'node:timers/promises'
import type { AccountRuntimes } from './account-runtimes.ts'
import { logDiagnostic } from '../modules/logging/index.ts'

/** Core may depend on the local MCP listener; account recovery begins after Core is available. */
export function startOsAccounts(runtimes: AccountRuntimes, coreBaseUrl: string) {
  const abort = new AbortController()
  const task = (async () => {
    while (!abort.signal.aborted) {
      try {
        const response = await fetch(`${coreBaseUrl.replace(/\/$/, '')}/__ping`, { redirect: 'error',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) })
        await response.body?.cancel()
        if (response.ok) { await runtimes.start(); return }
      } catch (error) {
        if (abort.signal.aborted) return
        // A cold Core is an expected startup dependency; no account is opened against an unavailable server.
        if (error instanceof Error && error.name !== 'TypeError' && error.name !== 'TimeoutError')
          logDiagnostic({ event: 'os.accounts.waiting', message: '等待 Core 后恢复智能体账号', error: error.message }, 'warn')
      }
      try { await setTimeout(1000, undefined, { signal: abort.signal }) } catch { return }
    }
  })().catch(error => logDiagnostic({ event: 'os.accounts.startup_failed', message: '智能体账号恢复失败',
    error: error instanceof Error ? error.message : String(error) }, 'error'))
  return { async close() { abort.abort(); await task } }
}
