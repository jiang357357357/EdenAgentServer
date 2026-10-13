import { searchRequest } from './workspace-search-contracts.ts'
import type { SearchMessage } from './workspace-search-contracts.ts'
import { scanWorkspace } from './workspace-search-scanner.ts'

function send(message: SearchMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) { reject(new Error('Search host disconnected')); return }
    process.send(message, error => error ? reject(error) : resolve())
  })
}

process.once('disconnect', () => process.exit(0))
process.once('message', raw => {
  void (async () => {
    try {
      const request = searchRequest.parse(raw)
      const result = await scanWorkspace(request, snapshot => send({ type: 'progress', snapshot }))
      await send({ type: 'done', ...result })
    } catch (error) {
      await send({ type: 'error', error: (error instanceof Error ? error.message : String(error)).slice(0, 4096) })
    } finally { process.disconnect?.() }
  })().catch(() => process.exit(1))
})
