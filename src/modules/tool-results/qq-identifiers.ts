export const qqTraceKeys = new Set(['request_id', 'requestId', 'session_id', 'sessionId', 'turn_id', 'turnId',
  'call_id', 'callId', 'trace_id', 'traceId', 'sha256'])
const kinds: Record<string, string> = {
  tid: 'qzone', message_id: 'message', messageId: 'message', msgId: 'message', source_message_id: 'message',
  forward_id: 'message',
  file_id: 'file', fileId: 'file', file_uuid: 'file', folder_id: 'folder', folderId: 'folder',
  current_parent_directory: 'folder', target_parent_directory: 'folder', notice_id: 'notice',
  flag: 'request', next_cursor: 'cursor', cursor: 'cursor',
}
const businessIds = new Set(['bot_id', 'botId', 'user_id', 'userId', 'group_id', 'groupId', 'target_user_id',
  'target_group_id', 'contact_user_id', 'contact_group_id', 'operator_id', 'uin', 'uin_id', 'emoji_id', 'app_id',
  'user_ids', 'group_ids', 'emoji_ids'])

export function qqIdentifierKind(key: string, segment?: string): string | undefined {
  if (key === 'resource_ids') return undefined
  if (segment === 'resources' && ['file', 'image', 'record', 'video'].includes(key)) return 'file'
  if (key === 'id' && segment === 'face') return undefined
  if (key === 'id' && segment === 'reply') return 'message'
  if (key === 'id') return 'resource'
  if (businessIds.has(key)) return undefined
  if (key.endsWith('_ids')) return kinds[key.slice(0, -1)] ?? 'resource'
  return kinds[key] ?? (/_id$|Id$/.test(key) ? 'resource' : undefined)
}

export type QqReference = `qqref:${string}:${number}`
export const isQqReference = (value: unknown): value is QqReference => typeof value === 'string' && /^qqref:[a-z]+:[1-9]\d*$/.test(value)
