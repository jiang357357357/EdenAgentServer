import type { JsonValue } from '@eden/api'
import { resultFields as fields, resultList, resultObject, type ModelResult } from './model-fields.ts'
import { MCP_IMAGE_REFERENCE } from '../../model-prompts/capabilities.ts'

/** Provider business JSON stays intact; image bytes use the existing separate image blocks. */
export const mcpBusinessResult: ModelResult = value => {
  if (Array.isArray(value)) return value.map(item => mcpBusinessResult(item))
  if (!value || typeof value !== 'object') return value
  const image = typeof value.mimeType === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(value.mimeType)
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, image && (key === 'data' || key === 'blob') ? MCP_IMAGE_REFERENCE : mcpBusinessResult(item)]))
}

export const skillExecutionResult: ModelResult = (value, _input, hidden) => fields(value,
  ['skill', 'tool', 'output'], hidden, ['revision'])

export const createdSkillResult: ModelResult = (value, _input, hidden) => fields(value,
  ['name', 'description', 'content', 'tools', 'files', 'enabled', 'available', 'missingTools', 'modelInvocable', 'profiles', 'scope'],
  hidden, ['contentHash', 'previewID', 'previewId', 'revision'])

export const connectorListResult: ModelResult = (value, _input, hidden) => {
  const raw = resultObject(value)
  const summary = (item: JsonValue) => fields(item, ['id', 'key', 'name', 'desiredState', 'runtimeState', 'lastError',
    'queries', 'actions', 'events', 'queryTool', 'actionTool'], hidden, ['revision', 'generation'])
  return raw.connectors ? { ...fields(raw, ['notice']), connectors: resultList(raw.connectors, summary) } : summary(raw)
}

export const connectorEventResult: ModelResult = (value, _input, hidden) => {
  const raw = resultObject(value)
  const event = (item: JsonValue) => fields(item, ['id', 'connectorId', 'eventType', 'payload', 'createdAt', 'wake'],
    hidden, ['externalId', 'sessionId', 'jobId'])
  return raw.events ? { ...fields(raw, ['nextCursor', 'hasMore', 'direction']), events: resultList(raw.events, event) } : event(raw)
}

export const mcpServersResult: ModelResult = (value, _input, hidden) => {
  const raw = resultObject(value)
  return { runtimes: resultList(raw.runtimes!, item => fields(item,
    ['id', 'pluginId', 'componentId', 'kind', 'server'], hidden, ['revision'])),
  errors: resultList(raw.errors!, item => fields(item, ['id', 'error'])) }
}

/** Revision is an explicit artifact choice for TS plugin installation/rollback. */
export const pluginManagementResult: ModelResult = (value, input, hidden) => {
  if (input?.action === 'describe') return value
  if (input?.action === 'invoke') return value
  if (Array.isArray(value)) return value.map(item => fields(item, ['id', 'revision', 'version', 'active']))
  const raw = resultObject(value)
  if (raw.manifestExample) return value
  const row = fields(raw, ['id', 'manifest', 'source', 'revision', 'valid', 'passed', 'cases', 'testedAt', 'backend', 'disabled', 'enabled', 'readRoot', 'activatedAt'],
    hidden, ['draftRevision', 'expectedDraftRevision'])
  // Declared test cases are plugin-owned business content, never recursively classified.
  return row
}

export const connectorPackageResult: ModelResult = (value, _input, hidden) => {
  if (Array.isArray(value)) return value.map(item => connectorPackageResult(item, undefined, hidden))
  const raw = resultObject(value)
  if (raw.workflow || raw.manifestExample) return value
  const row = fields(raw, ['id', 'name', 'description', 'version', 'verified', 'enabled', 'trustState', 'sourceType',
    'expiresAt', 'permissions', 'createdAt', 'updatedAt'], hidden, ['revision', 'previewID', 'previewId'])
  if (Array.isArray(raw.components)) row.components = raw.components.map(item => fields(item,
    ['id', 'kind', 'name', 'description', 'enabled', 'enabledByDefault']))
  if (Array.isArray(raw.versions)) row.versions = raw.versions.map(item => fields(item,
    ['version', 'active', 'trustState', 'sourceType', 'installedAt'], hidden, ['revision']))
  return row
}
