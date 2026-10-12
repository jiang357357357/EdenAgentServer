import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { NapcatClient } from '../../../src/modules/mon/napcat-client.ts'
import { napcatTools } from '../../../src/modules/mon/napcat-tools.ts'

export const rawTid = '3adce9e90fa4cb6a8c500800'
export const rawMessageId = '4294967123'
const spec = (mutating: boolean, fields: string[]) => ({ description: 'fixture', mutating, target: 'account',
  parameters: { type: 'object', properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])), required: fields } })
export const actionCatalog = { protocol: 'napcat-action.v1', actions: {
  send_qzone_msg: spec(true, ['content']), delete_qzone_msg: spec(true, ['tid']),
  get_msg: spec(false, ['message_id']), delete_msg: spec(true, ['message_id']),
  set_group_add_request: spec(true, ['flag', 'sub_type']),
} }

export function qqResultFixture(filename = ':memory:') {
  const database = new EdenDatabase(filename, 'mon'), sessions = new SessionRepository(database, 'mon')
  const session = sessions.create('QQ result privacy')
  sessions.ownership.assign(session.id, JSON.stringify(['https://core.example', '7']))
  database.transaction(() => new MonConnectionRepository(database).saveInTransaction(session.id,
    { coreBaseUrl: 'https://core.example', coreToken: 'test-only-token' }))
  const sent: { action: string; params: Record<string, unknown>; request_id: string }[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)); sent.push(input)
    const result = input.action === '__capabilities__' ? actionCatalog : input.action === 'send_qzone_msg'
      ? { tid: rawTid, status: 'success', note: `published ${rawTid}` } : input.action === '__events__'
        ? { items: [{ event: { flag: 'native-request-flag', sub_type: 'add' } }], next_cursor: 'native-next-cursor' }
        : input.action === 'get_msg' ? { message_id: rawMessageId, message: [{ type: 'text', data: { text: '正文' } }] }
          : { success: true }
    return Response.json({ data: { request_id: input.request_id, status: 'success', action: input.action, result } })
  }
  const client = new NapcatClient(sessions, undefined, fetcher), permissions = new PermissionService(database, sessions.events)
  permissions.setMode('full_access')
  const turnId = randomUUID(), tools = napcatTools(client, permissions, session.id, turnId)
  const context = { callId: 'test-call', signal: new AbortController().signal }
  return { database, sessions, session, client, permissions, tools, turnId, sent, context,
    tool: (name: string) => tools.find(tool => tool.name === name)!, close: () => database.close() }
}
