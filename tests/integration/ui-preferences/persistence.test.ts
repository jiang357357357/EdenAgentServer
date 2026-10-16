import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EdenDatabase } from "@eden/store"
import { UiPreferenceRepository } from "../../../src/modules/ui-preferences/index.ts"
import { uiPreferenceRoutes } from "../../../src/transport/rpc/ui-preferences.routes.ts"
import { DEFAULT_PANEL_OPACITY, rpcMethods } from "@eden/api"
import { withAccount } from "../../../src/modules/accounts/index.ts"

const defaultAppearance = { chatFontScale: 100, componentFontScale: 100, panelOpacity: DEFAULT_PANEL_OPACITY,
  baseTheme: "night", backgroundMode: "wallpaper", accentTheme: "mist" }

test("interface preferences survive restart, reject invalid values and stay within their realm", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eden-ui-pref-"))
  let database = new EdenDatabase(path.join(root, "mon.db"), "mon")
  const local = new EdenDatabase(path.join(root, "local.db"), "local")
  try {
    const routes = uiPreferenceRoutes(new UiPreferenceRepository(database))
    assert.deepEqual(await routes["ui.preferences.get"]({}), { autoScrollEnabled: true })
    assert.deepEqual(await routes["ui.appearance.get"]({}), defaultAppearance)
    assert.deepEqual(await routes["ui.background.get"]({}), { opacity: 100, blur: 0, imageBlobId: null })
    await routes["ui.preferences.update"]({ autoScrollEnabled: false })
    await routes["ui.appearance.update"]({ chatFontScale: 115, componentFontScale: 90, panelOpacity: 63 })
    await routes["ui.background.update"]({ opacity: 63, blur: 14 })
    await assert.rejects(routes["ui.preferences.update"]({ autoScrollEnabled: "false" }))
    await assert.rejects(routes["ui.appearance.update"]({ chatFontScale: 145, componentFontScale: 100 }))
    await assert.rejects(routes["ui.background.update"]({ opacity: 101, blur: 14 }))
    database.close()
    database = new EdenDatabase(path.join(root, "mon.db"), "mon")
    assert.deepEqual(new UiPreferenceRepository(database).get(), { autoScrollEnabled: false })
    assert.deepEqual(new UiPreferenceRepository(database).appearance(), { ...defaultAppearance, chatFontScale: 115, componentFontScale: 90, panelOpacity: 63 })
    assert.deepEqual(new UiPreferenceRepository(database).background(), { opacity: 63, blur: 14, imageBlobId: null })
    assert.deepEqual(new UiPreferenceRepository(local).get(), { autoScrollEnabled: true })
    local.connection.prepare("INSERT INTO runtime_settings VALUES(?,?,?)").run(
      "ui.appearance:local",
      JSON.stringify({ fontScale: 125 }),
      Date.now(),
    )
    assert.deepEqual(new UiPreferenceRepository(local).appearance(), { ...defaultAppearance, chatFontScale: 125, componentFontScale: 125 })
    assert.deepEqual(new UiPreferenceRepository(local).background(), { opacity: 100, blur: 0, imageBlobId: null })
  } finally {
    database.close()
    local.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("panel opacity accepts the full range and stays isolated by account across restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eden-panel-opacity-"))
  let database = new EdenDatabase(path.join(root, "mon.db"), "mon")
  const account = (key: string) => ({ key, userId: key, coreBaseUrl: "https://fixture.invalid" })
  try {
    let routes = uiPreferenceRoutes(new UiPreferenceRepository(database))
    for (const [key, panelOpacity] of [["a", 0], ["b", 100]] as const) {
      const result = await withAccount(account(key), () => routes["ui.appearance.update"]({ ...defaultAppearance, panelOpacity }))
      assert.equal(rpcMethods["ui.appearance.get"].result.parse(result).panelOpacity, panelOpacity)
    }
    for (const panelOpacity of [-1, 101, 0.5, "85", null]) {
      await assert.rejects(withAccount(account("a"), () => routes["ui.appearance.update"]({ ...defaultAppearance, panelOpacity })))
    }
    database.close()
    database = new EdenDatabase(path.join(root, "mon.db"), "mon")
    routes = uiPreferenceRoutes(new UiPreferenceRepository(database))
    assert.equal(rpcMethods["ui.appearance.get"].result.parse(await withAccount(account("a"), () => routes["ui.appearance.get"]({}))).panelOpacity, 0)
    assert.equal(rpcMethods["ui.appearance.get"].result.parse(await withAccount(account("b"), () => routes["ui.appearance.get"]({}))).panelOpacity, 100)
    assert.deepEqual(await withAccount(account("c"), () => routes["ui.appearance.get"]({})), defaultAppearance)
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("new light and dark themes persist through RPC and restart without crossing account or realm", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eden-theme-colors-"))
  let database = new EdenDatabase(path.join(root, "mon.db"), "mon")
  const local = new EdenDatabase(path.join(root, "local.db"), "local")
  const account = (key: string) => ({ key, userId: key, coreBaseUrl: "https://fixture.invalid" })
  const themes = ["sky", "pink", "teal", "white", "navy", "forest"] as const
  try {
    let routes = uiPreferenceRoutes(new UiPreferenceRepository(database))
    for (const baseTheme of themes) {
      const input = { ...defaultAppearance, baseTheme, backgroundMode: "theme", panelOpacity: 67, chatFontScale: 112 }
      assert.deepEqual(await withAccount(account(baseTheme), () => routes["ui.appearance.update"](input)), input)
    }
    await assert.rejects(withAccount(account("sky"), () => routes["ui.appearance.update"]({ ...defaultAppearance, baseTheme: "invalid-theme" })))
    database.close()
    database = new EdenDatabase(path.join(root, "mon.db"), "mon")
    routes = uiPreferenceRoutes(new UiPreferenceRepository(database))
    for (const baseTheme of themes) {
      const value = await withAccount(account(baseTheme), () => routes["ui.appearance.get"]({}))
      assert.deepEqual(rpcMethods["ui.appearance.get"].result.parse(value),
        { ...defaultAppearance, baseTheme, backgroundMode: "theme", panelOpacity: 67, chatFontScale: 112 })
      assert.deepEqual(await withAccount(account(baseTheme), () => uiPreferenceRoutes(new UiPreferenceRepository(local))["ui.appearance.get"]({})), defaultAppearance)
    }
    assert.deepEqual(await withAccount(account("unconfigured"), () => routes["ui.appearance.get"]({})), defaultAppearance)
  } finally {
    database.close()
    local.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("old and corrupt panel preferences receive the readable default without rewriting stored settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eden-panel-legacy-"))
  const database = new EdenDatabase(path.join(root, "local.db"), "local")
  try {
    const repository = new UiPreferenceRepository(database)
    for (const panelOpacity of [undefined, -1, 101, 0.5, "85", null]) {
      const json = JSON.stringify({ fontScale: 125, panelOpacity })
      database.connection.prepare("INSERT INTO runtime_settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
        .run("ui.appearance:local", json, Date.now())
      assert.deepEqual(repository.appearance(), { ...defaultAppearance, chatFontScale: 125, componentFontScale: 125 })
      assert.equal(database.connection.prepare("SELECT value_json FROM runtime_settings WHERE key=?").get("ui.appearance:local")?.value_json, json)
    }
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})
