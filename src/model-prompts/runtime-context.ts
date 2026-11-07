import type { JsonValue } from '@eden/api'
export const ATTACHMENT_INPUT_CONTEXT_PREFIX = '本轮用户提供的附件引用：\n'

/** Attachment references belong to the initiating input, never the system prefix. */
export function attachmentInputContext(attachments: readonly JsonValue[]): string {
  return attachments.length ? ATTACHMENT_INPUT_CONTEXT_PREFIX + JSON.stringify(attachments)
    + '\n引用用于读取对应附件；未读取的文件正文不能据此推断。' : ''
}
