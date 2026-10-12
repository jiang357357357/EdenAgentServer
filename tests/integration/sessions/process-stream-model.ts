import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Local SSE recording for the session integration tests; never contacts a model provider. */
export async function processStreamModel(mode: 'tool' | 'wait', tokens = 400) {
  let requests = 0
  const responses = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain this fixture only. */ }
    requests++
    responses.add(response)
    response.on('close', () => responses.delete(response))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
      id: `fixture-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`)
    chunk({ role: 'assistant' })
    if (requests === 1) {
      for (let index = 0; index < tokens; index++) chunk({ reasoning_content: '想' })
      if (mode === 'wait') { response.flushHeaders(); return }
      chunk({ tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'write_once', arguments: '' } }] })
      for (const character of JSON.stringify({ value: '文'.repeat(tokens) })) chunk({ tool_calls: [{ index: 0, function: { arguments: character } }] })
      chunk({}, 'tool_calls')
    } else {
      for (const character of 'fixture done') chunk({ content: character })
      chunk({}, 'stop')
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    get requests() { return requests }, tokens,
    config: { provider: 'fixture', id: 'fixture', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 32000, maxTokens: 2048 },
    async close() {
      for (const response of responses) response.destroy()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
