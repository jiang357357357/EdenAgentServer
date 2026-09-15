import { ZodError } from 'zod'
import { MonClient, MonHttpError } from '@eden/integrations'
import { parseCoreAssistant, coreSettingsSchema, coreEntities, resolveCoreModel, coreIdSchema } from './model-schema.ts'
import { publicVendors, modelOption, selectEntity } from './model-options.ts'

export async function loadMonCatalog(client: MonClient, assistantId?: string | number, signal?: AbortSignal) {
  try { return await readMonCatalog(client, assistantId, signal) }
  catch (error) {
    if (error instanceof ZodError) throw new Error('Core 模型目录数据格式不兼容，请检查 Core 的模型配置。')
    throw error
  }
}

async function readMonCatalog(client: MonClient, assistantId?: string | number, signal?: AbortSignal) {
  const assistantPath = assistantId === undefined ? '/api/assistants/current/' : `/api/assistants/${encodeURIComponent(String(coreIdSchema.parse(assistantId)))}/`
  let assistantRaw
  try { assistantRaw = await client.get(assistantPath, signal) }
  catch (error) {
    if (error instanceof MonHttpError && error.status === 404) {
      if (assistantId !== undefined) throw new Error(`会话助手（ID：${String(assistantId)}）已不在 Mon Core 中，请为本会话重新选择助手。`)
      throw new Error('Mon Core 当前没有可用的默认助手，请先在助手管理中设置。')
    }
    throw error
  }
  const [settingsRaw, vendorsRaw, entitiesRaw] = await Promise.all([
    client.get('/api/agent/settings/my/', signal), client.get('/api/core/vendors/ai/', signal), client.getCollection('/api/ai/entities/', signal),
  ])
  const assistant = parseCoreAssistant(assistantRaw, assistantId)
  const settings = coreSettingsSchema.parse(settingsRaw)
  const vendors = publicVendors(vendorsRaw)
  const entities = coreEntities(entitiesRaw)
  const preferred = assistant.character.ai_talk_entity_id ?? settings.default_model
  const selected = selectEntity(entities, preferred)
  const vision = entities.find(entity => entity.status === 'active' && entity.is_multimodal && String(entity.id) === String(assistant.character.vision_ai_entity_id)) ??
    entities.find(entity => entity.status === 'active' && entity.is_multimodal && entity.is_vision_default) ?? entities.find(entity => entity.status === 'active' && entity.is_multimodal)
  const detail = selected ? resolveCoreModel(await client.get(`/api/ai/entities/${encodeURIComponent(String(selected.id))}/`, signal)) : undefined
  const visionDetail = vision ? resolveCoreModel(await client.get(`/api/ai/entities/${encodeURIComponent(String(vision.id))}/`, signal)) : undefined
  if (detail && String(detail.entityId) !== String(selected?.id)) throw new Error('Mon model detail identity does not match the selected entity')
  if (visionDetail && String(visionDetail.entityId) !== String(vision?.id)) throw new Error('Mon vision detail identity does not match the selected entity')
  return {
    binding: detail, visionBinding: visionDetail,
    catalog: { source: 'core', serviceType: 'ai', vendors,
      assistant: { id: assistant.id, name: assistant.name }, character: { id: assistant.character.id, name: assistant.character.name },
      current: selected ? modelOption(selected, selected.id, vendors) : null, vision: vision ? modelOption(vision, undefined, vendors) : null,
      selectionSource: assistant.character.ai_talk_entity_id != null ? 'character' : 'input',
      options: entities.map(entity => modelOption(entity, selected?.id, vendors)), actors: [],
    },
  }
}
