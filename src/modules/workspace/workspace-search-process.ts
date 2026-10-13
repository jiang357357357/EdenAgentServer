import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { SEARCH_BUDGET_MS, SEARCH_CLEANUP_MS, searchMessage, searchRequest } from './workspace-search-contracts.ts'
import type { SearchRequest, SearchResult, SearchSnapshot, SearchStopReason } from './workspace-search-contracts.ts'

declare const EDEN_BUNDLED_SERVER: boolean
interface SearchPolicy { budgetMs?: number; worker?: URL }

function stopWorker(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  if (child.pid === undefined) return Promise.resolve(true)
  return new Promise(resolve => {
    const finish = (stopped: boolean) => {
      clearTimeout(timer)
      child.off('exit', exited)
      if (!stopped) { if (child.connected) child.disconnect(); child.unref() }
      resolve(stopped)
    }
    const exited = () => finish(true)
    const timer = setTimeout(() => finish(false), SEARCH_CLEANUP_MS)
    child.once('exit', exited)
    // Only this read-only Node scanner is killed. It never launches subprocesses or writes files.
    child.kill('SIGKILL')
  })
}

/** Policy overrides are host/test-only; model parameters cannot increase the deadline or select code. */
export function runSearchProcess(raw: SearchRequest, signal: AbortSignal, policy: SearchPolicy = {}): Promise<SearchResult> {
  signal.throwIfAborted()
  const request = searchRequest.parse(raw)
  const started = performance.now()
  const budgetMs = policy.budgetMs ?? SEARCH_BUDGET_MS
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > SEARCH_BUDGET_MS) throw new Error('Invalid search budget')
  const bundled = typeof EDEN_BUNDLED_SERVER !== 'undefined' && EDEN_BUNDLED_SERVER
  const entry = policy.worker ?? new URL(bundled ? './workspace-search-worker.mjs' : './workspace-search-worker.ts', import.meta.url)
  const spawnOptions = { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] as ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: ['--max-old-space-size=128', ...(bundled || policy.worker ? [] : ['--import', import.meta.resolve('tsx')])] }
  const child = fork(entry, [], spawnOptions)
  return supervise(child, request, signal, started, budgetMs)
}

function supervise(child: ChildProcess, request: SearchRequest, signal: AbortSignal, started: number, budgetMs: number): Promise<SearchResult> {
  return new Promise((resolve, reject) => {
    let snapshot: SearchSnapshot = { matches: [], scannedFiles: 0, visitedEntries: 0, skippedFiles: 0 }
    let finishing = false
    const finish = (reason: SearchStopReason, error?: unknown) => {
      if (finishing) return
      finishing = true
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      child.removeAllListeners('message')
      void stopWorker(child).then(workerStopped => {
        if (error !== undefined) { reject(error); return }
        resolve({ ...snapshot, truncated: reason !== 'completed', stopReason: reason, budgetMs,
          elapsedMs: Math.round(performance.now() - started), workerStopped })
      }, reject)
    }
    const aborted = () => finish('timeout', signal.reason ?? new Error('Search cancelled'))
    const timer = setTimeout(() => finish('timeout'), Math.max(0, budgetMs - (performance.now() - started)))
    signal.addEventListener('abort', aborted, { once: true })
    child.on('error', error => finish('timeout', error))
    child.once('exit', (code, exitSignal) => finish('timeout', new Error(`Search worker exited before returning (${exitSignal ?? code})`)))
    child.on('message', raw => {
      if (performance.now() - started >= budgetMs) { finish('timeout'); return }
      const parsed = searchMessage.safeParse(raw)
      if (!parsed.success) { finish('timeout', new Error('Invalid search worker response')); return }
      const message = parsed.data
      if (message.type === 'error') { finish('timeout', new Error(message.error)); return }
      snapshot = message.snapshot
      if (message.type === 'done') finish(message.stopReason)
    })
    if (signal.aborted) { aborted(); return }
    child.send(request, error => { if (error) finish('timeout', error) })
  })
}
