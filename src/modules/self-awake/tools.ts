import { selfAwakeContextSchema } from './context.ts'
import type { SelfAwakeContext } from './context.ts'
import { z } from 'zod'
import { selfAwakeTimerSchema, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { JobRepository } from '../jobs/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import type { SelfAwakeRepository } from './repository.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

export function selfAwakeTools(repository: SelfAwakeRepository, jobs: JobRepository, permissions: PermissionService, activity: SelfAwakeContext, sessionId: string, turnId: string): RuntimeTool[] {
  return [{
    name: 'set_self_awake_timer', revision: 'eden.self-awake.v1', executionMode: 'sequential',
    description: toolDescription('set_self_awake_timer'),
    parameters: toJson(z.toJSONSchema(selfAwakeTimerSchema, { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = selfAwakeTimerSchema.parse(raw)
      repository.timerPublication.assertAvailable()
      const requestedAt = input.at ?? Date.now() + input.afterMinutes! * 60000
      if (requestedAt <= Date.now() || requestedAt > Date.now() + 10080 * 60000) throw new Error('自醒时间必须在未来七天以内')
      const dueAt = Math.min(requestedAt, repository.deadline())
      const parent = repository.parentJob(sessionId, turnId)
      const depth = parent ? parent.depth + 1 : 0
      if (depth > 8) throw new Error('自醒连续安排深度已超过限制，需要新的用户指令')
      await permissions.request({ ...context, sessionId, turnId }, 'job.schedule', `self-awake:${sessionId}`, toJson({ dueAt, reason: input.reason, depth }))
      context.signal.throwIfAborted()
      const job = jobs.schedule({ kind: 'self_awake', sessionId, dueAt,
        payload: { prompt: input.reason, trigger: { type: 'scheduled', source: 'agent', reason: input.reason } },
        key: `self-awake:${sessionId}:${turnId}:${context.callId}`, causationId: parent?.id ?? turnId, depth })
      repository.timerPublication.publish()
      return toJson(job)
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
