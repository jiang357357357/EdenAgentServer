import { z } from 'zod'
import { contactHistorySchema, toJson, jsonValue } from '@eden/api'
import type { MonClient } from '@eden/integrations'
import { ownerQqTarget } from './qq-contact.ts'
const id = z.union([z.number().int().safe(), z.string().max(128)])
const messageSchema = z.object({ id, role: z.enum(['user', 'assistant']), content: jsonValue.optional(),
  created_at: z.union([z.string().max(128), z.number()]).nullish(), timestamp: z.union([z.string().max(128), z.number()]).nullish(),
})
type Message = z.infer<typeof messageSchema>

/** Consecutive user messages and the following replies form one round. */
export function qqConversationRounds(messages: Message[]) {
  const rounds: { messages: Message[] }[] = []
  let previousRole: string | undefined
  for (const message of messages) {
    if (message.role === 'user' && previousRole !== 'user') rounds.push({ messages: [] })
    rounds.at(-1)?.messages.push(message)
    previousRole = message.role
  }
  return rounds
}

export async function readOwnerQqHistory(client: MonClient, raw: unknown, signal: AbortSignal) {
  contactHistorySchema.parse(raw)
  const target = await ownerQqTarget(client, signal)
  const messages: Message[] = [], seen = new Set<string>()
  let cursor: string | undefined, hasMore = false
  for (let page = 0; page < 10; page++) {
    signal.throwIfAborted()
    const query = new URLSearchParams({ target_type: 'user', target_qq_number: target.number, limit: '100' })
    if (cursor) query.set('before_id', cursor)
    const result = await client.get(`/api/devices/qq_bot/${target.bot}/messages/?${query}`, signal)
    const envelope = z.record(z.string(), z.unknown()).parse(result)
    if (envelope.success === false) throw new Error('Core could not read owner QQ history')
    const data = z.object({ messages: z.array(messageSchema).max(100), has_more: z.boolean().default(false), next_before_id: id.nullish() }).parse(envelope.data ?? result)
    for (const message of data.messages) if (!seen.has(String(message.id))) { seen.add(String(message.id)); messages.push(message) }
    hasMore = data.has_more
    if (!hasMore || qqConversationRounds([...messages].reverse()).length > 10) break
    const next = data.next_before_id == null ? undefined : String(data.next_before_id)
    if (!next || next === cursor) throw new Error('QQ history pagination did not advance')
    cursor = next
  }
  const all = qqConversationRounds(messages.reverse())
  // When bounded retrieval ends inside a round, omit that incomplete oldest round.
  if (hasMore) all.shift()
  const rounds = all.slice(-10)
  if (Buffer.byteLength(JSON.stringify(rounds)) > 256 * 1024) throw new Error('QQ conversation exceeds the readable size limit')
  return toJson({ channel: 'qq', targetType: 'user', rounds, roundCount: rounds.length, truncated: hasMore && all.length < 10 })
}
