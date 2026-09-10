import { z } from 'zod'
import type { JsonValue } from '@eden/api/connector'
import { cstring, packet } from './packets.ts'

export function serverAction(action: string, payload: JsonValue) {
  if (action === 'pause_game') return packet(5, cstring('pause'))
  if (action === 'resume_game') return packet(5, cstring('unpause'))
  if (action === 'save_game') {
    const input = z.object({ save_name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default('edenagent') }).strict().parse(payload)
    return packet(5, cstring(`save ${input.save_name}`))
  }
  if (action === 'send_chat') {
    const { text } = z.object({ text: z.string().trim().min(1).refine(value => Buffer.byteLength(value) <= 4096 && !value.includes('\0')) }).strict().parse(payload)
    return packet(4, Buffer.concat([Buffer.from([2, 0, 0, 0, 0, 0]), cstring(text)]))
  }
  throw new Error('Unknown OpenTTD server action')
}
