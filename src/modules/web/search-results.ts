import { clean, truncate } from './web-content.ts'

export interface SearchResult { title: string; url: string; snippet: string; hostname: string; provider: string; publishedAt: string | null; score: number | null; refId?: string }

export function normalizeResults(provider: string, query: string, raw: any[], maximum: number): SearchResult[] {
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const candidates = raw.flatMap((value, index): Array<SearchResult & { relevance: number }> => {
    const title = clean(String(value?.title ?? value?.name ?? ''))
    const url = resultUrl(String(value?.url ?? value?.link ?? ''))
    if (!title || !url) return []
    const snippet = resultSnippet(value)
    const lowerTitle = title.toLocaleLowerCase(), lowerSnippet = snippet.toLocaleLowerCase()
    if (!searchTextRelevant(query, lowerTitle, lowerSnippet) && !(Number(value?.score ?? 0) > 0)) return []
    const relevance = terms.reduce((score, term) => score + (lowerTitle.includes(term) ? 10 : lowerSnippet.includes(term) ? 2 : 0), 0) + Number(value?.score ?? 0) * 10 - index * 0.01
    return [{ title, url: url.toString(), snippet, hostname: url.hostname, ...resultMetadata(value, provider), relevance }]
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

function resultUrl(raw: string): URL | undefined {
  let url: URL
  try { url = new URL(raw) } catch { return undefined }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || blockedHost(url.hostname)) return undefined
  url.hash = ''
  return url
}

function resultSnippet(value: any): string {
  return truncate(clean(String(value?.description ?? value?.snippet ?? value?.content ?? value?.text ?? '')), 1_200)
}

function resultMetadata(value: any, provider: string): Pick<SearchResult, 'provider' | 'publishedAt' | 'score'> {
  return {
    provider: String(value?.provider ?? provider),
    publishedAt: value?.published_at ?? value?.publishedDate ?? value?.published_date ?? value?.date ?? null,
    score: Number.isFinite(Number(value?.score)) ? Number(value.score) : null,
  }
}

export function searchTextRelevant(query: string, title: string, snippet: string): boolean {
  const terms = [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2))]
  if (!terms.length) return true
  const lowerTitle = title.toLocaleLowerCase(), lowerSnippet = snippet.toLocaleLowerCase()
  const titleHits = terms.filter(term => lowerTitle.includes(term)).length
  const allHits = terms.filter(term => lowerTitle.includes(term) || lowerSnippet.includes(term)).length
  return titleHits > 0 || allHits >= Math.min(2, terms.length)
}

export function mergeResults(groups: SearchResult[][], maximum: number): SearchResult[] {
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

function blockedHost(host: string) { const value = host.toLowerCase().replace(/\.$/, ''); return value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') }
export function renderResults(results: SearchResult[]) { return results.map(item => `[${item.refId}] ${item.title}\n${item.url}${item.snippet ? `\n${item.snippet}` : ''}`).join('\n\n') }
