import { z } from 'zod'
import { Ajv } from 'ajv'
import catalog from './cua-catalog.json' with { type: 'json' }
import { cuaToolNames } from '@eden/api'
import { DesktopError } from './contracts.ts'

const entry = z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() }).passthrough() }).passthrough()
export const cuaCatalog = z.array(entry).parse(catalog.tools)
if (cuaCatalog.length !== cuaToolNames.length || cuaToolNames.some(name => !cuaCatalog.some(tool => tool.name === name)))
  throw new Error('Cua public tool catalog differs from the pinned API names')
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })
const validators = new Map(cuaCatalog.map(tool => [tool.name, ajv.compile(tool.inputSchema)]))
export function assertCuaInput(name: string, input: unknown) {
  const validate = validators.get(name)
  if (!validate) throw new DesktopError('Cua 工具未登记', 'CUA_TOOL_NOT_FOUND')
  if (!validate(input)) throw new DesktopError(`Cua 参数不符合上游契约：${ajv.errorsText(validate.errors)}`, 'CUA_INPUT_INVALID')
}
export function assertNativeCuaCatalog(value: string) {
  const actual = z.object({ tools: z.array(entry) }).passthrough().parse(JSON.parse(value)).tools
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    if (item && typeof item === 'object') return `{${Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    return JSON.stringify(item)
  }
  if (actual.length !== cuaCatalog.length || cuaCatalog.some(expected =>
    canonical(actual.find(tool => tool.name === expected.name)?.inputSchema) !== canonical(expected.inputSchema)))
    throw new DesktopError('Cua 原生目录与内置的 0.28.0 参数契约不一致，已阻止调用', 'CUA_CATALOG_MISMATCH')
}
