import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { QuestionService, questionTool } from '../../../src/modules/questions/index.ts'
import { questionRoutes } from '../../../src/transport/rpc/question.routes.ts'
import { RpcRouter } from '../../../src/transport/rpc/router.ts'
import { EdenAgentRpcClient } from '../../../../frontend/web/src/lib/rpc-client.ts'

test('two decision clients use real WebSocket question routes and only one accepted answer resumes the model', { timeout: 20000 }, async () => {
  const ask = { questions: [{ header: '下一步', question: '继续执行吗？', options: [{ label: '继续', description: '继续任务' }], custom: true }] }
  const model = await recordedModel([{ tool: 'request_user_input', input: ask }, { text: '已收到回答并继续任务' }])
  const db = new EdenDatabase(':memory:', 'local'), repository = new SessionRepository(db, 'local'), questions = new QuestionService(repository)
  const sessions = new SessionService(repository, model.config, (id, turn) => [questionTool(questions, id, turn)])
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', socket => {
    const router = new RpcRouter('local', questionRoutes(questions))
    socket.on('message', bytes => { void router.dispatch(JSON.parse(String(bytes))).then(result => socket.send(JSON.stringify(result))) })
  })
  const clients = [new EdenAgentRpcClient(5000), new EdenAgentRpcClient(5000)]
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await Promise.all(clients.map(client => client.connect(`ws://127.0.0.1:${address.port}`, 'fixture-capability', 'fixture', 'local')))
    let requested!: () => void
    const waiting = new Promise<void>(resolve => { requested = resolve })
    const unsubscribe = repository.events.subscribe(event => { if (event.kind === 'question.requested') requested() })
    const session = repository.create('Isolated decision')
    sessions.start(session.id, '请先提出一个选择题')
    await waiting
    unsubscribe()
    const pending = await clients[0]!.request('question.list', {})
    assert.equal(pending.length, 1)
    assert.equal(model.requests.length, 1)
    const decisions = await Promise.allSettled(clients.map(client => client.request('question.resolve', {
      requestId: pending[0]!.id, answers: [['继续']], supplementary: ['先完成当前步骤'],
    })))
    assert.equal(decisions.filter(decision => decision.status === 'fulfilled').length, 1)
    const rejected = decisions.find((decision): decision is PromiseRejectedResult => decision.status === 'rejected')
    assert.match(String(rejected?.reason), /already resolved/)
    await sessions.waitForIdle(session.id)
    assert.deepEqual(await clients[1]!.request('question.list', {}), [])
    await assert.rejects(clients[1]!.request('question.resolve', { requestId: pending[0]!.id, answers: [['继续']] }), /already resolved/)
    assert.equal(model.requests.length, 2)
    assert.match(JSON.stringify(model.requests[1]), /继续|先完成当前步骤/)
    assert.equal(db.connection.prepare("SELECT COUNT(*) AS count FROM question_requests WHERE state='answered'").get()!.count, 1)
  } finally {
    for (const client of clients) client.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await sessions.close(); questions.close(); db.close(); await model.close()
  }
})
