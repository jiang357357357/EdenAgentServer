import type { DurableEvent, RuntimeOrigin } from '@eden/api'

/** Notify about invalidation only. Never replay session ranges onto a reminder connection. */
export function reminderEventNotifier(origin: RuntimeOrigin, refresh: () => Promise<void>,
  active: () => boolean, send: (value: unknown) => void): (event: DurableEvent) => void {
  let queued = false
  return event => {
    if (!['desktop.reminder.created', 'desktop.reminder.displayed', 'desktop.reminder.closed'].includes(event.kind)
      || queued || !active()) return
    queued = true
    void refresh().then(() => {
      if (active()) send({ jsonrpc: '2.0', method: 'desktop.reminder.changed', params: { runtimeOrigin: origin } })
    }).catch(() => {}) // AccountEventDelivery owns authentication failure and closes the connection.
      .finally(() => { queued = false })
  }
}
