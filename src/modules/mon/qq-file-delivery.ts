import { createHash } from 'node:crypto'
import { z } from 'zod'
import { toJson } from '@eden/api'
import { MonHttpError, type MonClient } from '@eden/integrations'
import type { EdenDatabase } from '@eden/store'
import { ContactNotDeliveredError } from './contact-error.ts'
import { ownerQqTarget } from './qq-contact.ts'
import { QqFileDeliveryRepository } from './qq-file-repository.ts'
import { QqFileDeliveryUnknown } from './qq-file-error.ts'

export interface OwnerQqFile { target: { bot: string; number: string }; filename: string; bytes: Buffer; requestId: string }
const receiptSchema = z.object({ success: z.literal(true), data: z.object({
  status: z.literal('sent'), confirmed: z.literal(true), request_id: z.string(),
  target_qq_number: z.string(), filename: z.string(), byte_length: z.number().int(), sha256: z.string(),
  file_id: z.string().optional(),
}) })

export async function deliverOwnerQqFile(database: EdenDatabase, client: MonClient, sessionId: string, input: OwnerQqFile, signal: AbortSignal) {
  signal.throwIfAborted()
  const current = await ownerQqTarget(client, signal)
  if (current.bot !== input.target.bot || current.number !== input.target.number)
    throw new ContactNotDeliveredError('QQ recipient changed after approval; approve the new target before sending')
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const metadata = { kind: 'file', bot: current.bot, target_qq_number: current.number,
    filename: input.filename, byte_length: input.bytes.length, sha256, request_id: input.requestId }
  const repository = new QqFileDeliveryRepository(database)
  signal.throwIfAborted()
  const previous = repository.begin(sessionId, input.requestId, JSON.stringify(metadata))
  if (previous !== undefined) return toJson(previous)
  try {
    const raw = await client.post(`/api/devices/qq_bot/${current.bot}/send-file/`, toJson({
      target_type: 'user', target_qq_number: current.number, filename: input.filename,
      byte_length: input.bytes.length, sha256, content_base64: input.bytes.toString('base64'), request_id: input.requestId,
    }), signal, 180000)
    const parsed = receiptSchema.parse(raw).data
    if (parsed.request_id !== input.requestId || parsed.target_qq_number !== current.number || parsed.filename !== input.filename
      || parsed.byte_length !== input.bytes.length || parsed.sha256 !== sha256) throw new Error('QQ file receipt does not match the approved file')
    const receipt = { channel: 'qq', status: 'sent', confirmed: true, requestId: input.requestId,
      filename: input.filename, byteLength: input.bytes.length, ...(parsed.file_id ? { fileId: parsed.file_id } : {}) }
    repository.confirm(input.requestId, receipt)
    return toJson(receipt)
  } catch (error) {
    const rejected = error instanceof MonHttpError && [400, 401, 403, 404, 413, 422].includes(error.status)
    repository.fail(input.requestId, rejected)
    if (rejected) throw new ContactNotDeliveredError('Core rejected the QQ file; check the bot, recipient permissions and Core version')
    throw new QqFileDeliveryUnknown()
  }
}
