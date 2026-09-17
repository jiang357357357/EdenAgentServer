import { baseThemeSchema, type BaseTheme, accentThemeSchema, type AccentTheme } from "@eden/api"
import { currentAccount } from "../accounts/index.ts"
import type { EdenDatabase } from "@eden/store"

/** UI preferences belong to this local runtime realm, independently of chat sessions. */
export class UiPreferenceRepository {
  constructor(private readonly database: EdenDatabase) {}
  appearance() {
    const key = `ui.appearance:${currentAccount()?.key ?? "local"}`
    const row = this.database.connection.prepare("SELECT value_json FROM runtime_settings WHERE key=?").get(key)
    if (!row) return { chatFontScale: 100, componentFontScale: 100, accentTheme: "mist" as const, baseTheme: "night" as const, backgroundMode: "wallpaper" as const }
    try {
      const value = JSON.parse(String(row.value_json)) as Record<string, unknown>
      const legacyScale = validFontScale(value.fontScale) ? value.fontScale : 100
      const chatFontScale = validFontScale(value.chatFontScale) ? value.chatFontScale : legacyScale
      const componentFontScale = validFontScale(value.componentFontScale) ? value.componentFontScale : legacyScale
      if (validFontScale(chatFontScale) && validFontScale(componentFontScale)) {
        return { chatFontScale, componentFontScale, baseTheme: baseThemeSchema.catch("night").parse(value.baseTheme), backgroundMode: value.backgroundMode === "theme" ? "theme" as const : "wallpaper" as const, accentTheme: accentThemeSchema.catch("mist").parse(value.accentTheme) }
      }
    } catch {
      /* A corrupt preference falls back to the standard interface size. */
    }
    return { chatFontScale: 100, componentFontScale: 100, accentTheme: "mist" as const, baseTheme: "night" as const, backgroundMode: "wallpaper" as const }
  }
  updateAppearance(input: { chatFontScale: number; componentFontScale: number; accentTheme?: AccentTheme; baseTheme?: BaseTheme; backgroundMode?: "theme" | "wallpaper" }) {
    const key = `ui.appearance:${currentAccount()?.key ?? "local"}`
    this.database.connection.prepare(
      "INSERT INTO runtime_settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    ).run(key, JSON.stringify(input), Date.now())
    return this.appearance()
  }
  background() {
    const key = `ui.background:${currentAccount()?.key ?? "local"}`
    const row = this.database.connection.prepare("SELECT value_json FROM runtime_settings WHERE key=?").get(key)
    if (!row) return { opacity: 100, blur: 0, imageBlobId: null }
    try {
      const value = JSON.parse(String(row.value_json)) as Record<string, unknown>
      if (
        typeof value.opacity === "number" &&
        value.opacity >= 0 &&
        value.opacity <= 100 &&
        typeof value.blur === "number" &&
        value.blur >= 0 &&
        value.blur <= 30 &&
        (value.imageBlobId === null ||
          value.imageBlobId === undefined ||
          (typeof value.imageBlobId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.imageBlobId)))
      ) {
        return { opacity: value.opacity, blur: value.blur, imageBlobId: value.imageBlobId ?? null }
      }
    } catch {
      /* A corrupt preference falls back to the visible default. */
    }
    return { opacity: 100, blur: 0, imageBlobId: null }
  }
  updateBackground(input: { opacity: number; blur: number; imageBlobId: string | null }) {
    if (input.imageBlobId) {
      const blob = this.database.connection.prepare("SELECT mime FROM blobs WHERE id=?").get(input.imageBlobId)
      if (!blob || !String(blob.mime).startsWith("image/")) throw new Error("Background image is unavailable")
    }
    const key = `ui.background:${currentAccount()?.key ?? "local"}`
    this.database.connection
      .prepare(
        "INSERT INTO runtime_settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
      )
      .run(key, JSON.stringify(input), Date.now())
    return this.background()
  }
  get() {
    const account = currentAccount()
    if (account) {
      const row = this.database.connection
        .prepare("SELECT auto_scroll_enabled FROM account_ui_preferences WHERE account_key=?")
        .get(account.key)
      return { autoScrollEnabled: row ? row.auto_scroll_enabled === 1 : true }
    }
    const row = this.database.connection.prepare("SELECT auto_scroll_enabled FROM ui_preferences WHERE id=1").get()
    return { autoScrollEnabled: row ? row.auto_scroll_enabled === 1 : true }
  }
  update(input: { autoScrollEnabled: boolean }) {
    const account = currentAccount()
    if (account) {
      this.database.connection
        .prepare(
          `INSERT INTO account_ui_preferences VALUES(?,?) ON CONFLICT(account_key) DO UPDATE SET auto_scroll_enabled=excluded.auto_scroll_enabled`,
        )
        .run(account.key, Number(input.autoScrollEnabled))
      return this.get()
    }
    this.database.connection
      .prepare(
        `INSERT INTO ui_preferences(id,auto_scroll_enabled) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET auto_scroll_enabled=excluded.auto_scroll_enabled`,
      )
      .run(Number(input.autoScrollEnabled))
    return this.get()
  }
}

function validFontScale(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 80 && value <= 140
}
