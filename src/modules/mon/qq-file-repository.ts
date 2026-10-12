import type { EdenDatabase } from '@eden/store'
import { ContactNotDeliveredError } from './contact-error.ts'
import { QqFileDeliveryUnknown } from './qq-file-error.ts'

/** Durable intent and minimal receipts; file contents never enter the delivery table. */
export class QqFileDeliveryRepository {
  constructor(private readonly database: EdenDatabase) {}

  begin(sessionId: string, requestId: string, payload: string): unknown {
    const db = this.database.connection
    const existing = db.prepare('SELECT * FROM mon_contact_deliveries WHERE request_id=?').get(requestId)
    if (existing) {
      if (existing.channel !== 'qq' || existing.session_id !== sessionId || existing.payload_json !== payload)
        throw new Error('QQ file request ID conflicts with an existing delivery')
      if (existing.state === 'accepted') return JSON.parse(String(existing.receipt_json))
      if (existing.state === 'failed') throw new ContactNotDeliveredError('Core rejected this QQ file; no automatic resend')
      throw new QqFileDeliveryUnknown()
    }
    db.prepare("INSERT INTO mon_contact_deliveries VALUES(?,?,?,?,'running',NULL,NULL,?,?)")
      .run(requestId, sessionId, 'qq', payload, Date.now(), Date.now())
    return undefined
  }

  confirm(requestId: string, receipt: unknown) {
    this.database.connection.prepare("UPDATE mon_contact_deliveries SET state='accepted',receipt_json=?,updated_at=? WHERE request_id=? AND state='running'")
      .run(JSON.stringify(receipt), Date.now(), requestId)
  }

  fail(requestId: string, rejected: boolean) {
    this.database.connection.prepare("UPDATE mon_contact_deliveries SET state=?,error=?,updated_at=? WHERE request_id=? AND state='running'")
      .run(rejected ? 'failed' : 'unknown', rejected ? 'Core rejected QQ file delivery' : 'QQ file outcome unknown; do not automatically resend', Date.now(), requestId)
  }
}
