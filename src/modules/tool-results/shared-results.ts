import { resultFields as fields, resultList, resultObject, type ModelResult } from './model-fields.ts'
import type { JsonValue } from '@eden/api'

function sharedStatus(value: JsonValue) {
  return fields(value, ['available', 'reason', 'bound', 'spaceId', 'paused', 'canPublish', 'publishReason', 'state',
    'pending', 'conflicts', 'lastSync', 'error', 'root'])
}

export const sharedQueryResult: ModelResult = (value, _input, hidden) => {
  const raw = resultObject(value)
  const row = fields(raw, ['sharedDirectory', 'source', 'total', 'nextOffset'])
  if (raw.directory) row.directory = fields(raw.directory, ['path', 'status', 'error'], hidden, ['revision'])
  if (raw.shared) row.shared = sharedStatus(raw.shared)
  if (Object.hasOwn(raw, 'spaces')) row.spaces = resultList(raw.spaces!, item =>
    fields(item, ['id', 'name', 'role', 'hostDeviceId', 'hostName', 'reachable']))
  if (Object.hasOwn(raw, 'files')) row.files = resultList(raw.files!, item =>
    fields(item, ['fileId', 'path', 'deleted', 'size'], hidden, ['revision', 'sha256']))
  return row
}

export const fileResult: ModelResult = (value, _input, hidden) => {
  const raw = resultObject(value)
  const row = fields(raw, ['name', 'path', 'size', 'binary', 'truncated', 'content', 'offset', 'nextOffset', 'offsetUnit',
    'bytes', 'action', 'destination', 'recoveryId', 'restored', 'deleted', 'renamed', 'spaceId', 'sharedDirectory', 'synchronized'],
    hidden, ['sha256', 'expectedSha256', 'revision'])
  if (raw.result) row.result = fileResult(raw.result, undefined, hidden)
  return row
}

export const imageResult: ModelResult = value => fields(value, ['name', 'path', 'mime', 'byteLength'])
