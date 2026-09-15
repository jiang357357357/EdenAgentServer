import type { EdenDatabase } from '@eden/store'

/** UI preferences belong to this local runtime realm, independently of chat sessions. */
export class UiPreferenceRepository {
  constructor(private readonly database: EdenDatabase) {}
  get() {
    const row = this.database.connection.prepare('SELECT auto_scroll_enabled FROM ui_preferences WHERE id=1').get()
    return { autoScrollEnabled: row ? row.auto_scroll_enabled === 1 : true }
  }
  update(input: { autoScrollEnabled: boolean }) {
    this.database.connection.prepare(`INSERT INTO ui_preferences(id,auto_scroll_enabled) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET auto_scroll_enabled=excluded.auto_scroll_enabled`).run(Number(input.autoScrollEnabled))
    return this.get()
  }
}
