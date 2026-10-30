import { resultFields as fields, resultList, resultObject, type ModelResult } from './model-fields.ts'

export const agentResult: ModelResult = (value, _input, hidden) => {
  if (Array.isArray(value)) return value.map(item => agentResult(item, undefined, hidden))
  const raw = resultObject(value)
  if (raw.agent) return { agent: agentResult(raw.agent, undefined, hidden), timedOut: raw.timedOut ?? false }
  const row = fields(raw, ['id', 'parentId', 'parentActorId', 'agentPath', 'taskName', 'role', 'status', 'error',
    'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'deadlineAt', 'recoveryState', 'workspaceRoot'], hidden,
    ['sessionId', 'childSessionId', 'rootSessionId', 'coordinationBatchId'])
  if (Object.hasOwn(raw, 'result')) row.result = raw.result === null ? null : fields(raw.result!,
    ['content', 'summary', 'artifacts', 'changedFiles', 'tests'])
  if (raw.usage) row.usage = fields(raw.usage, ['turns', 'modelRequests', 'toolCalls', 'tokens', 'costMicrousd', 'tokensUnknown', 'costUnknown'])
  return row
}

export const mailboxResult: ModelResult = (value, _input, hidden) => {
  if (!Array.isArray(value)) return fields(value, ['id', 'agentId', 'queued'])
  return resultList(value, item => {
    const raw = resultObject(item)
    const row = fields(raw, ['id', 'sender', 'message', 'createdAt', 'kind', 'historical'], hidden, ['senderSessionId'])
    row.sender = raw.sender ? fields(raw.sender, ['agentId', 'agentPath', 'taskName', 'kind'], hidden) : { kind: 'unknown' }
    if (raw.details !== undefined && raw.details !== null) row.detailsAvailable = true
    return row
  })
}
