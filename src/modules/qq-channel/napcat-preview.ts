const targetKeys = ['group_id', 'user_id', 'message_id', 'source_message_id', 'target_user_id', 'target_group_id',
  'contact_user_id', 'contact_group_id', 'tid', 'flag', 'file_id', 'folder_id']
function brief(value: unknown, limit: number): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\b(password|token|secret|api[_-]?key)=\S+/gi, '$1=[隐藏]').slice(0, limit)
}

function imageSummary(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (!key.endsWith('base64') && !/^(?:data:image\/[^;]+;base64,|base64:\/\/)/.test(value)) return value
  const encoded = value.replace(/^(?:data:[^,]+,|base64:\/\/)/, '').replace(/\s/g, '')
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return `[图片数据，约 ${Math.max(0, Math.floor(encoded.length * 3 / 4) - padding)} 字节]`
}

export function napcatPermissionPreview(value: Record<string, unknown>): string | undefined {
  if (value.channel !== 'qq_action' || typeof value.action !== 'string') return undefined
  if (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)) return undefined
  const params = value.params as Record<string, unknown>
  const targets = targetKeys.filter(key => params[key] !== undefined).map(key => `${key}=${brief(params[key], 512)}`)
  const rest = Object.fromEntries(Object.entries(params).filter(([key]) => !targetKeys.includes(key)))
  return [`QQ 操作: ${brief(value.action, 80)}`, `机器人: ${brief(value.bot, 32)}`, ...targets,
    `参数: ${brief(JSON.stringify(rest, imageSummary), 500)}`].join('；')
}
