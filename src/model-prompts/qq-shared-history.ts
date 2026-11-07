import type { QqSharedContext, QqSharedMessage } from '@eden/api'
import { speaker } from './qq-group-context.ts'

export const sharedGroupRoleChanged = '群聊角色绑定已变更；历史回答属于当时的角色，当前身份以新的角色设定为准。'

export function sharedGroupInput(context: QqSharedContext, text: string, attachments: string): string {
  return [
    `[本轮群消息]\n当前发言人：${JSON.stringify(speaker(context.speaker_name, context.speaker_permission, context.operator_qq))}`,
    '个人权限为接收时的资料，实际操作与审批仍以宿主当前校验为准。',
    context.quote ? '[引用的群消息]\n' + JSON.stringify({ message_id: context.quote.message_id,
      sender: speaker(context.quote.sender_name, context.quote.sender_permission, context.quote.sender_qq, context.quote.role),
      content: context.quote.content }) : '',
    attachments,
    '[当前消息]\n' + text,
  ].filter(Boolean).join('\n\n')
}

export function sharedGroupRecord(message: QqSharedMessage): string {
  return '[本群公开记录，仅作对话背景]\n' + JSON.stringify({
    sender: speaker(message.sender_name, message.sender_permission, message.sender_qq, message.role),
    message_id: message.message_id, timestamp: message.timestamp, content: message.content,
  })
}
