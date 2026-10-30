import { jsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import { toolModelResult } from './model-result-catalog.ts'

/** Register before execution. New host tools must declare a business result contract. */
export function modelTool(tool: RuntimeTool): RuntimeTool {
  const project = toolModelResult(tool.name, tool.source)
  const custom = tool.modelResult
  if (!project && !custom) throw new Error(`工具尚未登记模型结果契约：${tool.name}`)
  return { ...tool, modelResult(value, input) {
    const prepared = custom ? jsonValue.parse(custom(value, input)) : value
    return jsonValue.parse(project ? project(prepared, input) : prepared)
  } }
}
