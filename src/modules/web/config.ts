import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export type SearchProvider = 'brave' | 'exa' | 'tavily' | 'searxng' | 'sogou' | 'bing' | 'duckduckgo'

export interface WebConfig {
  providers: SearchProvider[]
  searchTimeoutMs: number
  cacheTtlMs: number
  fetchTimeoutMs: number
  fetchMaxBytes: number
  braveApiKey?: string | undefined
  exaApiKey?: string | undefined
  tavilyApiKey?: string | undefined
  searxngUrl?: string | undefined
}

const provider = z.enum(['brave', 'exa', 'tavily', 'searxng', 'sogou', 'bing', 'duckduckgo'])
const searchKeys: Record<string, string> = {
  PROVIDER: 'EDEN_AGENT_SEARCH_PROVIDER',
  TIMEOUT_MS: 'EDEN_AGENT_SEARCH_TIMEOUT_MS',
  CACHE_TTL_SECONDS: 'EDEN_AGENT_SEARCH_CACHE_TTL_SECONDS',
  BRAVE_API_KEY: 'BRAVE_SEARCH_API_KEY',
  EXA_API_KEY: 'EXA_API_KEY',
  TAVILY_API_KEY: 'TAVILY_API_KEY',
  SEARXNG_URL: 'EDEN_AGENT_SEARXNG_URL',
  FETCH_TIMEOUT_MS: 'EDEN_AGENT_FETCH_TIMEOUT_MS',
  FETCH_MAX_BYTES: 'EDEN_AGENT_FETCH_MAX_BYTES',
}

export function webConfig(environment: NodeJS.ProcessEnv, cwd: string): WebConfig {
  const env = { ...searchFileEnvironment(cwd), ...environment }
  const requested = (env.EDEN_AGENT_SEARCH_PROVIDER ?? 'auto').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const providers = requested.includes('auto') ? automaticProviders(env) : [...new Set(requested.map(value => provider.parse(value)))]
  if (!providers.length) throw new Error('EDEN_AGENT_SEARCH_PROVIDER must select at least one provider')
  return {
    providers,
    searchTimeoutMs: integer(env.EDEN_AGENT_SEARCH_TIMEOUT_MS, 10_000, 1_000, 60_000),
    cacheTtlMs: integer(env.EDEN_AGENT_SEARCH_CACHE_TTL_SECONDS, 120, 0, 3_600) * 1_000,
    fetchTimeoutMs: integer(env.EDEN_AGENT_FETCH_TIMEOUT_MS, 20_000, 1_000, 120_000),
    fetchMaxBytes: integer(env.EDEN_AGENT_FETCH_MAX_BYTES, 2 * 1024 * 1024, 64 * 1024, 10 * 1024 * 1024),
    ...(first(env.BRAVE_SEARCH_API_KEY, env.BRAVE_API_KEY) ? { braveApiKey: first(env.BRAVE_SEARCH_API_KEY, env.BRAVE_API_KEY) } : {}),
    ...(first(env.EXA_API_KEY) ? { exaApiKey: first(env.EXA_API_KEY) } : {}),
    ...(first(env.TAVILY_API_KEY) ? { tavilyApiKey: first(env.TAVILY_API_KEY) } : {}),
    ...(first(env.EDEN_AGENT_SEARXNG_URL, env.SEARXNG_URL) ? { searxngUrl: first(env.EDEN_AGENT_SEARXNG_URL, env.SEARXNG_URL) } : {}),
  }
}

function automaticProviders(env: NodeJS.ProcessEnv): SearchProvider[] {
  const values: SearchProvider[] = ['brave']
  if (first(env.EXA_API_KEY)) values.push('exa')
  if (first(env.TAVILY_API_KEY)) values.push('tavily')
  if (first(env.EDEN_AGENT_SEARXNG_URL, env.SEARXNG_URL)) values.push('searxng')
  return [...values, 'sogou', 'bing', 'duckduckgo']
}

function integer(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  return z.coerce.number().int().min(minimum).max(maximum).parse(raw ?? fallback)
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.map(value => value?.trim()).find((value): value is string => Boolean(value))
}

/** Reads only [search]. Process environment is merged afterwards and always wins. */
function searchFileEnvironment(start: string): NodeJS.ProcessEnv {
  let directory = path.resolve(start)
  while (true) {
    const filename = path.join(directory, '.monconfig')
    if (existsSync(filename)) return parseSearchSection(readFileSync(filename, 'utf8'))
    const parent = path.dirname(directory)
    if (parent === directory) return {}
    directory = parent
  }
}

function parseSearchSection(content: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  let active = false
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = line.match(/^\[([^\]]+)]$/)
    if (section) { active = section[1]?.trim().toLowerCase() === 'search'; continue }
    if (!active) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim().toUpperCase()
    const envKey = searchKeys[key]
    if (envKey) result[envKey] = line.slice(separator + 1).trim()
  }
  return result
}
