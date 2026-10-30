import { rpcMethods } from '@eden/api'
import type { MemoryModelStatus } from '@eden/api'
import type { LocalMemoryModel } from '../../modules/memories/index.ts'
import { contractHandler } from './contract-handler.ts'

export function memoryModelRoutes(model: LocalMemoryModel | undefined) {
  const local = () => { if (!model) throw new Error('伊甸园记忆模型由 Core 内置，无需在尘世下载。'); return model }
  const core: MemoryModelStatus = { state: 'core', model: 'bge-small-zh-v1.5', path: null, downloadedBytes: 0, totalBytes: 96295409, error: null }
  return {
    'memory.model.status': contractHandler(rpcMethods['memory.model.status'], () => model?.status() ?? core),
    'memory.model.download': contractHandler(rpcMethods['memory.model.download'], () => local().download()),
    'memory.model.cancel': contractHandler(rpcMethods['memory.model.cancel'], () => local().cancel()),
  }
}
