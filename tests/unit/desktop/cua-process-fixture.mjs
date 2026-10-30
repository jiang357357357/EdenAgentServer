import { createInterface } from 'node:readline'

const running = new Map()
const output = value => process.stdout.write(JSON.stringify(value) + '\n')
if (process.argv[2] === 'dpi-failure') {
  output({ error: { code: 'CUA_DPI_CONTEXT_UNAVAILABLE', message: 'DPI fixture refused before native startup', outcome: 'failed' } })
  process.exit(1)
}
output({ ready: true, backend: 'eden.cua-driver.0.28.0' })
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.action === 'cancel') {
    if (running.has(request.requestId)) { running.delete(request.requestId); output({ id: request.requestId, error: { code: 'CUA_CANCELLED', message: 'Fixture cancelled', outcome: 'unknown' } }) }
  } else if (request.action === 'crash') process.exit(23)
  else if (request.action === 'refuse') output({ id: request.id, error: { code: 'background_unavailable', message: 'refused', outcome: 'failed', diagnostics: { windowBounds: { x: 1, y: 2, width: 3, height: 4 } } } })
  else if (request.action === 'wait') { running.set(request.id, true); output({ id: request.args.ack, result: true }) }
  else output({ id: request.id, result: [] })
}
