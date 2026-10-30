import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBlobBody } from './blob-body.ts'
import { z } from 'zod'
import type { OsTools } from '../../modules/os/index.ts'

const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string()]).optional(), method: z.string(), params: z.unknown().optional() })
const call = z.object({ name: z.string(), arguments: z.unknown().optional() })

/** Stateless Streamable HTTP, retaining the existing local Core/MCP contract. */
export class OsMcpEndpoint {
  private readonly active = new Set<Promise<void>>()
  private closed = false
  constructor(private readonly tools: OsTools, private readonly componentVersion: string) {}
  handle(request: IncomingMessage, response: ServerResponse) {
    if (this.closed || this.active.size >= 32) { response.writeHead(503).end(); return }
    const host = String(request.headers.host ?? '').toLowerCase().split(':')[0] ?? ''
    if (request.headers.origin || !['127.0.0.1', 'localhost'].includes(host)) { response.writeHead(403).end(); return }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return }
    if (!String(request.headers['content-type']).startsWith('application/json')) { response.writeHead(415).end(); return }
    const task = this.dispatch(request, response).catch(error => {
      if (!response.destroyed && !response.writableEnded) this.reply(response, { jsonrpc: '2.0', id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : 'Invalid request' } })
    }).finally(() => { this.active.delete(task) })
    this.active.add(task)
  }
  private async dispatch(request: IncomingMessage, response: ServerResponse) {
    const input = envelope.parse(JSON.parse((await readBlobBody(request, 8 * 1024 * 1024)).toString('utf8')))
    if (input.id === undefined) { response.writeHead(202).end(); return }
    const params = input.params && typeof input.params === 'object' ? input.params as Record<string, unknown> : {}
    let result: unknown
    switch (input.method) {
      case 'initialize': result = { protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(String(params.protocolVersion)) ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'eden-agent-local-capabilities', version: this.componentVersion } }; break
      case 'ping': result = {}; break
      case 'tools/list': result = { tools: this.tools.list() }; break
      case 'tools/call': {
        const args = call.parse(params), value = await this.tools.call(args.name, args.arguments)
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; break
      }
      default: this.reply(response, { jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'Method not found' } }); return
    }
    this.reply(response, { jsonrpc: '2.0', id: input.id, result })
  }
  private reply(response: ServerResponse, value: unknown) {
    if (!response.destroyed && !response.writableEnded) response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
  }
  async close() { this.closed = true; await Promise.allSettled(this.active) }
}
