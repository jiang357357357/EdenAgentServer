import { rpcMethods } from '@eden/api'
import type { PromptModeRepository } from '../../modules/prompt-mode/index.ts'
import { contractHandler } from './contract-handler.ts'

export function promptModeRoutes(repository: PromptModeRepository) {
  return {
    'prompt.mode.get': contractHandler(rpcMethods['prompt.mode.get'], () => repository.get()),
    'prompt.mode.update': contractHandler(rpcMethods['prompt.mode.update'], input => repository.update(input)),
  }
}
