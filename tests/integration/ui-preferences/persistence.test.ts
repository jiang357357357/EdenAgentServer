import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EdenDatabase } from "@eden/store"
import { UiPreferenceRepository } from "../../../src/modules/ui-preferences/index.ts"
import { uiPreferenceRoutes } from "../../../src/transport/rpc/ui-preferences.routes.ts"

test("interface preferences survive restart, reject invalid values and stay within their realm", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eden-ui-pref-"))
  let database = new EdenDatabase(path.join(root, "mon.db"), "mon")
  const local = new EdenDatabase(path.join(root, "local.db"), "local")
  try {
    const routes = uiPreferenceRoutes(new UiPreferenceRepository(database))
    assert.deepEqual(await routes["ui.preferences.get"]({}), { autoScrollEnabled: true })
    assert.deepEqual(await routes["ui.appearance.get"]({}), { chatFontScale: 100, componentFontScale: 100 })
    assert.deepEqual(await routes["ui.background.get"]({}), { opacity: 100, blur: 0, imageBlobId: null })
    await routes["ui.preferences.update"]({ autoScrollEnabled: false })
    await routes["ui.appearance.update"]({ chatFontScale: 115, componentFontScale: 90 })
    await routes["ui.background.update"]({ opacity: 63, blur: 14 })
    await assert.rejects(routes["ui.preferences.update"]({ autoScrollEnabled: "false" }))
    await assert.rejects(routes["ui.appearance.update"]({ chatFontScale: 145, componentFontScale: 100 }))
    await assert.rejects(routes["ui.background.update"]({ opacity: 101, blur: 14 }))
    database.close()
    database = new EdenDatabase(path.join(root, "mon.db"), "mon")
    assert.deepEqual(new UiPreferenceRepository(database).get(), { autoScrollEnabled: false })
    assert.deepEqual(new UiPreferenceRepository(database).appearance(), { chatFontScale: 115, componentFontScale: 90 })
    assert.deepEqual(new UiPreferenceRepository(database).background(), { opacity: 63, blur: 14, imageBlobId: null })
    assert.deepEqual(new UiPreferenceRepository(local).get(), { autoScrollEnabled: true })
    local.connection.prepare("INSERT INTO runtime_settings VALUES(?,?,?)").run(
      "ui.appearance:local",
      JSON.stringify({ fontScale: 125 }),
      Date.now(),
    )
    assert.deepEqual(new UiPreferenceRepository(local).appearance(), { chatFontScale: 125, componentFontScale: 125 })
    assert.deepEqual(new UiPreferenceRepository(local).background(), { opacity: 100, blur: 0, imageBlobId: null })
  } finally {
    database.close()
    local.close()
    await rm(root, { recursive: true, force: true })
  }
})
