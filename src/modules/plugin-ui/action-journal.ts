import type { EdenDatabase } from '@eden/store'

/** UI tool operations have their own audit events, separate from model tool turns. */
export class PluginUiActionJournal {
  constructor(private readonly database: EdenDatabase) {}
  assertFresh(sessionId: string, requestId: string) {
    const previous = this.database.connection.prepare(`SELECT 1 FROM events WHERE session_id=?
      AND kind='plugin.ui.action.started' AND json_extract(payload_json,'$.requestId')=? LIMIT 1`).get(sessionId, requestId)
    if (previous) throw new Error('该界面请求已经执行或结果尚未确认，请查看原操作状态，不要复用请求标识重试')
  }
}
