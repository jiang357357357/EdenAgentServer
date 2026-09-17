import type { JsonValue } from '@eden/api'
import type { SearchProvider, WebConfig } from './config.ts'
import { requestPublic } from './public-http.ts'

export interface SearchInput { queries: string[]; maxResults: number; domains: string[]; freshness?: 'day' | 'week' | 'month' | 'year' | undefined }
export interface FetchInput { url?: string | undefined; refId?: string | undefined; maxChars: number }

interface Resource { kind: 'search' | 'page'; url: string; title: string; body: string; createdAt: number }
interface SearchResult { title: string; url: string; snippet: string; hostname: string; provider: string; publishedAt: string | null; score: number | null; refId?: string }
interface TurnResearchState { searches: number; fetches: number; queries: Set<string>; updatedAt: number }

const MAX_SEARCHES_PER_TURN = 2
const MAX_FETCHES_PER_TURN = 4

export class WebService {
  private readonly cache = new Map<string, { createdAt: number; value: SearchResult[]; provider: string }>()
  private readonly resources = new Map<string, Map<string, Resource>>()
  private readonly counters = new Map<string, { search: number; page: number }>()
  private readonly turnResearch = new Map<string, TurnResearchState>()
  private anonymousBraveTail: Promise<void> = Promise.resolve()
  private anonymousBraveAvailableAt = 0
  constructor(private readonly config: WebConfig) {}

  async search(sessionId: string, input: SearchInput, signal: AbortSignal, turnId?: string): Promise<JsonValue> {
    const research = turnId ? this.consumeSearch(sessionId, turnId, input.queries) : undefined
    const completed = await Promise.allSettled(input.queries.map(query => this.searchOne(sessionId, query, input, signal)))
    const successes = completed.flatMap(item => item.status === 'fulfilled' ? [item.value] : [])
    const errors = completed.flatMap((item, index) => item.status === 'rejected' ? [{ query: input.queries[index]!, error: errorMessage(item.reason) }] : [])
    if (!successes.length) throw new Error(`所有联网搜索入口均失败：${errors.map(item => `${item.query}: ${item.error}`).join('; ')}`)
    const results = mergeResults(successes.map(value => value.results), input.maxResults)
    for (const result of results) result.refId = this.putResource(sessionId, 'search', result.url, result.title, '')
    return json({
      queries: input.queries,
      providers: [...new Set(successes.map(value => value.provider))],
      results,
      errors,
      text: renderResults(results),
      ...(research ? { research } : {}),
    })
  }

  async fetch(sessionId: string, input: FetchInput, signal: AbortSignal, turnId?: string): Promise<JsonValue> {
    const research = turnId ? this.consumeFetch(sessionId, turnId) : undefined
    const target = input.refId ? this.getResource(sessionId, input.refId).url : input.url
    if (!target) throw new Error('url 或 refId 至少需要一个')
    const response = await requestPublic(new URL(target), { signal, timeoutMs: this.config.fetchTimeoutMs, maxBytes: this.config.fetchMaxBytes })
    if (response.status < 200 || response.status >= 300) throw new Error(`${response.url} 返回 HTTP ${response.status}`)
    const raw = response.body.toString('utf8')
    let title = ''
    let content = raw
    if (response.contentType.includes('html')) ({ title, content } = extractHtml(raw))
    else if (!(response.contentType.startsWith('text/') || response.contentType.includes('json') || !response.contentType)) throw new Error(`不支持的网页内容类型：${response.contentType}`)
    const body = truncate(content, input.maxChars)
    const refId = this.putResource(sessionId, 'page', response.url.toString(), title, body)
    const contentQuality = response.contentType.includes('html') && !substantiveHtml(title, body) ? 'insufficient' : 'substantive'
    return json({ refId, url: response.url.toString(), title, content: body, contentType: response.contentType,
      bytes: response.body.length, responseTruncated: response.truncated || body.length < content.length, contentQuality,
      ...(contentQuality === 'insufficient' ? { warning: '页面可访问，但没有提取到足以核实事实的正文。不要把标题当作正文证据。' } : {}),
      ...(research ? { research } : {}) })
  }

  find(sessionId: string, refId: string, pattern: string): JsonValue {
    const resource = this.getResource(sessionId, refId)
    if (resource.kind !== 'page') throw new Error('页内查找只能使用 web_fetch 返回的页面 refId')
    const source = resource.body.toLocaleLowerCase()
    const needle = pattern.toLocaleLowerCase()
    const matches: string[] = []
    let offset = 0
    while (matches.length < 10) {
      const found = source.indexOf(needle, offset)
      if (found < 0) break
      const excerpt = collapse(resource.body.slice(Math.max(0, found - 180), Math.min(resource.body.length, found + pattern.length + 280)))
      if (!matches.includes(excerpt)) matches.push(excerpt)
      offset = found + Math.max(1, needle.length)
    }
    return json({ refId, pattern, title: resource.title, url: resource.url, matches })
  }

  private async searchOne(sessionId: string, query: string, input: SearchInput, signal: AbortSignal) {
    const key = JSON.stringify([sessionId, query, input.maxResults, input.domains, input.freshness, this.config.providers])
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.createdAt <= this.config.cacheTtlMs) return { provider: cached.provider, results: structuredClone(cached.value) }
    const failures: string[] = []
    for (const provider of this.config.providers) {
      signal.throwIfAborted()
      try {
        const results = await this.providerSearch(provider, query, input, signal)
        if (!results.length) { failures.push(`${provider}: 没有可用结果`); continue }
        this.cache.set(key, { createdAt: Date.now(), value: structuredClone(results), provider })
        this.trimCache()
        return { provider, results }
      } catch (error) { failures.push(`${provider}: ${errorMessage(error)}`) }
    }
    throw new Error(failures.join('; '))
  }

  private async providerSearch(provider: SearchProvider, query: string, input: SearchInput, signal: AbortSignal): Promise<SearchResult[]> {
    const request = providerRequest(this.config, provider, query, input)
    const send = () => requestPublic(request.url, { method: request.method, headers: request.headers, body: request.body,
      signal, timeoutMs: this.config.searchTimeoutMs, maxBytes: 2_000_000 })
    const response = provider === 'brave' && !this.config.braveApiKey ? await this.withAnonymousBraveSlot(signal, send) : await send()
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
    const text = response.body.toString('utf8')
    const raw = provider === 'bing' ? parseBing(text)
      : provider === 'sogou' ? parseSogou(text)
      : provider === 'duckduckgo' ? parseDuck(text)
        : provider === 'brave' && !this.config.braveApiKey ? parseBrave(text)
          : jsonProvider(provider, JSON.parse(text))
    return normalizeResults(provider, query, raw, input.maxResults)
  }

  private putResource(sessionId: string, kind: 'search' | 'page', url: string, title: string, body: string): string {
    const resources = this.resources.get(sessionId) ?? new Map<string, Resource>()
    const counter = this.counters.get(sessionId) ?? { search: 0, page: 0 }
    counter[kind] += 1
    const refId = `${kind}_${counter[kind]}`
    resources.set(refId, { kind, url, title, body, createdAt: Date.now() })
    while (resources.size > 128) {
      const oldest = [...resources].sort((left, right) => left[1].createdAt - right[1].createdAt)[0]
      if (!oldest) break
      resources.delete(oldest[0])
    }
    this.resources.set(sessionId, resources); this.counters.set(sessionId, counter)
    return refId
  }

  private getResource(sessionId: string, refId: string): Resource {
    const resource = this.resources.get(sessionId)?.get(refId)
    if (!resource) throw new Error(`当前会话不存在网页引用 ${refId}`)
    return resource
  }

  private trimCache() {
    while (this.cache.size > 128) {
      const oldest = [...this.cache].sort((left, right) => left[1].createdAt - right[1].createdAt)[0]
      if (!oldest) return
      this.cache.delete(oldest[0])
    }
  }

  private consumeSearch(sessionId: string, turnId: string, queries: string[]) {
    const state = this.turnState(sessionId, turnId)
    const keys = queries.map(normalizeQuery)
    if (keys.every(key => state.queries.has(key))) throw new Error('本轮已经执行过相同查询，请使用已有结果作答')
    if (state.searches >= MAX_SEARCHES_PER_TURN) throw new Error('本轮网页搜索已达到两次上限，请使用已有结果作答；需要更多研究时请在下一轮继续')
    state.searches += 1
    for (const key of keys) state.queries.add(key)
    state.updatedAt = Date.now()
    return {
      searchCallsUsed: state.searches,
      searchCallsRemaining: MAX_SEARCHES_PER_TURN - state.searches,
      instruction: state.searches === 1
        ? '已有相关结果时请读取一至两个来源并作答；只有结果均不相关时才补充搜索。'
        : '搜索预算已用完，请使用现有结果作答并说明证据限制。',
    }
  }

  private consumeFetch(sessionId: string, turnId: string) {
    const state = this.turnState(sessionId, turnId)
    if (state.fetches >= MAX_FETCHES_PER_TURN) throw new Error('本轮网页正文读取已达到四次上限，请使用已有来源作答')
    state.fetches += 1
    state.updatedAt = Date.now()
    return { fetchCallsUsed: state.fetches, fetchCallsRemaining: MAX_FETCHES_PER_TURN - state.fetches }
  }

  private turnState(sessionId: string, turnId: string): TurnResearchState {
    const key = `${sessionId}:${turnId}`
    const state = this.turnResearch.get(key) ?? { searches: 0, fetches: 0, queries: new Set<string>(), updatedAt: Date.now() }
    this.turnResearch.set(key, state)
    if (this.turnResearch.size > 256) {
      const oldest = [...this.turnResearch].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]
      if (oldest) this.turnResearch.delete(oldest[0])
    }
    return state
  }

  private async withAnonymousBraveSlot<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.anonymousBraveTail
    let release!: () => void
    this.anonymousBraveTail = new Promise(resolve => { release = resolve })
    await previous
    try {
      await abortableDelay(Math.max(0, this.anonymousBraveAvailableAt - Date.now()), signal)
      return await operation()
    } finally {
      this.anonymousBraveAvailableAt = Date.now() + 3_000
      release()
    }
  }
}

function providerRequest(config: WebConfig, provider: SearchProvider, query: string, input: SearchInput): { url: URL; method: 'GET' | 'POST'; headers?: Record<string, string>; body?: Buffer } {
  const scoped = input.domains.length ? `${query} ${input.domains.map(domain => `site:${domain}`).join(' OR ')}` : query
  if (provider === 'bing') {
    const url = new URL('https://www.bing.com/search'); url.searchParams.set('q', scoped); url.searchParams.set('count', String(input.maxResults)); return { url, method: 'GET' }
  }
  if (provider === 'duckduckgo') {
    const url = new URL('https://html.duckduckgo.com/html/'); url.searchParams.set('q', scoped); return { url, method: 'GET' }
  }
  if (provider === 'sogou') {
    const url = new URL('https://www.sogou.com/web'); url.searchParams.set('query', scoped)
    return { url, method: 'GET', headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' } }
  }
  if (provider === 'brave') {
    if (!config.braveApiKey) {
      const url = new URL('https://search.brave.com/search'); url.searchParams.set('q', scoped); url.searchParams.set('source', 'web')
      return { url, method: 'GET', headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' } }
    }
    const url = new URL('https://api.search.brave.com/res/v1/web/search'); url.searchParams.set('q', scoped); url.searchParams.set('count', String(input.maxResults))
    if (input.freshness) url.searchParams.set('freshness', ({ day: 'pd', week: 'pw', month: 'pm', year: 'py' })[input.freshness])
    return { url, method: 'GET', headers: { 'x-subscription-token': config.braveApiKey } }
  }
  if (provider === 'exa') {
    if (!config.exaApiKey) throw new Error('未配置 EXA_API_KEY')
    return jsonRequest('https://api.exa.ai/search', { query, numResults: input.maxResults, type: 'auto', useAutoprompt: true, includeDomains: input.domains }, { 'x-api-key': config.exaApiKey })
  }
  if (provider === 'tavily') {
    if (!config.tavilyApiKey) throw new Error('未配置 TAVILY_API_KEY')
    return jsonRequest('https://api.tavily.com/search', { api_key: config.tavilyApiKey, query, max_results: input.maxResults, include_domains: input.domains, time_range: input.freshness })
  }
  if (!config.searxngUrl) throw new Error('未配置 EDEN_AGENT_SEARXNG_URL')
  const url = new URL('/search', config.searxngUrl); url.searchParams.set('q', scoped); url.searchParams.set('format', 'json'); url.searchParams.set('categories', 'general')
  if (input.freshness) url.searchParams.set('time_range', input.freshness)
  return { url, method: 'GET' }
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return { url: new URL(url), method: 'POST' as const, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)) }
}

function jsonProvider(provider: SearchProvider, payload: any): any[] {
  if (provider === 'brave') return Array.isArray(payload?.web?.results) ? payload.web.results : []
  return Array.isArray(payload?.results) ? payload.results : []
}

function parseBing(html: string): any[] {
  return [...html.matchAll(/<li[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi)]
    .map(match => ({ url: normalizeBingUrl(decode(match[1] ?? '')), title: match[2] ?? '', snippet: match[0]?.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '' }))
}

function parseBrave(html: string): any[] {
  return html.split('<div class="result-body').slice(1).flatMap(segment => {
    const link = segment.match(/<a[^>]*href="(https?:\/\/[^"#]+)"[^>]*class="[^"]*\bl1\b[^"]*"/i)
    const title = segment.match(/<div[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/a>/i)
    if (!link?.[1] || !title?.[1]) return []
    const snippet = segment.match(/<div[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]
      ?? segment.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? ''
    return [{ url: decode(link[1]), title: title[1], snippet }]
  })
}

function normalizeBingUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!url.hostname.endsWith('bing.com')) return url.toString()
    const encoded = url.searchParams.get('u')
    if (!encoded?.startsWith('a1')) return url.toString()
    const decoded = Buffer.from(encoded.slice(2), 'base64url').toString('utf8')
    return new URL(decoded).toString()
  } catch { return value }
}

function parseDuck(html: string): any[] {
  return [...html.matchAll(/<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap(match => {
    try {
      const raw = decode(match[1] ?? '')
      const wrapped = new URL(raw, 'https://duckduckgo.com')
      const url = wrapped.hostname.endsWith('duckduckgo.com') ? wrapped.searchParams.get('uddg') ?? wrapped.toString() : wrapped.toString()
      return [{ url, title: match[2] ?? '' }]
    } catch { return [] }
  })
}

function parseSogou(html: string): any[] {
  return html.split(/<div class="vrwrap"/i).slice(1).flatMap(segment => {
    const title = segment.match(/<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)
    const direct = segment.match(/\bdata-url="(https?:\/\/[^"#]+)"/i)?.[1]
    const link = segment.match(/<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/i)?.[1]
    const target = direct ?? (link?.startsWith('http') ? link : undefined)
    if (!title?.[1] || !target) return []
    const snippet = segment.match(/<div[^>]*class="[^"]*\bfz-mid\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? ''
    return [{ url: decode(target), title: title[1], snippet }]
  })
}

function normalizeResults(provider: string, query: string, raw: any[], maximum: number): SearchResult[] {
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const candidates = raw.flatMap((value, index): Array<SearchResult & { relevance: number }> => {
    const title = clean(String(value?.title ?? value?.name ?? ''))
    const rawUrl = String(value?.url ?? value?.link ?? '')
    if (!title || !rawUrl) return []
    let url: URL
    try { url = new URL(rawUrl) } catch { return [] }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || blockedHost(url.hostname)) return []
    url.hash = ''
    const snippet = truncate(clean(String(value?.description ?? value?.snippet ?? value?.content ?? value?.text ?? '')), 1_200)
    const lowerTitle = title.toLocaleLowerCase(), lowerSnippet = snippet.toLocaleLowerCase()
    if (!searchTextRelevant(query, lowerTitle, lowerSnippet) && !(Number(value?.score ?? 0) > 0)) return []
    const relevance = terms.reduce((score, term) => score + (lowerTitle.includes(term) ? 10 : lowerSnippet.includes(term) ? 2 : 0), 0) + Number(value?.score ?? 0) * 10 - index * 0.01
    return [{ title, url: url.toString(), snippet, hostname: url.hostname, provider: String(value?.provider ?? provider),
      publishedAt: value?.published_at ?? value?.publishedDate ?? value?.published_date ?? value?.date ?? null,
      score: Number.isFinite(Number(value?.score)) ? Number(value.score) : null, relevance }]
  }).sort((left, right) => right.relevance - left.relevance)
  const urls = new Set<string>(), titles = new Set<string>(), hosts = new Map<string, number>(), results: SearchResult[] = []
  for (const { relevance: _relevance, ...item } of candidates) {
    const urlKey = item.url.replace(/\/$/, ''), titleKey = item.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    const hostCount = hosts.get(item.hostname) ?? 0
    if (urls.has(urlKey) || (titleKey && titles.has(titleKey)) || hostCount >= 2) continue
    urls.add(urlKey); if (titleKey) titles.add(titleKey); hosts.set(item.hostname, hostCount + 1); results.push(item)
    if (results.length >= maximum) break
  }
  return results
}

export function searchTextRelevant(query: string, title: string, snippet: string): boolean {
  const terms = [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2))]
  if (!terms.length) return true
  const lowerTitle = title.toLocaleLowerCase(), lowerSnippet = snippet.toLocaleLowerCase()
  const titleHits = terms.filter(term => lowerTitle.includes(term)).length
  const allHits = terms.filter(term => lowerTitle.includes(term) || lowerSnippet.includes(term)).length
  return titleHits > 0 || allHits >= Math.min(2, terms.length)
}

function mergeResults(groups: SearchResult[][], maximum: number): SearchResult[] {
  const urls = new Set<string>(), titles = new Set<string>(), hosts = new Map<string, number>(), results: SearchResult[] = []
  const longest = Math.max(0, ...groups.map(group => group.length))
  for (let index = 0; index < longest && results.length < maximum; index += 1) {
    for (const group of groups) {
      const item = group[index]
      if (!item) continue
      const urlKey = item.url.replace(/\/$/, ''), titleKey = item.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      const hostCount = hosts.get(item.hostname) ?? 0
      if (urls.has(urlKey) || (titleKey && titles.has(titleKey)) || hostCount >= 2) continue
      urls.add(urlKey); if (titleKey) titles.add(titleKey); hosts.set(item.hostname, hostCount + 1); results.push({ ...item })
      if (results.length >= maximum) break
    }
  }
  return results
}

function extractHtml(html: string): { title: string; content: string } {
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const safe = html.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|section|article|header|footer|h[1-6]|li|tr|ul|ol)\s*>/gi, '\n')
  return { title, content: safe.replace(/<[^>]+>/g, ' ').split(/\r?\n/).map(clean).filter(Boolean).join('\n\n') }
}

function substantiveHtml(title: string, content: string): boolean {
  const normalized = collapse(content)
  const withoutTitle = title ? normalized.replace(collapse(title), '').trim() : normalized
  return withoutTitle.length >= 160
}

function normalizeQuery(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (_all, entity: string) => {
    if (entity[0] === '#') { const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10; return String.fromCodePoint(Number.parseInt(entity.slice(radix === 16 ? 2 : 1), radix)) }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[entity.toLowerCase()] ?? "'"
  })
}
function clean(value: string) { return collapse(decode(value.replace(/<[^>]+>/g, ' '))) }
function collapse(value: string) { return value.replace(/\s+/g, ' ').trim() }
function truncate(value: string, length: number) { return value.length <= length ? value : `${value.slice(0, length)}…` }
function blockedHost(host: string) { const value = host.toLowerCase().replace(/\.$/, ''); return value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
function renderResults(results: SearchResult[]) { return results.map(item => `[${item.refId}] ${item.title}\n${item.url}${item.snippet ? `\n${item.snippet}` : ''}`).join('\n\n') }
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, milliseconds)
    const abort = () => { cleanup(); reject(signal.reason ?? Object.assign(new Error('Web request cancelled'), { name: 'AbortError' })) }
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
