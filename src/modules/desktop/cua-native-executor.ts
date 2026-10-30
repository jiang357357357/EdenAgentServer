import { toJson } from '@eden/api'
import { DesktopError, type DesktopDriver, type DesktopResult } from './contracts.ts'
import { assertCuaInput, cuaCatalog } from './cua-catalog.ts'
import { CuaReferences } from './cua-references.ts'
import { parseCuaJson } from './cua-json.ts'
import { CUA_REFERENCE_SCOPE } from '../../model-prompts/cua-tools.ts'
import { nativeOutcome } from './native-outcome.ts'

export class CuaNativeExecutor {
  private readonly references = new CuaReferences()
  constructor(private readonly driver: DesktopDriver) {}
  invalidate() { this.references.clear() }
  async execute(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<DesktopResult> {
    const tool = cuaCatalog.find(item => item.name === name)
    if (!tool || !this.driver.native) throw new DesktopError('Cua 原生工具尚不可用，请更新共享驱动服务', 'CUA_TOOL_UNAVAILABLE')
    assertCuaInput(name, input)
    const native = this.references.encode(input) as Record<string, unknown>
    signal.throwIfAborted()
    const result = await this.driver.native(name, native, signal)
    const parsed = result.structuredJson ? parseCuaJson(result.structuredJson) : undefined
    const data = name === 'page' ? parsed : this.references.decode(parsed)
    const text = ['clipboard_read', 'get_accessibility_tree', 'page'].includes(name) || !result.structuredJson ? result.text : undefined
    return { value: toJson({ ...nativeOutcome(result, tool.annotations.readOnlyHint === true),
      ...(data !== undefined ? { data } : {}), ...(text ? { text } : {}),
      referenceScope: CUA_REFERENCE_SCOPE }), images: result.images }
  }
}
