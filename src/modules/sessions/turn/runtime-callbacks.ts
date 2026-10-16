import { chargeSubagentBudget, assertSubagentTool, recordSubagentRequest, recordSubagentResponse } from '../../subagent-execution/index.ts'
import { requestContext } from './request-context.ts'
import { randomUUID } from 'node:crypto'
import { RuntimePersistenceError, type RuntimeCallbacks } from '@eden/runtime-pi'
import { toJson } from '@eden/api'
import { privateMemoryPayload, privateMemoryCheckpoint } from '../../tool-results/index.ts'
import { MemoryRepository } from '../../memories/index.ts'
import type { JsonValue, RuntimeCheckpoint } from '@eden/api'
import type { SessionInput } from '../contracts.ts'
import type { SessionRepository } from '../session-repository.ts'
import { SignalRepository } from '../input/signal-repository.ts'
import { attachmentMessage } from '../../attachments/index.ts'
import { StreamCoalescer } from './stream-coalescer.ts'

export interface RuntimeCallbackScope {
  checkpoint?: RuntimeCallbacks['checkpoint']
  actor?: { assistantID: string | number; planID?: string; beatIndex?: number }
  privateNonAssistantMessages?: boolean
  privateUserInput?: boolean
}

function messageNamespace(kind: string, value: Record<string, JsonValue>, scope: RuntimeCallbackScope, consumed: boolean): string {
  const role = messageRole(value)
  if (scope.privateUserInput && kind.startsWith('message_') && role === 'user' && !consumed) return 'handoff.runtime'
  const hidden = scope.privateNonAssistantMessages && kind.startsWith('message_') && role && role !== 'assistant' && !consumed
  return hidden ? 'actor.runtime' : 'agent'
}

function messageRole(value: Record<string, JsonValue>) {
  const message = value.message
  return message && typeof message === 'object' && !Array.isArray(message) ? message.role : undefined
}

function checkpointEntryId(snapshot: RuntimeCheckpoint): string | undefined {
  const entry = snapshot.entries.at(-1)
  return entry && typeof entry === 'object' && !Array.isArray(entry) && entry.type === 'message'
    && typeof entry.id === 'string' ? entry.id : undefined
}

function associateContextEntry(kind: string, value: Record<string, JsonValue>, entryId?: string): void {
  if (kind === 'message_end' && messageRole(value) === 'assistant' && entryId) value.contextEntryId = entryId
}

export function runtimeCallbacks(repository: SessionRepository, input: SessionInput, scope: RuntimeCallbackScope = {}): RuntimeCallbacks {
  let messageId: string | undefined
  let contextEntryId: string | undefined
  let initialUserEnded = false
  const contexts = new Map<string, Record<string, JsonValue>>()
  const signals = new SignalRepository(repository.database, repository.events)
  const append = (kind: string, payload: Parameters<RuntimeCallbacks['event']>[1]) => {
    repository.events.append(input.sessionId, input.turnId, kind, scoped(privateMemoryPayload(payload)))
  }
  const scoped = (payload: JsonValue): JsonValue => scope.actor ? { ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload }), actor: scope.actor } : payload
  const stream = new StreamCoalescer(append)
  return {
    async checkpoint(snapshot) {
      stream.flush()
      try {
        if (scope.checkpoint) await scope.checkpoint(snapshot)
        else repository.saveCheckpoint(snapshot, input.turnId)
        contextEntryId = checkpointEntryId(snapshot)
        return privateMemoryCheckpoint(snapshot, new MemoryRepository(repository.database).credentialValues())
      } catch (error) { throw new RuntimePersistenceError('会话检查点提交失败', error) }
    },
    async event(kind, payload, delivery) {
      if (kind !== 'message_update') stream.flush()
      const consumed = kind === 'message_end' && signals.consume(input.sessionId, input.turnId, payload)
      const value: Record<string, JsonValue> = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? { ...payload } : { value: payload }
      if (kind === 'message_start') messageId = randomUUID()
      if (kind.startsWith('message_') && messageId) value.messageId = messageId
      associateContextEntry(kind, value, contextEntryId)
      const namespace = messageNamespace(kind, value, scope, consumed)
      const projected = namespace === 'agent' && !initialUserEnded && !consumed && kind.startsWith('message_') ? attachmentMessage(value, input.metadata) : value
      await stream.event(`${namespace}.${kind}`, projected, delivery?.coalesced === true)
      if (kind === 'message_end' && messageRole(value) === 'user') initialUserEnded = true
    },
    async request(snapshot) {
      stream.flush()
      const event = repository.database.transaction(() => {
        const projected = privateMemoryPayload(snapshot)
        const value = projected && typeof projected === 'object' && !Array.isArray(projected) ? projected : {}
        const previous = repository.events.latestActorContextEstimate(input.sessionId, scope.actor?.assistantID)
        const contextEstimate = requestContext(value, input.metadata, previous, scope.actor?.assistantID)
        contexts.set(String(value.requestId), contextEstimate)
        chargeSubagentBudget(repository.database, input.sessionId, 'model', value.costConfigured === true)
        recordSubagentRequest(repository.database, input.sessionId, input.turnId, snapshot)
        return repository.events.insert(input.sessionId, input.turnId, 'model.request', scoped({ ...value, contextEstimate }))
      })
      repository.events.publish(event)
    },
    async response(snapshot) {
      stream.flush()
      const value = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {}
      const message = value.message && typeof value.message === 'object' && !Array.isArray(value.message) ? value.message : {}
      const event = repository.database.transaction(() => {
        recordSubagentResponse(repository.database, input.sessionId, input.turnId, snapshot)
        return repository.events.insert(input.sessionId, input.turnId, 'model.response', scoped({
          requestId: value.requestId ?? null,
          contextEstimate: contexts.get(String(value.requestId)) ?? null,
          errorMessage: message.errorMessage ?? null, usage: message.usage ?? null, stopReason: message.stopReason ?? null, costConfigured: value.costConfigured === true
        }))
      })
      contexts.delete(String(value.requestId))
      repository.events.publish(event)
    },
    async beforeTool(name, callId, revision, args) {
      stream.flush()
      const event = repository.database.transaction(() => {
        assertSubagentTool(repository.database, input.sessionId, name)
        chargeSubagentBudget(repository.database, input.sessionId, 'tool')
        repository.database.connection.prepare('INSERT INTO tool_operations(id,session_id,turn_id,tool_name,revision,state,result_json,created_at,updated_at,request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(`${input.turnId}:${callId}`, input.sessionId, input.turnId, name, revision, 'running', null, Date.now(), Date.now(), JSON.stringify(toJson(args)))
        return repository.events.insert(input.sessionId, input.turnId, 'operation.started', scoped({ callId, name, revision, args: toJson(args) }))
      })
      repository.events.publish(event)
    },
    async afterTool(callId, result, failed, outcome = failed ? 'failed' : 'completed') {
      stream.flush()
      const event = repository.database.transaction(() => {
        repository.database.connection.prepare('UPDATE tool_operations SET state=?, result_json=?, error_json=?, updated_at=? WHERE id=?')
          .run(outcome, JSON.stringify(result), failed ? JSON.stringify(result) : null, Date.now(), `${input.turnId}:${callId}`)
        return repository.events.insert(input.sessionId, input.turnId, 'operation.completed', scoped({ callId, result, failed, outcome }))
      })
      repository.events.publish(event)
    },
  }
}
