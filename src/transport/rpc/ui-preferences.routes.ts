import { rpcMethods } from "@eden/api"
import type { UiPreferenceRepository } from "../../modules/ui-preferences/index.ts"
import { contractHandler } from "./contract-handler.ts"
export function uiPreferenceRoutes(repository: UiPreferenceRepository) {
  return {
    "ui.appearance.get": contractHandler(rpcMethods["ui.appearance.get"], () => repository.appearance()),
    "ui.appearance.update": contractHandler(rpcMethods["ui.appearance.update"], (input) =>
      repository.updateAppearance(input),
    ),
    "ui.background.get": contractHandler(rpcMethods["ui.background.get"], () => repository.background()),
    "ui.background.update": contractHandler(rpcMethods["ui.background.update"], (input) =>
      repository.updateBackground(input),
    ),
    "ui.preferences.get": contractHandler(rpcMethods["ui.preferences.get"], () => repository.get()),
    "ui.preferences.update": contractHandler(rpcMethods["ui.preferences.update"], (input) => repository.update(input)),
  }
}
