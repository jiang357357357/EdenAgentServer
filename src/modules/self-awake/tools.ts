import { timerReceipt } from './timer-receipt.ts'
import { selfAwakeContextSchema } from './context.ts'
import type { SelfAwakeContext } from './context.ts'
import { z } from 'zod'
import { selfAwakeToolTimerSchema, selfAwakeDiaryWriteSchema, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { JobRepository } from '../jobs/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import type { SelfAwakeRepository } from './repository.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

export function selfAwakeTools(repository: SelfAwakeRepository, jobs: JobRepository, permissions: PermissionService, activity: SelfAwakeContext, sessionId: string, turnId: string): RuntimeTool[] {
  return [{
    name: 'write_diary', revision: 'eden.self-awake.diary.v1', executionMode: 'sequential',
    description: toolDescription('write_diary'),
    parameters: toJson(z.toJSONSchema(selfAwakeDiaryWriteSchema, { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = selfAwakeDiaryWriteSchema.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'memory.write', `self-awake-diary:${sessionId}:${turnId}`, toJson(input))
      context.signal.throwIfAborted()
      return toJson(repository.writeDiary(sessionId, turnId, input))
    },
  }, {
    name: 'set_self_awake_timer', revision: 'eden.self-awake.v1', executionMode: 'sequential',
    description: toolDescription('set_self_awake_timer'),
    parameters: toJson(z.toJSONSchema(selfAwakeToolTimerSchema, { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = selfAwakeToolTimerSchema.parse(raw)
      repository.timerPublication.assertAvailable()
      const requestedAt = input.at ?? Date.now() + input.afterMinutes! * 60000
      if (requestedAt <= Date.now() || requestedAt > Date.now() + 10080 * 60000) throw new Error('自醒时间必须在未来七天以内')
      const deadline = repository.deadline()
      const dueAt = Math.max(Date.now() + 1000, Math.min(requestedAt, deadline))
      const parent = repository.parentJob(sessionId, turnId)
      const depth = parent ? parent.depth + 1 : 0
      if (depth > 8) throw new Error('自醒连续安排深度已超过限制，需要新的用户指令')
      await permissions.request({ ...context, sessionId, turnId }, 'job.schedule', `self-awake:${sessionId}`, toJson({ dueAt, reason: input.reason, depth }))
      context.signal.throwIfAborted()
      const job = jobs.schedule({ kind: 'self_awake', sessionId, dueAt,
        payload: { prompt: input.reason, trigger: { type: 'scheduled', source: 'agent', reason: input.reason } },
        key: `self-awake:${sessionId}:${turnId}:${context.callId}`, causationId: parent?.id ?? turnId, depth })
      repository.timerPublication.publish()
      return timerReceipt(job, requestedAt, deadline, repository.context(sessionId, turnId).run?.request)
    },
  }, {
    name: 'get_self_awake_context', revision: 'eden.self-awake.v1', executionMode: 'sequential',
    description: toolDescription('get_self_awake_context'),
    parameters: toJson(z.toJSONSchema(selfAwakeContextSchema, { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) {
      return activity.read(sessionId, turnId, raw, context.signal)
    },
  }]
}
