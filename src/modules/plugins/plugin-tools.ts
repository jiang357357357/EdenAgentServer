import type { PluginService } from '@eden/plugin-host'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { RuntimeTool } from '@eden/runtime-pi'
import { pluginDraftOperationSchema, pluginManageSchema, pluginDraftSchema, pluginIdSchema, pluginVersionSchema,
  pluginActivationSchema, pluginInvokeSchema, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { PermissionService } from '../permissions/index.ts'
import { modelDraftSnapshots } from './model-draft-snapshots.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const modelInvokeSchema = pluginIdSchema.extend({ input: z.record(z.string(), z.unknown()) })

export function pluginTools(plugins: PluginService, permissions: PermissionService, sessionId: string, turnId: string, actorId?: string | number): RuntimeTool[] {
  const drafts = modelDraftSnapshots(plugins, JSON.stringify([sessionId, turnId, actorId ?? null]))
  const management: RuntimeTool = {
    name: 'manage_plugins', revision: 'eden.plugin-management.v1', executionMode: 'sequential',
    description: toolDescription('manage_plugins'),
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['describe', 'read', 'draft', 'validate', 'test', 'install', 'activate', 'disable', 'list', 'invoke'] }, args: { type: 'object' } }, required: ['action', 'args'], additionalProperties: false },
    target(input) {
      const command = pluginManageSchema.parse(input)
      if (command.action !== 'invoke') return undefined
      const value = modelInvokeSchema.parse(command.args)
      const active = plugins.activations.list().find(item => item.id === value.id)
      if (!active) throw new Error('Plugin revision is not active')
      if (!value.input || typeof value.input !== 'object' || Array.isArray(value.input)) throw new Error('Plugin input must be an object')
      return { identity: `plugin:${value.id}`, input: value.input }
    },
    async execute(input, context) {
      const command = pluginManageSchema.parse(input)
      if (command.action === 'describe') return plugins.describe()
      if (command.action === 'invoke') {
        const value = modelInvokeSchema.parse(command.args)
        const active = plugins.activations.list().find(item => item.id === value.id)
        if (!active) throw new Error('Plugin is not active')
        command.args = toJson({ ...value, revision: active.revision })
      }
      if (command.action === 'read') return toJson(drafts.read(pluginIdSchema.parse(command.args).id))
      if (command.action === 'list') return toJson(plugins.versions.list())
      if (command.action === 'draft') {
        const value = pluginDraftSchema.omit({ expectedDraftRevision: true }).parse(command.args)
        const id = pluginIdSchema.parse({ id: (value.manifest as Record<string, JsonValue>).id }).id
        command.args = toJson({ ...value, expectedDraftRevision: drafts.expected(id) })
      }
      if (command.action === 'validate' || command.action === 'test') {
        const value = pluginIdSchema.parse(command.args)
        command.args = { ...value, expectedDraftRevision: drafts.capture(value.id) }
      }
      if (command.action === 'validate') {
        const input = pluginDraftOperationSchema.parse(command.args)
        const built = await plugins.validate(input.id, context.signal, input.expectedDraftRevision)
        return { id: built.manifest.id, revision: built.revision, valid: true }
      }
      // Exact request details are durable and visible before any plugin mutation or execution.
      const testInput = command.action === 'test' ? pluginDraftOperationSchema.parse(command.args) : undefined
      const testedRevision = testInput ? (await plugins.validate(testInput.id, context.signal, testInput.expectedDraftRevision)).revision : undefined
      await permissions.request({ ...context, sessionId, turnId }, `plugin.${command.action}`, testedRevision ? `plugin-test@${testedRevision}` : 'plugin-registry', command.args)
      context.signal.throwIfAborted()
      const result = await managePlugin(plugins, command.action, command.args, context.signal, testedRevision)
      if (command.action === 'draft') {
        const draft = result as { manifest: { id: string }; source: string; draftRevision: string }
        drafts.remember(draft.manifest.id, draft.draftRevision)
        return toJson({ manifest: draft.manifest, source: draft.source })
      }
      return result
    },
  }
  const active: RuntimeTool[] = plugins.activations.list().map(item => {
    const plugin = plugins.versions.read(item.id, item.revision)
    return {
      identity: `plugin:${item.id}`, source: 'plugin',
      name: `plugin_${item.id.replaceAll('-', '_').slice(0, 24)}_${createHash('sha256').update(item.id).digest('hex').slice(0, 8)}_${plugin.manifest.tool.name.slice(0, 22)}`,
      revision: item.revision, description: plugin.manifest.tool.description, parameters: plugin.manifest.tool.parameters,
      async execute(input, context) {
        await permissions.request({ ...context, sessionId, turnId }, 'plugin.invoke', `${item.id}@${item.revision}`, toJson(input))
        return plugins.invoke(item.id, item.revision, toJson(input), context.signal)
      },
    }
  })
  return [management, ...active]
}

async function managePlugin(plugins: PluginService, action: string, args: JsonValue, signal: AbortSignal, testedRevision?: string): Promise<JsonValue> {
  if (action === 'draft') {
    const params = pluginDraftSchema.parse(args)
    return toJson(plugins.drafts.save(params.manifest, params.source, params.expectedDraftRevision))
  }
  if (action === 'test') { const input = pluginDraftOperationSchema.parse(args); return toJson(await plugins.test(input.id, signal, testedRevision, input.expectedDraftRevision)) }
  if (action === 'install') {
    const params = pluginVersionSchema.parse(args)
    return toJson(await plugins.install(params.id, params.revision, signal))
  }
  if (action === 'activate') {
    const params = pluginActivationSchema.parse(args)
    return toJson(await plugins.activate(params.id, params.revision, params.readRoot))
  }
  if (action === 'disable') { plugins.disable(pluginIdSchema.parse(args).id); return { disabled: true } }
  const params = pluginInvokeSchema.parse(args)
  return plugins.invoke(params.id, params.revision, params.input, signal)
}
