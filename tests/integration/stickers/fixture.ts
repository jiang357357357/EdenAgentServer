import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { toJson } from '@eden/api'
import { createServices } from '../../../src/bootstrap/services.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { NapcatClient } from '../../../src/modules/mon/index.ts'
import { stickerTools } from '../../../src/modules/stickers/index.ts'
import { AttachmentRepository } from '../../../src/modules/attachments/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'

export const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
export const metadata = { name: '开心', description: '开心地笑', emotion: '高兴', intent: '表达开心', aliases: ['笑笑', '高兴'] }

export async function stickerFixture(channel: 'app' | 'qq' | 'group' = 'app') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-stickers-'))
  const requests: { method: string; path: string; body: Buffer; headers: import('node:http').IncomingHttpHeaders }[] = []
  const uploaded: FormData[] = []
  let base = '', status = 'success', image: Buffer = gif, imageMime = 'image/gif', nextId = 2
  let afterCatalog: (() => void) | undefined
  let catalog = [{ id: 1, character_id: 9, ...metadata, image_url: '', enabled: true }]
  const core = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks), url = request.url ?? ''
      requests.push({ method: request.method!, path: url, body, headers: request.headers })
      if (url === '/image.gif') { response.writeHead(200, { 'content-type': imageMime }).end(image); return }
      if (url.startsWith('/api/characters/9/stickers/') && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(catalog)); return
      }
      if (url === '/api/characters/9/stickers/' && request.method === 'POST') {
        const form = await new Request(base + url, { method: 'POST', headers: { 'content-type': request.headers['content-type']! }, body }).formData()
        uploaded.push(form)
        const sticker = { id: nextId++, character_id: 9, name: String(form.get('name')), description: String(form.get('description')),
          emotion: String(form.get('emotion')), intent: String(form.get('intent')), aliases: JSON.parse(String(form.get('aliases'))),
          image_url: base + '/image.gif', enabled: true }
        catalog.push(sticker)
        response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(sticker)); return
      }
      if (url.startsWith('/api/characters/9/stickers/') && request.method === 'DELETE') {
        const id = Number(url.split('/').at(-2)); catalog = catalog.filter(item => item.id !== id)
        response.writeHead(204).end(); return
      }
      if (url === '/api/devices/qq_bot/actions/execute/') {
        const input = JSON.parse(body.toString())
        const result = input.action === '__capabilities__' ? { protocol: 'napcat-action.v1', actions: {
          send_private_sticker: { description: '发送表情包', mutating: true, target: 'user', parameters: {} },
          send_group_sticker: { description: '发送表情包', mutating: true, target: 'group', parameters: {} },
        } } : { message_id: 'platform-message-secret', request_id: 'platform-trace-secret' }
        if (input.action === '__capabilities__') afterCatalog?.()
        if (status === 'disconnect' && input.action !== '__capabilities__') { response.destroy(); return }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: {
          request_id: input.request_id, action: input.action, status: input.action === '__capabilities__' ? 'success' : status, result,
        } })); return
      }
      response.writeHead(404).end()
    } catch (error) { response.writeHead(500).end(String(error)) }
  })
  await new Promise<void>(resolve => core.listen(0, '127.0.0.1', resolve))
  const address = core.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  base = `http://127.0.0.1:${address.port}`; catalog[0]!.image_url = base + '/image.gif'
  const database = new EdenDatabase(':memory:', 'mon')
  const identity = { coreBaseUrl: base, userId: '7', secret: 'fixture-only-secret' }
  const services = createServices(database, { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root }, root), origin: 'mon', monIdentity: identity })
  const session = services.repository.create('表情包', [{ assistantId: 1, characterId: 9 }], null,
    { purpose: 'user_chat', sourceChannel: channel === 'app' ? 'app' : 'qq' })
  const account = { key: accountKey(base, '7'), userId: '7', coreBaseUrl: base }
  services.repository.ownership.assign(session.id, account.key)
  database.transaction(() => new MonConnectionRepository(database).saveInTransaction(session.id, { coreBaseUrl: base, coreToken: 'fixture-token' }))
  if (channel === 'qq') {
    database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)').run('111111', '222222', session.id, Date.now())
    services.permissions.setQqMode('111111', '222222', 'full_access')
  } else if (channel === 'group') database.connection.prepare('INSERT INTO qq_group_sessions VALUES(?,?,?,?,?,?)')
    .run(session.id, '111111', '333333', '222222', 1, Date.now())
  services.permissions.setMode('takeover')
  const attachment = await withAccount(account, () => services.blobs.put(gif, 'image/gif'))
  const snapshots = await services.attachments.snapshot([{ blobId: attachment.id, mime: 'image/gif', filename: 'smile.gif' }])
  const inputs = new InputRepository(database, services.repository.events)
  inputs.enqueue(session.id, '收藏这个表情包', randomUUID(), toJson({ attachments: snapshots }))
  const input = inputs.claim(session.id)!
  const napcat = new NapcatClient(services.repository, identity)
  const toolset = stickerTools(services.mon, napcat, services.repository, services.permissions, new AttachmentRepository(database),
    services.attachments, session.id, input.turnId)
  const context = () => ({ signal: new AbortController().signal, callId: randomUUID() })
  return { ...services, root, database, session, input, inputs, base, requests, uploaded, attachment, toolset, context,
    tool(name: string) { return toolset.find(tool => tool.name === name)! },
    execute(name: string, args: Record<string, unknown>) { return this.tool(name).execute(args, context()) },
    status(value: string) { status = value }, image(value: Buffer, mime = 'image/gif') { image = value; imageMime = mime },
    afterCatalog(callback: () => void) { afterCatalog = callback },
    async close() {
      await services.memoryExtractions.close()
      await Promise.all([services.sessions.close(), services.mon.close(), services.plugins.close(), services.companion.close(), services.qqChannelBridge?.close()])
      services.questions.close(); database.close()
      await new Promise<void>(resolve => core.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    } }
}
