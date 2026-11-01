import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { memoCreateSchema, toJson } from '@eden/api'
import { MonClient } from '@eden/integrations'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { JobRepository, JobScheduler } from '../../../src/modules/jobs/index.ts'
import { MemoRepository, MemoNotifications, MemoDeliveryRepository, MemoDeliveryService, MemoDeliveryEffects, MemoJobRecovery, memoDispatcher } from '../../../src/modules/memos/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { contactTools, deviceTools, NapcatClient, napcatTools } from '../../../src/modules/mon/index.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'
import { deliverContact } from '../../../src/modules/mon/contact-delivery.ts'
import { DesktopReminderRepository, desktopReminderTools } from '../../../src/modules/notifications/index.ts'

export const email = { name: 'send_external_email', input: { title: '角色的提醒', message: '老师，约好的时间到了，爱丽丝来提醒啦。' } }
export const qq = { name: 'execute_qq_action', input: { action: 'send_private_msg', params: { user_id: '654321', message: '角色自主选择的 QQ 提醒' } } }
export type Step = { name: string; input: Record<string, unknown> }

/** Real scheduler → isolated runtime → local SSE provider → approved builtin tool → local HTTP Core. */
export async function roleReminderFixture(t: TestContext, sourceChannel: 'app' | 'qq' = 'qq', group = false) {
  const plans = { steps: [email] as Step[], reject: false, rejectEmail: false, loseReceipt: false, malformed: false, deviceStatus: 'sent' }
  const writes: { channel: string; body: Record<string, unknown> }[] = [], prompts: string[] = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString()
    const raw = body ? JSON.parse(body) : {}
    res.setHeader('content-type', 'application/json')
    if (req.url?.startsWith('/v1/')) {
      const messages = raw.messages as { role: string; content?: string }[]
      const lastUser = messages.findLastIndex(message => message.role === 'user')
      const content = messages[lastUser]?.content ?? ''
      const prompt = typeof content === 'string' ? content : JSON.stringify(content); prompts.push(prompt)
      const count = messages.slice(lastUser + 1).filter(message => message.role === 'tool').length
      const step = plans.steps[count]
      res.setHeader('content-type', 'text/event-stream')
      const delta = step ? { role: 'assistant', tool_calls: [{ index: 0, id: `choice-${count}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.input) } }] }
        : { role: 'assistant', content: '提醒处理完毕。' }
      res.end(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: step ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    if (req.url?.includes('actions/execute')) {
      if (raw.action === '__capabilities__') {
        res.end(JSON.stringify({ data: { request_id: raw.request_id, action: raw.action, status: 'success', result: {
          protocol: 'napcat-action.v1', actions: { send_private_msg: { description: 'Send', mutating: true, target: 'contact',
            parameters: { type: 'object', properties: { user_id: { type: 'string' }, message: { type: 'string' } }, required: ['user_id', 'message'] } } },
        } } })); return
      }
      writes.push({ channel: 'qq', body: raw })
      if (plans.loseReceipt) { req.socket.destroy(); return }
      res.end(JSON.stringify({ data: { request_id: raw.request_id, action: raw.action, status: plans.reject ? 'failed' : 'success',
        result: plans.malformed ? {} : { message_id: 1000 + writes.length } } })); return
    }
    writes.push({ channel: 'email', body: raw })
    if (plans.loseReceipt) { req.socket.destroy(); return }
    res.end(JSON.stringify(plans.malformed ? {} : { success: !plans.reject && !plans.rejectEmail }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  const account = { key: accountKey(baseUrl, '2'), coreBaseUrl: baseUrl, userId: '2' }
  const session = withAccount(account, () => repository.create('角色定时提醒', [{ assistantID: 'fixture' }], {}, { purpose: 'user_chat', sourceChannel }))
  if (sourceChannel === 'qq' && group) database.connection.prepare('INSERT INTO qq_group_sessions VALUES(?,?,?,?,?,?)').run(session.id, '123456', '987654', '654321', 0, Date.now())
  else if (sourceChannel === 'qq') database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)').run('123456', '654321', session.id, Date.now())
  const jobs = new JobRepository(database), memos = new MemoRepository(database, jobs), notifications = new MemoNotifications(database)
  const deliveries = new MemoDeliveryRepository(database, memos, notifications, jobs)
  const effects = new MemoDeliveryEffects(deliveries, async (_sessionId, id) => ({ id, status: plans.deviceStatus }))
  const permissions = new PermissionService(database, repository.events, () => false); permissions.setMode('full_access')
  if (sourceChannel === 'qq') permissions.setQqMode('123456', '654321', 'full_access', group ? '987654' : undefined)
  const client = new MonClient(baseUrl, 'fixture-token')
  const mon = {
    contactChannels: async () => ({ qq: { available: true }, email: { available: true } }),
    contactOwnerByEmail: (sid: string, input: { requestId: string; title: string; message: string }, signal: AbortSignal) =>
      deliverContact(database, client, sid, input.requestId, 'email', '/api/agent/external-email/send/', JSON.stringify({ subject: input.title, content: input.message, request_id: input.requestId }), signal),
    issueEsp32Command: async () => ({ id: 'device-fixture', status: plans.deviceStatus }),
  } as unknown as MonBindingService
  const napcat = new NapcatClient(repository, { coreBaseUrl: baseUrl, userId: '2', secret: 'fixture-secret' })
  const desktop = new DesktopReminderRepository(repository)
  const model = { provider: 'fixture', id: 'fixture', baseUrl: `${baseUrl}/v1`, contextWindow: 32000, maxTokens: 2048 }
  const sessions = new SessionService(repository, model, (sid, tid) => [
    ...contactTools(mon, permissions, sid, tid), ...napcatTools(napcat, permissions, sid, tid),
    ...deviceTools(mon, permissions, sid, tid), ...desktopReminderTools(desktop, permissions, sid, tid),
  ].map(tool => effects.wrap(tool, sid, tid)))
  const service = new MemoDeliveryService(deliveries, sessions, effects)
  const dispatch = memoDispatcher(database, memos, notifications, jobs, sessions, deliveries)
  const recovery = new MemoJobRecovery(database, memos, notifications, jobs, sessions, deliveries)
  const scheduler = new JobScheduler(jobs, { 'memo.reminder': dispatch, 'memo.reminder.redelivery': job => recovery.dispatch(job) })
  t.after(async () => {
    scheduler.close(); await service.close(); await sessions.close(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve())); database.close()
  })
  const create = (patch: Record<string, unknown> = {}) => memos.create(memoCreateSchema.parse({ title: '到点喝水', content: '提醒内容由角色自然组织',
    kind: 'reminder', remindAt: Date.now() - 1000, relatedSessionId: session.id, ...patch }))
  const stage = () => { const job = jobs.claim()!; assert.ok(job); dispatch(job); return job }
  const finish = async () => {
    await service.drain(); await sessions.waitForIdle(session.id); jobs.settleInputs(); await service.drain()
  }
  return { database, repository, session, sessions, jobs, memos, notifications, deliveries, effects, permissions,
    desktop, napcat, service, recovery, scheduler, plans, writes, prompts, create, stage, finish, toJson }
}
