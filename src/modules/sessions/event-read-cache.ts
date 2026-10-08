import type { DurableEvent } from '@eden/api'
import type { EdenDatabase } from '@eden/store'

/** A small realm-local cache; callers must check session ownership before every read. */
export class EventReadCache {
  private readonly entries = new Map<string, { event: DurableEvent; bytes: number }>()
  private bytes = 0
  private revision: string | undefined

  constructor(private readonly maximumEntries = 256, private readonly maximumBytes = 8 * 1024 * 1024) {}

  synchronize(database: EdenDatabase): void {
    // total_changes catches same-connection edits (including rolled-back writes);
    // data_version catches another connection changing or deleting a delta base.
    const changes = database.connection.prepare('SELECT total_changes() AS changes').get()?.changes
    const version = database.connection.prepare('PRAGMA data_version').get()?.data_version
    const revision = `${changes}:${version}:${database.inTransaction}`
    if (revision === this.revision) return
    this.entries.clear()
    this.bytes = 0
    this.revision = revision
  }

  get(sessionId: string, seq: string): DurableEvent | undefined {
    const key = JSON.stringify([sessionId, seq]), entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.event
  }

  set(event: DurableEvent): void {
    const key = JSON.stringify([event.sessionId, event.seq])
    const previous = this.entries.get(key)
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key) }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (bytes > this.maximumBytes || this.maximumEntries < 1) return
    this.entries.set(key, { event, bytes })
    this.bytes += bytes
    while (this.entries.size > this.maximumEntries || this.bytes > this.maximumBytes) {
      const oldest = this.entries.keys().next().value!
      this.bytes -= this.entries.get(oldest)!.bytes
      this.entries.delete(oldest)
    }
  }
}
