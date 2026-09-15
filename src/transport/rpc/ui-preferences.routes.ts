import { rpcMethods } from '@eden/api'
import type { UiPreferenceRepository } from '../../modules/ui-preferences/index.ts'
import { contractHandler } from './contract-handler.ts'
export function uiPreferenceRoutes(repository: UiPreferenceRepository) {
  return {
    'ui.preferences.get': contractHandler(rpcMethods['ui.preferences.get'], () => repository.get()),
    'ui.preferences.update': contractHandler(rpcMethods['ui.preferences.update'], input => repository.update(input)),
  }
}
