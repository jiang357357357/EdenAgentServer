import { recordedModel } from '@eden/runtime-pi/testing'
import type { RuntimeTool } from '@eden/runtime-pi'
import { EdenDatabase } from '@eden/store'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { QqSharedBridge } from '../../../src/modules/qq-channel/shared-bridge.ts'
import { QqSharedRepository } from '../../../src/modules/qq-channel/shared-repository.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'

export const identity = { coreBaseUrl: 'https://fixture.invalid', userId: '7', secret: 'shared-group-test' }
export const account = { key: accountKey(identity.coreBaseUrl, '7'), userId: '7', coreBaseUrl: identity.coreBaseUrl }
export const environment = { sourceChannel: 'qq', channelAudience: 'qq_group', botQq: '100001', groupQq: '300001', locale: 'zh-CN', timezone: 'Asia/Shanghai' }

export async function sharedFixture(scripts: Parameters<typeof recordedModel>[0], tools: (sessionId: string, turnId: string) => RuntimeTool[] = () => [],
  configure?: () => Promise<unknown>) {
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  const model = await recordedModel(scripts)
  const session = withAccount(account, () => repository.create('QQ 群聊', [{ assistantId: 1, characterId: 2,
    profile: { character: { name: 'Alice', system_prompt: '你是群聊助手 Alice。根据真实发言人回答问题。' } } }], environment,
    { purpose: 'user_chat', sourceChannel: 'qq' }))
  new QqSharedRepository(database).bind(session.id, '100001', '300001')
  const sessions = new SessionService(repository, model.config, tools)
  const mon = { catalog: configure ?? (async () => { throw new Error('Unexpected model rebinding') }) } as unknown as MonBindingService
  const bridge = new QqSharedBridge(identity, database, sessions, mon, new AbortController().signal)
  return { database, repository, model, session, sessions, bridge,
    async idle() { await sessions.waitForIdle(session.id) },
    async close() { await bridge.close(); await sessions.close(); await model.close(); database.close() } }
}

export function groupInput(sequence: number, operator = '200001', previous: string | null = null) {
  return { user_id: '7', bot_qq: '100001', group_qq: '300001', contact_qq: operator, assistant_id: 1, character_id: 2,
    schema_version: 'qq-group-turn.v5', message_id: `native-${sequence}`, text: `第 ${sequence} 个问题`,
    context: { schema_version: 'qq-group-shared.v1', bot_qq: '100001', group_qq: '300001', operator_qq: operator,
      speaker_name: operator === '200001' ? 'A' : 'B', speaker_permission: operator === '200001' ? 'super_admin' : 'allowed',
      source_key: `core-${sequence}`, sequence, previous_source_key: previous, messages: [] } }
}
