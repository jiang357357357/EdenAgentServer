import type { TestContext } from 'node:test'
import type { RuntimeModel } from '@eden/runtime-pi'

/** Synthetic Core catalog; model requests still reach the separate HTTP provider. */
export function mockSharedCatalog(t: TestContext, model: RuntimeModel, userId = '7') {
  const state = { assistant: 1, character: 2, requests: [] as string[] }
  const original = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin !== 'https://fixture.invalid') return original(input, init)
    state.requests.push(url.pathname)
    const entity = { id: 1, ai_model: model.id, ai_name: 'Test model', vendor: model.provider, status: 'active',
      api_key: 'synthetic-test-key', api_endpoint: model.baseUrl, default_params: { context_window: model.contextWindow, max_tokens: model.maxTokens } }
    const body = url.pathname === '/api/internal/service-token/' ? { user_id: userId, token: 'synthetic-core-token' }
      : url.pathname.startsWith('/api/assistants/') ? { id: state.assistant, name: 'Alice', character: { id: state.character,
        name: 'Alice', system_prompt: 'You are Alice in a public QQ group.', ai_talk_entity_id: 1 } }
      : url.pathname === '/api/agent/settings/my/' ? { default_model: '1' }
      : url.pathname === '/api/core/vendors/ai/' ? { vendors: {} }
      : url.pathname === '/api/ai/entities/' ? [entity] : entity
    return Response.json(body)
  }) as typeof fetch)
  return state
}
